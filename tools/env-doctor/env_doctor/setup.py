from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from .doctor import _validate_and_sanitize_url

PLAN_SCHEMA_VERSION = "omnimemory.env-doctor.setup-plan/v1"
RECEIPT_SCHEMA_VERSION = "omnimemory.env-doctor.setup-receipt/v1"
_USER_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


@dataclass(frozen=True)
class SetupOptions:
    project_root: Path
    hook_entry: Path | None = None
    hub_url: str = "http://127.0.0.1:8787"
    user_id: str = "local-user"
    mcp_url: str | None = None
    allow_remote_mcp: bool = False


@dataclass(frozen=True)
class PlannedAction:
    action_id: str
    operation: str
    target: str
    summary: str
    changes: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.action_id,
            "operation": self.operation,
            "target": self.target,
            "summary": self.summary,
            "changes": self.changes,
        }


@dataclass(frozen=True)
class _PlannedWrite:
    target: Path
    original_digest: str | None
    content: bytes
    existed: bool


@dataclass(frozen=True)
class SetupPlan:
    schema_version: str
    status: Literal["ready", "blocked", "noop"]
    project_root: str
    dry_run: bool
    actions: list[PlannedAction]
    warnings: list[str]
    errors: list[str]
    _writes: tuple[_PlannedWrite, ...] = field(default_factory=tuple, repr=False)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "status": self.status,
            "project_root": self.project_root,
            "dry_run": self.dry_run,
            "actions": [action.to_dict() for action in self.actions],
            "warnings": self.warnings,
            "errors": self.errors,
        }


@dataclass(frozen=True)
class SetupReceipt:
    schema_version: str
    status: Literal["applied", "noop"]
    changed_files: list[str]
    backups: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "status": self.status,
            "changed_files": self.changed_files,
            "backups": self.backups,
        }


class SetupPlanner:
    def build(self, options: SetupOptions) -> SetupPlan:
        root = options.project_root.expanduser().resolve()
        warnings: list[str] = []
        errors: list[str] = []
        actions: list[PlannedAction] = []
        writes: list[_PlannedWrite] = []

        if not root.is_dir():
            errors.append("Project root does not exist or is not a directory.")
            return _blocked_plan(root, warnings, errors)
        if not _USER_ID_PATTERN.fullmatch(options.user_id):
            errors.append(
                "User ID must be a 1-64 character pseudonymous slug using letters, digits, dot, underscore, or dash."
            )
        try:
            hub_url = _validate_and_sanitize_url(options.hub_url, allow_remote=False)
        except ValueError as exc:
            errors.append(str(exc))
            hub_url = ""

        hook_candidate = (
            options.hook_entry
            or (root / "adapters" / "claude-code" / "bin" / "hook.mjs")
        ).expanduser()
        if not hook_candidate.is_absolute():
            hook_candidate = root / hook_candidate
        hook_is_symlink = hook_candidate.is_symlink()
        hook_path = hook_candidate.resolve()
        if not _inside(root, hook_path) or not hook_path.is_file() or hook_is_symlink:
            errors.append(
                "Hook entry must be an existing regular file inside the project root."
            )

        settings_path = root / ".claude" / "settings.local.json"
        try:
            _ensure_safe_target(root, settings_path)
        except ValueError as exc:
            errors.append(str(exc))

        existing: dict[str, Any] = {}
        original_bytes: bytes | None = None
        if settings_path.exists():
            try:
                original_bytes = settings_path.read_bytes()
                value = json.loads(original_bytes)
                if not isinstance(value, dict):
                    raise ValueError("top-level JSON value is not an object")
                existing = value
            except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
                errors.append(
                    "Existing .claude/settings.local.json is not a valid JSON object; no changes will be made."
                )

        if errors:
            return _blocked_plan(root, warnings, errors)

        proposed = _copy_json(existing)
        env = proposed.setdefault("env", {})
        if not isinstance(env, dict):
            return _blocked_plan(
                root, warnings, ["Existing settings env field is not an object."]
            )
        for key, value in (
            ("MEMORY_HUB_URL", hub_url),
            ("MEMORY_HUB_USER_ID", options.user_id),
        ):
            if key in env and env[key] != value:
                warnings.append(
                    f"Preserved existing {key}; the requested value was not written."
                )
            else:
                env[key] = value

        hooks = proposed.setdefault("hooks", {})
        if not isinstance(hooks, dict):
            return _blocked_plan(
                root, warnings, ["Existing settings hooks field is not an object."]
            )
        relative_hook = hook_path.relative_to(root).as_posix()
        hook_arg = "${CLAUDE_PROJECT_DIR}/" + relative_hook
        specifications = {
            "SessionStart": ("startup|resume|clear|compact|fork", 3),
            "UserPromptSubmit": (None, 3),
            "Stop": (None, 5),
            "SessionEnd": ("clear|resume|logout|prompt_input_exit|other", 5),
        }
        added_events: list[str] = []
        for event, (matcher, timeout) in specifications.items():
            group = _hook_group(hook_arg, matcher, timeout)
            configured = hooks.setdefault(event, [])
            if not isinstance(configured, list):
                return _blocked_plan(
                    root, warnings, [f"Existing hooks.{event} field is not a list."]
                )
            if group in configured:
                continue
            if any(_looks_like_omnimemory_hook(item) for item in configured):
                return _blocked_plan(
                    root,
                    warnings,
                    [
                        f"A different OmniMemory hook already exists for {event}; review it manually before replacing it."
                    ],
                )
            configured.append(group)
            added_events.append(event)

        if proposed.get("disableAllHooks") is True:
            warnings.append(
                "disableAllHooks is true; the generated hooks will remain inactive until that setting changes."
            )

        new_bytes = (
            json.dumps(proposed, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
        if original_bytes != new_bytes:
            writes.append(
                _PlannedWrite(
                    target=settings_path,
                    original_digest=_digest(original_bytes)
                    if original_bytes is not None
                    else None,
                    content=new_bytes,
                    existed=original_bytes is not None,
                )
            )
            actions.append(
                PlannedAction(
                    "configure_claude_hooks",
                    "merge_json_with_backup",
                    ".claude/settings.local.json",
                    "Merge local OmniMemory hook settings without replacing unrelated keys.",
                    [
                        "Set missing MEMORY_HUB_URL and MEMORY_HUB_USER_ID values (values omitted from plan output).",
                        f"Add hook groups for: {', '.join(added_events) if added_events else 'none'}.",
                        "Create a timestamped backup first when the target already exists.",
                    ],
                )
            )

        exclude_result = self._plan_git_exclude(root, warnings)
        if isinstance(exclude_result, str):
            errors.append(exclude_result)
        elif exclude_result is not None:
            write, action = exclude_result
            writes.append(write)
            actions.append(action)

        if options.mcp_url is not None:
            mcp_result = self._plan_mcp(root, options, warnings)
            if isinstance(mcp_result, str):
                errors.append(mcp_result)
            elif mcp_result is not None:
                write, action = mcp_result
                writes.append(write)
                actions.append(action)

        if errors:
            return _blocked_plan(root, warnings, errors)
        status: Literal["ready", "noop"] = "ready" if writes else "noop"
        return SetupPlan(
            PLAN_SCHEMA_VERSION,
            status,
            str(root),
            True,
            actions,
            warnings,
            [],
            tuple(writes),
        )

    def _plan_git_exclude(
        self,
        root: Path,
        warnings: list[str],
    ) -> tuple[_PlannedWrite, PlannedAction] | str | None:
        git_entry = root / ".git"
        if not git_entry.exists():
            warnings.append(
                "No standard .git directory was found; verify that .claude/settings.local.json cannot be committed."
            )
            return None
        if not git_entry.is_dir():
            warnings.append(
                "Git worktree metadata was detected; add /.claude/settings.local.json to a private exclude manually."
            )
            return None
        target = git_entry / "info" / "exclude"
        try:
            _ensure_safe_target(root, target)
        except ValueError as exc:
            return str(exc)
        original: bytes | None = None
        text = ""
        if target.exists():
            try:
                original = target.read_bytes()
                text = original.decode("utf-8")
            except (OSError, UnicodeError):
                return "Git private exclude is not readable UTF-8; add the Claude local settings rule manually."
        rules = [
            "/.claude/settings.local.json",
            "/.claude/settings.local.json.bak.*",
            "/.mcp.json.bak.*",
        ]
        present = {line.strip() for line in text.splitlines()}
        missing_rules = [rule for rule in rules if rule not in present]
        if not missing_rules:
            return None
        prefix = "" if not text or text.endswith(("\n", "\r")) else "\n"
        content = (text + prefix + "\n".join(missing_rules) + "\n").encode("utf-8")
        return (
            _PlannedWrite(
                target,
                _digest(original) if original is not None else None,
                content,
                original is not None,
            ),
            PlannedAction(
                "protect_local_claude_settings",
                "append_git_private_exclude_with_backup",
                ".git/info/exclude",
                "Keep project-local Claude settings out of version control on this machine.",
                [
                    "Append only local Claude settings and Env Doctor backup patterns.",
                    "Preserve all existing private exclude rules.",
                ],
            ),
        )

    def _plan_mcp(
        self,
        root: Path,
        options: SetupOptions,
        warnings: list[str],
    ) -> tuple[_PlannedWrite, PlannedAction] | str | None:
        assert options.mcp_url is not None
        try:
            mcp_url = _validate_and_sanitize_url(
                options.mcp_url, options.allow_remote_mcp
            )
        except ValueError as exc:
            return str(exc).replace("health checks", "MCP configuration")
        target = root / ".mcp.json"
        try:
            _ensure_safe_target(root, target)
        except ValueError as exc:
            return str(exc)
        original: bytes | None = None
        data: dict[str, Any] = {}
        if target.exists():
            try:
                original = target.read_bytes()
                decoded = json.loads(original)
                if not isinstance(decoded, dict):
                    return "Existing .mcp.json is not a JSON object."
                data = decoded
            except (OSError, UnicodeError, json.JSONDecodeError):
                return "Existing .mcp.json is invalid; no changes will be made."
        proposed = _copy_json(data)
        servers = proposed.setdefault("mcpServers", {})
        if not isinstance(servers, dict):
            return "Existing .mcp.json mcpServers field is not an object."
        definition = {"type": "http", "url": mcp_url}
        current = servers.get("omnimemory")
        if current is not None and current != definition:
            return "An omnimemory MCP server already exists with a different definition; review it manually."
        servers["omnimemory"] = definition
        content = (
            json.dumps(proposed, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
        if original == content:
            return None
        warnings.append(
            "Project MCP servers require explicit workspace approval in interactive Claude Code sessions."
        )
        return (
            _PlannedWrite(
                target,
                _digest(original) if original is not None else None,
                content,
                original is not None,
            ),
            PlannedAction(
                "configure_claude_mcp",
                "merge_json_with_backup",
                ".mcp.json",
                "Add a credential-free OmniMemory HTTP MCP endpoint.",
                [
                    "Add only mcpServers.omnimemory.",
                    "Never add headers, tokens, or embedded URL credentials.",
                ],
            ),
        )

    def apply(self, plan: SetupPlan) -> SetupReceipt:
        if plan.status == "blocked":
            raise ValueError("cannot apply a blocked setup plan")
        if not plan._writes:
            return SetupReceipt(RECEIPT_SCHEMA_VERSION, "noop", [], [])

        root = Path(plan.project_root).resolve()
        for write in plan._writes:
            _ensure_safe_target(root, write.target)
            current = write.target.read_bytes() if write.target.exists() else None
            if (current is not None) != write.existed or (
                _digest(current) if current is not None else None
            ) != write.original_digest:
                raise RuntimeError(
                    f"setup target changed after planning: {write.target.name}; rebuild the plan"
                )

        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backups: list[str] = []
        backup_by_target: dict[Path, Path] = {}
        staged: list[tuple[_PlannedWrite, Path]] = []
        replaced: list[_PlannedWrite] = []
        try:
            for write in plan._writes:
                write.target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                mode = (
                    stat.S_IMODE(write.target.stat().st_mode)
                    if write.target.exists()
                    else 0o600
                )
                staged.append((write, _stage_write(write.target, write.content, mode)))

            for write, _ in staged:
                if write.target.exists():
                    backup = _next_backup_path(write.target, timestamp)
                    shutil.copy2(write.target, backup)
                    backup_by_target[write.target] = backup
                    backups.append(str(backup))

            for write, temporary in staged:
                os.replace(temporary, write.target)
                replaced.append(write)
                _fsync_directory(write.target.parent)
        except Exception as exc:
            rollback_errors: list[str] = []
            for write in reversed(replaced):
                try:
                    backup = backup_by_target.get(write.target)
                    if backup is not None:
                        shutil.copy2(backup, write.target)
                    elif write.target.exists():
                        write.target.unlink()
                except OSError:
                    rollback_errors.append(write.target.name)
            if rollback_errors:
                raise RuntimeError(
                    "setup failed and rollback could not restore: "
                    + ", ".join(rollback_errors)
                ) from exc
            raise
        finally:
            for _, temporary in staged:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

        changed = [str(write.target) for write in plan._writes]
        return SetupReceipt(RECEIPT_SCHEMA_VERSION, "applied", changed, backups)


def _blocked_plan(root: Path, warnings: list[str], errors: list[str]) -> SetupPlan:
    return SetupPlan(
        PLAN_SCHEMA_VERSION, "blocked", str(root), True, [], warnings, errors
    )


def _hook_group(hook_arg: str, matcher: str | None, timeout: int) -> dict[str, Any]:
    group: dict[str, Any] = {
        "hooks": [
            {
                "type": "command",
                "command": "node",
                "args": [hook_arg],
                "timeout": timeout,
            }
        ]
    }
    if matcher is not None:
        group["matcher"] = matcher
    return group


def _looks_like_omnimemory_hook(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    handlers = value.get("hooks")
    if not isinstance(handlers, list):
        return False
    for handler in handlers:
        if not isinstance(handler, dict):
            continue
        args = handler.get("args")
        if isinstance(args, list) and any(
            isinstance(arg, str) and "adapters/claude-code/bin/hook.mjs" in arg
            for arg in args
        ):
            return True
    return False


def _copy_json(value: dict[str, Any]) -> dict[str, Any]:
    return json.loads(json.dumps(value))


def _digest(content: bytes | None) -> str | None:
    if content is None:
        return None
    return hashlib.sha256(content).hexdigest()


def _inside(root: Path, target: Path) -> bool:
    try:
        target.relative_to(root)
        return True
    except ValueError:
        return False


def _ensure_safe_target(root: Path, target: Path) -> None:
    resolved_parent = target.parent.resolve()
    if not _inside(root, resolved_parent):
        raise ValueError(
            f"Refusing to write {target.name}: target resolves outside the project root."
        )
    if target.exists() and target.is_symlink():
        raise ValueError(
            f"Refusing to write {target.name}: symbolic-link targets are not supported."
        )


def _next_backup_path(target: Path, timestamp: str) -> Path:
    candidate = target.with_name(f"{target.name}.bak.{timestamp}")
    counter = 1
    while candidate.exists():
        candidate = target.with_name(f"{target.name}.bak.{timestamp}.{counter}")
        counter += 1
    return candidate


def _stage_write(target: Path, content: bytes, mode: int) -> Path:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=target.parent
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        return temporary
    except Exception:
        if temporary.exists():
            temporary.unlink()
        raise


def _fsync_directory(directory: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
