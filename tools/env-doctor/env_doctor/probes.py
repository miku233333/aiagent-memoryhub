from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str
    timed_out: bool = False


class Commands(Protocol):
    def which(self, name: str) -> str | None: ...

    def run(self, args: list[str], timeout: float = 5.0) -> CommandResult: ...


class LocalCommands:
    """Runs fixed argv without a shell and with credential-like env vars removed."""

    _SENSITIVE_MARKERS = (
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "COOKIE",
        "API_KEY",
        "AUTH_KEY",
    )

    def which(self, name: str) -> str | None:
        return shutil.which(name)

    def run(self, args: list[str], timeout: float = 5.0) -> CommandResult:
        safe_env = {
            key: value
            for key, value in os.environ.items()
            if not any(marker in key.upper() for marker in self._SENSITIVE_MARKERS)
        }
        try:
            completed = subprocess.run(
                args,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
                shell=False,
                env=safe_env,
            )
            return CommandResult(
                completed.returncode, completed.stdout, completed.stderr
            )
        except subprocess.TimeoutExpired:
            return CommandResult(124, "", "command timed out", timed_out=True)
        except OSError as exc:
            return CommandResult(127, "", exc.__class__.__name__)
