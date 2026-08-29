from __future__ import annotations

import json
import math
from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_METADATA_BYTES = 32 * 1024
MAX_METADATA_DEPTH = 8
MAX_METADATA_KEYS = 128
MAX_METADATA_KEY_LENGTH = 128
MAX_METADATA_LIST_ITEMS = 256
MAX_METADATA_STRING_LENGTH = 8_192


def _validate_metadata(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("metadata must be a JSON object")
    try:
        serialized = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (RecursionError, TypeError, ValueError) as error:
        raise ValueError("metadata must contain only finite JSON values") from error
    if len(serialized) > MAX_METADATA_BYTES:
        raise ValueError(f"metadata must not exceed {MAX_METADATA_BYTES} UTF-8 bytes")

    key_count = 0
    stack: list[tuple[Any, int]] = [(value, 0)]
    while stack:
        current, depth = stack.pop()
        if depth > MAX_METADATA_DEPTH:
            raise ValueError(f"metadata nesting must not exceed {MAX_METADATA_DEPTH}")
        if isinstance(current, dict):
            key_count += len(current)
            if key_count > MAX_METADATA_KEYS:
                raise ValueError(f"metadata must not exceed {MAX_METADATA_KEYS} keys")
            for key, item in current.items():
                if not isinstance(key, str):
                    raise ValueError("metadata keys must be strings")
                if len(key) > MAX_METADATA_KEY_LENGTH:
                    raise ValueError(
                        f"metadata keys must not exceed {MAX_METADATA_KEY_LENGTH} characters"
                    )
                stack.append((item, depth + 1))
            continue
        if isinstance(current, list):
            if len(current) > MAX_METADATA_LIST_ITEMS:
                raise ValueError(
                    f"metadata arrays must not exceed {MAX_METADATA_LIST_ITEMS} items"
                )
            stack.extend((item, depth + 1) for item in current)
            continue
        if current is None or isinstance(current, bool):
            continue
        if isinstance(current, int):
            continue
        if isinstance(current, float):
            if not math.isfinite(current):
                raise ValueError("metadata numbers must be finite")
            continue
        if isinstance(current, str):
            if len(current) > MAX_METADATA_STRING_LENGTH:
                raise ValueError(
                    "metadata string values must not exceed "
                    f"{MAX_METADATA_STRING_LENGTH} characters"
                )
            continue
        raise ValueError("metadata contains a non-JSON value")
    return value


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Scope(ApiModel):
    user_id: str = Field(min_length=1, max_length=200)
    project_id: str | None = Field(default=None, min_length=1, max_length=200)

    @field_validator("user_id", "project_id", mode="before")
    @classmethod
    def strip_identifiers(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None


class MemoryStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    FORGOTTEN = "forgotten"


class ProjectionTarget(StrEnum):
    CLAUDE_WEB = "claude_web"
    CLAUDE_CODE = "claude_code"


class MemoryProposal(ApiModel):
    scope: Scope
    content: str = Field(min_length=1, max_length=20_000)
    explicit_user_fact: bool = False
    source_platform: str = Field(default="unknown", min_length=1, max_length=100)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("content")
    @classmethod
    def require_nonblank_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("content must not be blank")
        return value

    @field_validator("source_platform", mode="before")
    @classmethod
    def strip_source_platform(cls, value: str) -> str:
        return value.strip()

    @field_validator("metadata", mode="before")
    @classmethod
    def bound_metadata(cls, value: Any) -> dict[str, Any]:
        return _validate_metadata(value)


class MemoryItem(ApiModel):
    id: str
    scope: Scope
    content: str
    canonical_digest: str
    status: MemoryStatus
    explicit_user_fact: bool
    source_platform: str
    metadata: dict[str, Any]
    created_at: datetime
    updated_at: datetime
    approved_at: datetime | None
    forgotten_at: datetime | None


class ItemResponse(ApiModel):
    schema_version: str = "v1"
    item: MemoryItem


class ScopeRequest(ApiModel):
    scope: Scope


class ItemsResponse(ApiModel):
    schema_version: str = "v1"
    items: list[MemoryItem]


class MemorySearchRequest(ApiModel):
    scope: Scope
    query: str = Field(min_length=1, max_length=1_000)
    limit: int = Field(default=20, ge=1, le=100)
    include_global: bool = True

    @field_validator("query", mode="before")
    @classmethod
    def strip_query(cls, value: str) -> str:
        return value.strip()


class ForgetRequest(ApiModel):
    scope: Scope
    reason: str = Field(default="user_requested", min_length=1, max_length=500)

    @field_validator("reason", mode="before")
    @classmethod
    def strip_reason(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("reason must not be blank")
        return value


class Tombstone(ApiModel):
    memory_id: str
    scope: Scope
    reason: str
    created_at: datetime


class TombstoneResponse(ApiModel):
    schema_version: str = "v1"
    tombstone: Tombstone


class SettingUpdate(ApiModel):
    cross_cultural_polish: bool


class CrossCulturalSetting(ApiModel):
    user_id: str
    target: ProjectionTarget
    cross_cultural_polish: bool = False
    label: str = "国际化表达润色"
    updated_at: datetime | None = None


class SettingResponse(ApiModel):
    schema_version: str = "v1"
    setting: CrossCulturalSetting


class ProjectionRequest(ApiModel):
    user_id: str = Field(min_length=1, max_length=200)
    target: ProjectionTarget
    content: str = Field(min_length=1, max_length=100_000)
    protected_terms: list[str] = Field(default_factory=list, max_length=200)

    @field_validator("user_id", mode="before")
    @classmethod
    def strip_user_id(cls, value: str) -> str:
        return value.strip()

    @field_validator("content")
    @classmethod
    def require_nonblank_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("content must not be blank")
        return value


class ProjectionResponse(ApiModel):
    schema_version: str = "v1"
    target: ProjectionTarget
    enabled: bool
    changed: bool
    canonical_content: str
    rendered_content: str
    canonical_digest: str
    rendered_digest: str
    applied_rules: list[str]


class ContextPackRequest(ApiModel):
    scope: Scope
    target: ProjectionTarget | None = None
    query: str | None = Field(default=None, max_length=1_000)
    limit: int = Field(default=20, ge=1, le=100)
    include_global: bool = True
    source_platform: str = Field(default="unknown", min_length=1, max_length=100)
    session_id: str | None = Field(default=None, min_length=1, max_length=500)

    @field_validator("query", mode="before")
    @classmethod
    def normalize_optional_query(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None

    @field_validator("source_platform", "session_id", mode="before")
    @classmethod
    def strip_context_identifiers(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None


class ContextPackItem(ApiModel):
    id: str
    scope: Scope
    canonical_content: str
    rendered_content: str
    canonical_digest: str
    rendered_digest: str
    changed: bool
    source_platform: str
    created_at: datetime


class ContextPackResponse(ApiModel):
    schema_version: str = "v1"
    scope: Scope
    target: ProjectionTarget | None
    items: list[ContextPackItem]
    rendered_content: str
    setting: CrossCulturalSetting | None
    delivery_state: Literal["prepared"] = "prepared"


class CheckpointRequest(ApiModel):
    scope: Scope
    summary: str = Field(min_length=1, max_length=50_000)
    source_platform: str = Field(min_length=1, max_length=100)
    session_id: str | None = Field(default=None, min_length=1, max_length=500)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("summary")
    @classmethod
    def require_nonblank_summary(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("summary must not be blank")
        return value

    @field_validator("source_platform", "session_id", mode="before")
    @classmethod
    def strip_checkpoint_identifiers(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None

    @field_validator("metadata", mode="before")
    @classmethod
    def bound_metadata(cls, value: Any) -> dict[str, Any]:
        return _validate_metadata(value)


class Checkpoint(ApiModel):
    id: str
    scope: Scope
    summary: str
    source_platform: str
    session_id: str | None
    metadata: dict[str, Any]
    created_at: datetime


class CheckpointResponse(ApiModel):
    schema_version: str = "v1"
    checkpoint: Checkpoint
