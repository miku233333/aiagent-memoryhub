from fastapi.testclient import TestClient

from memory_hub.app import create_app


def test_explicit_user_fact_is_auto_approved_but_inference_is_pending(tmp_path):
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url="http://127.0.0.1"
    ) as client:
        explicit = client.post(
            "/v1/memory/proposals",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "content": "This project uses PostgreSQL.",
                "explicit_user_fact": True,
                "source_platform": "codex",
            },
        )
        inferred = client.post(
            "/v1/memory/proposals",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "content": "The user probably prefers PostgreSQL everywhere.",
                "explicit_user_fact": False,
                "source_platform": "codex",
            },
        )

    assert explicit.status_code == 201
    assert explicit.json()["item"]["status"] == "approved"
    assert explicit.json()["item"]["approved_at"] is not None
    assert inferred.status_code == 201
    assert inferred.json()["item"]["status"] == "pending"
    assert inferred.json()["item"]["approved_at"] is None


def test_pending_proposal_only_appears_after_owner_approval(tmp_path):
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url="http://127.0.0.1"
    ) as client:
        proposed = client.post(
            "/v1/memory/proposals",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "content": "Use terse commit messages.",
            },
        ).json()["item"]

        before = client.get(
            "/v1/memories",
            params={"user_id": "user-1", "project_id": "project-a"},
        )
        approved = client.post(
            f"/v1/memory/proposals/{proposed['id']}/approve",
            json={"scope": {"user_id": "user-1", "project_id": "project-a"}},
        )
        after = client.get(
            "/v1/memories",
            params={"user_id": "user-1", "project_id": "project-a"},
        )

    assert before.status_code == 200
    assert before.json()["items"] == []
    assert approved.status_code == 200
    assert approved.json()["item"]["status"] == "approved"
    assert [item["id"] for item in after.json()["items"]] == [proposed["id"]]


def test_canonical_content_preserves_original_whitespace(tmp_path):
    canonical = "  国内用户偏好简洁。\n"
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url="http://127.0.0.1"
    ) as client:
        response = client.post(
            "/v1/memory/proposals",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "content": canonical,
                "explicit_user_fact": True,
            },
        )

    assert response.status_code == 201
    assert response.json()["item"]["content"] == canonical


def test_proposals_can_be_listed_by_status_for_human_review(tmp_path):
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url="http://127.0.0.1"
    ) as client:
        pending = client.post(
            "/v1/memory/proposals",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "content": "A model-derived preference.",
            },
        ).json()["item"]
        approved = client.post(
            "/v1/memory/proposals",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "content": "An explicit preference.",
                "explicit_user_fact": True,
            },
        ).json()["item"]

        review_queue = client.get(
            "/v1/memory/proposals",
            params={"user_id": "user-1", "project_id": "project-a"},
        )
        approved_list = client.get(
            "/v1/memory/proposals",
            params={
                "user_id": "user-1",
                "project_id": "project-a",
                "status": "approved",
            },
        )

    assert [item["id"] for item in review_queue.json()["items"]] == [pending["id"]]
    assert [item["id"] for item in approved_list.json()["items"]] == [approved["id"]]
