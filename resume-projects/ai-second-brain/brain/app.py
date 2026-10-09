import asyncio
import contextlib
import secrets
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, UploadFile
from fastapi.responses import HTMLResponse

from brain.integrations import Notion, Telegram
from brain.models import QueryInput, TextInput
from brain.providers import DemoProvider, GeminiProvider
from brain.service import Brain
from brain.settings import Settings
from brain.store import Store
from brain.vectors import VectorStore

MIMES = {"text/plain", "text/markdown", "image/jpeg", "image/png", "image/webp",
         "audio/ogg", "audio/mpeg", "audio/wav", "audio/mp4", "video/mp4", "video/webm"}


def public_job(job):
    return {key: job[key] for key in ["id", "source_id", "status", "attempts", "error",
                                     "summary", "transcript", "created_at"]}


def create_app(settings: Settings | None = None, provider=None, vector_client=None):
    settings = settings or Settings()
    settings.validate_services()

    @asynccontextmanager
    async def lifespan(app):
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        async with httpx.AsyncClient(timeout=90, follow_redirects=False) as http:
            actual_provider = provider or (DemoProvider() if settings.demo_mode
                                           else GeminiProvider(settings, http))
            store = Store(settings.data_dir / "brain.sqlite")
            vectors = VectorStore(settings, actual_provider, vector_client)
            notion = (Notion(settings.notion_token.get_secret_value(), settings.notion_version, http)
                      if settings.notion_token.get_secret_value() else None)
            app.state.brain = Brain(settings, store, actual_provider, vectors, notion)
            app.state.telegram = Telegram(settings.telegram_bot_token.get_secret_value(), http)
            task = asyncio.create_task(app.state.brain.worker()) if settings.worker_enabled else None
            try:
                yield
            finally:
                if task:
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await task
                vectors.close()

    app = FastAPI(title="AI Second Brain", version="1.0.0", lifespan=lifespan)

    async def auth(x_api_key: str = Header(default="")):
        if not secrets.compare_digest(x_api_key.encode(), settings.api_key.get_secret_value().encode()):
            raise HTTPException(401, "A valid X-API-Key is required")
        return settings.owner_id

    def save_file(data):
        directory = settings.data_dir / "uploads"
        directory.mkdir(exist_ok=True)
        path = directory / str(uuid.uuid4())
        path.write_bytes(data)
        return str(path.resolve())

    @app.get("/", response_class=HTMLResponse, include_in_schema=False)
    def home():
        return Path(__file__).with_name("dashboard.html").read_text()

    @app.get("/health")
    async def health():
        return {"status": "ok", "mode": app.state.brain.provider.name,
                "worker_enabled": settings.worker_enabled}

    @app.post("/v1/ingest/text", status_code=202)
    async def ingest(payload: TextInput, owner=Depends(auth)):
        if not payload.text.strip():
            raise HTTPException(422, "Text must not be blank")
        job = app.state.brain.store.enqueue(owner, payload.text, payload.source_id)
        return public_job(job)

    @app.post("/v1/ingest/file", status_code=202)
    async def upload(file: UploadFile, owner=Depends(auth)):
        try:
            if file.content_type not in MIMES:
                raise HTTPException(415, "Unsupported media type")
            data = await file.read(settings.max_upload_bytes + 1)
            if len(data) > settings.max_upload_bytes:
                raise HTTPException(413, "Attachment exceeds the upload limit")
            if not data:
                raise HTTPException(422, "Attachment is empty")
            job = app.state.brain.store.enqueue(owner, "", file_path=save_file(data), mime=file.content_type)
            return public_job(job)
        finally:
            await file.close()

    @app.get("/v1/jobs")
    def jobs(owner=Depends(auth)):
        return [public_job(job) for job in app.state.brain.store.jobs(owner)]

    @app.get("/v1/jobs/{job_id}")
    def job(job_id: str, owner=Depends(auth)):
        found = app.state.brain.store.get_job(owner, job_id)
        if not found:
            raise HTTPException(404, "Job not found")
        return public_job(found)

    @app.get("/v1/memories")
    def memories(owner=Depends(auth)):
        return app.state.brain.store.memories(owner)

    @app.post("/v1/ask")
    async def ask(payload: QueryInput, owner=Depends(auth)):
        try:
            return await app.state.brain.ask(owner, payload.question, payload.limit)
        except Exception:
            raise HTTPException(503, "Retrieval provider unavailable; please retry")

    @app.post("/telegram/webhook")
    async def telegram(update: dict, x_telegram_bot_api_secret_token: str = Header(default="")):
        expected = settings.telegram_webhook_secret.get_secret_value()
        if not expected or not settings.telegram_bot_token.get_secret_value():
            raise HTTPException(503, "Telegram is not configured")
        if not secrets.compare_digest(x_telegram_bot_api_secret_token.encode(), expected.encode()):
            raise HTTPException(401, "Invalid webhook secret")
        message = update.get("message", {})
        sender = message.get("from", {}).get("id")
        if sender not in settings.telegram_allowed_user_ids:
            raise HTTPException(403, "Sender is not allowed")
        if not isinstance(update.get("update_id"), int):
            raise HTTPException(422, "Missing update ID")
        source_id = f"telegram:{update['update_id']}"
        existing = next((j for j in app.state.brain.store.jobs(settings.owner_id)
                         if j["source_id"] == source_id), None)
        if existing:
            return {"ok": True, "job_id": existing["id"]}
        text = message.get("text", message.get("caption", ""))[:60000]
        media = message.get("voice") or message.get("audio") or message.get("video") or message.get("document")
        mime = media.get("mime_type", "audio/ogg") if media else None
        if message.get("photo"):
            media, mime = message["photo"][-1], "image/jpeg"
        path = None
        if media:
            if mime not in MIMES:
                raise HTTPException(415, "Unsupported Telegram attachment")
            try:
                data = await app.state.telegram.download(media["file_id"], settings.max_upload_bytes)
                path = save_file(data)
            except ValueError:
                raise HTTPException(413, "Attachment cannot be accepted")
            except Exception:
                raise HTTPException(503, "Telegram download unavailable")
        elif not text.strip():
            return {"ok": True, "ignored": True}
        found = app.state.brain.store.enqueue(settings.owner_id, text, source_id, path, mime)
        if path and found["file_path"] != path:
            Path(path).unlink(missing_ok=True)
        return {"ok": True, "job_id": found["id"]}

    return app
