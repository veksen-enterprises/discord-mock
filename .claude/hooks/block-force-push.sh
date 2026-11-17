#!/bin/bash
# Gate force-pushes so the rebase-only flow works without dead-ends.
#
# Our flow is rebase-only: we never merge `main` into a feature branch (that
# clutters history with merge commits). But rebasing a branch that's already
# been pushed REWRITES history, and the only way to update the PR afterwards is
# a force-push. `--force-with-lease` is the safe one — it aborts if the remote
# moved since the last fetch, so it can't silently clobber another agent's work.
#
# Policy: allow `--force-with-lease` on feature branches; block plain
# `--force`/`-f` (no lease) anywhere; block ANY force-push to main/master.
# See .claude/rules/git-workflow.md.
cmd=$(jq -r '.tool_input.command // ""')

# Only care about pushes.
case "$cmd" in
  *"git push"*) ;;
  *) exit 0 ;;
esac

# Is this a force-push at all?
case "$cmd" in
  *"--force"* | *" -f"*) ;;
  *) exit 0 ;;
esac

# Never rewrite shared history.
case "$cmd" in
  *main* | *master*)
    echo "Blocked: never force-push main/master." >&2
    exit 2
    ;;
esac

# Safe rewrite on a feature branch — allowed.
case "$cmd" in
  *"--force-with-lease"*) exit 0 ;;
esac

# Plain --force / -f without a lease — require the safe variant.
echo "Blocked: use 'git push --force-with-lease' instead of plain --force/-f on feature branches (and never force-push main)." >&2
exit 2
