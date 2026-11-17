---
globs: "*"
---

# Research Rules

## When to Research

- Before modelling any Discord behaviour: a route, an event, an error code, a limit
- Unfamiliar discord.js or @discordjs/* internals
- A fix attempt has failed

## How to Research

1. Read the project's own code first — grep for existing usage patterns.
2. For Discord behaviour, read https://docs.discord.food/reference and the official docs. Don't rely on training data: the API changes.
3. For how discord.js reacts, read its source in `node_modules` (`@discordjs/rest`, `@discordjs/ws`, `discord.js/src`). Cite the function in the code comment or the test name.
4. When docs and discord.js disagree, or the docs are silent, say so in the code. Mark the behaviour "inferred, not checked against Discord" until a contract test covers it.
5. Use subagents for deep research to avoid polluting main context.
6. Summarize findings before implementing.

## Planning

For non-trivial changes (>20 lines, new feature, architectural): write a plan stating what files change, the approach, and risks. Wait for confirmation.
