from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from env_doctor.setup import SetupOptions, SetupPlanner


class RepositoryContractTests(unittest.TestCase):
    def test_generated_hooks_match_the_repository_adapter_example(self) -> None:
        repository = Path(__file__).resolve().parents[3]
        example_path = (
            repository / "adapters" / "claude-code" / "examples" / "settings.json"
        )
        if not example_path.is_file():
            self.skipTest("repository Claude Code adapter example is not present")
        example = json.loads(example_path.read_text(encoding="utf-8"))

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            hook = root / "adapters" / "claude-code" / "bin" / "hook.mjs"
            hook.parent.mkdir(parents=True)
            hook.write_text("// adapter\n", encoding="utf-8")
            planner = SetupPlanner()
            planner.apply(
                planner.build(SetupOptions(project_root=root, hook_entry=hook))
            )
            generated = json.loads(
                (root / ".claude" / "settings.local.json").read_text(encoding="utf-8")
            )

        self.assertEqual(generated["hooks"], example["hooks"])
        self.assertEqual(
            generated["env"]["MEMORY_HUB_URL"], example["env"]["MEMORY_HUB_URL"]
        )


if __name__ == "__main__":
    unittest.main()
