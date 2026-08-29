from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path

from env_doctor.cli import build_parser, main


class CliTests(unittest.TestCase):
    def test_check_cli_exposes_explicit_public_network_opt_in(self) -> None:
        args = build_parser().parse_args(["check", "--probe-network"])

        self.assertTrue(args.probe_network)

    def test_setup_cli_is_dry_run_by_default_and_json_is_parseable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            hook = root / "adapters" / "claude-code" / "bin" / "hook.mjs"
            hook.parent.mkdir(parents=True)
            hook.write_text("// adapter\n", encoding="utf-8")
            stdout = io.StringIO()
            stderr = io.StringIO()

            exit_code = main(
                [
                    "setup",
                    "--project-root",
                    str(root),
                    "--hook-entry",
                    str(hook),
                    "--json",
                ],
                stdout=stdout,
                stderr=stderr,
            )

            payload = json.loads(stdout.getvalue())
            self.assertEqual(exit_code, 0)
            self.assertTrue(payload["dry_run"])
            self.assertEqual(payload["status"], "ready")
            self.assertFalse((root / ".claude" / "settings.local.json").exists())
            self.assertEqual(stderr.getvalue(), "")

    def test_setup_cli_requires_apply_for_writes_and_returns_a_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            hook = root / "adapters" / "claude-code" / "bin" / "hook.mjs"
            hook.parent.mkdir(parents=True)
            hook.write_text("// adapter\n", encoding="utf-8")
            stdout = io.StringIO()

            exit_code = main(
                [
                    "setup",
                    "--project-root",
                    str(root),
                    "--hook-entry",
                    str(hook),
                    "--apply",
                    "--json",
                ],
                stdout=stdout,
                stderr=io.StringIO(),
            )

            payload = json.loads(stdout.getvalue())
            self.assertEqual(exit_code, 0)
            self.assertEqual(payload["receipt"]["status"], "applied")
            self.assertTrue((root / ".claude" / "settings.local.json").is_file())

    def test_remote_hub_url_is_rejected_without_writing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            hook = root / "adapters" / "claude-code" / "bin" / "hook.mjs"
            hook.parent.mkdir(parents=True)
            hook.write_text("// adapter\n", encoding="utf-8")
            stdout = io.StringIO()

            exit_code = main(
                [
                    "setup",
                    "--project-root",
                    str(root),
                    "--hook-entry",
                    str(hook),
                    "--hub-url",
                    "https://example.com?token=secret",
                    "--apply",
                    "--json",
                ],
                stdout=stdout,
                stderr=io.StringIO(),
            )

            payload = json.loads(stdout.getvalue())
            self.assertEqual(exit_code, 2)
            self.assertEqual(payload["status"], "blocked")
            self.assertNotIn("secret", stdout.getvalue())
            self.assertFalse((root / ".claude" / "settings.local.json").exists())


if __name__ == "__main__":
    unittest.main()
