---
status: accepted
---

# The Facade Is the Only Public API

Decided with JP 2026-11-18, after driving sin-bot and the d2armory bot through the Mock.

**The problem.** The package exported two layers: the core (`createDiscordMock`, `mock.as(user)`,
the Model) and a facade over it. Both were reachable, so a test, or an agent writing one, could
mix them, and every core rename would break consumers.

**The decision.** `src/index.ts` is the only export: `createDiscord`, the handle types, `respond`
and `Permission`. The core lives in `src/internal/` and is built but not exported, so
`package.json#exports` makes it unreachable. The facade follows four rules:

- One way per action. A Member acts (`alice.run`, `click`, `select`); a message has no methods.
- Users find components by what they see: buttons and options by label, never custom ids.
- `find` is the one wait for a message; `vi.waitFor` covers everything else.
- A failed action names messages by their text and lists what exists.

## Consequences

- The core can change freely; its tests import it by path.
- A behaviour a test needs is added to the facade, or it doesn't exist for consumers.
- Option and command names stay runtime checks: discord.js's builders erase their literal types.
