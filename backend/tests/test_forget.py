from fastapi.testclient import TestClient

from memory_hub.app import create_app


def test_forget_creates_idempotent_tombstone_and_immediately_hides_memory(tmp_path):
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url="http://127.0.0.1"
    ) as client:
        item = client.post(
            "/v1/memory/proposals",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "content": "Forget this database choice.",
                "explicit_user_fact": True,
            },
        ).json()["item"]

        wrong_scope = client.post(
            f"/v1/memories/{item['id']}/forget",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-b"},
                "reason": "wrong project",
            },
        )
        forgotten = client.post(
            f"/v1/memories/{item['id']}/forget",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "reason": "user requested deletion",
            },
        )
        replay = client.post(
            f"/v1/memories/{item['id']}/forget",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "reason": "a later retry",
            },
        )
        cannot_restore = client.post(
            f"/v1/memory/proposals/{item['id']}/approve",
            json={"scope": {"user_id": "user-1", "project_id": "project-a"}},
        )
        listed = client.get(
            "/v1/memories",
            params={"user_id": "user-1", "project_id": "project-a"},
        ).json()["items"]
        searched = client.post(
            "/v1/memories/search",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "query": "database",
            },
        ).json()["items"]

    assert wrong_scope.status_code == 404
    assert forgotten.status_code == 200
    assert forgotten.json()["tombstone"]["memory_id"] == item["id"]
    assert forgotten.json()["tombstone"]["reason"] == "user requested deletion"
    assert replay.json()["tombstone"] == forgotten.json()["tombstone"]
    assert cannot_restore.status_code == 409
    assert listed == []
    assert searched == []
