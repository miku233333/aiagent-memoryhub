from fastapi.testclient import TestClient

from memory_hub.app import create_app


def test_proposal_idempotency_replays_same_item_and_rejects_key_reuse(tmp_path):
    request = {
        "scope": {"user_id": "user-1", "project_id": "project-a"},
        "content": "Remember this once.",
        "explicit_user_fact": True,
    }
    headers = {"Idempotency-Key": "session-1-turn-7"}

    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url="http://127.0.0.1"
    ) as client:
        first = client.post("/v1/memory/proposals", json=request, headers=headers)
        replay = client.post("/v1/memory/proposals", json=request, headers=headers)
        conflict = client.post(
            "/v1/memory/proposals",
            json={**request, "content": "A different fact."},
            headers=headers,
        )
        listed = client.get(
            "/v1/memories",
            params={"user_id": "user-1", "project_id": "project-a"},
        ).json()["items"]

    assert first.status_code == 201
    assert replay.status_code == 201
    assert replay.json()["item"]["id"] == first.json()["item"]["id"]
    assert conflict.status_code == 409
    assert conflict.json()["detail"] == "Idempotency key reused with different request"
    assert len(listed) == 1
