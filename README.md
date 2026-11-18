# discordjs-test-kit

A fake Discord that a stock discord.js `Client` logs in to, so a test runs the bot as it ships. It runs a real local HTTP server (REST) and WebSocket server (Gateway) on `127.0.0.1`, keeps an in-memory model of guilds, channels, members, messages and interactions, and refuses what Discord refuses.

```ts
import { createDiscord } from "discordjs-test-kit";

const discord = await createDiscord(); // torn down when the test ends; fails it on a Gap
const server = discord.guild("SIN");
const challengesChannel = discord.channel(server, "challenges");
const alice = discord.member(server, "Alice");
const bot = createBot(discord.clientOptions); // the only change a bot needs
await discord.start(bot.client, { commands });

const reportMenu = await alice.run(challengesChannel, "report");
await alice.select(reportMenu, "5-2"); // the bot updates the same message in place
expect(reportMenu.embeds.at(-1)?.title).toBe("Match Reported!");
```

## Install

```sh
npm install --save-dev discordjs-test-kit
```

Peers: `discord.js` `^14.26.4` and `vitest` `^4.1.2 || ^5.0.0`; CI runs both floors and the locked latest. Node 22 or 24.

Agents writing tests: the package ships a skill at [`skills/discordjs-test-kit/SKILL.md`](skills/discordjs-test-kit/SKILL.md). No agent loads skills from `node_modules` by itself. Link it with [skills-npm](https://github.com/antfu/skills-npm): `npm i -D skills-npm && npx skills-npm setup` symlinks it into `.claude/skills/` (and `.agents/skills/` for other agents) and adds a `prepare` script that relinks after each install. The link points into `node_modules`, so upgrading the kit updates the skill. Or copy the folder into `.claude/skills/` yourself.

## Writing a test

`Discord` builds the World, starts the bot, injects failures and reads what happened. A `Member` acts. Each action has one way to write it.

| `Discord`                                    | Returns             | Notes                                                                       |
| -------------------------------------------- | ------------------- | --------------------------------------------------------------------------- |
| `createDiscord()`                            | `Promise<Discord>`  | One per test, on its own port                                               |
| `guild(name)`                                | `Guild<N>`          |                                                                             |
| `category(guild, name)`                      | `Category<N>`       |                                                                             |
| `channel(guild, name, category?)`            | `TextChannel<N>`    |                                                                             |
| `forum(guild, name)`                         | `Forum<N>`          |                                                                             |
| `member(guild, name, nick?)`                 | `Member<N>`         | A new user who joined `guild`                                               |
| `owner(guild)`                               | `Member<N>`         | Has every permission                                                        |
| `start(client, { commands?, permissions? })` | `Promise<void>`     | `permissions`: what the bot's invite grants, in guilds built before `start` |
| `fail(method, path, response)`               | `void`              | Overrides a Route, e.g. `respond.serverError(503)`                          |
| `archive(thread)`                            | `void`              | Discord archives it for inactivity                                          |
| `messages(channel)`                          | `Message[]`         | Oldest first, live objects                                                  |
| `dms(member)`                                | `Message[]`         | The bot's DMs with `member`                                                 |
| `find(where, text)`                          | `Promise<Message>`  | Waits for a match written since the latest action, up to 2 s                |
| `clientOptions`                              | `{ rest: { api } }` | Spread into the bot's `Client` options                                      |

| `Member`                            | Returns               | Notes                                                    |
| ----------------------------------- | --------------------- | -------------------------------------------------------- |
| `run(channel, "cmd sub", options?)` | `Promise<Message>`    | The visible reply, after any defer                       |
| `click(message, label)`             | `Promise<Message>`    | A button by its label, or its emoji when it has no label |
| `select(message, label)`            | `Promise<Message>`    | A string-select option by its label                      |
| `post(channel, message)`            | `Message`             | Files are served by the mock                             |
| `forumPost(forum, post)`            | `{ thread, message }` |                                                          |
| `react(message, emoji)`             | `void`                |                                                          |
| `nickname(nick \| null)`            | `void`                | null goes back to their name                             |
| `leave()`                           | `void`                |                                                          |

`label` is an exact string or a RegExp, and must match exactly one button or option. `Message` is discord-api-types' `APIMessage`, and it's live: when the bot updates a message in place, the object the test holds shows it. `click` and `select` return the message visible afterwards, which is a new one only when the bot answers with a new message.

**Waiting.** `find(where, text)` resolves with a message in a channel, thread or member's DMs that the bot created or edited since the latest action (a member's action, `start` or `archive`), and whose text contains `text` (or matches a RegExp). The text is the content plus each embed's title, description, fields and footer. A board that already said "Bob" before the action doesn't count, so a bot that never reposts fails. If one is already written it returns the newest; otherwise it resolves as soon as the first matching write lands, and rejects after 2 s showing the last messages. The deadline runs on the real timers, so a test that fakes timers or `Date` still gets the error. To check the bot sent nothing more (exactly one reply, or none), `await discord.idle()`: it resolves once the bot has had no request open and nothing new to react to for 100ms. A bot that works longer than that before its first request looks idle. Something disappearing ("Bob is off the board") is `vi.waitFor`.

**Errors name what's there.** A failed action names messages by their text and lists what exists: `alice can't click "Cancel": "Pick a score" has buttons Confirm, 🔄, Rules`; `/reprot isn't registered. Registered: /report`.

**Types.** Handles carry their kind and guild: a category doesn't fit where a channel goes, and a `Member<"SIN">` can't act in another guild's channel or pass another guild's member as an option. Command names, labels and permissions are runtime checks: discord.js's builders type a command's name as `string`, so the literal never reaches the mock. The probes are in [`test/api.types.ts`](test/api.types.ts).

## Before and after

A `/join` command, as sin-bot writes it: defer ephemerally, find the ladder from the channel's category, store the member's server nickname, answer with an embed. The full runnable version is in [`examples/ladder/`](examples/ladder).

### Before: hand-rolled fakes

```ts
import { createMockChatInputCommandInteraction } from "../test/discord-utils";
// ^ importing this runs its top-level vi.mock("discord.js"): every builder in this file is a stub

it("should add the member to the ladder", async () => {
  const interaction = createMockChatInputCommandInteraction({
    displayName: "Bravo",
  });
  // = { user: { id: "123456789", ... }, member: { displayName: "Bravo" },
  //     deferReply: vi.fn(), editReply: vi.fn() } as unknown as ChatInputCommandInteraction
  vi.spyOn(ladders, "fromChannel").mockReturnValue(store.get("Test Ladder"));
  vi.spyOn(replyModule, "reply").mockReturnValue({
    withSuccess: vi.fn(),
    withError: vi.fn(),
  });

  await executeJoin(interaction, store);

  expect(interaction.deferReply).toHaveBeenCalled();
  expect(store.get("Test Ladder")?.get("123456789")).toBe("Bravo");
  expect(replyModule.reply(interaction).withSuccess).toHaveBeenCalledWith({
    title: "Joined the Ladder!",
    description: "You have successfully joined the ladder. Good luck!",
  });
});
```

The test checks that `executeJoin` called what it was written to call. The ladder lookup and the reply are spied out, the interaction is a cast object, and `execute` is called directly, so command registration and routing never run either.

### After: the bot logs in to the mock

```ts
const discord = await createDiscord();
const server = discord.guild("SIN");
const ladderCategory = discord.category(server, "Test Ladder");
const challengesChannel = discord.channel(server, "challenges", ladderCategory);
const alice = discord.member(server, "alice", { nickname: "Bravo" });
const bot = createBot(store, discord.clientOptions); // the bot's only test seam
await discord.start(bot.client, { commands });

const reply = await alice.run(challengesChannel, "join");

expect(reply.flags! & MessageFlags.Ephemeral).toBe(MessageFlags.Ephemeral);
expect(reply.embeds[0]).toMatchObject({ title: "Joined the Ladder!" });
expect(store.get("Test Ladder")?.get(alice.id)).toBe("Bravo");
```

No `vi.mock`, no spies, no casts. Alice runs `/join` in a channel, and the test reads the message Discord would show her.

### Three bugs, both suites

Each bug was planted in `examples/ladder/` and both suites were run:

| Bug                                                                                | Fakes | Mock                                                                            |
| ---------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------- |
| `reply.ts` calls `interaction.reply` after the defer instead of `editReply`        | pass  | fail: discord.js throws `InteractionAlreadyReplied`, Alice never gets an answer |
| The ladder is looked up by category id instead of name                             | pass  | fail: "No Ladder" in a ladder channel                                           |
| The command is renamed to `join-ladder` in the registration but not in the handler | pass  | fail: `/join` isn't registered                                                  |

## How it hooks in

One option: `rest: { api: mock.apiUrl }`. Checked in discord.js 14.28:

- `@discordjs/rest` builds every URL from `options.api` (`DefaultRestOptions.api`).
- The gateway URL is not configured anywhere. `@discordjs/ws` calls `GET /gateway/bot` through that same REST client and connects to whatever `url` comes back (`WebSocketManager.fetchGatewayInformation`), so pointing REST at the mock also points the gateway at it.
- No global patching, no module mocking. Tests can run in parallel, each with its own mock on its own port.

Why not msw: neither discord.js transport goes through what msw intercepts. See [ADR 0001](docs/adr/0001-bots-connect-to-real-local-servers.md).

## Rules the mock enforces

Why it's strict: [ADR 0003](docs/adr/0003-strict-by-default.md). The other decisions are in [`docs/adr/`](docs/adr), the product direction in [VISION.md](VISION.md), the vocabulary in [GLOSSARY.md](GLOSSARY.md).

| Rule         | Mock behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permissions  | Computed from @everyone, roles and channel overwrites. Missing VIEW_CHANNEL gives 50001, missing SEND_MESSAGES gives 50013. Guilds get a human owner by default, because owners bypass every check.                                                                                                                                                                                                                                                                                                                                                |
| Intents      | No GUILD_MESSAGES, no MESSAGE_CREATE. No MESSAGE_CONTENT, empty content/embeds/attachments/components/poll unless DM, mention or own message. No GUILD_PRESENCES, GUILD_CREATE carries only the bot's own member. Privileged intent not "enabled in the portal": close 4014.                                                                                                                                                                                                                                                                       |
| Commands     | `run()` only works for commands the bot actually registered via `PUT /applications/.../commands`. Options are typed and validated against the registered schema (required, unknown, wrong type, choices).                                                                                                                                                                                                                                                                                                                                          |
| Interactions | Unacknowledged after 3s: 10062. Acknowledged twice: 40060 (codes from Discord's table; HTTP statuses inferred). Deferred replies show as loading until edited; a followUp right after a defer edits the loading message. Callback types 6/7 on a slash command are a Gap. Ephemeral replies don't reach the gateway (inferred).                                                                                                                                                                                                                    |
| Components   | A button is pressed by its label, an option picked by its label; none or several matching, disabled, or a link button fails. Only the invoker can use an ephemeral message's components.                                                                                                                                                                                                                                                                                                                                                           |
| Limits       | Sends, edits, interaction replies and followups over Discord's limits get 400 + 50035: content 2000, 10 embeds, embed title 256, description 4096, 25 fields (name 256, value 1024), footer 2048, author 256, 6000 in total; 5 rows of 5 buttons, custom_id 100, button label 80, 25 select options. The per-field error codes are inferred. A member's option values outside `min_value`/`max_value`/`min_length`/`max_length` are refused, as the Discord app does.                                                                              |
| Members      | `GET`/`PATCH` member (nick, roles, timeouts up to 28 days), role add/remove, kick, ban, unban, ban lookups. Each checks the bot's permission (Manage Nicknames, Manage Roles, Moderate Members, Kick Members, Ban Members) and the role hierarchy: nobody acts on the owner, the bot only acts on members and roles below its highest role, and admins can't be timed out. Refusals are 50013; unknown member, role and ban are 10007, 10011, 10026 (pairings inferred). Voice fields, member flags and a ban's `delete_message_seconds` are Gaps. |
| Gateway      | Bad token on identify or resume: 4004. Unparseable payload: 4002. Op 8 (`members.fetch()`) answers with GUILD_MEMBERS_CHUNK; a full member list needs GUILD_MEMBERS. Op 3 (`setPresence`) is accepted and dropped (inferred). Any other op the mock doesn't answer is a Gap. Dropped connection: discord.js resumes and missed events are replayed.                                                                                                                                                                                                |

**Types.** Payloads are typed with `discord-api-types` (what discord.js itself uses). docs.discord.food is the reference for behaviour that the types don't capture; its source is readable at github.com/discord-userdoccers/discord-userdoccers. Its JSON error-code table loads client-side, so error codes are taken from Discord's own table in discord/discord-api-docs.

## What discord.js does under failure (verified by the tests)

| Discord does                      | discord.js does                                                    | Bot sees                                   |
| --------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ |
| One 5xx                           | Retries immediately (`retries: 3`)                                 | Nothing                                    |
| Persistent 5xx                    | 1 try + 3 retries, then throws                                     | `HTTPError` with `status`                  |
| Closes the connection mid-request | No retry (`shouldRetry` only covers ECONNRESET/abort)              | `other side closed`, code `UND_ERR_SOCKET` |
| Resets the connection             | Retries                                                            | Nothing                                    |
| Route 429                         | Waits `Retry-After` (+50ms offset), retries, forever               | Latency only                               |
| Global 429                        | Stalls every authenticated route; interaction callbacks are exempt | Latency only                               |
| 429 with `rejectOnRateLimit` set  | Throws                                                             | `RateLimitError`                           |
| 403 / 404 / 400                   | Throws, no retry                                                   | `DiscordAPIError` with Discord's `code`    |

The "closed vs reset" split is a real asymmetry in `@discordjs/rest`. Which one a real Discord outage produces is unchecked.

## Not done yet

- Most of the API surface. Unimplemented routes return 404 and are recorded, and the test fails when it ends, so a Gap is never mistaken for a pass.
- Gateway `zlib-stream` and ETF. discord.js asks for zlib-stream when `zlib-sync` is installed. The mock records a Gap and closes with 4000, but discord.js resumes on 4000, so the bot reconnects in a loop until the test times out; the Gap check at teardown names the cause.
- Known differences from docs.discord.food, not fixed yet: interaction tokens never expire (Discord: 15 minutes); callback `flags` aren't filtered to the five allowed ones; command `version` changes on every PUT; registered commands lack `nsfw`, `contexts`, `integration_types` defaults; timed-out members keep all their permissions (Discord: only VIEW_CHANNEL and READ_MESSAGE_HISTORY); editing overwrites doesn't check the bot holds what it allows; no `X-RateLimit-*` headers outside 429s; READY lacks `session_type`; RESUME ignores `seq`; identify doesn't check 4003/4005/4013; component replies get message type 20 (unchecked); a member's own channel permissions aren't checked when they post, react or press (only that they're in the server).
- Components V2 limits (40 components, 4000 characters of text). Autocomplete, modals, multi-select menus, partials, context-menu (user and message) commands.
- The contract check against real Discord (`contract/`, nightly in Actions) covers only what a bot can trigger itself. User actions (slash commands, button presses, the 3s deadline, 40060) stay modelled from the docs, not checked.

What each consumer needs next: [docs/adoption.md](docs/adoption.md).
