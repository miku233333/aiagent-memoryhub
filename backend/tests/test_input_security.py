import sqlite3

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from memory_hub.app import create_app
from memory_hub.models import (
    MAX_METADATA_BYTES,
    MAX_METADATA_KEYS,
    MAX_METADATA_KEY_LENGTH,
    MemoryProposal,
)

LOOPBACK_URL = "http://127.0.0.1"


def _fake_secret(prefix: str, body: str) -> str:
    """Build detector fixtures without embedding provider-shaped tokens in Git."""
    return prefix + body


def _proposal(secret: str) -> dict:
    return {
        "scope": {"user_id": "user-1", "project_id": "project-a"},
        "content": f"credential under test: {secret}",
        "explicit_user_fact": True,
    }


@pytest.mark.parametrize(
    "secret",
    [
        _fake_secret("gho_", "abcdefghijklmnopqrstuvwxyz123456"),
        _fake_secret("ghs_", "abcdefghijklmnopqrstuvwxyz123456"),
        _fake_secret("github_pat_", "abcdefghijklmnopqrstuvwxyz123456"),
        _fake_secret("xoxb-", "1234567890-abcdefghij"),
        "Bearer abcdefghijklmnop",
        "Bearer YWJjZGVmZ2hpamtsbW5vcA==",
        "refresh_token=abcdef",
        "client_secret=abcdef",
    ],
)
def test_claude_recognized_token_families_are_blocked_before_storage(tmp_path, secret):
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url=LOOPBACK_URL
    ) as client:
        response = client.post("/v1/memory/proposals", json=_proposal(secret))

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "secret_detected"
    assert secret not in response.text


def test_checkpoint_metadata_uses_the_same_secret_boundary(tmp_path):
    secret = _fake_secret("xoxp-", "1234567890-abcdefghij")
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url=LOOPBACK_URL
    ) as client:
        response = client.post(
            "/v1/checkpoints",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "summary": "safe summary",
                "source_platform": "codex",
                "metadata": {"diagnostic": secret},
            },
        )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "secret_detected"
    assert secret not in response.text


def test_legacy_secret_is_blocked_again_at_context_egress(tmp_path):
    database = tmp_path / "hub.sqlite3"
    legacy_secret = _fake_secret("ghu_", "abcdefghijklmnopqrstuvwxyz123456")
    with TestClient(create_app(database), base_url=LOOPBACK_URL) as client:
        stored = client.post(
            "/v1/memory/proposals",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "content": "safe historical memory",
                "explicit_user_fact": True,
            },
        ).json()["item"]
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE memories SET content = ? WHERE id = ?",
                (legacy_secret, stored["id"]),
            )
        response = client.post(
            "/v1/context-pack",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "source_platform": "codex",
            },
        )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "secret_detected"
    assert legacy_secret not in response.text


@pytest.mark.parametrize(
    "metadata",
    [
        {f"key-{index}": index for index in range(MAX_METADATA_KEYS + 1)},
        {"k" * (MAX_METADATA_KEY_LENGTH + 1): "value"},
        {"payload": "x" * MAX_METADATA_BYTES},
        {"nested": {"a": {"b": {"c": {"d": {"e": {"f": {"g": {"h": {"i": 1}}}}}}}}}},
    ],
)
def test_metadata_resource_bounds_reject_unreasonable_payloads(tmp_path, metadata):
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url=LOOPBACK_URL
    ) as client:
        proposal = client.post(
            "/v1/memory/proposals",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "content": "safe content",
                "metadata": metadata,
            },
        )
        checkpoint = client.post(
            "/v1/checkpoints",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "summary": "safe summary",
                "source_platform": "codex",
                "metadata": metadata,
            },
        )

    assert proposal.status_code == 422
    assert checkpoint.status_code == 422


def test_metadata_rejects_non_json_python_value_before_model_coercion():
    with pytest.raises(ValidationError, match="non-JSON"):
        MemoryProposal.model_validate(
            {
                "scope": {"user_id": "user-1"},
                "content": "safe content",
                "metadata": {"tuple": ("not", "a", "JSON", "array")},
            }
        )


def test_reasonable_nested_metadata_remains_compatible(tmp_path):
    metadata = {
        "hook": "SessionEnd",
        "attempt": 2,
        "flags": [True, False, None],
        "details": {"latency_ms": 12.5},
    }
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url=LOOPBACK_URL
    ) as client:
        response = client.post(
            "/v1/memory/proposals",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "content": "safe content",
                "metadata": metadata,
            },
        )

    assert response.status_code == 201
    assert response.json()["item"]["metadata"] == metadata
