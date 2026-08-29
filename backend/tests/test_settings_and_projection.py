from hashlib import sha256
from statistics import median
from time import perf_counter

from fastapi.testclient import TestClient

from memory_hub.app import create_app
from memory_hub.projection import project


def test_cross_cultural_polish_is_off_by_default_and_isolated_by_target(tmp_path):
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url="http://127.0.0.1"
    ) as client:
        default_code = client.get("/v1/settings/user-1/claude_code")
        enabled_web = client.put(
            "/v1/settings/user-1/claude_web",
            json={"cross_cultural_polish": True},
        )
        code_after = client.get("/v1/settings/user-1/claude_code")
        other_user = client.get("/v1/settings/user-2/claude_web")

    assert default_code.status_code == 200
    assert default_code.json()["setting"]["cross_cultural_polish"] is False
    assert default_code.json()["setting"]["label"] == "国际化表达润色"
    assert enabled_web.json()["setting"]["cross_cultural_polish"] is True
    assert code_after.json()["setting"]["cross_cultural_polish"] is False
    assert other_user.json()["setting"]["cross_cultural_polish"] is False


def test_projection_expands_only_relative_geography_when_enabled(tmp_path):
    canonical = "国内用户从国外登录，我国法律适用于该项目。"
    request = {
        "user_id": "user-1",
        "target": "claude_code",
        "content": canonical,
    }
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url="http://127.0.0.1"
    ) as client:
        disabled = client.post("/v1/projections/preview", json=request)
        client.put(
            "/v1/settings/user-1/claude_code",
            json={"cross_cultural_polish": True},
        )
        enabled = client.post("/v1/projections/render", json=request)

    assert disabled.status_code == 200
    assert disabled.json()["enabled"] is False
    assert disabled.json()["rendered_content"] == canonical
    assert enabled.status_code == 200
    assert enabled.json()["enabled"] is True
    assert enabled.json()["canonical_content"] == canonical
    assert enabled.json()["canonical_digest"] == sha256(canonical.encode()).hexdigest()
    assert enabled.json()["rendered_content"] == (
        "中国境内用户从中国境外登录，中国法律适用于该项目。"
    )
    assert enabled.json()["changed"] is True


def test_projection_preserves_chinese_facts_quotes_code_paths_urls_and_canonical(
    tmp_path,
):
    canonical = (
        "张伟是中国籍，住在北京市，在中国人民银行工作；"
        "适用《中华人民共和国数据安全法》，预算100人民币。"
        "引用：“国内市场”。代码 `region = '国内'`，路径 /国内/data，"
        "链接 https://example.cn/国内，日期2026年8月30日。"
        "国内用户从国外登录。"
    )
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url="http://127.0.0.1"
    ) as client:
        stored = client.post(
            "/v1/memory/proposals",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "content": canonical,
                "explicit_user_fact": True,
            },
        ).json()["item"]
        client.put(
            "/v1/settings/user-1/claude_code",
            json={"cross_cultural_polish": True},
        )
        projected = client.post(
            "/v1/projections/render",
            json={
                "user_id": "user-1",
                "target": "claude_code",
                "content": canonical,
            },
        ).json()
        canonical_after = client.get(
            "/v1/memories",
            params={"user_id": "user-1", "project_id": "project-a"},
        ).json()["items"][0]

    assert projected["rendered_content"] == canonical.replace(
        "国内用户从国外登录", "中国境内用户从中国境外登录"
    )
    assert "张伟是中国籍" in projected["rendered_content"]
    assert "中国人民银行" in projected["rendered_content"]
    assert "《中华人民共和国数据安全法》" in projected["rendered_content"]
    assert "“国内市场”" in projected["rendered_content"]
    assert "`region = '国内'`" in projected["rendered_content"]
    assert "/国内/data" in projected["rendered_content"]
    assert "https://example.cn/国内" in projected["rendered_content"]
    assert "2026年8月30日" in projected["rendered_content"]
    assert canonical_after["id"] == stored["id"]
    assert canonical_after["content"] == canonical
    assert canonical_after["canonical_digest"] == stored["canonical_digest"]
    assert stored["canonical_digest"] == sha256(canonical.encode()).hexdigest()


def test_secret_is_blocked_before_storage_or_projection(tmp_path):
    secret_value = "sk-" + "proj-abcdefghijklmnopqrstuv"
    secret_content = "OPENAI_API_KEY=" + secret_value
    with TestClient(
        create_app(tmp_path / "hub.sqlite3"), base_url="http://127.0.0.1"
    ) as client:
        proposal = client.post(
            "/v1/memory/proposals",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "content": secret_content,
                "explicit_user_fact": True,
            },
        )
        metadata_proposal = client.post(
            "/v1/memory/proposals",
            json={
                "scope": {"user_id": "user-1", "project_id": "project-a"},
                "content": "A safe-looking summary.",
                "metadata": {"api_key": secret_value},
            },
        )
        projection = client.post(
            "/v1/projections/render",
            json={
                "user_id": "user-1",
                "target": "claude_code",
                "content": secret_content,
            },
        )

    assert proposal.status_code == 422
    assert metadata_proposal.status_code == 422
    assert proposal.json()["detail"]["code"] == "secret_detected"
    assert projection.status_code == 422
    assert projection.json()["detail"]["code"] == "secret_detected"
    assert secret_content not in proposal.text
    assert secret_content not in projection.text


def test_projection_treats_old_sentinel_text_as_canonical_content():
    canonical = "\ufff00\ufff1 “国内市场” 国内用户"

    result = project(canonical, enabled=True)

    assert result.canonical_content == canonical
    assert result.rendered_content == "\ufff00\ufff1 “国内市场” 中国境内用户"


def test_projection_scales_without_per_span_restoration_passes():
    def elapsed_for(span_count: int) -> tuple[float, str]:
        content = " ".join('"国内市场"' for _ in range(span_count)) + " 国内用户"
        measurements = []
        rendered = ""
        for _ in range(3):
            started = perf_counter()
            rendered = project(content, enabled=True).rendered_content
            measurements.append(perf_counter() - started)
        return median(measurements), rendered

    small_elapsed, _ = elapsed_for(1_000)
    large_elapsed, rendered = elapsed_for(8_000)

    assert rendered.count('"国内市场"') == 8_000
    assert rendered.endswith("中国境内用户")
    assert large_elapsed < (small_elapsed * 12) + 0.05


def test_projection_matches_overlapping_protected_terms_in_linear_pass():
    def elapsed_for(content_length: int) -> float:
        content = "a" * content_length
        protected_term = "a" * (content_length // 2)
        measurements = []
        for _ in range(3):
            started = perf_counter()
            result = project(
                content,
                enabled=True,
                protected_terms=(protected_term,),
            )
            measurements.append(perf_counter() - started)
            assert result.rendered_content == content
        return median(measurements)

    small_elapsed = elapsed_for(10_000)
    large_elapsed = elapsed_for(80_000)

    assert large_elapsed < (small_elapsed * 12) + 0.05
