from __future__ import annotations

import re

_SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "private_key",
        re.compile(r"-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----"),
    ),
    (
        "provider_api_key",
        re.compile(r"\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b"),
    ),
    (
        "github_token",
        re.compile(r"\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b"),
    ),
    ("slack_token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("aws_access_key", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    (
        "bearer_token",
        re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}", re.IGNORECASE),
    ),
    (
        "credential_assignment",
        re.compile(
            r"\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|"
            r"client[_-]?secret|secret|password|passwd|cookie)"
            r"\b\s*[:=]\s*[\"']?[^\s\"'`,;]{6,}",
            re.IGNORECASE,
        ),
    ),
)


def detect_secrets(content: str) -> tuple[str, ...]:
    """Return detector names only; never include secret material in errors/logs."""

    return tuple(name for name, pattern in _SECRET_PATTERNS if pattern.search(content))
