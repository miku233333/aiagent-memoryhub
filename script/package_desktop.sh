#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
DESKTOP_DIRECTORY="${REPOSITORY_ROOT}/desktop"
WEB_DIRECTORY="${REPOSITORY_ROOT}/web"
BACKEND_DIRECTORY="${REPOSITORY_ROOT}/backend"
BACKEND_RESOURCE_DIRECTORY="${DESKTOP_DIRECTORY}/resources/Backend"
RELEASE_DIRECTORY="${DESKTOP_DIRECTORY}/release"
PYINSTALLER_VERSION="6.22.2"
readonly SCRIPT_DIR REPOSITORY_ROOT DESKTOP_DIRECTORY WEB_DIRECTORY
readonly BACKEND_DIRECTORY BACKEND_RESOURCE_DIRECTORY RELEASE_DIRECTORY
readonly PYINSTALLER_VERSION

# Signing material is captured by this trusted wrapper and immediately removed
# from the exported environment. Dependency installation, source compilation,
# and PyInstaller never receive signing or notarization credentials. The values
# are injected only into the final electron-builder process.
sign_csc_link="${CSC_LINK:-}"
sign_csc_key_password="${CSC_KEY_PASSWORD:-}"
sign_csc_name="${CSC_NAME:-}"
sign_codesign_identity="${MEMORY_HUB_CODESIGN_IDENTITY:-}"
sign_apple_id="${APPLE_ID:-}"
sign_apple_password="${APPLE_APP_SPECIFIC_PASSWORD:-}"
sign_apple_team_id="${APPLE_TEAM_ID:-}"
set +a
export -n sign_csc_link sign_csc_key_password sign_csc_name
export -n sign_codesign_identity sign_apple_id sign_apple_password sign_apple_team_id
unset CSC_LINK CSC_KEY_PASSWORD CSC_NAME MEMORY_HUB_CODESIGN_IDENTITY
unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID

target="${1:-}"
case "${target}" in
  mac)
    if [[ "$(uname -s)" != "Darwin" ]]; then
      printf 'The mac target must be built on macOS.\n' >&2
      exit 2
    fi
    sidecar_filename="ai-agent-memoryhub-sidecar"
    case "$(uname -m)" in
      arm64) target_arch="arm64" ;;
      x86_64) target_arch="x64" ;;
      *)
        printf 'Unsupported macOS release architecture: %s\n' "$(uname -m)" >&2
        exit 2
        ;;
    esac
    release_platform="macos"
    ;;
  win)
    case "$(uname -s)" in
      MINGW*|MSYS*|CYGWIN*) ;;
      *)
        printf 'The win target must be built from Git Bash on Windows.\n' >&2
        exit 2
        ;;
    esac
    sidecar_filename="ai-agent-memoryhub-sidecar.exe"
    target_arch="x64"
    release_platform="windows"
    ;;
  *)
    printf 'Usage: %s [mac|win]\n' "$0" >&2
    exit 2
    ;;
esac

if [[ -n "${sign_csc_link}" && -z "${sign_csc_key_password}" ]] \
  || [[ -z "${sign_csc_link}" && -n "${sign_csc_key_password}" ]]; then
  printf 'CSC_LINK and CSC_KEY_PASSWORD must be supplied together.\n' >&2
  exit 2
fi
if [[ -n "${sign_apple_id}" || -n "${sign_apple_password}" ]]; then
  if [[ -z "${sign_apple_id}" || -z "${sign_apple_password}" \
    || ! "${sign_apple_team_id}" =~ ^[A-Z0-9]{10}$ ]]; then
    printf 'Apple notarization requires APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and a valid APPLE_TEAM_ID.\n' >&2
    exit 2
  fi
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$1" >&2
    exit 1
  fi
}

require_command node
require_command npm
require_command pnpm
require_command uv

if [[ -e "${RELEASE_DIRECTORY}" ]]; then
  printf 'Refusing to overwrite existing desktop artifacts at %s.\n' \
    "${RELEASE_DIRECTORY}" >&2
  printf 'Move or remove that exact directory before packaging again.\n' >&2
  exit 1
fi

python_command="${PYTHON_BIN:-}"
if [[ -z "${python_command}" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    python_command="python3"
  elif command -v python >/dev/null 2>&1; then
    python_command="python"
  else
    printf 'Python 3.12 or newer is required.\n' >&2
    exit 1
  fi
fi

"${python_command}" -c '
import sys
if sys.version_info < (3, 12):
    raise SystemExit("Python 3.12 or newer is required")
'

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/aiagent-memoryhub-package.XXXXXX")"
backend_environment="${temporary_root}/backend-venv"
pyinstaller_dist="${temporary_root}/pyinstaller-dist"
resource_backup="${temporary_root}/resource-backup"
electron_release_directory="${temporary_root}/electron-release"
readonly temporary_root backend_environment pyinstaller_dist resource_backup
readonly electron_release_directory
backend_was_present=0
resources_staged=0
package_completed=0
local_adhoc_signing=0

validate_resource_paths() {
  [[ "${BACKEND_RESOURCE_DIRECTORY}" == "${REPOSITORY_ROOT}/desktop/resources/Backend" ]]
}

validate_release_path() {
  [[ "${RELEASE_DIRECTORY}" == "${REPOSITORY_ROOT}/desktop/release" ]]
}

restore_resources() {
  if [[ "${resources_staged}" != "1" ]]; then
    return
  fi
  validate_resource_paths || {
    printf 'Refusing to clean unexpected resource paths.\n' >&2
    return 1
  }
  rm -rf -- "${BACKEND_RESOURCE_DIRECTORY}"
  if [[ "${backend_was_present}" == "1" ]]; then
    mv -- "${resource_backup}/Backend" "${BACKEND_RESOURCE_DIRECTORY}"
  fi
  resources_staged=0
}

cleanup() {
  if restore_resources; then
    rm -rf -- "${temporary_root}"
  else
    printf 'Resource restoration failed; backup retained at %s.\n' \
      "${resource_backup}" >&2
  fi
  if [[ "${package_completed}" != "1" && -e "${RELEASE_DIRECTORY}" ]]; then
    if validate_release_path; then
      rm -rf -- "${RELEASE_DIRECTORY}"
      printf 'Removed incomplete package output at %s.\n' \
        "${RELEASE_DIRECTORY}" >&2
    else
      printf 'Refusing to clean unexpected release path.\n' >&2
    fi
  fi
  sign_csc_link=""
  sign_csc_key_password=""
  sign_csc_name=""
  sign_codesign_identity=""
  sign_apple_id=""
  sign_apple_password=""
  sign_apple_team_id=""
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Installing locked web and desktop dependencies without signing credentials...\n'
CI=true pnpm --dir "${WEB_DIRECTORY}" install --frozen-lockfile
npm --prefix "${DESKTOP_DIRECTORY}" ci

printf 'Building the web interface and Electron main process...\n'
pnpm --dir "${WEB_DIRECTORY}" run build
npm --prefix "${DESKTOP_DIRECTORY}" run build

printf 'Creating an isolated Python build environment...\n'
uv_environment_path="${backend_environment}"
if [[ "${target}" == "win" ]]; then
  require_command cygpath
  uv_environment_path="$(cygpath -w "${backend_environment}")"
fi
UV_PROJECT_ENVIRONMENT="${uv_environment_path}" \
  uv sync \
    --project "${BACKEND_DIRECTORY}" \
    --frozen \
    --no-dev \
    --no-editable \
    --extra build \
    --python "${python_command}"

if [[ "${target}" == "win" ]]; then
  backend_python="${backend_environment}/Scripts/python.exe"
else
  backend_python="${backend_environment}/bin/python"
fi
if [[ ! -x "${backend_python}" ]]; then
  printf 'The isolated backend Python interpreter was not created.\n' >&2
  exit 1
fi

resolved_pyinstaller_version="$("${backend_python}" -c 'import PyInstaller; print(PyInstaller.__version__)')"
if [[ "${resolved_pyinstaller_version}" != "${PYINSTALLER_VERSION}" ]]; then
  printf 'Expected PyInstaller %s, got %s.\n' \
    "${PYINSTALLER_VERSION}" "${resolved_pyinstaller_version}" >&2
  exit 1
fi

printf 'Building backend sidecar with PyInstaller %s...\n' "${PYINSTALLER_VERSION}"
(
  cd -- "${BACKEND_DIRECTORY}"
  "${backend_python}" -m PyInstaller \
    --clean \
    --noconfirm \
    --distpath "${pyinstaller_dist}" \
    --workpath "${temporary_root}/pyinstaller-work" \
    "${BACKEND_DIRECTORY}/packaging/ai-agent-memoryhub-sidecar.spec"
)

sidecar_source="${pyinstaller_dist}/${sidecar_filename}"
if [[ ! -f "${sidecar_source}" ]]; then
  printf 'PyInstaller did not create %s.\n' "${sidecar_source}" >&2
  exit 1
fi

validate_resource_paths
mkdir -p -- "${resource_backup}" "${DESKTOP_DIRECTORY}/resources"
resources_staged=1
if [[ -e "${BACKEND_RESOURCE_DIRECTORY}" ]]; then
  mv -- "${BACKEND_RESOURCE_DIRECTORY}" "${resource_backup}/Backend"
  backend_was_present=1
fi
mkdir -p -- "${BACKEND_RESOURCE_DIRECTORY}"

cp -- "${sidecar_source}" "${BACKEND_RESOURCE_DIRECTORY}/${sidecar_filename}"

if [[ "${target}" == "mac" ]]; then
  signing_environment=()
  if [[ -z "${sign_csc_link}" && -z "${sign_csc_name}" \
    && -z "${sign_codesign_identity}" ]]; then
    signing_environment+=(
      "CSC_IDENTITY_AUTO_DISCOVERY=false"
      "MEMORY_HUB_ADHOC_SIGN=1"
    )
    local_adhoc_signing=1
    printf 'No macOS signing identity supplied; producing ad hoc-signed test artifacts.\n'
  elif [[ -n "${sign_codesign_identity}" && -z "${sign_csc_link}" \
    && -z "${sign_csc_name}" ]]; then
    signing_environment+=("CSC_NAME=${sign_codesign_identity}")
    printf 'macOS signing identity supplied; the release workflow will verify signing and notarization.\n'
  else
    [[ -n "${sign_csc_link}" ]] \
      && signing_environment+=("CSC_LINK=${sign_csc_link}")
    [[ -n "${sign_csc_key_password}" ]] \
      && signing_environment+=("CSC_KEY_PASSWORD=${sign_csc_key_password}")
    [[ -n "${sign_csc_name}" ]] \
      && signing_environment+=("CSC_NAME=${sign_csc_name}")
    printf 'macOS signing credentials supplied; the release workflow will verify signing and notarization.\n'
  fi
  [[ -n "${sign_apple_id}" ]] && signing_environment+=("APPLE_ID=${sign_apple_id}")
  [[ -n "${sign_apple_password}" ]] \
    && signing_environment+=("APPLE_APP_SPECIFIC_PASSWORD=${sign_apple_password}")
  [[ -n "${sign_apple_team_id}" ]] \
    && signing_environment+=("APPLE_TEAM_ID=${sign_apple_team_id}")
  (
    cd -- "${DESKTOP_DIRECTORY}"
    env "${signing_environment[@]}" \
      ./node_modules/.bin/electron-builder \
        --mac dmg zip \
        --config.directories.output="${electron_release_directory}" \
        --publish never
  )
else
  signing_environment=()
  if [[ -z "${sign_csc_link}" ]]; then
    signing_environment+=("CSC_IDENTITY_AUTO_DISCOVERY=false")
    printf 'No Windows signing certificate supplied; producing unsigned test artifacts.\n'
  else
    signing_environment+=("CSC_LINK=${sign_csc_link}")
    [[ -n "${sign_csc_key_password}" ]] \
      && signing_environment+=("CSC_KEY_PASSWORD=${sign_csc_key_password}")
    printf 'Windows signing credentials supplied; the release workflow will verify Authenticode.\n'
  fi
  (
    cd -- "${DESKTOP_DIRECTORY}"
    env "${signing_environment[@]}" \
      ./node_modules/.bin/electron-builder \
        --win nsis \
        --config.directories.output="${electron_release_directory}" \
        --publish never
  )
fi

# electron-builder diagnostics are useful during the run but are not release
# artifacts. Preserve them only inside the temporary build root, then require
# an exact artifact set and updater metadata/hash match.
for diagnostic_name in builder-debug.yml builder-effective-config.yaml; do
  if [[ -f "${electron_release_directory}/${diagnostic_name}" ]]; then
    mv -- "${electron_release_directory}/${diagnostic_name}" \
      "${temporary_root}/${diagnostic_name}"
  fi
done

desktop_version="$(node -p \
  "require('${DESKTOP_DIRECTORY}/package.json').version")"
"${python_command}" "${SCRIPT_DIR}/verify_release_artifacts.py" verify \
  --platform "${release_platform}" \
  --release-dir "${electron_release_directory}" \
  --version "${desktop_version}" \
  --arch "${target_arch}"

if [[ "${target}" == "mac" && "${local_adhoc_signing}" == "1" ]]; then
  "${SCRIPT_DIR}/verify_macos_artifacts.sh" \
    "${electron_release_directory}" "${desktop_version}" "${target_arch}" \
    false ""
fi

mv -- "${electron_release_directory}" "${RELEASE_DIRECTORY}"
package_completed=1
printf 'Desktop artifacts are available under %s/release.\n' "${DESKTOP_DIRECTORY}"
printf 'Signing status is intentionally not asserted by this script; use release verification.\n'
