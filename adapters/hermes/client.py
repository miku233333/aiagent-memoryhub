"""Small stdlib REST client for the Hermes provider starter."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


MAX_TOKEN_BYTES = 8 * 1024


def _default_hub_token_path() -> Path:
    if os.name == "nt":
        base = os.environ.get("APPDATA")
        if not base:
            base = str(Path(os.environ.get("USERPROFILE", Path.home())) / "AppData" / "Roaming")
    elif sys.platform == "darwin":
        base = str(Path(os.environ.get("HOME", Path.home())) / "Library" / "Application Support")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or str(
            Path(os.environ.get("HOME", Path.home())) / ".config"
        )
    return Path(base) / "MemoryHub" / "hub-token"


def _read_private_token_file(file_path: Path, *, optional: bool) -> str:
    try:
        path_metadata = os.lstat(file_path)
        if not stat.S_ISREG(path_metadata.st_mode):
            raise ValueError("token path is not a regular file")
        flags = os.O_RDONLY
        if os.name != "nt" and hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(file_path, flags)
        try:
            metadata = os.fstat(descriptor)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_dev != path_metadata.st_dev
                or metadata.st_ino != path_metadata.st_ino
                or metadata.st_size < 1
                or metadata.st_size > MAX_TOKEN_BYTES
            ):
                raise ValueError("not a bounded regular file")
            if os.name != "nt" and metadata.st_mode & 0o077:
                raise ValueError("token file is accessible by group or others")
            with os.fdopen(descriptor, "r", encoding="utf-8", closefd=False) as handle:
                token = handle.read(MAX_TOKEN_BYTES + 1).strip()
            if (
                not token
                or len(token.encode("utf-8")) > MAX_TOKEN_BYTES
                or any(ord(character) < 32 or ord(character) == 127 for character in token)
            ):
                raise ValueError("token content is invalid")
            return token
        finally:
            os.close(descriptor)
    except (OSError, UnicodeError, ValueError) as error:
        if optional:
            return ""
        raise ValueError("MEMORY_HUB_TOKEN_FILE could not be read securely") from error


def _read_hub_token() -> str:
    explicit_file = os.environ.get("MEMORY_HUB_TOKEN_FILE", "").strip()
    if explicit_file:
        return _read_private_token_file(Path(explicit_file), optional=False)
    literal = os.environ.get("MEMORY_HUB_TOKEN", "").strip()
    if literal:
        return literal
    return _read_private_token_file(_default_hub_token_path(), optional=True)


class HubClient:
    def __init__(self):
        self.url = os.environ.get("MEMORY_HUB_URL", "http://127.0.0.1:8787").rstrip("/")
        parsed = urllib.parse.urlparse(self.url)
        if parsed.scheme != "https" and not (
            parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        ):
            raise ValueError("remote Hub URL must use HTTPS")
        user_id = os.environ.get("MEMORY_HUB_USER_ID", "").strip()
        if not user_id:
            raise ValueError("MEMORY_HUB_USER_ID is required")
        self.scope = {"user_id": user_id}
        project_id = os.environ.get("MEMORY_HUB_PROJECT_ID", "").strip()
        if project_id:
            self.scope["project_id"] = project_id
        self.token = _read_hub_token()

    def _post(self, path, payload, idempotency_key=None):
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        request = urllib.request.Request(
            self.url + path,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"hub_request_failed_http_{error.code}") from None

    def context(self, query, session_id):
        payload = self._post(
            "/v1/context-pack",
            {
                "scope": self.scope,
                "query": query,
                "limit": 20,
                "include_global": True,
                "source_platform": "hermes",
                "session_id": session_id,
            },
        )
        if payload.get("target") is not None or payload.get("setting") is not None:
            raise RuntimeError("projection_echo_refused")
        for item in payload.get("items", []):
            if item.get("changed") or item.get("canonical_digest") != item.get("rendered_digest"):
                raise RuntimeError("projection_echo_refused")
        return str(payload.get("rendered_content", "")).strip()

    def _write(self, path, payload, kind):
        digest = hashlib.sha256(
            (kind + "\0" + json.dumps(payload, sort_keys=True)).encode("utf-8")
        ).hexdigest()
        return self._post(path, payload, digest)

    def propose(self, content, session_id, metadata):
        payload = {
            "scope": self.scope,
            "content": content,
            "explicit_user_fact": False,
            "source_platform": "hermes",
            "metadata": {**metadata, "session_id": session_id},
        }
        return self._write("/v1/memory/proposals", payload, "proposal")

    def checkpoint(self, summary, session_id, metadata):
        payload = {
            "scope": self.scope,
            "summary": summary,
            "source_platform": "hermes",
            "session_id": session_id,
            "metadata": metadata,
        }
        return self._write("/v1/checkpoints", payload, "checkpoint")
