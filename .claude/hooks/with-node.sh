#!/bin/bash
# Run a command with this project's Node on PATH.
#
# `npm` exists only inside nvm here (there is no /usr/local or Homebrew npm),
# and nvm is loaded by ~/.zshrc. Hooks are spawned with `/bin/sh -c`, which is
# not zsh and never reads that file, so a hook only finds `npm` when the Claude
# Code process happened to inherit an nvm PATH from the terminal that launched
# it. Started any other way — Spotlight, the dock, a service — the hook fails
# with `npm: command not found` and, being non-blocking, does so silently.
#
# Sourcing nvm here makes the hooks independent of how the app was started.
# `nvm use` picks up .nvmrc, so hooks run the Node version the repo requires
# rather than whichever one is default.
#
# Usage: .claude/hooks/with-node.sh <command> [args...]
set -uo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  nvm use --silent >/dev/null 2>&1 || true
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "with-node.sh: npm not found (looked for nvm at $NVM_DIR)" >&2
  exit 1
fi

exec "$@"
