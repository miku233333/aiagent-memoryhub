from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
VERIFIER_PATH = REPOSITORY_ROOT / "script" / "verify_release_artifacts.py"
SPEC = importlib.util.spec_from_file_location("release_verifier", VERIFIER_PATH)
assert SPEC is not None and SPEC.loader is not None
release_verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release_verifier)


def _sha512(path: Path) -> str:
    return base64.b64encode(hashlib.sha512(path.read_bytes()).digest()).decode("ascii")


def _write_update_metadata(path: Path, version: str, payloads: list[Path]) -> None:
    lines = [f"version: {version}", "files:"]
    for payload in payloads:
        lines.extend(
            [
                f"  - url: {payload.name}",
                f"    sha512: {_sha512(payload)}",
                f"    size: {payload.stat().st_size}",
            ]
        )
    lines.extend(
        [
            f"path: {payloads[0].name}",
            f"sha512: {_sha512(payloads[0])}",
            "releaseDate: '2026-08-30T00:00:00.000Z'",
        ]
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _fixture(root: Path, platform: str) -> Path:
    release = root / platform
    release.mkdir()
    version = "0.1.0"
    if platform == "macos":
        prefix = f"AI-Agent-MemoryHub-{version}-mac-arm64"
        zip_path = release / f"{prefix}.zip"
        dmg_path = release / f"{prefix}.dmg"
        zip_path.write_bytes(b"zip payload")
        dmg_path.write_bytes(b"dmg payload")
        (release / f"{prefix}.zip.blockmap").write_bytes(b"zip blockmap")
        (release / f"{prefix}.dmg.blockmap").write_bytes(b"dmg blockmap")
        (release / "mac-arm64").mkdir()
        _write_update_metadata(release / "latest-mac.yml", version, [zip_path, dmg_path])
    else:
        prefix = f"AI-Agent-MemoryHub-{version}-win-x64"
        installer = release / f"{prefix}.exe"
        installer.write_bytes(b"installer payload")
        (release / f"{prefix}.exe.blockmap").write_bytes(b"installer blockmap")
        (release / "win-unpacked").mkdir()
        _write_update_metadata(release / "latest.yml", version, [installer])
    return release


class ArtifactVerifierTests(unittest.TestCase):
    def test_exact_artifacts_stage_and_validate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            mac_release = _fixture(root, "macos")
            win_release = _fixture(root, "windows")
            mac_stage = root / "mac-stage"
            win_stage = root / "win-stage"
            source_sha = "a" * 40

            release_verifier.verify_release(
                platform="macos",
                release_directory=mac_release,
                version="0.1.0",
                arch="arm64",
                source_sha=source_sha,
                stage_directory=mac_stage,
            )
            release_verifier.verify_release(
                platform="windows",
                release_directory=win_release,
                version="0.1.0",
                arch="x64",
                source_sha=source_sha,
                stage_directory=win_stage,
            )

            merged = root / "merged"
            merged.mkdir()
            for stage in (mac_stage, win_stage):
                for source in stage.iterdir():
                    shutil.copy2(source, merged / source.name)
            release_verifier.validate_staged(
                merged,
                [merged / "macos.json", merged / "windows.json"],
                expected_source_sha=source_sha,
                expected_version="0.1.0",
            )

            (merged / "macos.json").write_text(
                (merged / "macos.json")
                .read_text(encoding="utf-8")
                .replace(f'"source_sha": "{source_sha}"', f'"source_sha": "{"b" * 40}"'),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                release_verifier.VerificationError, "does not match release commit"
            ):
                release_verifier.validate_staged(
                    merged,
                    [merged / "macos.json", merged / "windows.json"],
                    expected_source_sha=source_sha,
                    expected_version="0.1.0",
                )

    def test_delivery_layout_requires_artifact_files_and_no_unpacked_directory(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for platform, arch, unpacked_name in (
                ("macos", "arm64", "mac-arm64"),
                ("windows", "x64", "win-unpacked"),
            ):
                release = _fixture(root, platform)
                with self.assertRaisesRegex(
                    release_verifier.VerificationError,
                    "release directories differ",
                ):
                    release_verifier.verify_release(
                        platform=platform,
                        release_directory=release,
                        version="0.1.0",
                        arch=arch,
                        delivery_only=True,
                    )
                shutil.rmtree(release / unpacked_name)
                release_verifier.verify_release(
                    platform=platform,
                    release_directory=release,
                    version="0.1.0",
                    arch=arch,
                    delivery_only=True,
                )

    def test_rejects_extra_release_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            release = _fixture(Path(temporary), "macos")
            (release / "builder-debug.yml").write_text("secret-adjacent debug output")
            with self.assertRaisesRegex(
                release_verifier.VerificationError, "release files differ"
            ):
                release_verifier.verify_release(
                    platform="macos",
                    release_directory=release,
                    version="0.1.0",
                    arch="arm64",
                )

    def test_rejects_update_hash_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            release = _fixture(Path(temporary), "windows")
            installer = release / "AI-Agent-MemoryHub-0.1.0-win-x64.exe"
            installer.write_bytes(b"changed after metadata generation")
            with self.assertRaisesRegex(
                release_verifier.VerificationError, "metadata size mismatch"
            ):
                release_verifier.verify_release(
                    platform="windows",
                    release_directory=release,
                    version="0.1.0",
                    arch="x64",
                )

    def test_rejects_duplicate_update_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            release = _fixture(Path(temporary), "windows")
            metadata = release / "latest.yml"
            text = metadata.read_text(encoding="utf-8")
            entry = "\n".join(text.splitlines()[2:5])
            metadata.write_text(text.replace("path:", f"{entry}\npath:"), encoding="utf-8")
            with self.assertRaisesRegex(
                release_verifier.VerificationError, "metadata payloads differ"
            ):
                release_verifier.verify_release(
                    platform="windows",
                    release_directory=release,
                    version="0.1.0",
                    arch="x64",
                )


class WorkflowContractTests(unittest.TestCase):
    def test_third_party_actions_are_sha_pinned(self) -> None:
        pattern = re.compile(
            r"^\s*- uses: ([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)@([0-9a-f]{40})\s+# (v[^\s]+)$"
        )
        for relative in (".github/workflows/ci.yml", ".github/workflows/release.yml"):
            workflow = (REPOSITORY_ROOT / relative).read_text(encoding="utf-8")
            external = [line for line in workflow.splitlines() if "- uses:" in line and "./" not in line]
            self.assertTrue(external, relative)
            for line in external:
                self.assertRegex(line, pattern, f"unpinned action in {relative}: {line}")

    def test_checkout_never_persists_credentials(self) -> None:
        for relative in (".github/workflows/ci.yml", ".github/workflows/release.yml"):
            workflow = (REPOSITORY_ROOT / relative).read_text(encoding="utf-8")
            checkouts = workflow.count("uses: actions/checkout@")
            self.assertEqual(checkouts, workflow.count("persist-credentials: false"))

    def test_release_security_gates_are_source_visible(self) -> None:
        workflow = (REPOSITORY_ROOT / ".github/workflows/release.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn("permissions:\n  contents: read", workflow)
        self.assertRegex(
            workflow,
            r"(?ms)^  publish:.*?^    permissions:\n      contents: write$",
        )
        self.assertIn("git merge-base --is-ancestor", workflow)
        self.assertEqual(workflow.count("environment: release-signing"), 2)
        for line in workflow.splitlines():
            if "${{ secrets." in line:
                self.assertGreaterEqual(len(line) - len(line.lstrip()), 10)

    def test_packager_uses_only_canonical_pyinstaller_spec(self) -> None:
        packager = (REPOSITORY_ROOT / "script" / "package_desktop.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("packaging/ai-agent-memoryhub-sidecar.spec", packager)
        self.assertNotIn("script/memory_hub_sidecar.py", packager)
        self.assertFalse((REPOSITORY_ROOT / "script" / "memory_hub_sidecar.py").exists())

    def test_local_macos_packages_are_ad_hoc_signed_outside_the_workspace(self) -> None:
        package = (REPOSITORY_ROOT / "desktop" / "package.json").read_text(
            encoding="utf-8"
        )
        package_config = json.loads(package)
        packager = (REPOSITORY_ROOT / "script" / "package_desktop.sh").read_text(
            encoding="utf-8"
        )
        hook = (REPOSITORY_ROOT / "desktop" / "scripts" / "afterPack.cjs").read_text(
            encoding="utf-8"
        )
        sign_hook = (
            REPOSITORY_ROOT / "desktop" / "scripts" / "afterSign.cjs"
        ).read_text(encoding="utf-8")
        self.assertIn('"afterPack": "scripts/afterPack.cjs"', package)
        self.assertIn('"afterSign": "scripts/afterSign.cjs"', package)
        self.assertIs(
            package_config["build"]["electronFuses"]["resetAdHocDarwinSignature"],
            True,
        )
        self.assertIn('"MEMORY_HUB_ADHOC_SIGN=1"', packager)
        self.assertIn("unset MEMORY_HUB_ADHOC_SIGN", packager)
        self.assertIn('--config.directories.output="${electron_release_directory}"', packager)
        self.assertIn('"/usr/bin/xattr"', hook)
        self.assertNotIn('"--sign",', hook)
        self.assertIn('"--sign",', sign_hook)
        self.assertIn('"-",', sign_hook)

    def test_packager_keeps_unpacked_apps_out_of_the_delivery_directory(self) -> None:
        packager = (REPOSITORY_ROOT / "script" / "package_desktop.sh").read_text(
            encoding="utf-8"
        )
        verify_position = packager.index(
            '"${python_command}" "${SCRIPT_DIR}/verify_release_artifacts.py" verify'
        )
        quarantine_position = packager.index(
            'mv -- "${unpacked_directory}" "${temporary_root}/verified-unpacked"'
        )
        publish_position = packager.index(
            'mv -- "${electron_release_directory}" "${RELEASE_DIRECTORY}"'
        )
        self.assertLess(verify_position, quarantine_position)
        self.assertLess(quarantine_position, publish_position)
        self.assertRegex(
            packager,
            r'find "\$\{electron_release_directory\}"\s*\\?\s*'
            r'-mindepth 1 -maxdepth 1 ! -type f',
        )
        self.assertIn("MEMORY_HUB_RETAIN_VERIFICATION_OUTPUT", packager)
        self.assertIn('"${VERIFICATION_DIRECTORY}"', packager)

    def test_release_workflow_verifies_hidden_build_evidence_then_delivery_files(
        self,
    ) -> None:
        workflow = (REPOSITORY_ROOT / ".github/workflows/release.yml").read_text(
            encoding="utf-8"
        )
        self.assertEqual(
            workflow.count('MEMORY_HUB_RETAIN_VERIFICATION_OUTPUT: "1"'),
            2,
        )
        self.assertIn('desktop/.release-verification/mac-${arch}', workflow)
        self.assertIn('desktop/.release-verification/win-unpacked', workflow)
        self.assertEqual(workflow.count("--delivery-only"), 2)
        self.assertNotIn('desktop/release/win-unpacked', workflow)

    def test_packager_strips_secrets_before_build_commands(self) -> None:
        packager = (REPOSITORY_ROOT / "script" / "package_desktop.sh").read_text(
            encoding="utf-8"
        )
        unset_position = packager.index(
            "unset CSC_LINK CSC_KEY_PASSWORD CSC_NAME MEMORY_HUB_CODESIGN_IDENTITY"
        )
        install_position = packager.index("pnpm --dir \"${WEB_DIRECTORY}\" install")
        builder_position = packager.index("./node_modules/.bin/electron-builder")
        self.assertLess(unset_position, install_position)
        self.assertLess(install_position, builder_position)
        self.assertIn("export -n sign_csc_link", packager)
        self.assertNotIn("npm --prefix \"${DESKTOP_DIRECTORY}\" run dist:", packager)


if __name__ == "__main__":
    unittest.main()
