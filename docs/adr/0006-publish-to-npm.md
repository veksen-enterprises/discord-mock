---
status: accepted
---

# Publish to npm

Decided with JP 2026-11-18.

**The problem.** The bots pinned the kit from git. A git pin builds on install, needs access to the repo, and ties each bot to a commit instead of a version range.

**The decision.** Publish `discordjs-test-kit` to npm under the MIT license, and have the bots depend on `^0.1.0`.

## Consequences

- The facade (ADR 0005) is now a public API under semver. A breaking change to it needs a major version (a minor one while we're on 0.x).
- discord.js support is a promise: the peer range `^14.26.4` is tested in CI on the oldest and newest versions.
- `prepublishOnly` runs typecheck, lint, the format check and the tests, and `prepack` builds `dist`, so a publish can't ship what CI would reject.
