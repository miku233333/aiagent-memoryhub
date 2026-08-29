import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from memory_hub.app import _require_runtime_auth, create_app
from memory_hub.http_security import MAX_REQUEST_BODY_BYTES

LOOPBACK_URL = "http://127.0.0.1"
TEST_TOKEN = "desktop-generated-token-with-sufficient-entropy"


def test_v1_bearer_auth_is_enabled_from_environment_without_locking_health_or_ui(
    tmp_path, monkeypatch
):
    web_dir = tmp_path / "dist"
    web_dir.mkdir()
    (web_dir / "index.html").write_text("<main>MemoryHub</main>", encoding="utf-8")
    monkeypatch.setenv("MEMORY_HUB_WEB_DIR", str(web_dir))
    monkeypatch.setenv("MEMORY_HUB_TOKEN", TEST_TOKEN)

    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url=LOOPBACK_URL
    ) as client:
        missing = client.get("/v1/settings/user-1/claude_code")
        wrong = client.get(
            "/v1/settings/user-1/claude_code",
            headers={"Authorization": "Bearer definitely-the-wrong-token"},
        )
        accepted = client.get(
            "/v1/settings/user-1/claude_code",
            headers={"Authorization": f"Bearer {TEST_TOKEN}"},
        )
        health = client.get("/health")
        static_ui = client.get("/")

    assert missing.status_code == 401
    assert missing.headers["www-authenticate"] == "Bearer"
    assert wrong.status_code == 401
    assert accepted.status_code == 200
    assert health.status_code == 200
    assert static_ui.status_code == 200


def test_unset_token_preserves_loopback_development_api(tmp_path):
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url=LOOPBACK_URL
    ) as client:
        response = client.get("/v1/settings/user-1/claude_code")

    assert response.status_code == 200


def test_service_entrypoint_refuses_to_run_without_authentication(tmp_path):
    application = create_app(tmp_path / "hub.sqlite3", token=None)

    with pytest.raises(RuntimeError, match="MEMORY_HUB_TOKEN is required"):
        _require_runtime_auth(application)


def test_host_and_browser_origin_must_be_exact_loopback(tmp_path):
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url=LOOPBACK_URL
    ) as client:
        hostile_host = client.get(
            "/v1/settings/user-1/claude_code",
            headers={"Host": "attacker.example:8787"},
        )
        malformed_loopback_host = client.get(
            "/v1/settings/user-1/claude_code",
            headers={"Host": "127.0.0.1:attacker.example"},
        )
        hostile_origin = client.get(
            "/v1/settings/user-1/claude_code",
            headers={"Origin": "https://attacker.example"},
        )
        null_origin = client.get(
            "/v1/settings/user-1/claude_code", headers={"Origin": "null"}
        )
        malformed_loopback_origin = client.get(
            "/v1/settings/user-1/claude_code",
            headers={"Origin": "http://127.0.0.1:"},
        )
        loopback_origin = client.get(
            "/v1/settings/user-1/claude_code",
            headers={"Origin": "http://localhost:8787"},
        )

    assert hostile_host.status_code == 400
    assert malformed_loopback_host.status_code == 400
    assert hostile_origin.status_code == 403
    assert null_origin.status_code == 403
    assert malformed_loopback_origin.status_code == 403
    assert loopback_origin.status_code == 200


@pytest.mark.parametrize("configured", ["", " surrounded ", "line\nbreak"])
def test_invalid_configured_token_fails_closed(tmp_path, monkeypatch, configured):
    monkeypatch.setenv("MEMORY_HUB_TOKEN", configured)
    with pytest.raises(RuntimeError, match="MEMORY_HUB_TOKEN"):
        create_app(tmp_path / "hub.sqlite3")


def test_declared_oversized_request_is_rejected_before_json_parsing(tmp_path):
    oversized = b"{" + (b"x" * MAX_REQUEST_BODY_BYTES) + b"}"
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url=LOOPBACK_URL
    ) as client:
        response = client.post(
            "/v1/memory/proposals",
            content=oversized,
            headers={"Content-Type": "application/json"},
        )

    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "request_body_too_large"


def test_streamed_request_cannot_bypass_body_limit(tmp_path):
    application = create_app(tmp_path / "hub.sqlite3", token=None)
    chunks = iter(
        [
            {
                "type": "http.request",
                "body": b"x" * (MAX_REQUEST_BODY_BYTES // 2 + 1),
                "more_body": True,
            },
            {
                "type": "http.request",
                "body": b"y" * (MAX_REQUEST_BODY_BYTES // 2 + 1),
                "more_body": False,
            },
        ]
    )
    sent = []

    async def receive():
        return next(chunks)

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/v1/memory/proposals",
        "raw_path": b"/v1/memory/proposals",
        "query_string": b"",
        "root_path": "",
        "server": ("127.0.0.1", 8787),
        "client": ("127.0.0.1", 12345),
        "headers": [(b"host", b"127.0.0.1:8787")],
    }

    asyncio.run(application(scope, receive, send))

    start = next(
        message for message in sent if message["type"] == "http.response.start"
    )
    body = b"".join(
        message.get("body", b"")
        for message in sent
        if message["type"] == "http.response.body"
    )
    assert start["status"] == 413
    assert json.loads(body)["detail"]["code"] == "request_body_too_large"
