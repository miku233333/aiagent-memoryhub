import importlib

from fastapi.testclient import TestClient

from memory_hub.app import create_app


def test_health_reports_ready(tmp_path):
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url="http://127.0.0.1"
    ) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "memory-hub",
        "schema_version": "v1",
    }


def test_mcp_placeholder_fails_closed_until_sdk_transport_is_added(tmp_path):
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url="http://127.0.0.1"
    ) as client:
        response = client.post("/mcp", json={"jsonrpc": "2.0"})

    assert response.status_code == 501
    assert response.json()["detail"]["code"] == "mcp_transport_not_installed"


def test_sidecar_runner_uses_in_process_app_and_loopback_default(monkeypatch):
    app_module = importlib.import_module("memory_hub.app")
    captured = {}

    def fake_run(application, **options):
        captured["application"] = application
        captured["options"] = options

    monkeypatch.delenv("MEMORY_HUB_HOST", raising=False)
    monkeypatch.delenv("MEMORY_HUB_PORT", raising=False)
    monkeypatch.setattr(app_module.app.state, "auth_enabled", True)
    monkeypatch.setattr("uvicorn.run", fake_run)

    app_module.run()

    assert captured["application"] is app_module.app
    assert captured["options"]["host"] == "127.0.0.1"
    assert captured["options"]["port"] == 8787
