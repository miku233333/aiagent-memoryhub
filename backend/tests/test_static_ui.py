from fastapi.testclient import TestClient
import pytest

from memory_hub.app import create_app


def test_web_ui_is_disabled_when_environment_is_unset(tmp_path, monkeypatch):
    monkeypatch.delenv("MEMORY_HUB_WEB_DIR", raising=False)

    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url="http://127.0.0.1"
    ) as client:
        response = client.get("/")

    assert response.status_code == 404


def test_configured_web_dir_requires_a_regular_index_file(tmp_path, monkeypatch):
    web_dir = tmp_path / "dist"
    web_dir.mkdir()
    monkeypatch.setenv("MEMORY_HUB_WEB_DIR", str(web_dir))

    with pytest.raises(RuntimeError, match="index.html"):
        create_app(tmp_path / "hub.sqlite3")


def test_configured_web_dist_serves_index_at_root(tmp_path, monkeypatch):
    web_dir = tmp_path / "dist"
    web_dir.mkdir()
    (web_dir / "index.html").write_text(
        "<!doctype html><title>AI Agent MemoryHub desktop</title>",
        encoding="utf-8",
    )
    monkeypatch.setenv("MEMORY_HUB_WEB_DIR", str(web_dir))

    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url="http://127.0.0.1"
    ) as client:
        response = client.get("/")

    assert response.status_code == 200
    assert "AI Agent MemoryHub desktop" in response.text
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["referrer-policy"] == "no-referrer"


def test_web_dist_serves_assets_and_falls_back_for_spa_routes(tmp_path, monkeypatch):
    web_dir = tmp_path / "dist"
    assets = web_dir / "assets"
    assets.mkdir(parents=True)
    (web_dir / "index.html").write_text(
        "<!doctype html><main>desktop-shell</main>", encoding="utf-8"
    )
    (assets / "app.js").write_text(
        "globalThis.memoryHubDesktop = true;", encoding="utf-8"
    )
    monkeypatch.setenv("MEMORY_HUB_WEB_DIR", str(web_dir))

    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url="http://127.0.0.1"
    ) as client:
        asset = client.get("/assets/app.js")
        spa_route = client.get("/settings/profile")

    assert asset.status_code == 200
    assert asset.text == "globalThis.memoryHubDesktop = true;"
    assert "javascript" in asset.headers["content-type"]
    assert spa_route.status_code == 200
    assert "desktop-shell" in spa_route.text


def test_web_ui_never_falls_back_for_api_health_or_mcp_namespaces(
    tmp_path, monkeypatch
):
    web_dir = tmp_path / "dist"
    web_dir.mkdir()
    (web_dir / "index.html").write_text(
        "<!doctype html><main>must-not-mask-api-errors</main>", encoding="utf-8"
    )
    monkeypatch.setenv("MEMORY_HUB_WEB_DIR", str(web_dir))

    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url="http://127.0.0.1"
    ) as client:
        health = client.get("/health")
        mcp = client.post("/mcp", json={"jsonrpc": "2.0"})
        missing = [
            client.get("/v1/not-a-route"),
            client.get("/health/not-a-route"),
            client.get("/mcp/not-a-route"),
        ]

    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    assert mcp.status_code == 501
    assert mcp.json()["detail"]["code"] == "mcp_transport_not_installed"
    assert all(response.status_code == 404 for response in missing)
    assert all("must-not-mask-api-errors" not in response.text for response in missing)


def test_web_ui_rejects_traversal_instead_of_serving_or_falling_back(
    tmp_path, monkeypatch
):
    web_dir = tmp_path / "dist"
    web_dir.mkdir()
    (web_dir / "index.html").write_text(
        "<!doctype html><main>desktop-shell</main>", encoding="utf-8"
    )
    secret = tmp_path / "outside-secret.txt"
    secret.write_text("must-never-be-served", encoding="utf-8")
    monkeypatch.setenv("MEMORY_HUB_WEB_DIR", str(web_dir))

    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url="http://127.0.0.1"
    ) as client:
        dot_segments = client.get("/%2e%2e/outside-secret.txt")
        backslash = client.get("/%2e%2e%5Coutside-secret.txt")

    assert dot_segments.status_code == 404
    assert backslash.status_code == 404
    assert "must-never-be-served" not in dot_segments.text
    assert "must-never-be-served" not in backslash.text
    assert "desktop-shell" not in dot_segments.text
    assert "desktop-shell" not in backslash.text
