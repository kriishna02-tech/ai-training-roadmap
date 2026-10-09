# AI Second Brain

A personal memory system with Telegram capture, durable SQLite ingestion, Gemini understanding of text/images/audio/video, batch embedding, Qdrant retrieval, and live read-only Notion context. Includes an access-key protected API and a small capture/search dashboard.

## Quick start: no service credentials

```bash
python -m venv .venv
# Windows: .venv\Scripts\Activate.ps1 ; macOS/Linux: source .venv/bin/activate
pip install -e ".[dev]"
# Windows: Copy-Item .env.example .env ; macOS/Linux: cp .env.example .env
uvicorn brain.app:create_app --factory --port 8001
```

Open `http://localhost:8001`, enter `local-brain-key`, and save a note. The background worker processes pending notes; refresh memories and ask a related question. API documentation is at `/docs`.

**Offline demo is explicitly lexical retrieval using hashed word counts.** It never calls Gemini, does not pretend to transcribe media, and labels its answers as a demo. Real multimodal/semantic processing requires Gemini mode.

## Configure Gemini, Telegram, and Notion

1. Set `DEMO_MODE=false`, your `GEMINI_API_KEY`, and an available `GEMINI_MODEL` in `.env`. The default follows the current Gemini Interactions API documentation. Models are configurable because availability changes.
2. For Telegram, create a bot through BotFather. Set its token, a random webhook secret, and `TELEGRAM_ALLOWED_USER_IDS=[your_numeric_id]`. An empty allowlist disables Telegram. Expose the app through HTTPS and register `/telegram/webhook` through Telegram's `setWebhook` API with the matching `secret_token`. No webhook is registered automatically.
3. Set `NOTION_TOKEN` and share the pages you want with that integration. Retrieval searches titles and includes up to five matching pages' first 50 top-level blocks; it is not full-workspace body search or a recursive Notion index.
4. Replace `API_KEY` before exposing the app. This is a single-owner service. All explicitly allowlisted Telegram users share that owner's memory; use separate deployments for separate people.
5. Run `docker compose up --build` for the API and Qdrant, or leave `QDRANT_URL` empty for persistent embedded local Qdrant. For cloud Qdrant, set its URL and key.

The app accepts up to 10 MiB per file (smaller than the inline Gemini request limit after base64 expansion). Supported formats are listed in `brain/app.py`. Telegram messages are captured into the queue; query your memories through the dashboard or API.

## API examples

```bash
curl -X POST http://localhost:8001/v1/ingest/text \
  -H "X-API-Key: local-brain-key" -H "Content-Type: application/json" \
  -d '{"text":"The robotics project deadline is Friday","source_id":"note-1"}'

curl -X POST http://localhost:8001/v1/ask \
  -H "X-API-Key: local-brain-key" -H "Content-Type: application/json" \
  -d '{"question":"robotics deadline"}'
```

`GET /v1/jobs` exposes status, attempt count, and safe error classes. `GET /v1/memories` lists processed memories. `source_id` is an idempotency key per owner; retries with the same key return the original job.

## Reliability and retrieval

- SQLite WAL stores original captures, jobs, extracted text, summaries, and authoritative memory contents.
- `BEGIN IMMEDIATE` makes batch claims exclusive. Leases recover abandoned jobs and fence stale completion writes. Jobs retry with bounded exponential delay and then become failed.
- Each batch processes up to four captures concurrently. Each capture's memories use one Gemini batch-embedding request. This is bounded application batching, not the separate offline Gemini Batch API.
- Stable UUIDs make Qdrant retries idempotent. A partial index failure cannot expose a memory before SQLite marks the job ready. The queue provides at-least-once processing, not a distributed transaction across SQLite and Qdrant; a lease race may temporarily affect embedding freshness.
- Qdrant filters every retrieval by owner. Memory text comes from SQLite rather than unchecked vector payloads.
- Answers return their source records and citation IDs. Unknown or missing citations are rejected. Citation validation verifies IDs, not semantic truth; review the attached sources for important conclusions.
- Provider error messages are reduced to exception classes so token-bearing Telegram URLs are never stored in job errors.
- A configured Notion outage produces a visible warning and still permits local retrieval.
- Keep a single application process with local embedded Qdrant. Use hosted/server Qdrant for multiple workers. Back up the data volume; captured source files are retained until you remove them.

## Tests

```bash
pytest -q
ruff check .
```

The suite exercises real embedded Qdrant and SQLite: persistence, owner isolation, duplicate updates, concurrent queue claims, lease recovery, partial-index retry, invalid citations, API authentication, file size limits, and Telegram authorization. Gemini request structure is tested against an HTTP mock; live Gemini/Telegram/Notion are not verified without credentials.

References: [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output), [multimodal input](https://ai.google.dev/gemini-api/docs/video-understanding), [Qdrant Python client](https://github.com/qdrant/qdrant-client), [Telegram Bot API](https://core.telegram.org/bots/api), [Notion search](https://developers.notion.com/reference/post-search).
