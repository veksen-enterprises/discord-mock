---
status: accepted
---

# A Single Package, Not a Monorepo

Decided with JP 2026-11-17.

**The problem.** JP's projects start from monorepo-boilerplate (Turborepo, npm
workspaces). discord-mock could follow it.

**The decision.** One package at the repo root. There's one library and no
second package to share code with, and the consumers live in their own repos.
The docs, rules and tooling come from the boilerplate (VISION, GLOSSARY, ADRs,
`.claude/`, oxlint, oxfmt, vitest), without Turborepo or workspaces.

## Consequences

- If a second package appears (vitest matchers, a contract-test recorder),
  revisit this and move to the boilerplate's layout.
