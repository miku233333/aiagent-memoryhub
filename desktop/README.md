# AI Agent MemoryHub desktop

Electron 40 hosts the existing local MemoryHub web UI after its owned Python
sidecar passes the full `/health` identity check.

## Development

Build `../web/dist`, install the backend with `uv`, then run:

```sh
npm install
npm test
npm run typecheck
npm start
```

Development reinstalls the current local backend source and then starts
`uv run --no-editable --reinstall-package ai-agent-memory-hub memory-hub`.
Packaged builds require
`resources/Backend/ai-agent-memoryhub-sidecar` (or the `.exe` form on Windows)
before invoking `npm run dist:mac` or `npm run dist:win`.

The desktop process is the only owner of port `127.0.0.1:8787`; it fails with a
clear retry/quit prompt if another process already owns that port. The SQLite
database is stored in the `MemoryHub` directory below Electron's platform
application-data directory.

## Renderer API

The sandboxed preload exposes only `window.memoryHubDesktop`:

- `appInfo.get()`
- `environment.runCheck()`
- `hub.getState()` and `hub.onStateChange(listener)`
- `updates.getState()`, `updates.check()`, `updates.openReleasePage()`, and
  `updates.onStateChange(listener)`

Environment checks accept no arguments and run only the fixed `--version`
allowlist for Node.js, Python, uv, Git, and Claude, plus the owned Hub state.
