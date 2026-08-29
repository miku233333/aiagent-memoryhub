# Contributing to AI Agent MemoryHub

Thank you for helping improve AI Agent MemoryHub. By participating, you agree
to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before opening a change

1. Search the issues and open a focused proposal for substantial behavior or
   protocol changes.
2. Keep memory access scoped, consent-based, auditable, and safe by default.
3. Never commit credentials, user memory, private transcripts, signing
   certificates, or generated desktop resources.
4. Do not add features intended to evade provider eligibility, geographic,
   account-integrity, or abuse-prevention controls.

## Local checks

Use Python 3.12 or newer, Node.js 24, `uv`, `pnpm`, and `npm`.

```bash
uv run --project backend --frozen --extra dev pytest -c backend/pyproject.toml backend/tests
pnpm --dir web install --frozen-lockfile
pnpm --dir web test
pnpm --dir web build
npm --prefix desktop ci
npm --prefix desktop test
npm --prefix desktop run typecheck
npm --prefix desktop run build
```

Run adapter tests for any integration you modify. Packaging is host-native:

```bash
./script/package_desktop.sh mac  # macOS only
./script/package_desktop.sh win  # Windows Git Bash only
```

Packaging temporarily stages the generated backend sidecar and restores that
resource slot afterward. The built web directory is consumed directly by the
desktop packager. Do not commit sidecar binaries, web build output,
certificates, or installer artifacts.

## Pull requests

- Explain the user-visible behavior, safety boundary, and test evidence.
- Add or update tests for changed behavior.
- Keep unrelated formatting or generated files out of the change.
- Link the relevant issue and note platform-specific limitations.

The canonical repository is
[`miku233333/aiagent-memoryhub`](https://github.com/miku233333/aiagent-memoryhub).
