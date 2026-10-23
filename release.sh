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
exec node scripts/release.mjs "$@"
