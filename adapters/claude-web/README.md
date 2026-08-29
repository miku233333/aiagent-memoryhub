# Claude Web Remote MCP adapter

This directory contains a runnable, dependency-free Streamable HTTP bridge for Claude Web. It implements the MCP `2025-06-18` stateless request flow and translates approved tools to the Memory Hub REST API. It does **not** depend on the Hub's `/mcp` route.

The bridge fixes `user_id` and optional `project_id` at process startup. Those identifiers are not tool arguments, so Claude cannot switch scope. Every rendered lookup forces `target: "claude_web"` and returns only target-rendered memory; canonical records are not exposed by context/search tools.

## Run locally

Requirements: Node.js 20 or later and a Memory Hub listening on port 8787.

```sh
export MEMORY_HUB_URL=http://127.0.0.1:8787
export MEMORY_HUB_USER_ID=my-user-id
export MEMORY_HUB_PROJECT_ID=my-project-id
npm start
```

The bridge listens on `127.0.0.1:8790` and exposes:

- `GET /health`: local bridge readiness only (`upstream_verified` remains `false`).
- `POST /mcp`: stateless Streamable HTTP using JSON responses.
- `GET /mcp` and `DELETE /mcp`: `405`, because this stateless PoC has no server-initiated SSE subscription or session to terminate.

The implemented MCP methods are `initialize`, `ping`, `tools/list`, and `tools/call`; notifications such as `notifications/initialized` receive `202 Accepted`.

## Tools

| Tool | Default | Behavior |
| --- | --- | --- |
| `context_pack` | enabled | Loads approved memory from the fixed scope and returns only `claude_web` rendered content |
| `memory_search` | enabled | Searches through `/v1/context-pack` so the canonical form cannot bypass the projection switch |
| `projection_preview` | enabled | Shows canonical/rendered preview for caller-supplied text; does not store it |
| `memory_propose` | disabled | When explicitly enabled, always creates a pending Hub proposal for separate human review; a model assertion cannot auto-approve it |

Enable the write tool only for a connector where tool approvals and user intent are understood:

```sh
export CLAUDE_WEB_ENABLE_WRITE_TOOLS=1
```

The bridge always sends `explicit_user_fact: false`, applies a deterministic idempotency key, and leaves approval to a separate Hub review action. The tool schema deliberately has no model-supplied confirmation field. No commit, forget, approve, or destructive tool is exposed.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEMORY_HUB_URL` | `http://127.0.0.1:8787` | Hub REST base URL; remote URLs require HTTPS and credentials in URLs are rejected |
| `MEMORY_HUB_USER_ID` | required | Fixed non-secret user scope |
| `MEMORY_HUB_PROJECT_ID` | unset | Optional fixed project scope |
| `MEMORY_HUB_TOKEN_FILE` | auto-discovered | Preferred private upstream credential file; takes precedence over `MEMORY_HUB_TOKEN` |
| `MEMORY_HUB_TOKEN` | unset | Compatibility upstream credential; never logged or returned |
| `MEMORY_HUB_TIMEOUT_MS` | `2000` | Bounded per-request Hub timeout |
| `CLAUDE_WEB_BRIDGE_HOST` | `127.0.0.1` | Listener host |
| `CLAUDE_WEB_BRIDGE_PORT` | `8790` | Listener port |
| `CLAUDE_WEB_BRIDGE_BEARER_TOKEN` | unset | Fixed inbound token for loopback testing only; it never permits non-loopback binding |
| `CLAUDE_WEB_BRIDGE_TRUST_EXTERNAL_AUTH` | `0` | Required for every non-loopback binding; assert only when a trusted TLS/OAuth gateway protects all traffic |
| `CLAUDE_WEB_BRIDGE_ALLOWED_ORIGINS` | empty | Comma-separated exact Origins; any request carrying an unlisted Origin is rejected |
| `CLAUDE_WEB_ENABLE_WRITE_TOOLS` | `0` | Opt in to the confirmation-gated `memory_propose` tool |

Recognized API keys, access tokens, cookies, passwords, and private-key markers are blocked locally before query, preview, or proposal content reaches the Hub. This pattern screening is defense in depth; do not submit credentials to a connector.

Plain HTTP Hub/proxy targets are accepted only for the exact loopback hosts `localhost`, `127.0.0.1`, and `::1`. `MEMORY_HUB_URL` and `HUB_MCP_URL` reject URL userinfo. When neither token variable is set, the bridge discovers the desktop token at `~/Library/Application Support/MemoryHub/hub-token` on macOS, `%APPDATA%\MemoryHub\hub-token` on Windows, or `${XDG_CONFIG_HOME:-~/.config}/MemoryHub/hub-token` on Linux. It accepts only a non-symlink regular file no larger than 8 KiB and, on POSIX, mode `0600` or stricter. An explicit invalid token file fails closed.

## Add to Claude Web

For a private production connector:

1. Put the bridge behind a trusted HTTPS gateway that implements the OAuth behavior expected by Claude custom connectors.
2. Bind the bridge on a private interface and set `CLAUDE_WEB_BRIDGE_TRUST_EXTERNAL_AUTH=1` only after direct unauthenticated access is blocked at the network/gateway layer.
3. Use a dedicated fixed-scope process per user/project for this PoC. A multi-user service requires the gateway and Hub to cryptographically bind the authenticated principal to scope; do not select scope from model arguments.
4. In Claude, open **Settings → Connectors → Add custom connector** and enter `https://memory.example.com/mcp`.
5. Enable only the read tools initially. Add `CLAUDE_INSTRUCTIONS.md` to relevant Claude Project instructions when consistent invocation is important.

Do not expose the raw Node listener to the internet. The process refuses every non-loopback listener unless the matching `*_TRUST_EXTERNAL_AUTH` switch is explicitly set. A static bearer value remains useful for loopback probes, but does not satisfy that gate and is not a substitute for Claude-compatible OAuth and TLS.

Anthropic documents connector setup and supported remote transports in its official [custom connector setup](https://support.anthropic.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp) and [remote server requirements](https://support.anthropic.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers). The bridge follows the official MCP [Streamable HTTP rules](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports): JSON-RPC over one POST endpoint, the permitted stateless JSON response form, origin validation, loopback defaults, and authentication guidance.

`connector-manifest.example.json` is an operator-readable deployment record. Claude asks for connector name and URL; it does not import that JSON file.

## Cross-cultural polish switch

The target-specific setting lives in the Hub:

```http
PUT /v1/settings/{user_id}/claude_web
Content-Type: application/json

{"cross_cultural_polish": true}
```

When enabled, `context_pack` and `memory_search` return the Hub's rendered projection. The bridge does not edit canonical text and never sends a rendered projection back as a proposal.

## Ordinary Chat lifecycle limit

Claude Web ordinary chat does **not** expose deterministic `SessionStart`, `UserPromptSubmit`, `Stop`, or `SessionEnd` lifecycle hooks. The connector lets Claude invoke a tool, but cannot guarantee that every new/ending chat will do so. A successful read is `context prepared/returned`; a write with an item receipt is `accepted`. Without readback, use `delivered_unverified`, never `synced` or “Claude remembered it.”

## Native MCP proxy mode

If a future Hub exposes a fully implemented Streamable HTTP `/mcp`, the original transparent proxy remains available:

```sh
HUB_MCP_URL=http://127.0.0.1:8787/mcp npm run start:proxy
```

The proxy preserves MCP bodies, session headers, and SSE streaming while setting `X-Memory-Sync-Target: claude_web`. Its upstream URL follows the same no-userinfo and HTTPS-for-non-loopback rules. Do not use proxy mode with the current Hub `/mcp` placeholder.

## Verify

```sh
npm test
npm run check
```

Tests perform local MCP initialization, tool listing/calls, fixed-scope projection checks, secret blocking, pending-only write checks, transport/listener rejection, token-file loading, and transparent proxy streaming. They need no Claude account or real credential.
