import re

import httpx


class Telegram:
    def __init__(self, token, client):
        self.token, self.client = token, client

    async def download(self, file_id, max_bytes):
        response = await self.client.get(
            f"https://api.telegram.org/bot{self.token}/getFile", params={"file_id": file_id})
        response.raise_for_status()
        result = response.json()
        if not result.get("ok"):
            raise ValueError("Telegram file lookup failed")
        path = result["result"]["file_path"]
        if not re.fullmatch(r"[a-zA-Z0-9_./-]+", path) or ".." in path or path.startswith("/"):
            raise ValueError("Invalid Telegram file path")
        if result["result"].get("file_size", 0) > max_bytes:
            raise ValueError("Telegram attachment is too large")
        data = bytearray()
        async with self.client.stream("GET", f"https://api.telegram.org/file/bot{self.token}/{path}") as response:
            response.raise_for_status()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > max_bytes:
                    raise ValueError("Telegram attachment is too large")
        return bytes(data)


class Notion:
    def __init__(self, token, version, client: httpx.AsyncClient):
        self.client = client
        self.headers = {"Authorization": f"Bearer {token}", "Notion-Version": version}

    async def search(self, question):
        # Notion's search API matches titles, not arbitrary page body text.
        response = await self.client.post("https://api.notion.com/v1/search", headers=self.headers,
            json={"query": question[:100], "page_size": 5,
                  "filter": {"value": "page", "property": "object"}})
        response.raise_for_status()
        sources = []
        for page in response.json()["results"]:
            title = "Untitled page"
            for value in page.get("properties", {}).values():
                if value.get("type") == "title":
                    title = "".join(t.get("plain_text", "") for t in value.get("title", []))
            blocks = await self.client.get(
                f"https://api.notion.com/v1/blocks/{page['id']}/children",
                headers=self.headers, params={"page_size": 50})
            blocks.raise_for_status()
            texts = [title]
            for block in blocks.json()["results"]:
                body = block.get(block["type"], {})
                text = "".join(t.get("plain_text", "") for t in body.get("rich_text", []))
                if text:
                    texts.append(text)
            sources.append({"id": f"notion:{page['id']}", "title": title,
                            "content": "\n".join(texts)[:8000], "url": page.get("url", "")})
        return sources
