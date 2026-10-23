#!/bin/sh
# Portable entry point. All build decisions live in scripts/release.mjs.
set -eu

release_root=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
cd "$release_root"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js 24.13 or later (24.x) is required on the build machine.' >&2
  exit 1
fi
if ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit(major===24 && minor>=13 ? 0 : 1)'; then
  printf '%s\n' 'Node.js 24.13 or later (24.x) is required on the build machine.' >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' 'npm is required on the build machine.' >&2
  exit 1
fi

release_bootstrap=yes
for release_arg in "$@"; do
  case "$release_arg" in --help|-h|--dry-run) release_bootstrap=no ;; esac
done
if [ "$release_bootstrap" = yes ] && { [ ! -f node_modules/@electron/packager/package.json ] || [ ! -f node_modules/tsx/package.json ] || [ ! -f node_modules/typescript/package.json ]; }; then
  # Desktop packaging downloads and verifies its runtime separately.
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --include=dev
fi

exec node scripts/release.mjs "$@"
