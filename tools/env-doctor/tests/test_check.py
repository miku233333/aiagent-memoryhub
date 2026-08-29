from __future__ import annotations

import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from env_doctor.doctor import DoctorOptions, EnvironmentDoctor
from env_doctor.probes import CommandResult
from env_doctor.setup import SetupOptions, SetupPlanner


class FakeCommands:
    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []
        self.outputs = {
            ("node", "--version"): CommandResult(0, "v22.14.0\n", ""),
            ("python3", "--version"): CommandResult(0, "Python 3.12.9\n", ""),
            ("git", "--version"): CommandResult(0, "git version 2.48.1\n", ""),
            ("claude", "--version"): CommandResult(0, "2.1.211 (Claude Code)\n", ""),
            ("claude", "doctor"): CommandResult(0, "Healthy /Users/test\n", ""),
            ("claude", "mcp", "--help"): CommandResult(0, "Manage MCP servers\n", ""),
        }

    def which(self, name: str) -> str | None:
        return (
            f"/safe/bin/{name}"
            if name in {"node", "python3", "git", "claude"}
            else None
        )

    def run(self, args: list[str], timeout: float = 5.0) -> CommandResult:
        self.calls.append(tuple(args))
        return self.outputs.get(tuple(args), CommandResult(127, "", "not found"))


class RecordingNetworkProbe:
    def __init__(self) -> None:
        self.calls: list[tuple[str, int]] = []

    def probe(self, host: str, port: int):
        self.calls.append((host, port))
        raise AssertionError("the default check must not perform public network probes")


class SuccessfulNetworkProbe:
    def __init__(self) -> None:
        self.calls: list[tuple[str, int]] = []

    def probe(self, host: str, port: int) -> dict[str, object]:
        self.calls.append((host, port))
        return {
            "resolved": True,
            "ip_families": ["ipv4"],
            "tls_verified": True,
            "error": "none",
        }


class LeakyFailureNetworkProbe:
    def probe(self, host: str, port: int) -> dict[str, object]:
        return {
            "resolved": True,
            "ip_families": ["ipv4"],
            "tls_verified": False,
            "error": "203.0.113.9 through secret-proxy.example",
            "resolved_ip": "203.0.113.9",
        }


class EnvironmentDoctorTests(unittest.TestCase):
    def test_default_check_skips_all_public_network_probes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            network = RecordingNetworkProbe()

            report = EnvironmentDoctor(
                commands=FakeCommands(), environ={}, network_probe=network
            ).run(
                DoctorOptions(
                    project_root=root, home=root, hub_url="http://127.0.0.1:9"
                )
            )
            check = next(
                item
                for item in report.checks
                if item.check_id == "claude_network_connectivity"
            )

            self.assertEqual(network.calls, [])
            self.assertEqual(check.status, "skip")
            self.assertEqual(check.details["hosts_checked"], 0)

    def test_opt_in_network_check_probes_only_two_fixed_official_hosts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            network = SuccessfulNetworkProbe()

            report = EnvironmentDoctor(
                commands=FakeCommands(), environ={}, network_probe=network
            ).run(
                DoctorOptions(
                    project_root=root,
                    home=root,
                    hub_url="http://127.0.0.1:9",
                    probe_network=True,
                )
            )
            check = next(
                item
                for item in report.checks
                if item.check_id == "claude_network_connectivity"
            )

            self.assertEqual(
                network.calls,
                [("claude.ai", 443), ("api.anthropic.com", 443)],
            )
            self.assertEqual(check.status, "pass")
            self.assertEqual(check.details["hosts_checked"], 2)
            self.assertEqual(
                [target["host"] for target in check.details["targets"]],
                ["claude.ai", "api.anthropic.com"],
            )
            self.assertTrue(
                all(target["tls_verified"] for target in check.details["targets"])
            )

    def test_network_report_drops_raw_addresses_and_untrusted_error_text(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            report = EnvironmentDoctor(
                commands=FakeCommands(),
                environ={"HTTPS_PROXY": "http://private-proxy.example:8080"},
                network_probe=LeakyFailureNetworkProbe(),
            ).run(
                DoctorOptions(
                    project_root=root,
                    home=root,
                    hub_url="http://127.0.0.1:9",
                    probe_network=True,
                )
            )
            check = next(
                item
                for item in report.checks
                if item.check_id == "claude_network_connectivity"
            )
            serialized = json.dumps(report.to_dict())

            self.assertEqual(check.status, "warn")
            self.assertEqual(
                {target["error"] for target in check.details["targets"]},
                {"probe_error"},
            )
            self.assertNotIn("203.0.113.9", serialized)
            self.assertNotIn("private-proxy.example", serialized)

    def test_json_report_is_machine_readable_and_does_not_echo_config_secrets(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            claude_dir = root / ".claude"
            claude_dir.mkdir()
            (claude_dir / "settings.local.json").write_text(
                json.dumps(
                    {
                        "env": {"ANTHROPIC_API_KEY": "sk-ant-secret-value"},
                        "hooks": {
                            "SessionStart": [
                                {"hooks": [{"type": "command", "command": "node"}]}
                            ]
                        },
                    }
                ),
                encoding="utf-8",
            )
            (root / ".mcp.json").write_text(
                json.dumps(
                    {
                        "mcpServers": {
                            "omnimemory": {
                                "type": "http",
                                "url": "http://127.0.0.1:8765/mcp",
                                "headers": {"Authorization": "Bearer top-secret"},
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )

            report = EnvironmentDoctor(commands=FakeCommands()).run(
                DoctorOptions(project_root=root, hub_url="http://127.0.0.1:9")
            )
            serialized = json.dumps(report.to_dict(), ensure_ascii=False)

            self.assertEqual(report.schema_version, "omnimemory.env-doctor/v1")
            self.assertNotIn("sk-ant-secret-value", serialized)
            self.assertNotIn("top-secret", serialized)
            self.assertIn("claude_code", {check.check_id for check in report.checks})
            self.assertIn("python", {check.check_id for check in report.checks})
            self.assertIn("claude_hooks", {check.check_id for check in report.checks})
            self.assertIn("claude_mcp", {check.check_id for check in report.checks})

    def test_default_check_does_not_start_or_connect_to_configured_mcp_servers(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            commands = FakeCommands()
            EnvironmentDoctor(commands=commands).run(
                DoctorOptions(
                    project_root=Path(temp_dir),
                    home=Path(temp_dir),
                    hub_url="http://127.0.0.1:9",
                )
            )
            self.assertIn(("claude", "mcp", "--help"), commands.calls)
            self.assertNotIn(("claude", "mcp", "list"), commands.calls)

    def test_generated_omnimemory_hooks_are_reported_ready(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            hook = root / "adapters" / "claude-code" / "bin" / "hook.mjs"
            hook.parent.mkdir(parents=True)
            hook.write_text("// adapter\n", encoding="utf-8")
            planner = SetupPlanner()
            planner.apply(
                planner.build(SetupOptions(project_root=root, hook_entry=hook))
            )

            report = EnvironmentDoctor(commands=FakeCommands()).run(
                DoctorOptions(
                    project_root=root, home=root, hub_url="http://127.0.0.1:9"
                )
            )
            check = next(
                item for item in report.checks if item.check_id == "claude_hooks"
            )

            self.assertEqual(check.status, "pass")
            self.assertTrue(check.details["omnimemory_configured"])
            self.assertTrue(check.details["entry_present"])
            self.assertEqual(check.details["missing_events"], [])

    def test_missing_omnimemory_hook_entry_is_reported_as_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            settings = root / ".claude" / "settings.local.json"
            settings.parent.mkdir()
            handler = {
                "hooks": [
                    {
                        "type": "command",
                        "command": "node",
                        "args": [
                            "${CLAUDE_PROJECT_DIR}/adapters/claude-code/bin/hook.mjs"
                        ],
                    }
                ]
            }
            settings.write_text(
                json.dumps(
                    {
                        "hooks": {
                            event: [handler]
                            for event in (
                                "SessionStart",
                                "UserPromptSubmit",
                                "Stop",
                                "SessionEnd",
                            )
                        }
                    }
                ),
                encoding="utf-8",
            )

            report = EnvironmentDoctor(commands=FakeCommands()).run(
                DoctorOptions(
                    project_root=root, home=root, hub_url="http://127.0.0.1:9"
                )
            )
            check = next(
                item for item in report.checks if item.check_id == "claude_hooks"
            )

            self.assertEqual(check.status, "fail")
            self.assertFalse(check.details["entry_present"])

    def test_omnimemory_hook_with_non_node_command_is_reported_as_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            hook = root / "adapters" / "claude-code" / "bin" / "hook.mjs"
            hook.parent.mkdir(parents=True)
            hook.write_text("// adapter\n", encoding="utf-8")
            settings = root / ".claude" / "settings.local.json"
            settings.parent.mkdir()
            handler = {
                "hooks": [
                    {
                        "type": "command",
                        "command": "sh",
                        "args": [
                            "${CLAUDE_PROJECT_DIR}/adapters/claude-code/bin/hook.mjs"
                        ],
                    }
                ]
            }
            settings.write_text(
                json.dumps(
                    {
                        "hooks": {
                            event: [handler]
                            for event in (
                                "SessionStart",
                                "UserPromptSubmit",
                                "Stop",
                                "SessionEnd",
                            )
                        }
                    }
                ),
                encoding="utf-8",
            )

            report = EnvironmentDoctor(commands=FakeCommands(), environ={}).run(
                DoctorOptions(
                    project_root=root, home=root, hub_url="http://127.0.0.1:9"
                )
            )
            check = next(
                item for item in report.checks if item.check_id == "claude_hooks"
            )

            self.assertEqual(check.status, "fail")
            self.assertFalse(check.details["safe_command_shape"])

    def test_routing_check_reports_presence_without_exposing_values(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            environment = {
                "anthropic_base_url": "https://private-relay.example",
                "ANTHROPIC_API_KEY": "sk-ant-never-print",
                "HTTPS_PROXY": "http://user:password@proxy.example",
            }
            (root / ".claude.json").write_text(
                json.dumps(
                    {
                        "mcpServers": {
                            "private": {
                                "headers": {"Authorization": "Bearer never-print"}
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )

            report = EnvironmentDoctor(
                commands=FakeCommands(), environ=environment
            ).run(
                DoctorOptions(
                    project_root=root, home=root, hub_url="http://127.0.0.1:9"
                )
            )
            check = next(
                item
                for item in report.checks
                if item.check_id == "claude_routing_security"
            )
            serialized = json.dumps(report.to_dict())

            self.assertEqual(check.status, "warn")
            self.assertTrue(check.details["custom_anthropic_endpoint_present"])
            self.assertEqual(check.details["credential_variable_count"], 1)
            self.assertTrue(check.details["proxy_configuration_present"])
            self.assertEqual(check.details["literal_mcp_header_count"], 1)
            self.assertNotIn("private-relay", serialized)
            self.assertNotIn("sk-ant-never-print", serialized)
            self.assertNotIn("password", serialized)
            self.assertNotIn("never-print", serialized)

    def test_explicit_strict_sandbox_is_ready_and_disabled_filesystem_is_failure(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            settings = root / ".claude" / "settings.local.json"
            settings.parent.mkdir()
            settings.write_text(
                json.dumps(
                    {
                        "sandbox": {
                            "enabled": True,
                            "failIfUnavailable": True,
                            "allowUnsandboxedCommands": False,
                        }
                    }
                ),
                encoding="utf-8",
            )
            ready = EnvironmentDoctor(commands=FakeCommands(), environ={}).run(
                DoctorOptions(
                    project_root=root, home=root, hub_url="http://127.0.0.1:9"
                )
            )
            ready_check = next(
                item for item in ready.checks if item.check_id == "claude_sandbox"
            )
            self.assertEqual(ready_check.status, "pass")

            settings.write_text(
                json.dumps(
                    {
                        "sandbox": {
                            "enabled": True,
                            "filesystem": {"disabled": True},
                        }
                    }
                ),
                encoding="utf-8",
            )
            unsafe = EnvironmentDoctor(commands=FakeCommands(), environ={}).run(
                DoctorOptions(
                    project_root=root, home=root, hub_url="http://127.0.0.1:9"
                )
            )
            unsafe_check = next(
                item for item in unsafe.checks if item.check_id == "claude_sandbox"
            )
            self.assertEqual(unsafe_check.status, "fail")

    def test_health_report_uses_only_allowlisted_response_fields(self) -> None:
        class HealthHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - stdlib callback name
                payload = json.dumps({"status": "ok", "token": "do-not-print"}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, format: str, *args: object) -> None:
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), HealthHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                report = EnvironmentDoctor(commands=FakeCommands()).run(
                    DoctorOptions(
                        project_root=Path(temp_dir),
                        home=Path(temp_dir),
                        hub_url=f"http://127.0.0.1:{server.server_port}",
                    )
                )
                check = next(
                    item for item in report.checks if item.check_id == "memory_hub"
                )
                serialized = json.dumps(report.to_dict())
                self.assertEqual(check.status, "pass")
                self.assertEqual(check.details["service_status"], "ok")
                self.assertNotIn("do-not-print", serialized)
        finally:
            server.shutdown()
            server.server_close()

    def test_health_check_does_not_follow_redirects(self) -> None:
        target_requests: list[str] = []

        class TargetHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - stdlib callback name
                target_requests.append(self.path)
                self.send_response(200)
                self.end_headers()

            def log_message(self, format: str, *args: object) -> None:
                return

        target = ThreadingHTTPServer(("127.0.0.1", 0), TargetHandler)

        class RedirectHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - stdlib callback name
                self.send_response(302)
                self.send_header(
                    "Location", f"http://127.0.0.1:{target.server_port}/redirect-target"
                )
                self.end_headers()

            def log_message(self, format: str, *args: object) -> None:
                return

        redirect = ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
        threads = [
            threading.Thread(target=target.serve_forever, daemon=True),
            threading.Thread(target=redirect.serve_forever, daemon=True),
        ]
        for thread in threads:
            thread.start()
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                report = EnvironmentDoctor(commands=FakeCommands()).run(
                    DoctorOptions(
                        project_root=Path(temp_dir),
                        home=Path(temp_dir),
                        hub_url=f"http://127.0.0.1:{redirect.server_port}",
                    )
                )
                check = next(
                    item for item in report.checks if item.check_id == "memory_hub"
                )
                self.assertNotEqual(check.status, "pass")
                self.assertEqual(target_requests, [])
        finally:
            redirect.shutdown()
            target.shutdown()
            redirect.server_close()
            target.server_close()


if __name__ == "__main__":
    unittest.main()
