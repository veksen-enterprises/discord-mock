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
- A method that waits for the bot starts with `waitFor` and names what it returns
  (`waitForMessage`, `waitForDM`, `waitForThread`, `waitForIdle`); a member's action resolves with
  the bot's answer to it. `vi.waitFor` covers state outside Discord.
- A failed action names messages by their text and lists what exists.

**Amended 2026-11-18 (0.2.0).** The first rule for waits was "`find` is the one wait for a
message". By 0.1.1 `thread`, `findThread`, `hearBot` and `idle` waited too, and none of the names
said so: `find(bob, text)` hid that it waits, that it returns a bot message, and that a member means
their DMs. JP's bar since: a name the reader can't explain without the docs is a bad name.

## Consequences

- The core can change freely; its tests import it by path.
- A behaviour a test needs is added to the facade, or it doesn't exist for consumers.
- Option and command names stay runtime checks: discord.js's builders erase their literal types.
