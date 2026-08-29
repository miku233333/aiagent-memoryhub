from __future__ import annotations

import hmac
from collections.abc import Sequence
from urllib.parse import urlsplit

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

MAX_REQUEST_BODY_BYTES = 256 * 1024
TRUSTED_LOOPBACK_HOSTS = ("127.0.0.1", "localhost")


def _header_values(scope: Scope, name: bytes) -> list[str]:
    return [
        value.decode("latin-1")
        for key, value in scope.get("headers", ())
        if key.lower() == name
    ]


def _valid_loopback_host(value: str) -> bool:
    host, separator, port = value.partition(":")
    if host not in TRUSTED_LOOPBACK_HOSTS:
        return False
    if not separator:
        return True
    if not port.isascii() or not port.isdigit():
        return False
    return 0 <= int(port) <= 65_535


def _valid_loopback_origin(value: str) -> bool:
    if not value or any(character.isspace() for character in value):
        return False
    try:
        origin = urlsplit(value)
        port = origin.port
    except ValueError:
        return False
    expected_netloc = origin.hostname or ""
    if port is not None:
        expected_netloc = f"{expected_netloc}:{port}"
    return (
        origin.scheme == "http"
        and origin.hostname in TRUSTED_LOOPBACK_HOSTS
        and origin.netloc.casefold() == expected_netloc
        and origin.username is None
        and origin.password is None
        and origin.path == ""
        and origin.query == ""
        and origin.fragment == ""
        and (port is None or 0 <= port <= 65_535)
    )


async def _json_error(
    scope: Scope,
    receive: Receive,
    send: Send,
    *,
    status_code: int,
    code: str,
    message: str,
    headers: dict[str, str] | None = None,
) -> None:
    response = JSONResponse(
        status_code=status_code,
        content={"detail": {"code": code, "message": message}},
        headers=headers,
    )
    await response(scope, receive, send)


class RequestBodyLimitMiddleware:
    """Buffer JSON-sized requests before parsing, while enforcing a hard byte cap."""

    def __init__(
        self,
        app: ASGIApp,
        max_body_bytes: int = MAX_REQUEST_BODY_BYTES,
    ) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        content_lengths = _header_values(scope, b"content-length")
        if len(content_lengths) > 1:
            await self._reject_invalid_length(scope, receive, send)
            return
        if content_lengths:
            raw_length = content_lengths[0]
            if not raw_length.isascii() or not raw_length.isdigit():
                await self._reject_invalid_length(scope, receive, send)
                return
            if int(raw_length) > self.max_body_bytes:
                await self._reject_too_large(scope, receive, send)
                return

        buffered: list[Message] = []
        received_bytes = 0
        while True:
            message = await receive()
            buffered.append(message)
            if message["type"] == "http.disconnect":
                break
            if message["type"] != "http.request":
                continue
            received_bytes += len(message.get("body", b""))
            if received_bytes > self.max_body_bytes:
                await self._reject_too_large(scope, receive, send)
                return
            if not message.get("more_body", False):
                break

        buffered_messages = iter(buffered)

        async def replay_receive() -> Message:
            try:
                return next(buffered_messages)
            except StopIteration:
                return await receive()

        await self.app(scope, replay_receive, send)

    async def _reject_invalid_length(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        await _json_error(
            scope,
            receive,
            send,
            status_code=400,
            code="invalid_content_length",
            message="Content-Length must be one non-negative decimal value",
        )

    async def _reject_too_large(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        await _json_error(
            scope,
            receive,
            send,
            status_code=413,
            code="request_body_too_large",
            message=f"Request body exceeds {self.max_body_bytes} bytes",
        )


class V1RequestSecurityMiddleware:
    """Enforce browser-origin and optional bearer checks at the shared v1 boundary."""

    def __init__(self, app: ASGIApp, token: str | None = None) -> None:
        self.app = app
        self.token = token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not self._is_v1_path(scope):
            await self.app(scope, receive, send)
            return

        hosts = _header_values(scope, b"host")
        if len(hosts) != 1 or not _valid_loopback_host(hosts[0]):
            await _json_error(
                scope,
                receive,
                send,
                status_code=400,
                code="invalid_host",
                message="Host must be an exact loopback host",
            )
            return

        origins = _header_values(scope, b"origin")
        if len(origins) > 1 or (origins and not _valid_loopback_origin(origins[0])):
            await _json_error(
                scope,
                receive,
                send,
                status_code=403,
                code="untrusted_origin",
                message="Origin must be an exact loopback origin",
            )
            return

        if self.token is not None and not self._authorized(scope):
            await _json_error(
                scope,
                receive,
                send,
                status_code=401,
                code="authentication_required",
                message="A valid Memory Hub bearer token is required",
                headers={"WWW-Authenticate": "Bearer"},
            )
            return

        await self.app(scope, receive, send)

    @staticmethod
    def _is_v1_path(scope: Scope) -> bool:
        path = str(scope.get("path", ""))
        return path == "/v1" or path.startswith("/v1/")

    def _authorized(self, scope: Scope) -> bool:
        authorizations: Sequence[str] = _header_values(scope, b"authorization")
        if len(authorizations) != 1:
            return False
        scheme, separator, credentials = authorizations[0].partition(" ")
        return bool(
            separator
            and scheme.casefold() == "bearer"
            and credentials
            and not any(character.isspace() for character in credentials)
            and hmac.compare_digest(credentials, self.token or "")
        )
