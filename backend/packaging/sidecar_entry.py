"""Frozen executable entry for the AI Agent MemoryHub desktop sidecar."""

from __future__ import annotations

import os
import platform
from pathlib import Path


def _default_data_directory() -> Path:
    """Return a per-user fallback when Electron does not supply a database."""

    system = platform.system()
    if system == "Darwin":
        return Path.home() / "Library" / "Application Support" / "AI Agent MemoryHub"
    if system == "Windows":
        base = os.environ.get("LOCALAPPDATA")
        if base:
            return Path(base) / "AI Agent MemoryHub"
        return Path.home() / "AppData" / "Local" / "AI Agent MemoryHub"
    base = os.environ.get("XDG_STATE_HOME")
    if base:
        return Path(base) / "aiagent-memoryhub"
    return Path.home() / ".local" / "state" / "aiagent-memoryhub"


def main() -> None:
    data_directory = _default_data_directory()
    data_directory.mkdir(mode=0o700, parents=True, exist_ok=True)

    os.environ.setdefault(
        "MEMORY_HUB_DATABASE", str(data_directory / "memory-hub.sqlite3")
    )
    # A frozen desktop sidecar is never allowed to widen its listener through
    # inherited environment. Electron may still select its fixed port and the
    # reviewed packaged Web resource directory.
    os.environ["MEMORY_HUB_HOST"] = "127.0.0.1"
    os.environ["MEMORY_HUB_PORT"] = "8787"

    # Import after establishing database and loopback-only network defaults.
    from memory_hub.app import run

    run()


if __name__ == "__main__":
    main()
