from __future__ import annotations

import json
import os
import platform
import re
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import SplitResult, urlsplit, urlunsplit

from .models import CheckResult, DoctorReport
from .network import OFFICIAL_NETWORK_TARGETS, NetworkProbe, SocketNetworkProbe
from .probes import Commands, LocalCommands

SCHEMA_VERSION = "omnimemory.env-doctor/v1"
_NETWORK_ERROR_CLASSES = {
    "none",
    "dns_failure",
    "dns_no_address",
    "tcp_timeout",
    "tcp_refused",
    "tcp_unreachable",
    "tls_certificate",
    "tls_error",
    "connection_error",
    "probe_error",
}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str
    ) -> None:
        return None


@dataclass(frozen=True)
class DoctorOptions:
    project_root: Path
    hub_url: str = "http://127.0.0.1:8787"
    home: Path | None = None
    allow_remote_health: bool = False
    probe_mcp: bool = False
    probe_network: bool = False


class EnvironmentDoctor:
    def __init__(
        self,
        commands: Commands | None = None,
        environ: Mapping[str, str] | None = None,
        network_probe: NetworkProbe | None = None,
    ) -> None:
        self.commands = commands or LocalCommands()
        self.environ = dict(os.environ if environ is None else environ)
        self.network_probe = network_probe or SocketNetworkProbe()

    def run(self, options: DoctorOptions) -> DoctorReport:
        root = options.project_root.expanduser().resolve()
        home = (options.home or Path.home()).expanduser().resolve()
        safe_hub = _validate_and_sanitize_url(
            options.hub_url, options.allow_remote_health
        )
        checks = [
            self._check_executable(
                "node",
                ["node", "--version"],
                (20, 0),
                "Node.js",
                "Claude Code hook runtime",
            ),
            self._check_python(),
            self._check_uv(root),
            self._check_executable(
                "git", ["git", "--version"], (2, 23), "Git", "workspace setup"
            ),
            self._check_claude(),
            self._check_routing_security(root, home),
            self._check_network(options.probe_network),
            self._check_sandbox(root, home),
            self._check_hooks(root, home),
            self._check_mcp(root, home, options.probe_mcp),
            self._check_hub(safe_hub, root),
        ]
        overall = _overall_status(checks)
        return DoctorReport(
            schema_version=SCHEMA_VERSION,
            overall_status=overall,
            platform=f"{platform.system()} {platform.machine()}".strip(),
            project_root=str(root),
            hub_url=safe_hub,
            checks=checks,
        )

    def _check_network(self, enabled: bool) -> CheckResult:
        if not enabled:
            return CheckResult(
                "claude_network_connectivity",
                "Claude official network connectivity",
                "skip",
                "Public network probing is disabled by default",
                {"enabled": False, "hosts_checked": 0},
                "Use `check --probe-network` to opt in to fixed-host DNS and TLS checks.",
            )
        targets: list[dict[str, Any]] = []
        for host in OFFICIAL_NETWORK_TARGETS:
            try:
                raw = self.network_probe.probe(host, 443)
            except Exception:
                raw = {
                    "resolved": False,
                    "ip_families": [],
                    "tls_verified": False,
                    "error": "probe_error",
                }
            if not isinstance(raw, dict):
                raw = {
                    "resolved": False,
                    "ip_families": [],
                    "tls_verified": False,
                    "error": "probe_error",
                }
            raw_families = raw.get("ip_families", [])
            if not isinstance(raw_families, (list, tuple, set)):
                raw_families = []
            families = sorted(
                {
                    family
                    for family in raw_families
                    if isinstance(family, str)
                    if family in {"ipv4", "ipv6", "other"}
                }
            )
            error = raw.get("error")
            if not isinstance(error, str) or error not in _NETWORK_ERROR_CLASSES:
                error = "probe_error"
            targets.append(
                {
                    "host": host,
                    "resolved": raw.get("resolved") is True,
                    "ip_family_count": len(families),
                    "ip_families": families,
                    "tls_verified": raw.get("tls_verified") is True,
                    "error": error,
                }
            )
        verified = sum(1 for target in targets if target["tls_verified"])
        status = "pass" if verified == len(targets) else "warn"
        summary = (
            "TLS connectivity to both fixed Claude service hosts was verified"
            if status == "pass"
            else f"TLS connectivity verified for {verified} of {len(targets)} fixed Claude service hosts"
        )
        return CheckResult(
            "claude_network_connectivity",
            "Claude official network connectivity",
            status,
            summary,
            {"enabled": True, "hosts_checked": len(targets), "targets": targets},
            None
            if status == "pass"
            else "A failed direct TLS check is a connectivity warning only; review DNS, firewall, system clock, and approved network policy.",
        )

    def _check_python(self) -> CheckResult:
        command = next(
            (name for name in ("python3", "python") if self.commands.which(name)),
            "python3",
        )
        return self._check_executable(
            command,
            [command, "--version"],
            (3, 12),
            "Python",
            "Memory Hub runtime",
            check_id="python",
        )

    def _check_uv(self, root: Path) -> CheckResult:
        backend_project = root / "backend" / "pyproject.toml"
        if not backend_project.is_file():
            return CheckResult(
                "uv",
                "uv",
                "skip",
                "No repository Memory Hub backend was detected",
                {"present": bool(self.commands.which("uv")), "backend_detected": False},
            )
        executable = self.commands.which("uv")
        if not executable:
            return CheckResult(
                "uv",
                "uv",
                "warn",
                "The repository backend exists, but uv was not found",
                {"present": False, "backend_detected": True},
                "Install uv from a trusted package manager or manage backend dependencies manually.",
            )
        result = self.commands.run(["uv", "--version"])
        version = _extract_version(result.stdout or result.stderr)
        status = "pass" if result.returncode == 0 and version else "warn"
        return CheckResult(
            "uv",
            "uv",
            status,
            "uv is available for the repository Memory Hub"
            if status == "pass"
            else "uv exists but its version could not be verified",
            {
                "present": True,
                "backend_detected": True,
                "executable": executable,
                "version": ".".join(str(part) for part in version) if version else None,
            },
            None
            if status == "pass"
            else "Repair uv or manage backend dependencies manually.",
        )

    def _check_executable(
        self,
        name: str,
        version_args: list[str],
        minimum: tuple[int, int],
        title: str,
        purpose: str,
        check_id: str | None = None,
    ) -> CheckResult:
        stable_id = check_id or name
        executable = self.commands.which(name)
        if not executable:
            return CheckResult(
                stable_id,
                title,
                "fail",
                f"{title} was not found",
                {
                    "present": False,
                    "minimum": f"{minimum[0]}.{minimum[1]}",
                    "purpose": purpose,
                },
                f"Install a supported {title} release using a trusted package manager, then rerun check.",
            )
        result = self.commands.run(version_args)
        version = _extract_version(result.stdout or result.stderr)
        if result.returncode != 0 or version is None:
            return CheckResult(
                stable_id,
                title,
                "fail",
                f"{title} exists but its version could not be verified",
                {
                    "present": True,
                    "executable": executable,
                    "minimum": f"{minimum[0]}.{minimum[1]}",
                },
                f"Repair the {title} installation and rerun check.",
            )
        status = "pass" if version[:2] >= minimum else "fail"
        summary = (
            f"{title} {'.'.join(str(part) for part in version)} is ready"
            if status == "pass"
            else f"{title} {'.'.join(str(part) for part in version)} is below the required {minimum[0]}.{minimum[1]}"
        )
        return CheckResult(
            stable_id,
            title,
            status,
            summary,
            {
                "present": True,
                "executable": executable,
                "version": ".".join(str(part) for part in version),
                "minimum": f"{minimum[0]}.{minimum[1]}",
                "purpose": purpose,
            },
            None
            if status == "pass"
            else f"Upgrade {title} using a trusted package manager.",
        )

    def _check_claude(self) -> CheckResult:
        executable = self.commands.which("claude")
        if not executable:
            return CheckResult(
                "claude_code",
                "Claude Code",
                "fail",
                "Claude Code was not found",
                {"present": False},
                "Install Claude Code from the official Claude Code setup guide; this tool will not execute a remote installer.",
            )
        version_result = self.commands.run(["claude", "--version"])
        version = _extract_version(version_result.stdout or version_result.stderr)
        doctor_result = self.commands.run(["claude", "doctor"], timeout=10.0)
        if version_result.returncode != 0 or version is None:
            status = "fail"
            summary = "Claude Code exists but its version could not be verified"
        elif doctor_result.returncode == 0:
            status = "pass"
            summary = f"Claude Code {'.'.join(str(part) for part in version)} passed its read-only doctor"
        else:
            status = "warn"
            summary = (
                "Claude Code is installed, but its built-in doctor reported a problem"
            )
        return CheckResult(
            "claude_code",
            "Claude Code",
            status,
            summary,
            {
                "present": True,
                "executable": executable,
                "version": ".".join(str(part) for part in version) if version else None,
                "doctor_exit_code": doctor_result.returncode,
                "doctor_timed_out": doctor_result.timed_out,
            },
            None
            if status == "pass"
            else "Run `claude doctor` directly and review its local diagnostics.",
        )

    def _check_routing_security(self, root: Path, home: Path) -> CheckResult:
        files = _claude_settings_files(root, home)
        parsed, invalid = _read_json_configs(files)
        shell_keys = set(self.environ)
        settings_keys: set[str] = set()
        project_shared_credential_count = 0
        credential_markers = ("TOKEN", "SECRET", "PASSWORD", "API_KEY", "AUTH_KEY")
        for path, data in parsed:
            env = data.get("env")
            if not isinstance(env, dict):
                continue
            keys = {str(key) for key in env}
            settings_keys.update(keys)
            if path == root / ".claude" / "settings.json":
                project_shared_credential_count += sum(
                    1
                    for key in keys
                    if any(marker in key.upper() for marker in credential_markers)
                )

        all_keys = shell_keys | settings_keys
        normalized_keys = {key.upper() for key in all_keys}
        credential_variable_count = sum(
            1
            for key in all_keys
            if any(marker in key.upper() for marker in credential_markers)
        )
        custom_endpoint = "ANTHROPIC_BASE_URL" in normalized_keys
        proxy_present = bool(
            {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"} & normalized_keys
        )
        literal_mcp_header_count = sum(
            _literal_mcp_header_count(path)
            for path in (root / ".mcp.json", home / ".claude.json")
        )

        warnings: list[str] = []
        if custom_endpoint:
            warnings.append("custom Anthropic endpoint")
        if proxy_present:
            warnings.append("proxy environment")
        if project_shared_credential_count:
            warnings.append("credential-like project setting")
        if literal_mcp_header_count:
            warnings.append("literal MCP header")
        if invalid:
            warnings.append("invalid settings JSON")
        status = "warn" if warnings else "pass"
        summary = (
            "Review configured routing and credential exposure before using Claude Code"
            if warnings
            else "No custom Claude routing or literal project credential risk was detected"
        )
        return CheckResult(
            "claude_routing_security",
            "Claude routing and secrets",
            status,
            summary,
            {
                "custom_anthropic_endpoint_present": custom_endpoint,
                "proxy_configuration_present": proxy_present,
                "credential_variable_count": credential_variable_count,
                "project_shared_credential_count": project_shared_credential_count,
                "literal_mcp_header_count": literal_mcp_header_count,
                "settings_json_valid": not invalid,
            },
            None
            if status == "pass"
            else "Use only approved endpoints/proxies, keep credentials in a secret manager, and never alter locale or fingerprints to evade service controls.",
        )

    def _check_sandbox(self, root: Path, home: Path) -> CheckResult:
        parsed, invalid = _read_json_configs(_claude_settings_files(root, home))
        resolved: dict[str, Any] = {}
        for _, data in parsed:
            sandbox = data.get("sandbox")
            if isinstance(sandbox, dict):
                _deep_merge(resolved, sandbox)
        enabled = resolved.get("enabled") is True
        fail_if_unavailable = resolved.get("failIfUnavailable") is True
        allow_unsandboxed = resolved.get("allowUnsandboxedCommands") is not False
        filesystem = resolved.get("filesystem")
        filesystem_disabled = (
            isinstance(filesystem, dict) and filesystem.get("disabled") is True
        )
        credentials = resolved.get("credentials")
        credential_rule_count = 0
        if isinstance(credentials, dict):
            for key in ("files", "envVars"):
                entries = credentials.get(key)
                if isinstance(entries, list):
                    credential_rule_count += len(entries)

        if filesystem_disabled:
            status = "fail"
            summary = "Claude sandbox filesystem isolation is explicitly disabled"
        elif not enabled:
            status = "warn"
            summary = "Claude sandbox is not explicitly enabled in the checked settings"
        elif fail_if_unavailable and not allow_unsandboxed:
            status = "pass"
            summary = "Claude sandbox is enabled with fail-closed startup and no unsandboxed retry"
        else:
            status = "warn"
            summary = "Claude sandbox is enabled but still permits fallback or unavailable-platform execution"
        if invalid and status == "pass":
            status = "warn"
            summary = "Sandbox settings look strict, but another checked settings file is invalid"
        return CheckResult(
            "claude_sandbox",
            "Claude Code sandbox",
            status,
            summary,
            {
                "enabled": enabled,
                "fail_if_unavailable": fail_if_unavailable,
                "allow_unsandboxed_commands": allow_unsandboxed,
                "filesystem_isolation_disabled": filesystem_disabled,
                "credential_rule_count": credential_rule_count,
            },
            None
            if status == "pass"
            else "Review `/sandbox`; for strict isolation use sandbox.enabled, failIfUnavailable, allowUnsandboxedCommands=false, and credential deny/mask rules as appropriate.",
        )

    def _check_hooks(self, root: Path, home: Path) -> CheckResult:
        files = _claude_settings_files(root, home)
        parsed, invalid = _read_json_configs(files)
        if invalid:
            return CheckResult(
                "claude_hooks",
                "Claude Code hooks",
                "fail",
                "One or more Claude settings files contain invalid JSON",
                {
                    "files_checked": len(files),
                    "invalid_files": [
                        _display_path(path, root, home) for path in invalid
                    ],
                },
                "Repair the invalid JSON before applying any setup plan.",
            )
        event_names: set[str] = set()
        omnimemory_events: set[str] = set()
        omnimemory_entries: list[bool] = []
        omnimemory_command_shapes: list[bool] = []
        configured_files = 0
        disabled = False
        for _, data in parsed:
            if data.get("disableAllHooks") is True:
                disabled = True
            hooks = data.get("hooks")
            if isinstance(hooks, dict):
                configured_files += 1
                event_names.update(str(key) for key in hooks.keys())
                for event, groups in hooks.items():
                    if not isinstance(groups, list):
                        continue
                    for group in groups:
                        for hook_arg, safe_shape in _omnimemory_hook_specs(group):
                            omnimemory_events.add(str(event))
                            omnimemory_entries.append(
                                _hook_entry_exists(root, hook_arg)
                            )
                            omnimemory_command_shapes.append(safe_shape)
        required_events = {"SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"}
        missing_events = sorted(required_events - omnimemory_events)
        omnimemory_configured = bool(omnimemory_events)
        entry_present = bool(omnimemory_entries) and all(omnimemory_entries)
        safe_command_shape = bool(omnimemory_command_shapes) and all(
            omnimemory_command_shapes
        )
        if omnimemory_configured and not safe_command_shape:
            status = "fail"
            summary = "An OmniMemory hook uses an unexpected command or argument shape"
        elif omnimemory_configured and not entry_present:
            status = "fail"
            summary = "OmniMemory hooks are configured, but a referenced local hook entry is missing or unsafe"
        elif omnimemory_configured and missing_events:
            status = "warn"
            summary = f"OmniMemory hooks are valid but missing {len(missing_events)} required event(s)"
        elif omnimemory_configured and disabled:
            status = "warn"
            summary = "OmniMemory hooks are complete, but disableAllHooks is enabled in a checked scope"
        elif omnimemory_configured:
            status = "pass"
            summary = "All four OmniMemory Claude Code hooks are configured with a local entry"
        elif event_names:
            status = "warn"
            summary = "Claude hook settings are valid, but OmniMemory hooks are not configured"
        else:
            status = "warn"
            summary = "Claude hook settings are valid, but no hooks are configured"
        return CheckResult(
            "claude_hooks",
            "Claude Code hooks",
            status,
            summary,
            {
                "files_checked": len(files),
                "existing_files": len(parsed),
                "configured_files": configured_files,
                "event_names": sorted(event_names),
                "disabled": disabled,
                "omnimemory_configured": omnimemory_configured,
                "entry_present": entry_present,
                "safe_command_shape": safe_command_shape,
                "missing_events": missing_events,
            },
            None
            if status == "pass"
            else "Run `setup` to preview a local OmniMemory hook configuration.",
        )

    def _check_mcp(self, root: Path, home: Path, live_probe: bool) -> CheckResult:
        files = [root / ".mcp.json", home / ".claude.json"]
        parsed, invalid = _read_json_configs(files)
        if invalid:
            return CheckResult(
                "claude_mcp",
                "Claude Code MCP",
                "fail",
                "One or more MCP configuration files contain invalid JSON",
                {
                    "invalid_files": [
                        _display_path(path, root, home) for path in invalid
                    ],
                    "live_probe": "not_run",
                },
                "Repair the invalid JSON before enabling an MCP server.",
            )
        names: set[str] = set()
        for _, data in parsed:
            servers = data.get("mcpServers")
            if isinstance(servers, dict):
                names.update(str(name) for name in servers.keys())
        cli_available = False
        cli_result_code: int | None = None
        if self.commands.which("claude"):
            capability = self.commands.run(["claude", "mcp", "--help"])
            cli_available = capability.returncode == 0
            if live_probe:
                live = self.commands.run(["claude", "mcp", "list"], timeout=10.0)
                cli_result_code = live.returncode
        status = "pass" if cli_available else "warn"
        summary = (
            f"Claude MCP commands are available; {len(names)} configured server(s) detected"
            if cli_available
            else "Claude MCP commands could not be verified"
        )
        return CheckResult(
            "claude_mcp",
            "Claude Code MCP",
            status,
            summary,
            {
                "cli_available": cli_available,
                "configured_server_count": len(names),
                "omnimemory_configured": "omnimemory"
                in {name.lower() for name in names},
                "live_probe": "run" if live_probe else "skipped_safe_default",
                "live_probe_exit_code": cli_result_code,
            },
            None
            if cli_available
            else "Upgrade or repair Claude Code, then verify `claude mcp --help`.",
        )

    def _check_hub(self, hub_url: str, root: Path) -> CheckResult:
        parsed = urlsplit(hub_url)
        host = parsed.hostname or ""
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        tcp_open = False
        try:
            with socket.create_connection((host, port), timeout=0.75):
                tcp_open = True
        except OSError:
            pass
        health_url = hub_url.rstrip("/") + "/health"
        request = urllib.request.Request(
            health_url,
            method="GET",
            headers={
                "Accept": "application/json",
                "User-Agent": "omnimemory-env-doctor/0.1",
            },
        )
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), _NoRedirect
        )
        try:
            with opener.open(request, timeout=1.5) as response:
                status_code = response.status
                body = response.read(65536)
            service_status = None
            try:
                payload = json.loads(body)
                if isinstance(payload, dict) and isinstance(payload.get("status"), str):
                    candidate = payload["status"]
                    if re.fullmatch(r"[A-Za-z0-9._-]{1,64}", candidate):
                        service_status = candidate
            except (json.JSONDecodeError, UnicodeDecodeError):
                pass
            status = "pass" if 200 <= status_code < 300 else "warn"
            return CheckResult(
                "memory_hub",
                "Memory Hub",
                status,
                f"Memory Hub health endpoint returned HTTP {status_code}",
                {
                    "tcp_open": tcp_open,
                    "http_status": status_code,
                    "service_status": service_status,
                },
            )
        except urllib.error.HTTPError as exc:
            status = "warn" if 300 <= exc.code < 400 else "fail"
            exc.close()
            return CheckResult(
                "memory_hub",
                "Memory Hub",
                status,
                f"Memory Hub health endpoint returned HTTP {exc.code}",
                {"tcp_open": tcp_open, "http_status": exc.code, "service_status": None},
                "Health redirects are not followed; use the final loopback URL directly."
                if status == "warn"
                else "Inspect the local Memory Hub logs.",
            )
        except (urllib.error.URLError, TimeoutError, OSError):
            backend_hint = (
                " From the repository root, use `./script/build_and_run.sh`; "
                "for a backend-only launch, configure MEMORY_HUB_TOKEN and run "
                "`uv run --no-editable --reinstall-package "
                "ai-agent-memory-hub memory-hub` from backend."
                if (root / "backend" / "pyproject.toml").is_file()
                else ""
            )
            return CheckResult(
                "memory_hub",
                "Memory Hub",
                "fail",
                "Memory Hub health endpoint is not reachable",
                {"tcp_open": tcp_open, "http_status": None, "service_status": None},
                "Start the local Memory Hub and verify the configured loopback URL and port."
                + backend_hint,
            )


def _extract_version(text: str) -> tuple[int, ...] | None:
    match = re.search(r"(?<!\d)(\d+)\.(\d+)(?:\.(\d+))?", text[:512])
    if not match:
        return None
    return tuple(int(part) for part in match.groups(default="0"))


def _read_json_configs(
    files: list[Path],
) -> tuple[list[tuple[Path, dict[str, Any]]], list[Path]]:
    parsed: list[tuple[Path, dict[str, Any]]] = []
    invalid: list[Path] = []
    for path in files:
        if not path.is_file():
            continue
        try:
            if path.stat().st_size > 2 * 1024 * 1024:
                raise ValueError("configuration file is unexpectedly large")
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
            invalid.append(path)
            continue
        if not isinstance(value, dict):
            invalid.append(path)
            continue
        parsed.append((path, value))
    return parsed, invalid


def _claude_settings_files(root: Path, home: Path) -> list[Path]:
    """Return Claude Code settings in increasing scope precedence."""
    return [
        home / ".claude" / "settings.json",
        root / ".claude" / "settings.json",
        root / ".claude" / "settings.local.json",
    ]


def _literal_mcp_header_count(path: Path) -> int:
    """Count literal MCP header values without retaining or reporting them."""
    if not path.is_file() or path.is_symlink():
        return 0
    try:
        if path.stat().st_size > 2 * 1024 * 1024:
            return 0
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
        return 0
    if not isinstance(value, dict):
        return 0
    servers = value.get("mcpServers")
    if not isinstance(servers, dict):
        return 0
    return sum(
        1
        for server in servers.values()
        if isinstance(server, dict)
        for header_value in (
            server.get("headers", {}).values()
            if isinstance(server.get("headers"), dict)
            else ()
        )
        if isinstance(header_value, str) and "${" not in header_value
    )


def _deep_merge(target: dict[str, Any], source: dict[str, Any]) -> None:
    """Merge a higher-precedence settings object into an accumulated object."""
    for key, value in source.items():
        existing = target.get(key)
        if isinstance(existing, dict) and isinstance(value, dict):
            _deep_merge(existing, value)
        else:
            target[key] = value


def _omnimemory_hook_specs(group: Any) -> list[tuple[str, bool]]:
    if not isinstance(group, dict):
        return []
    handlers = group.get("hooks")
    if not isinstance(handlers, list):
        return []
    matches: list[tuple[str, bool]] = []
    for handler in handlers:
        if not isinstance(handler, dict):
            continue
        args = handler.get("args")
        if not isinstance(args, list):
            continue
        for index, arg in enumerate(args):
            if not isinstance(arg, str) or not arg.endswith(
                "adapters/claude-code/bin/hook.mjs"
            ):
                continue
            safe_shape = (
                handler.get("type") == "command"
                and handler.get("command") == "node"
                and index == 0
                and all(isinstance(value, str) for value in args)
            )
            matches.append((arg, safe_shape))
    return matches


def _hook_entry_exists(root: Path, hook_arg: str) -> bool:
    prefix = "${CLAUDE_PROJECT_DIR}/"
    if hook_arg.startswith(prefix):
        candidate = root / hook_arg[len(prefix) :]
    else:
        candidate = Path(hook_arg).expanduser()
        if not candidate.is_absolute():
            return False
    direct_symlink = candidate.is_symlink()
    resolved = candidate.resolve()
    try:
        resolved.relative_to(root)
    except ValueError:
        return False
    return resolved.is_file() and not direct_symlink


def _display_path(path: Path, root: Path, home: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        try:
            return "~/" + str(path.relative_to(home))
        except ValueError:
            return path.name


def _validate_and_sanitize_url(raw: str, allow_remote: bool) -> str:
    parsed = urlsplit(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("hub URL must be an http(s) URL with a host")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError(
            "hub URL must not contain credentials, query parameters, or fragments"
        )
    loopback_names = {"localhost", "127.0.0.1", "::1"}
    if parsed.hostname.lower() not in loopback_names and not allow_remote:
        raise ValueError("remote health checks require --allow-remote-health")
    try:
        parsed_port = parsed.port
    except ValueError as exc:
        raise ValueError("URL port is invalid") from exc
    port = f":{parsed_port}" if parsed_port else ""
    host = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
    clean = SplitResult(parsed.scheme, f"{host}{port}", parsed.path.rstrip("/"), "", "")
    return urlunsplit(clean)


def _overall_status(checks: list[CheckResult]) -> str:
    if any(check.status == "fail" for check in checks):
        return "fail"
    if any(check.status == "warn" for check in checks):
        return "warn"
    if all(check.status == "skip" for check in checks):
        return "skip"
    return "pass"
