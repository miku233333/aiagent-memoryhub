from fastapi.testclient import TestClient

from memory_hub.app import create_app


def test_checkpoint_retry_is_idempotent_across_app_restart(tmp_path):
    database = tmp_path / "hub.sqlite3"
    request = {
        "scope": {"user_id": "user-1", "project_id": "project-a"},
        "summary": "Implemented the first vertical slice.",
        "source_platform": "claude_code",
        "session_id": "session-42",
        "metadata": {"hook": "SessionEnd"},
    }
    headers = {"Idempotency-Key": "session-42:end:9"}

    with TestClient(create_app(database), base_url="http://127.0.0.1") as client:
        first = client.post("/v1/checkpoints", json=request, headers=headers)

    with TestClient(create_app(database), base_url="http://127.0.0.1") as client:
        replay = client.post("/v1/checkpoints", json=request, headers=headers)
        conflict = client.post(
            "/v1/checkpoints",
            json={**request, "summary": "A different checkpoint."},
            headers=headers,
        )

    assert first.status_code == 201
    assert replay.status_code == 201
    assert replay.json()["checkpoint"] == first.json()["checkpoint"]
    assert conflict.status_code == 409
