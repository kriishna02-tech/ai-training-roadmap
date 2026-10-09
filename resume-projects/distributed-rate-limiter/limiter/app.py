import math
import secrets
from contextlib import asynccontextmanager
from time import perf_counter

from fastapi import Depends, FastAPI, Header, HTTPException, Response
from prometheus_client import CollectorRegistry, Counter, Histogram, generate_latest
from redis.asyncio import Redis
from redis.exceptions import RedisError

from limiter.bucket import TokenBucket
from limiter.settings import Settings


def create_app(settings: Settings | None = None, redis_client: Redis | None = None) -> FastAPI:
    settings = settings or Settings()
    registry = CollectorRegistry()
    decisions = Counter("rate_limit_decisions", "Gateway decisions", ["outcome"], registry=registry)
    latency = Histogram("rate_limit_redis_seconds", "Atomic bucket latency", registry=registry)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.redis = redis_client or Redis.from_url(
            settings.redis_url,
            socket_connect_timeout=settings.redis_timeout_seconds,
            socket_timeout=settings.redis_timeout_seconds,
        )
        app.state.bucket = TokenBucket(
            app.state.redis, settings.capacity, settings.refill_per_second, settings.key_prefix
        )
        yield
        if redis_client is None:
            await app.state.redis.aclose()

    app = FastAPI(title="Distributed Rate Limiter", version="1.0.0", lifespan=lifespan)

    async def authenticate(x_api_key: str = Header(default="")) -> str:
        for key, subject in settings.api_keys.items():
            if secrets.compare_digest(x_api_key.encode(), key.encode()):
                return subject
        raise HTTPException(401, "A valid X-API-Key is required")

    async def limited(response: Response, subject: str = Depends(authenticate)) -> str:
        started = perf_counter()
        try:
            decision = await app.state.bucket.consume(subject)
        except RedisError:
            decisions.labels("unavailable").inc()
            # Losing Redis must not silently remove enforcement.
            raise HTTPException(503, "Rate limiter unavailable", headers={"Retry-After": "1"})
        finally:
            latency.observe(perf_counter() - started)
        headers = {
            "X-RateLimit-Limit": str(settings.capacity),
            "X-RateLimit-Remaining": str(decision.remaining),
            "X-RateLimit-Reset": str(math.ceil(decision.reset_ms / 1000)),
        }
        decisions.labels("allowed" if decision.allowed else "denied").inc()
        if not decision.allowed:
            headers["Retry-After"] = str(max(1, math.ceil(decision.retry_ms / 1000)))
            raise HTTPException(429, "Token bucket exhausted", headers=headers)
        response.headers.update(headers)
        return subject

    @app.get("/v1/resource", tags=["Gateway"])
    async def resource(subject: str = Depends(limited)):
        return {"message": "Request admitted", "subject": subject}

    @app.get("/health/live", tags=["Operations"])
    async def live():
        return {"status": "alive"}

    @app.get("/health/ready", tags=["Operations"])
    async def ready():
        try:
            await app.state.redis.ping()
        except RedisError:
            raise HTTPException(503, "Redis unavailable")
        return {"status": "ready"}

    @app.get("/metrics", include_in_schema=False)
    async def metrics(authorization: str = Header(default="")):
        expected = f"Bearer {settings.metrics_token.get_secret_value()}"
        if not secrets.compare_digest(authorization.encode(), expected.encode()):
            raise HTTPException(401, "Metrics token required")
        return Response(generate_latest(registry), media_type="text/plain; version=0.0.4")

    return app
