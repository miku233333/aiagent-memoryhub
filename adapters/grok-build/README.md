# Grok Build adapter starter

## Runnable locally

`bin/hook.mjs` uses the shared tested REST runtime in `../codex`. Configure the `MEMORY_HUB_*` environment variables, replace the absolute path in `hooks/read-only.example.json`, and copy it to a trusted user or project Grok hook location. Grok Build documents `SessionStart`, `UserPromptSubmit`, `Stop`, and `PostCompact` in its [official hook guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md).

The optional auto-checkpoint template requires `MEMORY_HUB_WRITE_ENABLED=1`. It records checkpoints only. Pending memory proposals use the shared stdin CLI and still require explicit review.

The shared runtime prefers `MEMORY_HUB_TOKEN_FILE`, retains `MEMORY_HUB_TOKEN` compatibility, and automatically discovers the desktop app's private `MemoryHub/hub-token` when neither is set. See `../codex/README.md` for platform paths and file-safety checks.

## Template only

`config.mcp.example.toml` follows the documented Grok Build remote MCP shape, but the current Hub has no MCP transport. Do not enable it until an authenticated public Streamable HTTP bridge exists; verify later with `grok mcp doctor omnimemory --json`. This adapter is not Grok native memory.
