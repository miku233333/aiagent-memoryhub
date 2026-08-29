from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from .models import (
    Checkpoint,
    CheckpointRequest,
    CrossCulturalSetting,
    MemoryItem,
    MemoryProposal,
    MemoryStatus,
    ProjectionTarget,
    Scope,
    Tombstone,
)


def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class IdempotencyConflictError(Exception):
    pass


class ForgottenMemoryError(Exception):
    pass


class Storage:
    def __init__(self, database_path: str | Path):
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _initialize(self) -> None:
        with self.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS memories (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    project_id TEXT,
                    content TEXT NOT NULL,
                    canonical_digest TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'forgotten')),
                    explicit_user_fact INTEGER NOT NULL CHECK (explicit_user_fact IN (0, 1)),
                    source_platform TEXT NOT NULL,
                    metadata_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    approved_at TEXT,
                    forgotten_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_memories_scope_status
                    ON memories(user_id, project_id, status, created_at);
                CREATE TABLE IF NOT EXISTS idempotency_keys (
                    operation TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    idempotency_key TEXT NOT NULL,
                    request_hash TEXT NOT NULL,
                    resource_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (operation, user_id, idempotency_key)
                );
                CREATE TABLE IF NOT EXISTS tombstones (
                    memory_id TEXT PRIMARY KEY REFERENCES memories(id),
                    user_id TEXT NOT NULL,
                    project_id TEXT,
                    reason TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS settings (
                    user_id TEXT NOT NULL,
                    target TEXT NOT NULL CHECK (target IN ('claude_web', 'claude_code')),
                    cross_cultural_polish INTEGER NOT NULL
                        CHECK (cross_cultural_polish IN (0, 1)),
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (user_id, target)
                );
                CREATE TABLE IF NOT EXISTS checkpoints (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    project_id TEXT,
                    summary TEXT NOT NULL,
                    source_platform TEXT NOT NULL,
                    session_id TEXT,
                    metadata_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_checkpoints_scope_created
                    ON checkpoints(user_id, project_id, created_at);
                """
            )
            columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(memories)").fetchall()
            }
            if "canonical_digest" not in columns:
                connection.execute(
                    "ALTER TABLE memories ADD COLUMN canonical_digest TEXT"
                )
                rows = connection.execute("SELECT id, content FROM memories").fetchall()
                for row in rows:
                    connection.execute(
                        "UPDATE memories SET canonical_digest = ? WHERE id = ?",
                        (
                            hashlib.sha256(row["content"].encode("utf-8")).hexdigest(),
                            row["id"],
                        ),
                    )

    def propose(
        self, proposal: MemoryProposal, idempotency_key: str | None = None
    ) -> MemoryItem:
        timestamp = utc_now()
        status = (
            MemoryStatus.APPROVED
            if proposal.explicit_user_fact
            else MemoryStatus.PENDING
        )
        memory_id = str(uuid4())
        approved_at = timestamp if status is MemoryStatus.APPROVED else None
        request_hash = hashlib.sha256(
            json.dumps(
                proposal.model_dump(mode="json"),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        canonical_digest = hashlib.sha256(proposal.content.encode("utf-8")).hexdigest()
        with self.connect() as connection:
            if idempotency_key is not None:
                connection.execute("BEGIN IMMEDIATE")
                replay = connection.execute(
                    """
                    SELECT request_hash, resource_id FROM idempotency_keys
                    WHERE operation = 'memory_proposal'
                      AND user_id = ? AND idempotency_key = ?
                    """,
                    (proposal.scope.user_id, idempotency_key),
                ).fetchone()
                if replay is not None:
                    if replay["request_hash"] != request_hash:
                        raise IdempotencyConflictError
                    row = connection.execute(
                        "SELECT * FROM memories WHERE id = ?",
                        (replay["resource_id"],),
                    ).fetchone()
                    return self._memory_from_row(row)
            connection.execute(
                """
                INSERT INTO memories (
                    id, user_id, project_id, content, canonical_digest, status,
                    explicit_user_fact, source_platform, metadata_json,
                    created_at, updated_at, approved_at, forgotten_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                """,
                (
                    memory_id,
                    proposal.scope.user_id,
                    proposal.scope.project_id,
                    proposal.content,
                    canonical_digest,
                    status.value,
                    int(proposal.explicit_user_fact),
                    proposal.source_platform,
                    json.dumps(proposal.metadata, ensure_ascii=False, sort_keys=True),
                    timestamp,
                    timestamp,
                    approved_at,
                ),
            )
            if idempotency_key is not None:
                connection.execute(
                    """
                    INSERT INTO idempotency_keys (
                        operation, user_id, idempotency_key,
                        request_hash, resource_id, created_at
                    ) VALUES ('memory_proposal', ?, ?, ?, ?, ?)
                    """,
                    (
                        proposal.scope.user_id,
                        idempotency_key,
                        request_hash,
                        memory_id,
                        timestamp,
                    ),
                )
            row = connection.execute(
                "SELECT * FROM memories WHERE id = ?", (memory_id,)
            ).fetchone()
        return self._memory_from_row(row)

    def approve(self, memory_id: str, scope: Scope) -> MemoryItem | None:
        timestamp = utc_now()
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT * FROM memories
                WHERE id = ? AND user_id = ? AND project_id IS ?
                """,
                (memory_id, scope.user_id, scope.project_id),
            ).fetchone()
            if row is None:
                return None
            if row["status"] == MemoryStatus.FORGOTTEN.value:
                raise ForgottenMemoryError
            if row["status"] == MemoryStatus.PENDING.value:
                connection.execute(
                    """
                    UPDATE memories
                    SET status = 'approved', approved_at = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (timestamp, timestamp, memory_id),
                )
                row = connection.execute(
                    "SELECT * FROM memories WHERE id = ?", (memory_id,)
                ).fetchone()
        return self._memory_from_row(row)

    def list_by_status(
        self,
        scope: Scope,
        status: MemoryStatus,
        *,
        limit: int = 100,
    ) -> list[MemoryItem]:
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT * FROM memories
                WHERE user_id = ? AND project_id IS ? AND status = ?
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """,
                (scope.user_id, scope.project_id, status.value, limit),
            ).fetchall()
        return [self._memory_from_row(row) for row in rows]

    def list_approved(
        self, scope: Scope, *, include_global: bool = True
    ) -> list[MemoryItem]:
        parameters: list[Any] = [scope.user_id]
        if scope.project_id is None:
            scope_clause = "project_id IS NULL"
        elif include_global:
            scope_clause = "(project_id = ? OR project_id IS NULL)"
            parameters.append(scope.project_id)
        else:
            scope_clause = "project_id = ?"
            parameters.append(scope.project_id)
        with self.connect() as connection:
            rows = connection.execute(
                f"""
                SELECT * FROM memories
                WHERE user_id = ? AND {scope_clause} AND status = 'approved'
                ORDER BY created_at DESC, id DESC
                """,
                parameters,
            ).fetchall()
        return [self._memory_from_row(row) for row in rows]

    def search_approved(
        self,
        scope: Scope,
        query: str,
        *,
        limit: int = 20,
        include_global: bool = True,
    ) -> list[MemoryItem]:
        parameters: list[Any] = [scope.user_id]
        if scope.project_id is None:
            scope_clause = "project_id IS NULL"
        elif include_global:
            scope_clause = "(project_id = ? OR project_id IS NULL)"
            parameters.append(scope.project_id)
        else:
            scope_clause = "project_id = ?"
            parameters.append(scope.project_id)
        escaped_query = (
            query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        )
        parameters.extend((f"%{escaped_query}%", limit))
        with self.connect() as connection:
            rows = connection.execute(
                f"""
                SELECT * FROM memories
                WHERE user_id = ? AND {scope_clause} AND status = 'approved'
                  AND LOWER(content) LIKE LOWER(?) ESCAPE '\\'
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """,
                parameters,
            ).fetchall()
        return [self._memory_from_row(row) for row in rows]

    def forget(self, memory_id: str, scope: Scope, reason: str) -> Tombstone | None:
        timestamp = utc_now()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            memory = connection.execute(
                """
                SELECT * FROM memories
                WHERE id = ? AND user_id = ? AND project_id IS ?
                """,
                (memory_id, scope.user_id, scope.project_id),
            ).fetchone()
            if memory is None:
                return None
            existing = connection.execute(
                "SELECT * FROM tombstones WHERE memory_id = ?", (memory_id,)
            ).fetchone()
            if existing is not None:
                return self._tombstone_from_row(existing)
            connection.execute(
                """
                UPDATE memories
                SET status = 'forgotten', forgotten_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (timestamp, timestamp, memory_id),
            )
            connection.execute(
                """
                INSERT INTO tombstones (
                    memory_id, user_id, project_id, reason, created_at
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (memory_id, scope.user_id, scope.project_id, reason, timestamp),
            )
            row = connection.execute(
                "SELECT * FROM tombstones WHERE memory_id = ?", (memory_id,)
            ).fetchone()
        return self._tombstone_from_row(row)

    def get_setting(
        self, user_id: str, target: ProjectionTarget
    ) -> CrossCulturalSetting:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT * FROM settings WHERE user_id = ? AND target = ?
                """,
                (user_id, target.value),
            ).fetchone()
        if row is None:
            return CrossCulturalSetting(user_id=user_id, target=target)
        return self._setting_from_row(row)

    def put_setting(
        self,
        user_id: str,
        target: ProjectionTarget,
        cross_cultural_polish: bool,
    ) -> CrossCulturalSetting:
        timestamp = utc_now()
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO settings (
                    user_id, target, cross_cultural_polish, updated_at
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id, target) DO UPDATE SET
                    cross_cultural_polish = excluded.cross_cultural_polish,
                    updated_at = excluded.updated_at
                """,
                (user_id, target.value, int(cross_cultural_polish), timestamp),
            )
            row = connection.execute(
                """
                SELECT * FROM settings WHERE user_id = ? AND target = ?
                """,
                (user_id, target.value),
            ).fetchone()
        return self._setting_from_row(row)

    def create_checkpoint(
        self,
        request: CheckpointRequest,
        idempotency_key: str | None = None,
    ) -> Checkpoint:
        timestamp = utc_now()
        checkpoint_id = str(uuid4())
        request_hash = hashlib.sha256(
            json.dumps(
                request.model_dump(mode="json"),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        with self.connect() as connection:
            if idempotency_key is not None:
                connection.execute("BEGIN IMMEDIATE")
                replay = connection.execute(
                    """
                    SELECT request_hash, resource_id FROM idempotency_keys
                    WHERE operation = 'checkpoint'
                      AND user_id = ? AND idempotency_key = ?
                    """,
                    (request.scope.user_id, idempotency_key),
                ).fetchone()
                if replay is not None:
                    if replay["request_hash"] != request_hash:
                        raise IdempotencyConflictError
                    row = connection.execute(
                        "SELECT * FROM checkpoints WHERE id = ?",
                        (replay["resource_id"],),
                    ).fetchone()
                    return self._checkpoint_from_row(row)
            connection.execute(
                """
                INSERT INTO checkpoints (
                    id, user_id, project_id, summary, source_platform,
                    session_id, metadata_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    checkpoint_id,
                    request.scope.user_id,
                    request.scope.project_id,
                    request.summary,
                    request.source_platform,
                    request.session_id,
                    json.dumps(request.metadata, ensure_ascii=False, sort_keys=True),
                    timestamp,
                ),
            )
            if idempotency_key is not None:
                connection.execute(
                    """
                    INSERT INTO idempotency_keys (
                        operation, user_id, idempotency_key,
                        request_hash, resource_id, created_at
                    ) VALUES ('checkpoint', ?, ?, ?, ?, ?)
                    """,
                    (
                        request.scope.user_id,
                        idempotency_key,
                        request_hash,
                        checkpoint_id,
                        timestamp,
                    ),
                )
            row = connection.execute(
                "SELECT * FROM checkpoints WHERE id = ?", (checkpoint_id,)
            ).fetchone()
        return self._checkpoint_from_row(row)

    @staticmethod
    def _memory_from_row(row: sqlite3.Row) -> MemoryItem:
        return MemoryItem(
            id=row["id"],
            scope=Scope(user_id=row["user_id"], project_id=row["project_id"]),
            content=row["content"],
            canonical_digest=row["canonical_digest"],
            status=MemoryStatus(row["status"]),
            explicit_user_fact=bool(row["explicit_user_fact"]),
            source_platform=row["source_platform"],
            metadata=json.loads(row["metadata_json"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            approved_at=row["approved_at"],
            forgotten_at=row["forgotten_at"],
        )

    @staticmethod
    def _tombstone_from_row(row: sqlite3.Row) -> Tombstone:
        return Tombstone(
            memory_id=row["memory_id"],
            scope=Scope(user_id=row["user_id"], project_id=row["project_id"]),
            reason=row["reason"],
            created_at=row["created_at"],
        )

    @staticmethod
    def _setting_from_row(row: sqlite3.Row) -> CrossCulturalSetting:
        return CrossCulturalSetting(
            user_id=row["user_id"],
            target=ProjectionTarget(row["target"]),
            cross_cultural_polish=bool(row["cross_cultural_polish"]),
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _checkpoint_from_row(row: sqlite3.Row) -> Checkpoint:
        return Checkpoint(
            id=row["id"],
            scope=Scope(user_id=row["user_id"], project_id=row["project_id"]),
            summary=row["summary"],
            source_platform=row["source_platform"],
            session_id=row["session_id"],
            metadata=json.loads(row["metadata_json"]),
            created_at=row["created_at"],
        )
