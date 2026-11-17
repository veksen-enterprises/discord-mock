---
status: accepted
---

# A Stateful Model, with Overrides on Top

Decided 2026-11-17 in the spike.

**The problem.** A bot reads what it wrote: it posts a message, then fetches
history; it replies, then edits the reply. A test either answers each of those
requests one by one, or keeps a Discord in memory that answers them.

**The decision.** The Mock keeps a Model. Built-in Routes read and write it,
and the Gateway dispatches the changes. On top, a test can add an Override for
any Route (`mock.use(method, path, handler, { once })`), checked first. An
Override returning `undefined` falls through to the Model.

Overrides are for what the Model can't produce: 5xx, 429, dropped connections,
and one-off errors. A permission error comes from the Model (deny the
permission with a channel overwrite), not from an Override.

## Considered Options

**Stateless per-test handlers, msw-style.** Rejected: every test would answer
every GET discord.js makes, and each answer is the test author's guess at
Discord. That is the hand-built-objects problem again, one layer down.

**Model only, no Overrides.** Rejected: outages and rate limits aren't states
of the world, and they're the paths most worth testing.

## Consequences

- World building is part of the API: guilds, channels, members, overwrites.
- A Rule lives in one place and every test gets it.
- An Override that returns what the Model would have returned is a smell; use
  the Model.
