# OpenClaw plugin starter

This is an exact contract skeleton for the documented native `before_prompt_build` hook. It injects approved Hub context and does not replace OpenClaw's built-in memory.

## Contract-tested locally

```bash
npm test
```

The test exercises registration and context injection without importing an OpenClaw host. The `runtime/index.js` entry uses `openclaw/plugin-sdk/plugin-entry` and the shared REST package.

## Template-only host installation

The machine used to build this PoC has OpenClaw `2026.4.24`, older than the current prompt-hook compatibility floor used by this starter (`>=2026.5.27`). Therefore host loading is deliberately **not claimed as verified**. On a compatible disposable profile:

1. Run `npm install` here so the local shared runtime dependency is materialized.
2. Review the code, then link with `openclaw plugins install --link . --force` and enable `omnimemory`.
3. Grant `plugins.entries.omnimemory.hooks.allowConversationAccess: true`; keep `allowPromptInjection` enabled only if this reviewed plugin should inject context.
4. Restart and verify with `openclaw plugins inspect omnimemory --runtime --json`.

The hook is read-only. Submit pending proposals through `../codex/bin/hub.mjs` with `MEMORY_HUB_PLATFORM=openclaw`. See the [official OpenClaw hook contract](https://docs.openclaw.ai/plugins/hooks).

Authentication uses the shared runtime: prefer `MEMORY_HUB_TOKEN_FILE`, or keep `MEMORY_HUB_TOKEN` for compatibility. If neither is set, the runtime discovers the private `MemoryHub/hub-token` written under the platform desktop app-data directory. The token is never logged; see `../codex/README.md` for file validation and platform paths.
