from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    redis_url: str = "redis://localhost:6379/0"
    capacity: int = Field(default=20, ge=1, le=100000)
    refill_per_second: float = Field(default=2, gt=0, le=100000)
    api_keys: dict[str, str] = {"local-demo-key": "demo"}
    metrics_token: SecretStr = SecretStr("local-metrics-token")
    key_prefix: str = "rate-limit"
    redis_timeout_seconds: float = Field(default=1, gt=0, le=30)
