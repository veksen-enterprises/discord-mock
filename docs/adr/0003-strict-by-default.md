---
status: accepted
---

# Strict by Default

Decided 2026-11-17 in the spike.

**The problem.** A lenient mock answers whatever the bot asks. The bot's test
passes, and the bot fails on Discord: the command was never registered, the
option name has a typo, the intent is missing, the bot lacks a permission.

**The decision.** The Mock refuses what Discord refuses, by default:

- A request with no Route is a Gap and fails the test.
- An Actor can only run a slash command the bot registered, with options that
  match the registered schema.
- Permissions are computed from roles and overwrites. The guild owner is a
  human by default, because an owner bypasses every check.
- Dispatches follow the session's intents; without MESSAGE_CONTENT, content
  arrives empty.
- An interaction acknowledged late (Deadline) or twice fails like on Discord.

A test loosens a Rule explicitly (an option, an Override), never by default.

## Consequences

- First adoption is noisier: a consumer's tests will fail on things that were
  silently wrong. That's the point.
- Each Rule needs a source, so it can be checked and argued with.
