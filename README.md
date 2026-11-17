# discord-mock

A fake Discord that a stock discord.js `Client` connects to in tests. It runs a real local HTTP server (REST) and WebSocket server (Gateway) on `127.0.0.1`, keeps an in-memory model of guilds, channels, members, messages and interactions, and lets the test act as users and inject failures.

Status: spike. 21 tests in `test/` show what works today.

```ts
const mock = await createDiscordMock();
const guild = mock.createGuild("test");
const general = mock.createTextChannel(guild, "general");
const alice = mock.createUser("alice");
mock.addMember(guild, alice);

const client = new Client({ intents, ...mock.clientOptions }); // the only change a bot needs
await client.login(mock.token);

const run = mock.as(alice).slashCommand(general, "echo", { text: "hello" });
expect((await run.reply()).content).toBe("hello");

mock.use("POST", "/channels/:id/messages", () => respond.rateLimited({ retryAfter: 0.3 }), { once: true });
```

## How it hooks in

One option: `rest: { api: mock.apiUrl }`. Checked in discord.js 14.28:

- `@discordjs/rest` builds every URL from `options.api` (`DefaultRestOptions.api`).
- The gateway URL is not configured anywhere. `@discordjs/ws` calls `GET /gateway/bot` through that same REST client and connects to whatever `url` comes back (`WebSocketManager.fetchGatewayInformation`), so pointing REST at the mock also points the gateway at it.
- No global patching, no module mocking. Tests can run in parallel, each with its own mock on its own port.

Why not msw: neither discord.js transport goes through what msw intercepts. See [ADR 0001](docs/adr/0001-bots-connect-to-real-local-servers.md).

## Rules the mock enforces

Why it's strict: [ADR 0003](docs/adr/0003-strict-by-default.md). The other decisions are in [`docs/adr/`](docs/adr), the product direction in [VISION.md](VISION.md), the vocabulary in [GLOSSARY.md](GLOSSARY.md).

| Rule | Mock behaviour |
| --- | --- |
| Permissions | Computed from @everyone, roles and channel overwrites. Missing VIEW_CHANNEL gives 50001, missing SEND_MESSAGES gives 50013. Guilds get a human owner by default, because owners bypass every check. |
| Intents | No GUILD_MESSAGES, no MESSAGE_CREATE. No MESSAGE_CONTENT, empty content/embeds/attachments unless DM, mention or own message. Privileged intent not "enabled in the portal": close 4014. |
| Commands | `slashCommand()` only works for commands the bot actually registered via `PUT /applications/.../commands`. Options are typed and validated against the registered schema (required, unknown, wrong type, choices). |
| Interactions | Unacknowledged after 3s: 10062. Acknowledged twice: 40060. Ephemeral replies don't reach the gateway. Deferred replies show as loading until edited. |
| Buttons | `clickButton()` fails if the message has no such button or it's disabled. |
| Gateway | Bad token: 4004. Dropped connection: discord.js resumes and missed events are replayed. |

**Types.** Payloads are typed with `discord-api-types` (what discord.js itself uses). docs.discord.food is the reference for behaviour that the types don't capture: error codes, intent rules, interaction timing.

## What discord.js does under failure (verified by the tests)

| Discord does | discord.js does | Bot sees |
| --- | --- | --- |
| One 5xx | Retries immediately (`retries: 3`) | Nothing |
| Persistent 5xx | 1 try + 3 retries, then throws | `HTTPError` with `status` |
| Closes the connection mid-request | No retry (`shouldRetry` only covers ECONNRESET/abort) | `other side closed`, code `UND_ERR_SOCKET` |
| Resets the connection | Retries | Nothing |
| Route 429 | Waits `Retry-After` (+50ms offset), retries, forever | Latency only |
| Global 429 | Stalls every authenticated route; interaction callbacks are exempt | Latency only |
| 429 with `rejectOnRateLimit` set | Throws | `RateLimitError` |
| 403 / 404 / 400 | Throws, no retry | `DiscordAPIError` with Discord's `code` |

The "closed vs reset" split is a real asymmetry in `@discordjs/rest`. Which one a real Discord outage produces is unchecked.

## Not done yet

- Most of the API surface. Unimplemented routes return 404 and are recorded; `assertNoUnhandledRequests()` turns that into a test failure so a gap is never mistaken for a pass.
- Gateway `zlib-stream` and ETF. discord.js asks for zlib-stream when `zlib-sync` is installed; the mock closes the socket with a clear reason instead of misbehaving.
- Reactions, threads, forums, DMs, members fetch, autocomplete, modals, select menus, attachments upload, partials.
- A contract check against real Discord (VISION.md, open questions). Until then, fidelity is modelled from the docs, not checked.

What each consumer needs next: [docs/adoption.md](docs/adoption.md).
