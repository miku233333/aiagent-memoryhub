# AI Agent MemoryHub backend

FastAPI + SQLite proof of concept for scoped, auditable memory synchronization across AI clients. It stores one canonical memory, exposes review and retrieval APIs, and creates target-specific Claude projections without rewriting the canonical text.

## Run locally

Python 3.12 or newer and [`uv`](https://docs.astral.sh/uv/) are required.

```bash
cd backend
uv sync --extra dev
MEMORY_HUB_TOKEN='<generated-local-token>' \
  uv run --no-editable --reinstall-package ai-agent-memory-hub memory-hub
```

`--no-editable` is intentional: on the current macOS workspace, files created under `.venv` carry the `UF_HIDDEN` flag and Python skips the editable-install `.pth` file. A non-editable wheel install avoids that environment-specific import failure. `--reinstall-package` also guarantees that a development launch uses the current source instead of an older non-editable wheel.

The server listens on `http://127.0.0.1:8787`. Configuration:

- `MEMORY_HUB_DATABASE`: SQLite file, default `./data/memory-hub.sqlite3`
- `MEMORY_HUB_HOST`: bind host, default `127.0.0.1`
- `MEMORY_HUB_PORT`: bind port, default `8787`
- `MEMORY_HUB_WEB_DIR`: optional absolute or working-directory-relative Vite `dist` directory; unset by default
- `MEMORY_HUB_TOKEN`: bearer token required by every `/v1` request when configured; the packaged desktop always generates and configures this token

All requests must use the exact loopback hosts `127.0.0.1` or `localhost` (with an optional numeric port). A browser `Origin` header on `/v1`, when present, must likewise be an HTTP loopback origin. `/health`, `/mcp`, and static UI files do not require the bearer token so the desktop can perform readiness checks and load its shell; they remain protected by the loopback Host restriction.

Interactive API documentation is at `/docs`; the OpenAPI document is at `/openapi.json`.

## Optional desktop UI

The backend remains API-only unless `MEMORY_HUB_WEB_DIR` is explicitly set. When set, startup fails closed unless the value resolves to an existing directory containing a safe, regular `index.html`.

```bash
MEMORY_HUB_TOKEN='<generated-local-token>' MEMORY_HUB_WEB_DIR=../web/dist \
  uv run --no-editable --reinstall-package ai-agent-memory-hub memory-hub
```

Static assets are served only after FastAPI routing has completed. Unknown `GET`/`HEAD` paths outside `/v1`, `/health`, and `/mcp` fall back to `index.html` for client-side routing. API responses, method handling, and trailing-slash redirects retain priority. Static lookup uses Starlette's traversal-safe `StaticFiles` with symlink following disabled; encoded dot-segment and backslash traversal attempts are rejected rather than receiving the SPA shell.

The Vite directory is trusted application code, not an upload directory. Do not point `MEMORY_HUB_WEB_DIR` at user-controlled files.

## Desktop sidecar build

The reproducible PyInstaller configuration builds the branded **AI Agent MemoryHub** backend sidecar while preserving the existing Python package and API names:

```bash
uv sync --frozen --no-dev --extra build
uv run --frozen --no-editable --no-dev --extra build pyinstaller \
  --noconfirm --clean packaging/ai-agent-memoryhub-sidecar.spec
```

The one-file executable is written to `dist/ai-agent-memoryhub-sidecar` on macOS/Linux and `dist/ai-agent-memoryhub-sidecar.exe` on Windows. Desktop packaging should preserve the `ai-agent-memoryhub-sidecar` basename under its `Resources/Backend` location. Its analysis explicitly includes FastAPI/Starlette static responses and Uvicorn's dynamically selected loop, HTTP, and lifespan modules. The Vite files are intentionally not embedded automatically: the desktop packager should place its reviewed `dist` directory in application resources and set `MEMORY_HUB_WEB_DIR` to that directory when launching the sidecar. If the variable is absent, the frozen executable exposes no static UI.

The committed spec and `packaging/sidecar_entry.py` are the single release build
path used by `script/package_desktop.sh`. The frozen entrypoint forces
`127.0.0.1:8787`, preserves a per-user fallback database location, and accepts
the reviewed `MEMORY_HUB_WEB_DIR` supplied by Electron. The build process itself
does not launch or bind the server.

## Memory lifecycle

1. `POST /v1/memory/proposals` stores canonical text. A fact explicitly stated by the user (`explicit_user_fact: true`) is approved immediately; inferred content stays `pending`.
2. `GET /v1/memory/proposals` returns an exact-scope review queue, filtered by `status`.
3. `POST /v1/memory/proposals/{id}/approve` approves a pending proposal. The caller must provide the exact owner scope.
4. Only approved memories appear in list, search, or context packs.
5. `POST /v1/memories/{id}/forget` writes an idempotent tombstone and immediately removes the memory from retrieval. It does not silently restore on a later approval call.

`Idempotency-Key` is supported by proposal and checkpoint writes. Replaying the same parsed payload returns the original resource. Reusing the key for a different payload returns HTTP 409.

## Scope behavior

Every memory has a required `user_id` and an optional `project_id`.

- A project query can include that user's global memories (`project_id: null`) with `include_global: true`, the default.
- It never includes another project or another user.
- A user-level query with no project sees only user-level memories.
- Pending proposal review uses the exact requested scope.

The packaged desktop sets `MEMORY_HUB_TOKEN` before starting the sidecar and sends `Authorization: Bearer <MEMORY_HUB_TOKEN>` on every `/v1` request. The service entrypoint refuses to start without that token. Tests may construct an isolated app with `token=None`, but this is not a supported listening mode. The caller-supplied `user_id` and `project_id` fields select storage scope; they are not separate user authentication or a multi-tenant ACL. Keep the service loopback-only.

## REST API

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Readiness response |
| `POST /v1/memory/proposals` | Propose or explicitly commit a canonical memory |
| `GET /v1/memory/proposals` | List exact-scope proposals by status |
| `POST /v1/memory/proposals/{id}/approve` | Human approval |
| `GET /v1/memories` | List approved, scoped memories |
| `POST /v1/memories/search` | Scoped substring search |
| `POST /v1/memories/{id}/forget` | Tombstone a memory |
| `POST /v1/context-pack` | Prepare scoped context and optional target projection |
| `GET /v1/settings/{user_id}/{target}` | Read a target setting, including its default |
| `PUT /v1/settings/{user_id}/{target}` | Update a target setting |
| `POST /v1/projections/preview` | Preview a non-mutating projection |
| `POST /v1/projections/render` | Render a non-mutating adapter payload |
| `POST /v1/checkpoints` | Persist an idempotent session checkpoint |

Example explicit memory:

```bash
export MEMORY_HUB_TOKEN='<generated-local-token>'
curl -sS http://127.0.0.1:8787/v1/memory/proposals \
  -H "Authorization: Bearer ${MEMORY_HUB_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: session-42-turn-7' \
  -d '{
    "scope": {"user_id": "user-1", "project_id": "project-a"},
    "content": "这个项目使用 PostgreSQL。",
    "explicit_user_fact": true,
    "source_platform": "codex"
  }'
```

Example context pack for Claude Code:

```json
{
  "scope": {"user_id": "user-1", "project_id": "project-a"},
  "target": "claude_code",
  "query": "PostgreSQL",
  "include_global": true,
  "source_platform": "claude_code",
  "session_id": "session-42"
}
```

The response uses `delivery_state: "prepared"`. HTTP success only means the Hub prepared the context; it does not claim the target client received or applied it.

## International expression polish

The internal setting is `cross_cultural_polish`; the UI label is **国际化表达润色**. It is:

- off by default;
- stored independently per user and target;
- allowed only for `claude_web` and `claude_code`;
- applied only to projections and context packs, never to canonical memory.

The deterministic rules clarify China-relative geography, for example:

- `国内用户` → `中国境内用户`
- `从国外` → `从中国境外`
- `我国法律` → `中国法律`

They do not remove or generalize Chinese identity, nationality, places, organizations, jurisdictions, laws, currencies, dates, numbers, or units. Quotes, book-title/legal-title brackets, inline/fenced code, paths, and URLs are protected spans. Callers can add exact proper nouns through `protected_terms` for preview/render requests.

Every memory response includes the stored `canonical_digest`. Projection responses return both canonical and rendered SHA-256 digests, plus the applied rule names. There is no API that overwrites canonical content.

## Secret gate

Known private-key, API-key, token, bearer-token, and credential-assignment patterns are blocked before memory/checkpoint storage and before projection/context-pack egress. Error responses include detector names but never echo the detected value. This is a fail-closed guard, not a substitute for a dedicated secret scanner.

## MCP status

The Python MCP SDK was not available in the workspace runtime, so the working vertical slice is REST-first. `/mcp` is an explicit fail-closed placeholder and returns HTTP 501 with `mcp_transport_not_installed`; it must not be presented as a working connector. A later Streamable HTTP MCP layer should map the stable REST behaviors rather than duplicate storage logic.

## Test

```bash
uv run --extra dev pytest
```

The integration tests exercise the public HTTP API against a real temporary SQLite database. They cover approval, scope isolation, search, tombstones, idempotency across restart, context packs, default-off target settings, canonical preservation, conservative China-relative projection, protected facts/spans, and secret blocking.
