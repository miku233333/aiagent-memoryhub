#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly SCRIPT_DIR REPOSITORY_ROOT

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$1" >&2
    exit 1
  fi
}

require_command npm
require_command pnpm
require_command uv

printf 'Building the web interface...\n'
CI=true pnpm --dir "${REPOSITORY_ROOT}/web" install --frozen-lockfile
pnpm --dir "${REPOSITORY_ROOT}/web" run build

printf 'Installing the locked Electron dependencies...\n'
npm --prefix "${REPOSITORY_ROOT}/desktop" ci

printf 'Launching AI Agent MemoryHub...\n'
# Electron owns the development sidecar lifecycle. Starting another backend here
# would race its fixed loopback port and break deterministic cleanup.
npm --prefix "${REPOSITORY_ROOT}/desktop" run start
