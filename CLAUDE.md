# discord-mock

A fake Discord (REST + Gateway) that a stock discord.js bot connects to in
tests. Consumers: sin-bot and the d2armory bot.

**Read `VISION.md` for product direction**: the north star (a passing bot test
means the bot works on Discord), the guiding principle (test the bot as it
ships), the values (fidelity, speed, tests that read like what users do), the
non-goals and the open questions. Use it to judge whether a change serves the
project.

**Read `GLOSSARY.md` for the ubiquitous language** (Mock, Model, Rule, Gap,
Override, Actor, Dispatch, Interaction run, …). Use its canonical terms; honor
its `_Avoid_` lists, in code names too.

**Read `docs/adr/`** before changing the area an ADR covers. If a change
contradicts one, say so explicitly rather than silently overriding it.

## Stack

- TypeScript (ESM), Node 22+ (CI runs 22 and 24: sin-bot is on 22, d2armory on 24)
- discord.js 14 as a peer dependency; `discord-api-types` for payloads; `ws`
- Vitest | Linter: OxLint | Formatter: OxFmt

## Commands

```
npm run test          # vitest run (contract scenarios run against the mock only)
npm run test:contract # mock vs the real test guild; needs DISCORD_CONTRACT_TOKEN
npm run typecheck     # tsc --noEmit
npm run lint          # oxlint
npm run lint:fix      # oxlint --fix
npm run format        # oxfmt (write)
npm run format:check  # oxfmt (check only)
```

## Layout

- `src/index.ts` — the public API: `createDiscord`, Members, `find`. The only export
- `test/api.types.ts` — type probes: misuses that must not compile
- `src/internal/mock.ts` — `createDiscordMock`, world building, Actors, built-in Routes
- `src/internal/state.ts` — the Model
- `src/internal/rest.ts` — Route matching, Overrides, the Request log, `respond.*`
- `src/internal/gateway.ts` — Sessions, identify/resume, intent-filtered Dispatches
- `src/internal/payloads.ts` — permission computation, Gateway payload builders
- `test/fixtures/bot.ts` — a small stock bot the tests drive
- `contract/` — the same bot-triggered scenarios against the mock and the test guild,
  compared by status and shape; accepted differences in `baseline.json`. Runs nightly
  in Actions (`.github/workflows/contract.yml`); this container can't reach discord.com
- `docs/adoption.md` — what each consumer needs, checked against their repos

## Modelling Discord

- Every Rule cites its source next to the code: a docs.discord.food page,
  Discord's docs, or the discord.js function whose behaviour it relies on.
- A behaviour not checked against real Discord is marked "inferred, not
  checked" until a contract test covers it.
- A new Route or Dispatch comes with a test that drives it through a stock
  `Client`, never by calling the Mock's internals.
- Never answer a request with a guess. Without a Route, it's a Gap.

## Workflow — ALWAYS Follow This Order

1. **Research** — Read Discord's docs and the discord.js source first. DO NOT guess. See `.claude/rules/research.md`.
2. **Plan** — State what you'll do and why BEFORE writing code. Get confirmation on non-trivial changes.
3. **Implement** — Write the code, with tests for new code.
4. **Finish** — Run `/finish` before saying done.

## Honesty Policy

- NEVER say something works if you cannot validate it.
- NEVER say something is complete if you haven't verified it.
- If unsure, ASK. Don't guess, don't take shortcuts.
- If a fix fails twice for the same issue, STOP. Analyze root cause first.

## Git Workflow

See `.claude/rules/git-workflow.md`. For now JP wants commits pushed straight
to `main`, no PRs.

## Code Comments

- Explain WHY, not WHAT. Only when the WHY is non-obvious.
- No filler. No AI-slop comments.

## Mistakes

Record mistakes in `.claude/rules/mistakes.md`: the lesson at the top, one
bullet each.
