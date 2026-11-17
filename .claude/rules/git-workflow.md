# Git Workflow

## Branches

- **For now, commit and push straight to `main`, no PRs** (JP, 2026-11-17).
  This holds until a consumer depends on discord-mock from git; then switch to
  feature branches and PRs, and update this file.
- Never force-push `main`. A hook enforces this (`.claude/hooks/block-force-push.sh`).
- If a push is rejected, `git fetch origin main && git rebase origin/main`,
  re-run the checks, push again. Never `git merge origin/main`.

## Commit Convention

- Format: `<type>(<scope>): <short infinitive message>`
- Types: `feat`, `fix`, `refact`, `docs`, `tests`, `chore`, `build`, `ci`, `perf`.
- Scope: the area affected (e.g. `rest`, `gateway`, `model`, `interactions`).
- Message: infinitive verb, lowercase, no period. It says what changed and
  why; when behaviour changes, the effect goes in the message.
  - Mechanism hiding the effect: `fix(rest): decode the path before matching`
  - Both: `fix(rest): decode the path so editReply reaches @original`
- One logical change per commit.
- Every commit is authored by Jean-Philippe Sirois <jp@sirois.xyz>; Claude
  appears only as a `Co-Authored-By` trailer.
