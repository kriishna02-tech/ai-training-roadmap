from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    data_dir: Path = Path("data")
    owner_id: str = "local-owner"
    api_key: SecretStr = SecretStr("local-brain-key")
    demo_mode: bool = True
    gemini_api_key: SecretStr = SecretStr("")
    gemini_model: str = "gemini-3.8-flash"
    embedding_model: str = "gemini-embedding-001"
    qdrant_url: str = ""
    qdrant_api_key: SecretStr = SecretStr("")
    telegram_bot_token: SecretStr = SecretStr("")
    telegram_webhook_secret: SecretStr = SecretStr("")
    telegram_allowed_user_ids: list[int] = []
    notion_token: SecretStr = SecretStr("")
    notion_version: str = "2025-09-03"
    worker_enabled: bool = True
    batch_size: int = Field(default=4, ge=1, le=8)
    lease_seconds: int = Field(default=300, ge=30)
    max_attempts: int = Field(default=3, ge=1, le=10)
    max_upload_bytes: int = Field(default=10 * 1024 * 1024, ge=1, le=10 * 1024 * 1024)

    def validate_services(self):
        if not self.demo_mode and not self.gemini_api_key.get_secret_value():
            raise ValueError("Set GEMINI_API_KEY or enable DEMO_MODE explicitly")
        if self.telegram_bot_token.get_secret_value() and (
            not self.telegram_webhook_secret.get_secret_value() or not self.telegram_allowed_user_ids
        ):
            raise ValueError("Telegram requires a webhook secret and an allowed-user list")
