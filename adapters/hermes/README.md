# Hermes MemoryProvider starter

This is a stdlib-only `MemoryProvider` starter using Hermes' documented plugin contract. It prefetches approved canonical Hub context, creates checkpoints after turns only when writes are enabled, and mirrors Hermes memory `add`/`replace` operations as **pending** Hub proposals.

## Contract-tested locally

```bash
python3 -m unittest discover -s tests
```

## Template-only Hermes installation

The Hermes package is not installed in the test environment, so discovery by a live Hermes runtime is not claimed. On a disposable Hermes profile, copy this directory as `$HERMES_HOME/plugins/omnimemory`, select `memory.provider: omnimemory`, set `MEMORY_HUB_USER_ID` and `MEMORY_HUB_URL`, then verify with the Hermes memory status command.

`MEMORY_HUB_WRITE_ENABLED` is off by default. Non-primary agent contexts do not write. This provider is additive and does not overwrite `MEMORY.md` or `USER.md`. The lifecycle matches the official [Hermes MemoryProvider source](https://github.com/NousResearch/hermes-agent/blob/main/agent/memory_provider.py).

For Hub authentication, prefer `MEMORY_HUB_TOKEN_FILE`; `MEMORY_HUB_TOKEN` remains compatible. With neither set, the provider discovers the desktop app's private token at `~/Library/Application Support/MemoryHub/hub-token` on macOS, `%APPDATA%\MemoryHub\hub-token` on Windows, or `${XDG_CONFIG_HOME:-~/.config}/MemoryHub/hub-token` on Linux. It reads only a non-symlink regular file up to 8 KiB and requires mode `0600` or stricter on POSIX. Token values are never logged.
