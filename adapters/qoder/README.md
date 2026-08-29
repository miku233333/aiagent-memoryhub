# Qoder adapter starter

## Runnable locally

`bin/hook.mjs` uses the tested shared REST runtime in `../codex`. Keep the adapter tree together, set `MEMORY_HUB_USER_ID`, optional `MEMORY_HUB_PROJECT_ID`, and `MEMORY_HUB_URL`, then merge `hooks/read-only.example.json` into `~/.qoder/settings.json` or the trusted project settings. Replace the absolute path first.

The read-only hooks inject approved context at session start and before a user prompt. The optional auto-checkpoint hooks require `MEMORY_HUB_WRITE_ENABLED=1`; they never auto-approve or overwrite canonical memory. Qoder documents JSON-on-stdin hooks and `additionalContext` in its [official hook reference](https://docs.qoder.com/cli/hooks).

Use the shared CLI for a proposal:

```bash
export MEMORY_HUB_PLATFORM=qoder
printf '%s' "Candidate fact" | node ../codex/bin/hub.mjs propose
```

This remains dry-run unless `--send` and the write-enable environment gate are both present.

The shared runtime prefers `MEMORY_HUB_TOKEN_FILE`, retains `MEMORY_HUB_TOKEN` compatibility, and automatically discovers the desktop app's private `MemoryHub/hub-token` when neither is set. See `../codex/README.md` for platform paths and file-safety checks.

## Template only

`.mcp.json.example` is not runnable against the current backend: `/mcp` intentionally returns HTTP 501. Use it only after an authenticated Streamable HTTP bridge is deployed and Qoder project MCP trust is granted. This adapter does not claim to modify Qoder native memory.
