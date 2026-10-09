# Distributed Rate Limiting Infrastructure

A runnable FastAPI gateway sharing atomic token buckets in Redis. Multiple application workers consume the same bucket through one Lua operation using the Redis clock.

## Run with Docker

Use Docker Compose 2.24+ for optional environment-file support. Copy `.env.example` to `.env` to customize API keys and policies; the demo works with defaults when no file is present.

```bash
docker compose up --build
curl -H "X-API-Key: local-demo-key" http://localhost:8000/v1/resource
```

API docs: `http://localhost:8000/docs`. Prometheus: port `9090`. Grafana: port `3000`, username `admin`, local password `local-grafana-password`. The rate limiter dashboard is provisioned automatically.

The Compose configuration binds published ports to localhost. Before deploying, replace the demo API keys, metrics token, and Grafana password. When changing `METRICS_TOKEN`, also change the Prometheus authorization credential. API keys identify trusted callers; arbitrary client-supplied user IDs and forwarded IP headers never determine a bucket.

## Run and test without Docker

Python 3.11+ and a local Redis server are required to run the gateway.

```bash
python -m venv .venv
# Windows: .venv\Scripts\Activate.ps1 ; macOS/Linux: source .venv/bin/activate
pip install -e ".[dev]"
uvicorn limiter.app:create_app --factory
pytest -q
ruff check .
python scripts/load_test.py
```

Tests default to fakeredis with a real Lua interpreter. For the same concurrency/refill suite against a real Redis instance, set `TEST_REDIS_URL=redis://localhost:6379/15` (PowerShell: `$env:TEST_REDIS_URL = 'redis://localhost:6379/15'`). Test buckets use unique prefixes.

## Behavior and design

- The default bucket allows a burst of 20 requests and refills at 2 tokens/second.
- A denial returns HTTP 429, `Retry-After`, remaining tokens, and seconds until a full refill in `X-RateLimit-Reset`.
- Redis errors return 503. Liveness stays available; readiness reflects Redis availability.
- Idle buckets expire after a complete refill interval. Policies form part of the bucket identity.
- Lua execution is atomic on one Redis primary. This is not a cross-region consensus protocol; asynchronous Redis failover can lose recently written bucket state. Redis AOF improves durability but does not eliminate that tradeoff.
- Prometheus uses bounded outcome labels, never customer IDs or keys. The metrics route requires a bearer token.

## Source references

[Redis scripting](https://redis.io/docs/latest/develop/programmability/eval-intro/) and [Redis token bucket guide](https://redis.io/docs/latest/develop/use-cases/rate-limiter/rust/).

No throughput or production-uptime claim is made without an actual measured deployment.
