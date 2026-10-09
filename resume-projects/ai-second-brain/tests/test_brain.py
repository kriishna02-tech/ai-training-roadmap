import json
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from fastapi.testclient import TestClient
from qdrant_client import QdrantClient

from brain.app import create_app
from brain.models import Answer
from brain.providers import DemoProvider, GeminiProvider
from brain.service import Brain
from brain.settings import Settings
from brain.store import Store
from brain.vectors import VectorStore


@pytest.fixture
def system(tmp_path):
    settings = Settings(data_dir=tmp_path, worker_enabled=False)
    store, provider = Store(tmp_path / "brain.sqlite"), DemoProvider()
    vectors = VectorStore(settings, provider, QdrantClient(":memory:"))
    brain = Brain(settings, store, provider, vectors)
    yield brain
    vectors.close()


async def test_ingest_retrieve_and_owner_isolation(system):
    system.store.enqueue("alice", "The robotics project deadline is Friday", "telegram:1")
    system.store.enqueue("bob", "Private robotics password secret", "telegram:1")
    assert await system.process_batch() == 2
    response = await system.ask("alice", "robotics deadline", 5)
    assert response["citation_ids"]
    assert "Friday" in response["answer"]
    assert "password" not in response["answer"]
    assert len(system.store.memories("alice")) == 1


async def test_idempotent_ingestion_and_failed_job_retry(system):
    first = system.store.enqueue("alice", "Remember the deployment checklist", "same-update")
    duplicate = system.store.enqueue("alice", "Remember the deployment checklist", "same-update")
    assert first["id"] == duplicate["id"]
    original = system.provider.extract

    async def fail_once(job):
        system.provider.extract = original
        raise RuntimeError("https://provider.example/token-that-must-not-be-logged")

    system.provider.extract = fail_once
    await system.process_batch()
    assert "token-that" not in system.store.get_job("alice", first["id"])["error"]
    with system.store.connection() as db:
        db.execute("UPDATE jobs SET available_at=0")
    await system.process_batch()
    assert system.store.get_job("alice", first["id"])["status"] == "ready"
    assert len(system.store.memories("alice")) == 1


def test_workers_claim_disjoint_jobs_and_recover_expired_leases(system):
    for i in range(20):
        system.store.enqueue("alice", f"note {i}")
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda _: system.store.claim(5, 300, 3), range(4)))
    ids = [job["id"] for batch in results for job in batch]
    assert len(set(ids)) == len(ids) == 20
    old_job = results[0][0]
    with system.store.connection() as db:
        db.execute("UPDATE jobs SET lease_until=0 WHERE id=?", (old_job["id"],))
    replacement = system.store.claim(1, 300, 3)[0]
    assert replacement["id"] == old_job["id"]
    assert replacement["lease_token"] != old_job["lease_token"]
    assert not system.store.is_current(old_job)


async def test_partial_index_failure_does_not_expose_incomplete_memory(system):
    job = system.store.enqueue("alice", "SQL query optimization checklist")
    original = system.vectors.put

    def fail_after_put(*args):
        original(*args)
        raise RuntimeError("simulated crash after index write")

    system.vectors.put = fail_after_put
    await system.process_batch()
    assert system.store.memories("alice") == []
    assert (await system.ask("alice", "SQL", 5))["sources"] == []
    system.vectors.put = original
    with system.store.connection() as db:
        db.execute("UPDATE jobs SET available_at=0")
    await system.process_batch()
    assert system.store.get_job("alice", job["id"])["status"] == "ready"
    assert system.vectors.client.count(system.vectors.collection).count == 1


async def test_rejects_invented_citations(system):
    system.store.enqueue("alice", "Learn SQLite transactions")
    await system.process_batch()

    async def invented(question, sources):
        return Answer(answer="Made up", citation_ids=["not-a-real-source"])

    system.provider.answer = invented
    answer = await system.ask("alice", "SQLite", 5)
    assert answer["citation_ids"] == []
    assert "verifiable" in answer["answer"]


def test_api_auth_upload_limits_and_safe_output(tmp_path):
    config = Settings(data_dir=tmp_path, worker_enabled=False, max_upload_bytes=16)
    with TestClient(create_app(config, vector_client=QdrantClient(":memory:"))) as client:
        assert client.get("/").status_code == 200
        assert client.get("/v1/jobs").status_code == 401
        headers = {"X-API-Key": "local-brain-key"}
        assert client.post("/v1/ingest/text", json={"text": "   "}, headers=headers).status_code == 422
        created = client.post("/v1/ingest/text", json={"text": "hello"}, headers=headers)
        assert created.status_code == 202
        assert "file_path" not in created.json()
        assert client.post("/v1/ingest/file", files={"file": ("big.txt", b"x" * 17, "text/plain")}, headers=headers).status_code == 413
        assert client.post("/v1/ingest/file", files={"file": ("x.exe", b"hi", "application/octet-stream")}, headers=headers).status_code == 415
        assert client.post("/v1/ingest/file", files={"file": ("x.txt", b"hi", "text/plain")}, headers=headers).status_code == 202
        assert client.post("/telegram/webhook", json={}).status_code == 503


def test_telegram_secret_allowlist_and_dedup(tmp_path):
    config = Settings(data_dir=tmp_path, worker_enabled=False, telegram_bot_token="test-token",
                      telegram_webhook_secret="test-secret", telegram_allowed_user_ids=[123])
    with TestClient(create_app(config, vector_client=QdrantClient(":memory:"))) as client:
        update = {"update_id": 4, "message": {"from": {"id": 123}, "text": "Remember Friday"}}
        assert client.post("/telegram/webhook", json=update).status_code == 401
        headers = {"X-Telegram-Bot-Api-Secret-Token": "test-secret"}
        first = client.post("/telegram/webhook", json=update, headers=headers)
        second = client.post("/telegram/webhook", json=update, headers=headers)
        assert first.json()["job_id"] == second.json()["job_id"]
        update["message"]["from"]["id"] = 999
        assert client.post("/telegram/webhook", json=update, headers=headers).status_code == 403


async def test_gemini_adapter_sends_structured_multimodal_request(tmp_path):
    requests = []

    def respond(request):
        payload = json.loads(request.content)
        requests.append(payload)
        return httpx.Response(200, json={"outputs": [{"type": "text", "text": json.dumps({
            "transcript": "A recorded idea", "summary": "An idea", "memories": [
                {"title": "Idea", "content": "A recorded idea", "kind": "note", "tags": []}]})}]})

    path = tmp_path / "audio"
    path.write_bytes(b"fake-audio-for-transport-test")
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        provider = GeminiProvider(Settings(gemini_api_key="test-key"), http)
        result = await provider.extract({"text": "caption", "file_path": str(path), "mime": "audio/ogg"})
    assert result.memories[0].title == "Idea"
    assert requests[0]["input"][1]["type"] == "audio"
    assert requests[0]["store"] is False
    assert requests[0]["response_format"]["schema"]["properties"]["memories"]


async def test_storage_survives_restart(tmp_path):
    config, provider = Settings(data_dir=tmp_path), DemoProvider()
    vectors = VectorStore(config, provider)
    brain = Brain(config, Store(tmp_path / "brain.sqlite"), provider, vectors)
    brain.store.enqueue("alice", "Redis Lua makes the update atomic")
    await brain.process_batch()
    vectors.close()
    reopened = VectorStore(config, provider)
    restored = Brain(config, Store(tmp_path / "brain.sqlite"), provider, reopened)
    assert (await restored.ask("alice", "Redis Lua", 5))["sources"]
    reopened.close()
