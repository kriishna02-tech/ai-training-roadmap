import hashlib
from dataclasses import dataclass
from importlib.resources import files

from redis.asyncio import Redis


@dataclass(frozen=True)
class Decision:
    allowed: bool
    remaining: int
    retry_ms: int
    reset_ms: int


class TokenBucket:
    def __init__(self, redis: Redis, capacity: int, rate: float, prefix: str = "rate-limit"):
        if capacity < 1 or rate <= 0:
            raise ValueError("Capacity and refill rate must be positive")
        self.redis, self.capacity, self.rate, self.prefix = redis, capacity, rate, prefix
        self.script = redis.register_script(files("limiter").joinpath("token_bucket.lua").read_text())

    async def consume(self, subject: str, cost: int = 1) -> Decision:
        if not subject or cost < 1 or cost > self.capacity:
            raise ValueError("Subject is required; cost must be between 1 and capacity")
        # A configuration change starts a fresh bucket rather than mixing policies.
        identity = hashlib.sha256(f"{subject}:{self.capacity}:{self.rate}".encode()).hexdigest()
        result = await self.script(
            keys=[f"{self.prefix}:{{{identity}}}"], args=[self.capacity, self.rate, cost]
        )
        return Decision(bool(result[0]), int(result[1]), int(result[2]), int(result[3]))
