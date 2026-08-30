#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$#" -lt 5 || "$#" -gt 6 ]]; then
  printf 'Usage: %s RELEASE_DIR VERSION ARCH OFFICIAL EXPECTED_TEAM_ID [UNPACKED_DIR]\n' \
    "$0" >&2
  exit 2
fi

release_directory="$1"
version="$2"
arch="$3"
official="$4"
expected_team_id="$5"
unpacked_directory="${6:-${release_directory}/mac-${arch}}"
app_name="AI Agent MemoryHub.app"
bundle_identifier="com.miku233333.memoryhub"
artifact_prefix="AI-Agent-MemoryHub-${version}-mac-${arch}"
source_app="${unpacked_directory}/${app_name}"
zip_artifact="${release_directory}/${artifact_prefix}.zip"
dmg_artifact="${release_directory}/${artifact_prefix}.dmg"
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/memoryhub-macos-verify.XXXXXX")"
zip_root="${temporary_root}/zip"
dmg_root="${temporary_root}/dmg"
dmg_attached=0
readonly release_directory version arch official expected_team_id app_name
readonly unpacked_directory bundle_identifier artifact_prefix source_app
readonly zip_artifact dmg_artifact
readonly temporary_root zip_root dmg_root

cleanup() {
  if [[ "${dmg_attached}" == "1" ]]; then
    hdiutil detach "${dmg_root}" -quiet || true
  fi
  rm -rf -- "${temporary_root}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "${official}" != "true" && "${official}" != "false" ]]; then
  printf 'OFFICIAL must be true or false.\n' >&2
  exit 2
fi
if [[ "${official}" == "true" ]]; then
  if [[ ! "${expected_team_id}" =~ ^[A-Z0-9]{10}$ ]]; then
    printf 'Official macOS verification requires an exact 10-character Team ID.\n' >&2
    exit 1
  fi
elif [[ -n "${expected_team_id}" ]]; then
  printf 'Unsigned artifacts must not claim an expected Team ID.\n' >&2
  exit 1
fi

verify_single_app() {
  local app_path="$1"
  local container_label="$2"
  local actual_identifier
  local actual_team
  local signature_details
  local sidecar_path

  if [[ ! -d "${app_path}" || -L "${app_path}" ]]; then
    printf '%s does not contain the expected regular app bundle.\n' \
      "${container_label}" >&2
    return 1
  fi
  actual_identifier="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
    "${app_path}/Contents/Info.plist")"
  if [[ "${actual_identifier}" != "${bundle_identifier}" ]]; then
    printf '%s bundle identifier mismatch: %s\n' \
      "${container_label}" "${actual_identifier}" >&2
    return 1
  fi
  sidecar_path="${app_path}/Contents/Resources/Backend/ai-agent-memoryhub-sidecar"
  if [[ ! -x "${sidecar_path}" ]]; then
    printf '%s is missing the executable backend sidecar.\n' "${container_label}" >&2
    return 1
  fi
  if [[ ! -f "${app_path}/Contents/Resources/Web/index.html" ]]; then
    printf '%s is missing the packaged web entry point.\n' "${container_label}" >&2
    return 1
  fi

  if [[ "${official}" == "true" ]]; then
    codesign --verify --deep --strict --verbose=2 "${app_path}"
    actual_team="$(codesign -dv --verbose=4 "${app_path}" 2>&1 \
      | sed -n 's/^TeamIdentifier=//p')"
    if [[ "${actual_team}" != "${expected_team_id}" ]]; then
      printf '%s Team ID mismatch: expected %s, got %s\n' \
        "${container_label}" "${expected_team_id}" "${actual_team:-none}" >&2
      return 1
    fi
    codesign --verify --strict --verbose=2 "${sidecar_path}"
    actual_team="$(codesign -dv --verbose=4 "${sidecar_path}" 2>&1 \
      | sed -n 's/^TeamIdentifier=//p')"
    if [[ "${actual_team}" != "${expected_team_id}" ]]; then
      printf '%s sidecar Team ID mismatch: expected %s, got %s\n' \
        "${container_label}" "${expected_team_id}" "${actual_team:-none}" >&2
      return 1
    fi
    codesign --verify --strict --verbose=2 \
      -R="anchor apple generic and certificate leaf[subject.OU] = \"${expected_team_id}\"" \
      "${sidecar_path}"
    codesign --verify --deep --strict --verbose=2 \
      -R="anchor apple generic and certificate leaf[subject.OU] = \"${expected_team_id}\"" \
      "${app_path}"
    spctl --assess --type execute --verbose=2 "${app_path}"
    xcrun stapler validate "${app_path}"
  else
    codesign --verify --deep --strict --verbose=2 "${app_path}"
    actual_team="$(codesign -dv --verbose=4 "${app_path}" 2>&1 \
      | sed -n 's/^TeamIdentifier=//p')"
    if [[ -n "${actual_team}" && "${actual_team}" != "not set" ]]; then
      printf '%s unexpectedly claims Team ID %s.\n' \
        "${container_label}" "${actual_team}" >&2
      return 1
    fi
    signature_details="$(codesign -dv --verbose=4 "${app_path}" 2>&1)"
    if ! grep -q '^Signature=adhoc$' <<<"${signature_details}"; then
      printf '%s is not ad hoc signed for local integrity.\n' \
        "${container_label}" >&2
      return 1
    fi
  fi
}

verify_container_root() {
  local root="$1"
  local label="$2"
  local unexpected_app

  if [[ ! -d "${root}/${app_name}" ]]; then
    printf '%s does not contain %s at its root.\n' "${label}" "${app_name}" >&2
    return 1
  fi
  unexpected_app="$(find "${root}" -mindepth 1 -maxdepth 1 \
    -name '*.app' ! -name "${app_name}" -print -quit)"
  if [[ -n "${unexpected_app}" ]]; then
    printf '%s contains an unexpected app bundle: %s\n' \
      "${label}" "${unexpected_app}" >&2
    return 1
  fi
  verify_single_app "${root}/${app_name}" "${label}"
}

verify_single_app "${source_app}" "electron-builder output"

mkdir -p -- "${zip_root}" "${dmg_root}"
ditto -x -k -- "${zip_artifact}" "${zip_root}"
verify_container_root "${zip_root}" "ZIP artifact"

hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "${dmg_root}" \
  "${dmg_artifact}" >/dev/null
dmg_attached=1
verify_container_root "${dmg_root}" "DMG artifact"

printf 'Every macOS container includes the expected app and passed trust checks.\n'
