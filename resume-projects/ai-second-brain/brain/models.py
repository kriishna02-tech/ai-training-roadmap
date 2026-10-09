from typing import Literal

from pydantic import BaseModel, Field


class Memory(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=8000)
    kind: Literal["note", "task", "reference", "event"] = "note"
    tags: list[str] = Field(default_factory=list, max_length=12)


class Extraction(BaseModel):
    transcript: str = Field(default="", max_length=60000)
    summary: str = Field(min_length=1, max_length=4000)
    memories: list[Memory] = Field(min_length=1, max_length=12)


class TextInput(BaseModel):
    text: str = Field(min_length=1, max_length=60000)
    source_id: str | None = Field(default=None, max_length=200)


class QueryInput(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    limit: int = Field(default=5, ge=1, le=10)


class Answer(BaseModel):
    answer: str
    citation_ids: list[str] = Field(default_factory=list)
