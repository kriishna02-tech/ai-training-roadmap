# Krishna Kumar — Resume Projects

Three independently runnable implementations of the projects listed in my SDE/AI resume. Each project includes source, setup instructions, and automated checks. Service credentials belong in local environment configuration and are excluded from Git.

| Project | What it does | Stack | Start here |
| --- | --- | --- | --- |
| AI Second Brain | Captures text/media, processes durable jobs, searches memories with citations, and reads live Notion context | Python, Gemini, Qdrant, SQLite, Telegram | [Project guide](ai-second-brain/README.md) |
| WashBook | Shows live laundry availability, reserves timed sessions, prevents conflicting claims, and manages maintenance/reports | React, TypeScript, Firebase Auth, Firestore, Cloud Functions | [Project guide](washbook/README.md) |
| Distributed Rate Limiting Infrastructure | Enforces shared token buckets with atomic Lua updates and provides operational metrics | Python, FastAPI, Redis, Docker, Prometheus, Grafana | [Project guide](distributed-rate-limiter/README.md) |

## Run locally

- **WashBook:** `cd washbook`, `npm ci`, `npm run dev`. The browser demo works immediately. The real backend runs in Firebase emulators; see its guide.
- **AI Second Brain:** `cd ai-second-brain`, `pip install -e ".[dev]"`, `uvicorn brain.app:create_app --factory --port 8001`. Enter `local-brain-key` in the dashboard. Offline demo is explicitly labelled lexical retrieval; Gemini mode requires your key.
- **Rate limiter:** `cd distributed-rate-limiter`, `docker compose up --build`. The API is at port 8000, Prometheus at 9090, and Grafana at 3000. The guide also supports a local Python + Redis setup.

Python projects require Python 3.11+. WashBook requires Node 24+ and Java 21+ for its emulators. Each project guide includes Windows PowerShell setup notes.

## Engineering evidence

Tests exercise concurrency and failure cases, including shared Redis buckets, exclusive ingestion claims, partial vector-index failure, stale Firestore clients, expiry/rebooking races, and access-control rules. The GitHub Actions workflow is configured to run both Python suites, real Redis integration, Firebase emulator tests, and the production React build. Python dependency versions are captured in each project's `uv.lock`; `uv sync --all-extras --frozen` reproduces them. WashBook uses `package-lock.json` with `npm ci`.

See [validation](docs/VALIDATION.md) for the actual checks performed and remaining live-service requirements.

## Interface previews

![WashBook desktop](docs/washbook-desktop.png)

![AI Second Brain](docs/second-brain.png)
