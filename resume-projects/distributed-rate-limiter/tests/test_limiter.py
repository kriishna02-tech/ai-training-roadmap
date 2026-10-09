import asyncio
import os
import uuid

import fakeredis.aioredis
import pytest
from fastapi.testclient import TestClient
from redis.asyncio import Redis
from redis.exceptions import ConnectionError

from limiter.app import create_app
from limiter.bucket import TokenBucket
from limiter.settings import Settings


@pytest.fixture
async def redis_client():
    client = (
        Redis.from_url(os.environ["TEST_REDIS_URL"])
        if os.environ.get("TEST_REDIS_URL")
        else fakeredis.aioredis.FakeRedis()
    )
    yield client
    await client.aclose()


async def test_atomic_across_many_workers(redis_client):
    prefix = f"test:{uuid.uuid4()}"
    workers = [TokenBucket(redis_client, 10, 0.001, prefix) for _ in range(8)]
    results = await asyncio.gather(
        *(workers[i % 8].consume("shared-customer") for i in range(200))
    )
    assert sum(d.allowed for d in results) == 10
    assert all(d.remaining >= 0 for d in results)
    assert all(d.retry_ms > 0 for d in results if not d.allowed)


async def test_subjects_are_isolated_and_ttl_exists(redis_client):
    prefix = f"test:{uuid.uuid4()}"
    bucket = TokenBucket(redis_client, 2, 1, prefix)
    assert (await bucket.consume("alice", 2)).allowed
    assert not (await bucket.consume("alice")).allowed
    assert (await bucket.consume("bob", 2)).allowed
    keys = [key async for key in redis_client.scan_iter(f"{prefix}:*")]
    assert len(keys) == 2
    assert all([await redis_client.pttl(key) > 0 for key in keys])


async def test_refill_and_script_cache_recovery(redis_client):
    bucket = TokenBucket(redis_client, 1, 20, f"test:{uuid.uuid4()}")
    assert (await bucket.consume("user")).allowed
    assert not (await bucket.consume("user")).allowed
    await redis_client.script_flush()
    await asyncio.sleep(0.07)
    assert (await bucket.consume("user")).allowed


async def test_invalid_cost(redis_client):
    bucket = TokenBucket(redis_client, 2, 1)
    for cost in [0, -1, 3]:
        with pytest.raises(ValueError):
            await bucket.consume("user", cost)


def test_http_auth_throttle_and_metrics():
    redis = fakeredis.aioredis.FakeRedis()
    config = Settings(capacity=2, refill_per_second=0.001)
    with TestClient(create_app(config, redis)) as client:
        assert client.get("/health/ready").status_code == 200
        assert client.get("/v1/resource").status_code == 401
        headers = {"X-API-Key": "local-demo-key"}
        assert client.get("/v1/resource", headers=headers).headers["X-RateLimit-Remaining"] == "1"
        assert client.get("/v1/resource", headers=headers).status_code == 200
        denied = client.get("/v1/resource", headers=headers)
        assert denied.status_code == 429
        assert int(denied.headers["Retry-After"]) > 0
        assert client.get("/metrics").status_code == 401
        metrics = client.get("/metrics", headers={"Authorization": "Bearer local-metrics-token"})
        assert 'rate_limit_decisions_total{outcome="denied"} 1.0' in metrics.text


def test_redis_outage_fails_closed():
    class UnavailableRedis:
        def register_script(self, _):
            async def unavailable(**kwargs):
                raise ConnectionError("offline")
            return unavailable

        async def ping(self):
            raise ConnectionError("offline")

    with TestClient(create_app(Settings(), UnavailableRedis())) as client:
        assert client.get("/health/live").status_code == 200
        assert client.get("/health/ready").status_code == 503
        assert client.get("/v1/resource", headers={"X-API-Key": "local-demo-key"}).status_code == 503
