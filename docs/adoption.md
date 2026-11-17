# Adoption in sin-bot and the d2armory bot

Checked by reading both repos at their current main.

## sin-bot

Current tests call `execute(interaction)` directly with duck-typed fakes (`src/test/fake-guild.ts`, `discord-mocks.ts`). That skips `interaction-create` routing, discord.js payload parsing and REST serialization: the fake's `send()` accepts whatever the command passes.

Bot changes needed:

- `src/index.ts` builds the `Client` at module top level with side effects (cron, DB). Extract `createClient(options)`.
- `src/setup-commands.ts` creates a module-level `new REST()` with the default API. Pass `api` through, or build the REST from the client.

Mock features needed (from usage counts in `src/`): `interaction.update` (71 calls), message delete, autocomplete `respond`, message component collectors (these should work for free once button/select interactions flow through the gateway), string select menus, DMs (`POST /users/@me/channels`), `guildMemberRemove`/`guildMemberUpdate` dispatch, members fetch.

## d2armory bot

`createBot(config)` is already a factory; add a `clientOptions` parameter.

Mock features needed: message attachments (the bot downloads `attachment.url` with global `fetch`, so the mock must serve attachments from its own host), reactions plus partials (`MESSAGE_REACTION_ADD` for uncached messages), active/archived thread fetches and forum channels for the boot walk, paginated history (`messages.fetch` with `before`, built), DMs.

## Next steps

1. Pick one real flow per bot and make it pass end to end: sin-bot `/join` → leaderboard repost; d2armory image post → ingest → reaction. This drives the feature list above in priority order instead of building the API surface speculatively.
2. Add the bot-side injection changes in each repo (small, listed above).
3. Distribution: git dependency first (`"discord-mock": "github:veksen-enterprises/discord-mock"`), npm publish once the API settles.
