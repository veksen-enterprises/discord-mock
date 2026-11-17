Run the completion checklist before declaring work done.

1. **Tests:** `npm run test`. All must pass.
2. **Typecheck:** `npm run typecheck`. Zero errors.
3. **Lint:** `npm run lint`. Zero errors.
4. **Format:** `npm run format`, then `npm run format:check`; read its verdict
   line, not just the last line.
5. **Scope check:** review `git diff`. Revert unrelated or format-only hunks.
   See `code-quality.md` → Scope Discipline.
6. **Self-review:** run `/review`.
7. **Rebase:** `git fetch origin main && git rebase origin/main`. Never merge.
   Non-trivial conflicts: STOP and ask.
8. **Post-rebase:** re-run tests, typecheck, lint, format.
9. **Commits:** per `git-workflow.md`.
10. **Summary:** what was done, which tests cover it, and caveats, including
    any behaviour marked "inferred, not checked".
