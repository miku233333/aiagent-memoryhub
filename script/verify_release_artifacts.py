#!/usr/bin/env python3
"""Verify electron-builder update artifacts and bind them to a source commit."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import shutil
from pathlib import Path
from typing import Any


_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
_SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class VerificationError(ValueError):
    """Raised when a release artifact violates the publishing contract."""


def _scalar(value: str, *, line_number: int) -> str:
    value = value.strip()
    if not value:
        raise VerificationError(f"empty YAML scalar on line {line_number}")
    if value.startswith("'"):
        if not value.endswith("'") or len(value) < 2:
            raise VerificationError(f"invalid single-quoted scalar on line {line_number}")
        return value[1:-1].replace("''", "'")
    if value.startswith('"'):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as error:
            raise VerificationError(
                f"invalid double-quoted scalar on line {line_number}"
            ) from error
        if not isinstance(parsed, str):
            raise VerificationError(f"non-string scalar on line {line_number}")
        return parsed
    if value[0] in "&*!|>{[" or " #" in value:
        raise VerificationError(f"unsupported YAML scalar on line {line_number}")
    return value


def _add_unique(target: dict[str, str], key: str, value: str, line_number: int) -> None:
    if key in target:
        raise VerificationError(f"duplicate YAML key {key!r} on line {line_number}")
    target[key] = _scalar(value, line_number=line_number)


def _parse_update_metadata(path: Path) -> tuple[dict[str, str], list[dict[str, str]]]:
    """Parse the intentionally small electron-builder update metadata schema.

    A general YAML parser would add another release-time dependency. Rejecting
    aliases, tags, nested objects, and unknown keys also keeps the verified
    representation aligned with what the updater consumes in this project.
    """

    top: dict[str, str] = {}
    files: list[dict[str, str]] = []
    in_files = False
    allowed_top = {"version", "files", "path", "sha512", "releaseDate"}
    allowed_file = {"url", "sha512", "size", "blockMapSize"}

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise VerificationError(f"cannot read update metadata: {path}") from error

    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        if line.startswith("  - "):
            if not in_files:
                raise VerificationError(
                    f"file entry outside files list on line {line_number}"
                )
            key, separator, value = line[4:].partition(":")
            if not separator or key not in allowed_file:
                raise VerificationError(f"unknown file key on line {line_number}")
            entry: dict[str, str] = {}
            _add_unique(entry, key, value, line_number)
            files.append(entry)
            continue
        if line.startswith("    "):
            if not in_files or not files:
                raise VerificationError(
                    f"file property without entry on line {line_number}"
                )
            key, separator, value = line[4:].partition(":")
            if not separator or key not in allowed_file:
                raise VerificationError(f"unknown file key on line {line_number}")
            _add_unique(files[-1], key, value, line_number)
            continue
        if line[0].isspace():
            raise VerificationError(f"unsupported indentation on line {line_number}")

        key, separator, value = line.partition(":")
        if not separator or key not in allowed_top:
            raise VerificationError(f"unknown top-level key on line {line_number}")
        if key == "files":
            if value.strip() or in_files:
                raise VerificationError(f"invalid files declaration on line {line_number}")
            in_files = True
            continue
        in_files = False
        _add_unique(top, key, value, line_number)

    if not files:
        raise VerificationError("update metadata contains no files")
    required_top = {"version", "path", "sha512", "releaseDate"}
    if set(top) != required_top:
        raise VerificationError(
            f"update metadata keys differ: expected {sorted(required_top)}, got {sorted(top)}"
        )
    for entry in files:
        required_file = {"url", "sha512", "size"}
        if not required_file.issubset(entry) or not set(entry).issubset(
            required_file | {"blockMapSize"}
        ):
            raise VerificationError(f"incomplete update file entry: {entry!r}")
    return top, files


def _digest(path: Path, algorithm: str) -> str:
    hasher = hashlib.new(algorithm)
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    if algorithm == "sha512":
        return base64.b64encode(hasher.digest()).decode("ascii")
    return hasher.hexdigest()


def _expected_layout(
    platform: str,
    version: str,
    arch: str,
    *,
    include_unpacked: bool = True,
) -> tuple[list[str], str, list[str]]:
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?", version):
        raise VerificationError(f"invalid release version: {version!r}")
    if arch not in {"arm64", "x64"}:
        raise VerificationError(f"unsupported release architecture: {arch!r}")

    if platform == "macos":
        prefix = f"AI-Agent-MemoryHub-{version}-mac-{arch}"
        artifacts = [
            f"{prefix}.dmg",
            f"{prefix}.dmg.blockmap",
            f"{prefix}.zip",
            f"{prefix}.zip.blockmap",
            "latest-mac.yml",
        ]
        expected_dirs = [f"mac-{arch}"] if include_unpacked else []
        return artifacts, "latest-mac.yml", expected_dirs
    if platform == "windows":
        if arch != "x64":
            raise VerificationError("the committed Windows target supports x64 only")
        prefix = f"AI-Agent-MemoryHub-{version}-win-{arch}"
        artifacts = [f"{prefix}.exe", f"{prefix}.exe.blockmap", "latest.yml"]
        expected_dirs = ["win-unpacked"] if include_unpacked else []
        return artifacts, "latest.yml", expected_dirs
    raise VerificationError(f"unsupported platform: {platform!r}")


def _verify_file_set(directory: Path, expected_files: list[str], expected_dirs: list[str]) -> None:
    if not directory.is_dir():
        raise VerificationError(f"release directory does not exist: {directory}")
    actual_files = sorted(path.name for path in directory.iterdir() if path.is_file())
    actual_dirs = sorted(path.name for path in directory.iterdir() if path.is_dir())
    if actual_files != sorted(expected_files):
        raise VerificationError(
            f"release files differ: expected {sorted(expected_files)}, got {actual_files}"
        )
    if actual_dirs != sorted(expected_dirs):
        raise VerificationError(
            f"release directories differ: expected {sorted(expected_dirs)}, got {actual_dirs}"
        )
    for name in expected_files:
        path = directory / name
        if path.is_symlink() or not path.is_file():
            raise VerificationError(f"artifact must be a regular non-symlink file: {name}")


def _verify_update_metadata(
    release_directory: Path,
    metadata_name: str,
    expected_payloads: list[str],
    version: str,
    primary_name: str,
) -> None:
    top, entries = _parse_update_metadata(release_directory / metadata_name)
    if top["version"] != version:
        raise VerificationError(
            f"metadata version mismatch: expected {version}, got {top['version']}"
        )
    urls = [entry["url"] for entry in entries]
    if urls != expected_payloads or len(set(urls)) != len(urls):
        raise VerificationError(
            f"metadata payloads differ: expected {expected_payloads}, got {urls}"
        )
    if top["path"] != primary_name:
        raise VerificationError(
            f"metadata primary path mismatch: expected {primary_name}, got {top['path']}"
        )

    for entry in entries:
        name = entry["url"]
        if not _SAFE_NAME_RE.fullmatch(name) or Path(name).name != name:
            raise VerificationError(f"unsafe metadata artifact name: {name!r}")
        artifact = release_directory / name
        try:
            expected_size = int(entry["size"])
        except ValueError as error:
            raise VerificationError(f"invalid artifact size for {name}") from error
        if expected_size <= 0 or artifact.stat().st_size != expected_size:
            raise VerificationError(f"metadata size mismatch for {name}")
        if _digest(artifact, "sha512") != entry["sha512"]:
            raise VerificationError(f"metadata SHA-512 mismatch for {name}")
        if "blockMapSize" in entry:
            try:
                block_map_size = int(entry["blockMapSize"])
            except ValueError as error:
                raise VerificationError(f"invalid blockMapSize for {name}") from error
            if block_map_size <= 0:
                raise VerificationError(f"invalid blockMapSize for {name}")

    primary = next(entry for entry in entries if entry["url"] == primary_name)
    if top["sha512"] != primary["sha512"]:
        raise VerificationError("top-level metadata SHA-512 differs from primary file")


def verify_release(
    *,
    platform: str,
    release_directory: Path,
    version: str,
    arch: str,
    source_sha: str | None = None,
    stage_directory: Path | None = None,
    official: bool = False,
    identity: str | None = None,
    delivery_only: bool = False,
) -> dict[str, Any]:
    expected_files, metadata_name, expected_dirs = _expected_layout(
        platform,
        version,
        arch,
        include_unpacked=not delivery_only,
    )
    _verify_file_set(release_directory, expected_files, expected_dirs)

    prefix = f"AI-Agent-MemoryHub-{version}-{'mac' if platform == 'macos' else 'win'}-{arch}"
    payloads = [f"{prefix}.zip", f"{prefix}.dmg"] if platform == "macos" else [f"{prefix}.exe"]
    primary = payloads[0]
    _verify_update_metadata(
        release_directory, metadata_name, payloads, version, primary
    )

    if source_sha is not None and not _SHA_RE.fullmatch(source_sha):
        raise VerificationError("source SHA must be exactly 40 lowercase hex characters")
    if official and not identity:
        raise VerificationError("official artifacts require an expected signing identity")
    if not official and identity:
        raise VerificationError("unsigned artifacts must not claim a signing identity")

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "platform": platform,
        "version": version,
        "arch": arch,
        "source_sha": source_sha,
        "official": official,
        "signing_identity": identity,
        "update_metadata": metadata_name,
        "artifacts": [],
    }
    for name in expected_files:
        artifact = release_directory / name
        manifest["artifacts"].append(
            {
                "name": name,
                "size": artifact.stat().st_size,
                "sha256": _digest(artifact, "sha256"),
            }
        )

    if stage_directory is not None:
        if stage_directory.exists() and any(stage_directory.iterdir()):
            raise VerificationError(f"staging directory is not empty: {stage_directory}")
        stage_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        for artifact in manifest["artifacts"]:
            source = release_directory / artifact["name"]
            destination = stage_directory / artifact["name"]
            shutil.copy2(source, destination, follow_symlinks=False)
            if _digest(destination, "sha256") != artifact["sha256"]:
                raise VerificationError(f"staged artifact hash mismatch: {artifact['name']}")
        manifest_path = stage_directory / f"{platform}.json"
        manifest_path.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
    return manifest


def validate_staged(
    assets_directory: Path,
    manifest_paths: list[Path],
    *,
    expected_source_sha: str,
    expected_version: str,
) -> None:
    if not assets_directory.is_dir():
        raise VerificationError(f"staged assets directory does not exist: {assets_directory}")
    if len(manifest_paths) != 2:
        raise VerificationError("exactly two platform manifests are required")

    expected_names = {path.name for path in manifest_paths}
    seen_platforms: set[str] = set()
    seen_artifacts: set[str] = set()
    if not _SHA_RE.fullmatch(expected_source_sha):
        raise VerificationError("expected source SHA must be 40 lowercase hex characters")

    for manifest_path in manifest_paths:
        if manifest_path.parent.resolve() != assets_directory.resolve():
            raise VerificationError("manifest must be located directly in the assets directory")
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise VerificationError(f"cannot parse manifest: {manifest_path}") from error
        manifest_keys = {
            "schema_version",
            "platform",
            "version",
            "arch",
            "source_sha",
            "official",
            "signing_identity",
            "update_metadata",
            "artifacts",
        }
        if (
            not isinstance(manifest, dict)
            or set(manifest) != manifest_keys
            or manifest.get("schema_version") != 1
        ):
            raise VerificationError(f"invalid manifest schema: {manifest_path}")
        platform = manifest.get("platform")
        if platform not in {"macos", "windows"} or platform in seen_platforms:
            raise VerificationError(f"invalid or duplicate platform manifest: {platform!r}")
        if manifest_path.name != f"{platform}.json":
            raise VerificationError(f"manifest filename does not match platform: {manifest_path}")
        seen_platforms.add(platform)

        current_sha = manifest.get("source_sha")
        current_version = manifest.get("version")
        if current_sha != expected_source_sha:
            raise VerificationError(
                f"manifest source does not match release commit: {manifest_path.name}"
            )
        if current_version != expected_version:
            raise VerificationError(
                f"manifest version does not match release version: {manifest_path.name}"
            )
        arch = manifest.get("arch")
        if not isinstance(arch, str):
            raise VerificationError(f"invalid architecture in {manifest_path.name}")
        expected_files, metadata_name, _ = _expected_layout(
            platform, expected_version, arch
        )
        if manifest.get("update_metadata") != metadata_name:
            raise VerificationError(
                f"manifest update metadata mismatch: {manifest_path.name}"
            )
        official = manifest.get("official")
        identity = manifest.get("signing_identity")
        if not isinstance(official, bool):
            raise VerificationError(f"invalid trust status in {manifest_path.name}")
        if official and (not isinstance(identity, str) or not identity):
            raise VerificationError(f"official manifest lacks identity: {manifest_path.name}")
        if not official and identity is not None:
            raise VerificationError(
                f"unofficial manifest claims an identity: {manifest_path.name}"
            )
        if platform == "macos" and official and not re.fullmatch(
            r"[A-Z0-9]{10}", identity
        ):
            raise VerificationError("macOS manifest contains an invalid Team ID")
        if platform == "windows" and official and not re.fullmatch(
            r".+#[A-F0-9]{40}", identity
        ):
            raise VerificationError("Windows manifest contains an invalid signer identity")

        artifacts = manifest.get("artifacts")
        if not isinstance(artifacts, list) or not artifacts:
            raise VerificationError(f"manifest contains no artifacts: {manifest_path.name}")
        manifest_names = [
            entry.get("name") if isinstance(entry, dict) else None for entry in artifacts
        ]
        if manifest_names != expected_files:
            raise VerificationError(
                f"manifest artifact set differs: expected {expected_files}, got {manifest_names}"
            )
        for entry in artifacts:
            if not isinstance(entry, dict) or set(entry) != {"name", "size", "sha256"}:
                raise VerificationError(f"invalid artifact entry in {manifest_path.name}")
            name = entry["name"]
            if (
                not isinstance(name, str)
                or not _SAFE_NAME_RE.fullmatch(name)
                or name in seen_artifacts
            ):
                raise VerificationError(f"unsafe or duplicate staged artifact: {name!r}")
            seen_artifacts.add(name)
            expected_names.add(name)
            artifact = assets_directory / name
            if artifact.is_symlink() or not artifact.is_file():
                raise VerificationError(f"missing staged artifact: {name}")
            if artifact.stat().st_size != entry["size"]:
                raise VerificationError(f"staged artifact size mismatch: {name}")
            if _digest(artifact, "sha256") != entry["sha256"]:
                raise VerificationError(f"staged artifact SHA-256 mismatch: {name}")

        prefix = (
            f"AI-Agent-MemoryHub-{expected_version}-"
            f"{'mac' if platform == 'macos' else 'win'}-{arch}"
        )
        payloads = (
            [f"{prefix}.zip", f"{prefix}.dmg"]
            if platform == "macos"
            else [f"{prefix}.exe"]
        )
        _verify_update_metadata(
            assets_directory,
            metadata_name,
            payloads,
            expected_version,
            payloads[0],
        )

    if seen_platforms != {"macos", "windows"}:
        raise VerificationError(f"missing platform manifest: {seen_platforms}")
    actual_names = {path.name for path in assets_directory.iterdir() if path.is_file()}
    actual_dirs = [path.name for path in assets_directory.iterdir() if path.is_dir()]
    if actual_dirs or actual_names != expected_names:
        raise VerificationError(
            f"staged assets differ: expected {sorted(expected_names)}, got {sorted(actual_names)}"
        )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("--platform", choices=("macos", "windows"), required=True)
    verify_parser.add_argument("--release-dir", type=Path, required=True)
    verify_parser.add_argument("--version", required=True)
    verify_parser.add_argument("--arch", choices=("arm64", "x64"), required=True)
    verify_parser.add_argument("--source-sha")
    verify_parser.add_argument("--stage-dir", type=Path)
    verify_parser.add_argument("--official", action="store_true")
    verify_parser.add_argument("--identity")
    verify_parser.add_argument(
        "--delivery-only",
        action="store_true",
        help="require only publishable files and reject unpacked application directories",
    )

    staged_parser = subparsers.add_parser("validate-staged")
    staged_parser.add_argument("--assets-dir", type=Path, required=True)
    staged_parser.add_argument("--manifest", action="append", type=Path, required=True)
    staged_parser.add_argument("--source-sha", required=True)
    staged_parser.add_argument("--version", required=True)
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        if args.command == "verify":
            verify_release(
                platform=args.platform,
                release_directory=args.release_dir,
                version=args.version,
                arch=args.arch,
                source_sha=args.source_sha,
                stage_directory=args.stage_dir,
                official=args.official,
                identity=args.identity,
                delivery_only=args.delivery_only,
            )
        else:
            validate_staged(
                args.assets_dir,
                args.manifest,
                expected_source_sha=args.source_sha,
                expected_version=args.version,
            )
    except VerificationError as error:
        print(f"release verification failed: {error}")
        return 1
    print("release artifact verification passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
