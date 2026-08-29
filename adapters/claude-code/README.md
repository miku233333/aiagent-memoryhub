# Claude Code automatic Memory Hub adapter

This adapter is a dependency-free Claude Code plugin PoC. It uses deterministic lifecycle hooks to load scoped context and export safe transcript deltas:

| Hook | Action |
| --- | --- |
| `SessionStart` | `POST /v1/context-pack` with `target: "claude_code"`; return `hookSpecificOutput.additionalContext` |
| `UserPromptSubmit` | Query the same context endpoint with the submitted prompt after secret screening |
| `Stop` | Read complete JSONL records after the persisted byte cursor; submit a checkpoint and explicit memory proposals |
| `SessionEnd` | Flush any transcript records appended after `Stop` |

The hook always exits successfully and prints one JSON object. A timeout, unavailable Hub, unreadable transcript, or invalid response does not block Claude Code. Failed exports do not advance the cursor, so a later hook can retry with the same idempotency keys.

## Requirements

- Node.js 20 or later
- A running Memory Hub
- An explicit non-secret `MEMORY_HUB_USER_ID`
- Claude Code with plugin hooks support

No Claude or Hub account credential is bundled. The preferred integration is `MEMORY_HUB_TOKEN_FILE`, pointing at the private token file written by the desktop app. `MEMORY_HUB_TOKEN` remains available for compatibility; do not commit either value or path to shared settings.

## Install as a plugin

For development, point Claude Code at this directory:

```sh
claude --plugin-dir ./adapters/claude-code
```

Set the Hub variables before starting Claude Code:

```sh
export MEMORY_HUB_URL=http://127.0.0.1:8787
export MEMORY_HUB_USER_ID=my-user-id
export MEMORY_HUB_PROJECT_ID=my-project-id
claude --plugin-dir ./adapters/claude-code
```

Use `/hooks` inside Claude Code to verify that `SessionStart`, `UserPromptSubmit`, `Stop`, and `SessionEnd` are loaded from the plugin. Plugin state is stored under `${CLAUDE_PLUGIN_DATA}` and contains only a byte cursor and timestamp, never transcript text.

For a project-local PoC without plugin installation, merge `examples/settings.json` into `.claude/settings.local.json`. Do not overwrite an existing `hooks` or `env` object. The example assumes the repository root contains `adapters/claude-code`.

The official references are [Claude Code hooks](https://code.claude.com/docs/en/hooks) and [plugin creation](https://code.claude.com/docs/en/plugins).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEMORY_HUB_URL` | `http://127.0.0.1:8787` | Hub REST base URL |
| `MEMORY_HUB_USER_ID` | required | Explicit user scope; invalid or absent scope fails closed and sends nothing |
| `MEMORY_HUB_PROJECT_ID` | unset | Optional project scope; the adapter never derives it from or uploads the local path |
| `MEMORY_HUB_TOKEN_FILE` | auto-discovered | Preferred private bearer-token file; takes precedence over `MEMORY_HUB_TOKEN` |
| `MEMORY_HUB_TOKEN` | unset | Compatibility bearer token; never logged |
| `MEMORY_HUB_TIMEOUT_MS` | `1500` | Per-request timeout, bounded to 100–10000 ms |
| `MEMORY_HUB_CONTEXT_LIMIT` | `20` | Context item limit, bounded to 1–100 |
| `MEMORY_HUB_TRANSCRIPT_MODE` | `redacted` | `redacted`, `metadata-only`, or `off` |
| `MEMORY_HUB_SECRET_MODE` | `strict` | `strict` drops a whole secret-bearing message; `redact` masks recognized values |
| `MEMORY_HUB_MAX_TRANSCRIPT_BYTES` | `262144` | Maximum increment read in one hook |
| `MEMORY_HUB_STATE_DIR` | Claude plugin data directory | Standalone cursor-state override |
| `MEMORY_HUB_DEBUG` | unset | Set `1` for sanitized error class/status messages on stderr |

`MEMORY_HUB_URL` rejects embedded credentials. Plain HTTP is accepted only for the exact loopback hosts `localhost`, `127.0.0.1`, and `::1`; every non-loopback Hub URL must use HTTPS.

When neither token variable is set, the adapter looks for the desktop token at `~/Library/Application Support/MemoryHub/hub-token` on macOS, `%APPDATA%\MemoryHub\hub-token` on Windows, or `${XDG_CONFIG_HOME:-~/.config}/MemoryHub/hub-token` on Linux. Automatic discovery accepts only a non-symlink regular file no larger than 8 KiB and, on POSIX systems, no permissions for group or other users (`chmod 600`). An explicitly configured invalid token file fails closed instead of falling back to the literal token.

Privacy modes:

- `redacted` transcript mode extracts only direct user/assistant text. It ignores tool use, tool results, thinking blocks, system entries, and malformed JSONL. Secret handling is then controlled by `MEMORY_HUB_SECRET_MODE`.
- `metadata-only` advances the cursor and sends only byte-range metadata; it sends no transcript text and creates no proposals.
- `off` advances the cursor locally and sends no checkpoint or proposal, preventing old text from being uploaded if export is later enabled.

Secret recognition is defense in depth, not a proof that arbitrary prose contains no sensitive information. Use `metadata-only` or `off` for confidential sessions. `strict` is the default and also prevents a secret-bearing `UserPromptSubmit` prompt from being used as the context search query.

## Proposal behavior

The adapter does not ask a local model to infer durable memories. It proposes only direct user text beginning with an explicit marker such as `记住：`, `記住：`, `remember that`, `please remember`, or `from now on`. Hub policy remains authoritative for pending/approval status.

Only the Hub renders target-specific context. The adapter sends `target: "claude_code"` and injects `rendered_content` unchanged, apart from a fixed data-boundary label. It never edits canonical memory and never writes rendered text back as a proposal.

## Cross-cultural polish switch

Configure the switch on the Hub, not in the plugin:

```http
PUT /v1/settings/{user_id}/claude_code
Content-Type: application/json

{"cross_cultural_polish": true}
```

The Hub may then return a target-specific projection from `/v1/context-pack`. Canonical text remains unchanged. A successful Hook response means `context injected`; it does not prove Claude adopted or retained the context as native memory.

## Idempotency and cursor rules

- Cursor files are keyed by a SHA-256 digest of session ID plus transcript path. Raw paths are not stored in Hub metadata.
- Cursor state stores a digest of the configured user/project scope. If scope changes mid-session, export fails closed instead of sending later transcript text to another scope.
- Checkpoints and proposals carry deterministic `Idempotency-Key` headers derived from session, byte range, and content.
- The local cursor advances only after every required Hub request succeeds. If a process stops after Hub acceptance but before cursor persistence, the next run repeats the same idempotency key.
- Secret-dropped records advance after the remaining safe delta is accepted; secret text is never retried for upload.
- A truncated/rotated transcript resets its local read offset safely.

The Hub must honor `Idempotency-Key` on both `/v1/checkpoints` and `/v1/memory/proposals` for end-to-end exactly-once creation. Without Hub readback, describe export as `delivered_unverified`, not synchronized.

## Verify

```sh
cd adapters/claude-code
npm test
npm run check
```

The test suite uses a local fake Hub; it needs no account or real credential.
