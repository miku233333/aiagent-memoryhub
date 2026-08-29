from fastapi.testclient import TestClient

from memory_hub.app import create_app


def _remember(client, project_id, content):
    return client.post(
        "/v1/memory/proposals",
        json={
            "scope": {"user_id": "user-1", "project_id": project_id},
            "content": content,
            "explicit_user_fact": True,
            "source_platform": "codex",
        },
    ).json()["item"]


def test_context_pack_is_scoped_projected_and_only_prepared_for_delivery(tmp_path):
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url="http://127.0.0.1"
    ) as client:
        project = _remember(client, "project-a", "国内用户使用 PostgreSQL")
        global_item = _remember(client, None, "回答保持简洁")
        _remember(client, "project-b", "B 项目的秘密决策")
        client.put(
            "/v1/settings/user-1/claude_code",
            json={"cross_cultural_polish": True},
        )

        response = client.post(
            "/v1/context-pack",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "target": "claude_code",
                "source_platform": "claude_code",
                "session_id": "session-42",
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["delivery_state"] == "prepared"
    assert body["setting"]["cross_cultural_polish"] is True
    assert {item["id"] for item in body["items"]} == {
        project["id"],
        global_item["id"],
    }
    projected = next(item for item in body["items"] if item["id"] == project["id"])
    assert projected["canonical_content"] == "国内用户使用 PostgreSQL"
    assert projected["rendered_content"] == "中国境内用户使用 PostgreSQL"
    assert "B 项目的秘密决策" not in body["rendered_content"]
    assert "中国境内用户使用 PostgreSQL" in body["rendered_content"]
