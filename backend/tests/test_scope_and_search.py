from fastapi.testclient import TestClient

from memory_hub.app import create_app


def _remember(client, user_id, project_id, content):
    return client.post(
        "/v1/memory/proposals",
        json={
            "scope": {"user_id": user_id, "project_id": project_id},
            "content": content,
            "explicit_user_fact": True,
        },
    ).json()["item"]


def test_list_never_leaks_other_users_or_projects(tmp_path):
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url="http://127.0.0.1"
    ) as client:
        project_a = _remember(client, "user-1", "project-a", "A only")
        global_item = _remember(client, "user-1", None, "Global preference")
        _remember(client, "user-1", "project-b", "B secret")
        _remember(client, "user-2", "project-a", "Other user secret")

        inherited = client.get(
            "/v1/memories",
            params={"user_id": "user-1", "project_id": "project-a"},
        ).json()["items"]
        exact = client.get(
            "/v1/memories",
            params={
                "user_id": "user-1",
                "project_id": "project-a",
                "include_global": "false",
            },
        ).json()["items"]

    assert {item["id"] for item in inherited} == {
        project_a["id"],
        global_item["id"],
    }
    assert [item["id"] for item in exact] == [project_a["id"]]


def test_search_returns_only_approved_matches_in_requested_scope(tmp_path):
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url="http://127.0.0.1"
    ) as client:
        expected = _remember(
            client, "user-1", "project-a", "Project database is PostgreSQL"
        )
        _remember(client, "user-1", "project-a", "Use Redis for cache")
        _remember(client, "user-1", "project-b", "PostgreSQL password differs")
        client.post(
            "/v1/memory/proposals",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "content": "PostgreSQL might be replaced",
                "explicit_user_fact": False,
            },
        )

        response = client.post(
            "/v1/memories/search",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "query": "postgresql",
            },
        )

    assert response.status_code == 200
    assert [item["id"] for item in response.json()["items"]] == [expected["id"]]
