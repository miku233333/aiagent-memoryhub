from __future__ import annotations

import errno
import socket
import ssl
from collections.abc import Callable
from typing import Any, Protocol

OFFICIAL_NETWORK_TARGETS = ("claude.ai", "api.anthropic.com")
_OFFICIAL_HOSTS = frozenset(OFFICIAL_NETWORK_TARGETS)
_ERROR_PRIORITY = (
    "tls_certificate",
    "tls_error",
    "tcp_timeout",
    "tcp_refused",
    "tcp_unreachable",
    "connection_error",
    "probe_error",
)
_UNREACHABLE_ERRNOS = {
    value
    for name in ("ENETDOWN", "ENETUNREACH", "EHOSTDOWN", "EHOSTUNREACH")
    if (value := getattr(errno, name, None)) is not None
}

AddressInfo = tuple[int, int, int, str, tuple[Any, ...]]
Resolver = Callable[[str, int], list[AddressInfo]]
TlsConnector = Callable[[str, AddressInfo, float], None]


class NetworkProbe(Protocol):
    def probe(self, host: str, port: int) -> dict[str, object]: ...


class SocketNetworkProbe:
    """Resolve and verify TLS for the fixed official allowlist without HTTP."""

    def __init__(
        self,
        *,
        resolver: Resolver | None = None,
        tls_connector: TlsConnector | None = None,
        timeout: float = 2.0,
    ) -> None:
        self._resolver = resolver or _resolve
        self._tls_connector = tls_connector or _connect_tls
        self._timeout = timeout

    def probe(self, host: str, port: int) -> dict[str, object]:
        if host not in _OFFICIAL_HOSTS or port != 443:
            return _result(False, [], False, "probe_error")
        try:
            resolved = self._resolver(host, port)
        except socket.gaierror:
            return _result(False, [], False, "dns_failure")
        except OSError:
            return _result(False, [], False, "dns_failure")
        except Exception:
            return _result(False, [], False, "probe_error")

        families: list[str] = []
        candidates: list[AddressInfo] = []
        for address in resolved:
            if not isinstance(address, tuple) or len(address) != 5:
                continue
            family = _family_name(address[0])
            if family in families:
                continue
            families.append(family)
            candidates.append(address)
        families.sort()
        if not candidates:
            return _result(False, families, False, "dns_no_address")

        failures: list[str] = []
        for address in candidates:
            try:
                self._tls_connector(host, address, self._timeout)
            except ssl.SSLCertVerificationError:
                failures.append("tls_certificate")
            except ssl.SSLError:
                failures.append("tls_error")
            except (TimeoutError, socket.timeout):
                failures.append("tcp_timeout")
            except ConnectionRefusedError:
                failures.append("tcp_refused")
            except OSError as exc:
                failures.append(_classify_socket_error(exc))
            except Exception:
                failures.append("probe_error")
            else:
                return _result(True, families, True, "none")
        error = next(
            (candidate for candidate in _ERROR_PRIORITY if candidate in failures),
            "connection_error",
        )
        return _result(True, families, False, error)


def _resolve(host: str, port: int) -> list[AddressInfo]:
    return socket.getaddrinfo(
        host,
        port,
        type=socket.SOCK_STREAM,
        proto=socket.IPPROTO_TCP,
    )


def _connect_tls(host: str, address: AddressInfo, timeout: float) -> None:
    family, socket_type, protocol, _, socket_address = address
    connection = socket.socket(family, socket_type, protocol)
    connection.settimeout(timeout)
    try:
        connection.connect(socket_address)
        context = ssl.create_default_context()
        if hasattr(context, "keylog_filename"):
            context.keylog_filename = None
        with context.wrap_socket(connection, server_hostname=host):
            connection = None  # type: ignore[assignment]
    finally:
        if connection is not None:
            connection.close()


def _family_name(family: int) -> str:
    if family == socket.AF_INET:
        return "ipv4"
    if family == socket.AF_INET6:
        return "ipv6"
    return "other"


def _classify_socket_error(error: OSError) -> str:
    if error.errno in _UNREACHABLE_ERRNOS:
        return "tcp_unreachable"
    if error.errno == errno.ECONNREFUSED:
        return "tcp_refused"
    return "connection_error"


def _result(
    resolved: bool,
    families: list[str],
    tls_verified: bool,
    error: str,
) -> dict[str, object]:
    return {
        "resolved": resolved,
        "ip_families": families,
        "tls_verified": tls_verified,
        "error": error,
    }
