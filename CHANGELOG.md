# Changelog

All notable changes to AI Agent MemoryHub are documented here. The project
uses semantic versioning once public releases begin.

## [0.1.0] - 2026-08-30

### Added

- Local-first FastAPI and SQLite canonical Memory Hub.
- Scoped proposals, approvals, search, context packs, forgetting, checkpoints,
  secret blocking, and idempotency.
- Claude Code lifecycle hooks and a Claude Web REST-to-MCP bridge.
- Shared adapters and starter integrations for Codex, Qoder, OpenClaw,
  Hermes, Grok Build, ChatGPT Web, Gemini Web, and Grok Web.
- React control console with memory, connector, environment, audit,
  projection, and Claude account-safety surfaces.
- International expression polish projections for Claude targets while
  preserving canonical memories and protected facts.
- Dry-run-first environment doctor with opt-in fixed-host DNS/TLS checks.
- Electron desktop shell for macOS and Windows packaging, with GitHub Release
  update prompts.

### Security boundaries

- The app remains loopback-first and does not claim to alter vendor-native
  memory.
- Regional, device-fingerprint, proxy, and platform-risk-control evasion are
  outside the project scope.
- Public remote deployment still requires authenticated scope binding, TLS,
  DLP, and verified delivery receipts.
