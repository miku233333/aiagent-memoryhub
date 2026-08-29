from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from env_doctor.setup import SetupOptions, SetupPlanner


class SetupSafetyTests(unittest.TestCase):
    def _root_with_hook(self, temp_dir: str) -> tuple[Path, Path]:
        root = Path(temp_dir)
        hook = root / "adapters" / "claude-code" / "bin" / "hook.mjs"
        hook.parent.mkdir(parents=True)
        hook.write_text("// adapter\n", encoding="utf-8")
        return root, hook

    def test_invalid_existing_json_blocks_apply(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root, hook = self._root_with_hook(temp_dir)
            settings = root / ".claude" / "settings.local.json"
            settings.parent.mkdir()
            settings.write_text("{not-json", encoding="utf-8")
            planner = SetupPlanner()

            plan = planner.build(SetupOptions(project_root=root, hook_entry=hook))

            self.assertEqual(plan.status, "blocked")
            with self.assertRaises(ValueError):
                planner.apply(plan)
            self.assertEqual(settings.read_text(encoding="utf-8"), "{not-json")

    def test_changed_target_after_planning_is_not_overwritten(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root, hook = self._root_with_hook(temp_dir)
            planner = SetupPlanner()
            plan = planner.build(SetupOptions(project_root=root, hook_entry=hook))
            settings = root / ".claude" / "settings.local.json"
            settings.parent.mkdir()
            settings.write_text('{"new": "user change"}\n', encoding="utf-8")

            with self.assertRaises(RuntimeError):
                planner.apply(plan)

            self.assertEqual(
                json.loads(settings.read_text(encoding="utf-8")), {"new": "user change"}
            )

    def test_multi_file_apply_rolls_back_when_a_later_replace_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root, hook = self._root_with_hook(temp_dir)
            exclude = root / ".git" / "info" / "exclude"
            exclude.parent.mkdir(parents=True)
            original_exclude = "# keep me\n"
            exclude.write_text(original_exclude, encoding="utf-8")
            planner = SetupPlanner()
            plan = planner.build(SetupOptions(project_root=root, hook_entry=hook))
            real_replace = os.replace
            call_count = 0

            def fail_second_replace(source: str | Path, target: str | Path) -> None:
                nonlocal call_count
                call_count += 1
                if call_count == 2:
                    raise OSError("simulated replace failure")
                real_replace(source, target)

            with patch("env_doctor.setup.os.replace", side_effect=fail_second_replace):
                with self.assertRaises(OSError):
                    planner.apply(plan)

            self.assertFalse((root / ".claude" / "settings.local.json").exists())
            self.assertEqual(exclude.read_text(encoding="utf-8"), original_exclude)

    def test_optional_mcp_setup_never_adds_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root, hook = self._root_with_hook(temp_dir)
            planner = SetupPlanner()

            plan = planner.build(
                SetupOptions(
                    project_root=root,
                    hook_entry=hook,
                    mcp_url="http://127.0.0.1:8787/mcp",
                )
            )
            receipt = planner.apply(plan)
            mcp = json.loads((root / ".mcp.json").read_text(encoding="utf-8"))

            self.assertEqual(receipt.status, "applied")
            self.assertEqual(
                mcp["mcpServers"]["omnimemory"],
                {"type": "http", "url": "http://127.0.0.1:8787/mcp"},
            )
            self.assertNotIn("headers", mcp["mcpServers"]["omnimemory"])

    def test_apply_adds_project_local_settings_to_git_private_exclude(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root, hook = self._root_with_hook(temp_dir)
            exclude = root / ".git" / "info" / "exclude"
            exclude.parent.mkdir(parents=True)
            exclude.write_text("# existing rule\n*.local\n", encoding="utf-8")
            planner = SetupPlanner()

            plan = planner.build(SetupOptions(project_root=root, hook_entry=hook))
            receipt = planner.apply(plan)

            content = exclude.read_text(encoding="utf-8")
            self.assertIn("# existing rule", content)
            self.assertIn("/.claude/settings.local.json", content.splitlines())
            self.assertIn("/.claude/settings.local.json.bak.*", content.splitlines())
            self.assertIn("/.mcp.json.bak.*", content.splitlines())
            self.assertEqual(len(receipt.backups), 1)
            self.assertIn("exclude.bak.", Path(receipt.backups[0]).name)

    def test_mcp_url_with_credentials_is_blocked_and_redacted(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root, hook = self._root_with_hook(temp_dir)
            plan = SetupPlanner().build(
                SetupOptions(
                    project_root=root,
                    hook_entry=hook,
                    mcp_url="http://user:password@127.0.0.1:8787/mcp",
                )
            )

            self.assertEqual(plan.status, "blocked")
            self.assertNotIn("password", json.dumps(plan.to_dict()))

    @unittest.skipIf(
        os.name == "nt", "symlink creation may require elevated Windows privileges"
    )
    def test_symlink_hook_entry_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root, real_hook = self._root_with_hook(temp_dir)
            link = root / "hook-link.mjs"
            link.symlink_to(real_hook)

            plan = SetupPlanner().build(
                SetupOptions(project_root=root, hook_entry=link)
            )

            self.assertEqual(plan.status, "blocked")


if __name__ == "__main__":
    unittest.main()
