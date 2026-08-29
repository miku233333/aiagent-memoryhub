from __future__ import annotations

import json
import socket
import ssl
import unittest

from env_doctor.network import SocketNetworkProbe


class SocketNetworkProbeTests(unittest.TestCase):
    def test_non_allowlisted_host_is_rejected_without_dns(self) -> None:
        calls: list[tuple[str, int]] = []

        def resolver(host: str, port: int):
            calls.append((host, port))
            return []

        result = SocketNetworkProbe(resolver=resolver).probe(
            "attacker-controlled.example", 443
        )

        self.assertEqual(calls, [])
        self.assertFalse(result["resolved"])
        self.assertEqual(result["error"], "probe_error")

    def test_tls_certificate_failure_is_classified_without_leaking_address(
        self,
    ) -> None:
        sensitive_ip = "203.0.113.77"

        def resolver(host: str, port: int):
            return [
                (
                    socket.AF_INET,
                    socket.SOCK_STREAM,
                    socket.IPPROTO_TCP,
                    "",
                    (sensitive_ip, port),
                )
            ]

        def tls_connector(host: str, address: tuple[object, ...], timeout: float):
            raise ssl.SSLCertVerificationError(
                f"certificate failed for {sensitive_ip} via private-proxy.example"
            )

        result = SocketNetworkProbe(
            resolver=resolver, tls_connector=tls_connector
        ).probe("claude.ai", 443)
        serialized = json.dumps(result)

        self.assertTrue(result["resolved"])
        self.assertEqual(result["ip_families"], ["ipv4"])
        self.assertFalse(result["tls_verified"])
        self.assertEqual(result["error"], "tls_certificate")
        self.assertNotIn(sensitive_ip, serialized)
        self.assertNotIn("private-proxy", serialized)


if __name__ == "__main__":
    unittest.main()
