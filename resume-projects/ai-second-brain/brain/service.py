import asyncio
import uuid


class Brain:
    def __init__(self, settings, store, provider, vectors, notion=None):
        self.settings, self.store, self.provider = settings, store, provider
        self.vectors, self.notion = vectors, notion

    async def process(self, job):
        try:
            extraction = await self.provider.extract(job)
            memories = [m.model_dump() | {"id": str(uuid.uuid5(
                uuid.NAMESPACE_URL, f"{job['owner']}:{job['id']}:{i}"))}
                for i, m in enumerate(extraction.memories)]
            embeddings = await self.provider.embed([m["content"] for m in memories])
            if not self.store.is_current(job):
                return
            await asyncio.to_thread(self.vectors.put, job["owner"], memories, embeddings)
            self.store.complete(job, extraction, memories)
        except Exception as exc:
            # Provider exception strings can contain token-bearing URLs. Store only the class.
            self.store.fail(job, f"Processing failed: {type(exc).__name__}", self.settings.max_attempts)

    async def process_batch(self):
        jobs = self.store.claim(self.settings.batch_size, self.settings.lease_seconds,
                                self.settings.max_attempts)
        await asyncio.gather(*(self.process(job) for job in jobs))
        return len(jobs)

    async def worker(self):
        while True:
            count = await self.process_batch()
            if not count:
                await asyncio.sleep(1)

    async def ask(self, owner, question, limit):
        vector = (await self.provider.embed([question], query=True))[0]
        ids = await asyncio.to_thread(self.vectors.search, owner, vector, limit)
        sources = self.store.memories(owner, ids)
        warnings = []
        if self.notion:
            try:
                sources.extend(await self.notion.search(question))
            except Exception:
                warnings.append("Notion is temporarily unavailable; local memories were used.")
        if not sources:
            return {"answer": "No supporting memory found.", "citation_ids": [],
                    "sources": [], "warnings": warnings, "mode": self.provider.name}
        answer = await self.provider.answer(question, sources)
        valid_ids = {s["id"] for s in sources}
        if any(item not in valid_ids for item in answer.citation_ids) or not answer.citation_ids:
            answer.answer = "An answer with verifiable citations could not be generated. Review the sources."
            answer.citation_ids = []
        return answer.model_dump() | {"sources": sources, "warnings": warnings,
                                      "mode": self.provider.name}
