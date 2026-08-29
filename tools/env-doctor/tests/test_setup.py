from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from env_doctor.setup import SetupOptions, SetupPlanner


class SetupPlannerTests(unittest.TestCase):
    def test_setup_is_dry_run_until_apply_and_then_creates_four_hooks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            hook = root / "adapters" / "claude-code" / "bin" / "hook.mjs"
            hook.parent.mkdir(parents=True)
            hook.write_text("// local adapter\n", encoding="utf-8")
            planner = SetupPlanner()
            options = SetupOptions(
                project_root=root, hook_entry=hook, user_id="local-user"
            )

            plan = planner.build(options)

            settings_path = root / ".claude" / "settings.local.json"
            self.assertEqual(plan.status, "ready")
            self.assertFalse(settings_path.exists(), "building a plan must not write")

            receipt = planner.apply(plan)
            settings = json.loads(settings_path.read_text(encoding="utf-8"))

            self.assertEqual(receipt.status, "applied")
            self.assertEqual(
                set(settings["hooks"]),
                {"SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"},
            )
            self.assertEqual(settings["env"]["MEMORY_HUB_URL"], "http://127.0.0.1:8787")
            self.assertEqual(settings["env"]["MEMORY_HUB_USER_ID"], "local-user")
            self.assertEqual(
                settings["hooks"]["SessionStart"][0]["matcher"],
                "startup|resume|clear|compact|fork",
            )
            self.assertEqual(
                settings["hooks"]["SessionEnd"][0]["matcher"],
                "clear|resume|logout|prompt_input_exit|other",
            )

    def test_apply_backs_up_and_preserves_unrelated_settings_without_exposing_them_in_plan(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            hook = root / "adapters" / "claude-code" / "bin" / "hook.mjs"
            hook.parent.mkdir(parents=True)
            hook.write_text("// local adapter\n", encoding="utf-8")
            settings_path = root / ".claude" / "settings.local.json"
            settings_path.parent.mkdir()
            original = {
                "env": {"PRIVATE_TOKEN": "do-not-print"},
                "model": "claude-sonnet",
            }
            settings_path.write_text(json.dumps(original), encoding="utf-8")
            planner = SetupPlanner()

            plan = planner.build(
                SetupOptions(project_root=root, hook_entry=hook, user_id="local-user")
            )
            self.assertNotIn("do-not-print", json.dumps(plan.to_dict()))
            receipt = planner.apply(plan)

            updated = json.loads(settings_path.read_text(encoding="utf-8"))
            self.assertEqual(updated["env"]["PRIVATE_TOKEN"], "do-not-print")
            self.assertEqual(updated["model"], "claude-sonnet")
            self.assertEqual(len(receipt.backups), 1)
            backup = Path(receipt.backups[0])
            self.assertEqual(json.loads(backup.read_text(encoding="utf-8")), original)

            second_plan = planner.build(
                SetupOptions(project_root=root, hook_entry=hook, user_id="local-user")
            )
            second_receipt = planner.apply(second_plan)
            self.assertEqual(second_receipt.status, "noop")
            self.assertEqual(second_receipt.backups, [])


if __name__ == "__main__":
    unittest.main()
