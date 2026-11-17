# Design notes and next steps

The README covers what exists. This file covers decisions still open and the path to using it in sin-bot and d2armory.

## Decisions taken in the spike

- **Real servers, not interception.** One `rest.api` option redirects both REST and the gateway (see README). Cost: a bot must let tests pass client options. Benefit: the whole discord.js stack runs (parsing, caching, REST queueing, rate-limit handling, gateway resume), which is exactly the code the current tests skip.
- **Stateful model with overrides.** Per-test stateless handlers would force every test to stub each GET that discord.js makes, and stubs are where "we pretend the code works" comes from. Overrides exist only for what the model can't produce.
- **Strict by default.** Unregistered commands, wrong option types, missing permissions, missing intents and unhandled routes all fail. A permissive mock reproduces the current problem.
- **Single package, not a monorepo.** There is one library and no second package that would share code with it. The consumers live in their own repos. If a second package shows up (vitest matchers, a recorder), move to the monorepo-boilerplate then. Tooling should still match the bots: vitest, oxlint, oxfmt, tsgo.

## Main risk: the mock can lie

A mock that disagrees with Discord produces green tests and broken bots, which is worse than no test. Mitigations, in order of value:

1. **Contract tests against real Discord.** Run the same scenario file against a private test guild (real token, CI secret, nightly) and against the mock, and diff the REST responses and gateway events by shape. This is the only thing that turns "modelled from the docs" into "checked". Not built.
2. **Unhandled requests fail.** Already built: gaps surface as failures, not passes.
3. **Every rule cites its source** (docs.discord.food page or discord.js source line) next to the code, so a reviewer can check it.

## Adoption: what each bot needs

Checked by reading both repos at their current main.

### sin-bot

Current tests call `execute(interaction)` directly with duck-typed fakes (`src/test/fake-guild.ts`, `discord-mocks.ts`). That skips `interaction-create` routing, discord.js payload parsing and REST serialization: the fake's `send()` accepts whatever the command passes.

Bot changes needed:
- `src/index.ts` builds the `Client` at module top level with side effects (cron, DB). Extract `createClient(options)`.
- `src/setup-commands.ts` creates a module-level `new REST()` with the default API. Pass `api` through, or build the REST from the client.

Mock features needed (from usage counts in `src/`): `interaction.update` (71 calls), message delete, autocomplete `respond`, message component collectors (these should work for free once button/select interactions flow through the gateway), string select menus, DMs (`POST /users/@me/channels`), `guildMemberRemove`/`guildMemberUpdate` dispatch, members fetch.

### d2armory bot

`createBot(config)` is already a factory; add a `clientOptions` parameter.

Mock features needed: message attachments (the bot downloads `attachment.url` with global `fetch`, so the mock must serve attachments from its own host), reactions plus partials (`MESSAGE_REACTION_ADD` for uncached messages), active/archived thread fetches and forum channels for the boot walk, paginated history (`messages.fetch` with `before`, built), DMs.

## Proposed next steps

1. Pick one real flow per bot and make it pass end to end: sin-bot `/join` → leaderboard repost; d2armory image post → ingest → reaction. This drives the feature list above in priority order instead of building the API surface speculatively.
2. Add the bot-side injection changes in each repo (small, listed above).
3. Contract test harness against a test guild.
4. Distribution: git dependency first (`"discord-mock": "github:veksen-enterprises/discord-mock"`), npm publish once the API settles.
