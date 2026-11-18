---
name: discordjs-test-kit
description: Write or fix a test for a discord.js bot with discordjs-test-kit. Use when testing slash commands, buttons, select menus, messages, DMs, member changes or Discord failures, or when a discordjs-test-kit error needs reading.
---

# Testing a discord.js bot with discordjs-test-kit

The bot logs in to a fake Discord over real HTTP and WebSocket. Nothing in discord.js is mocked. A test builds a server, starts the bot, acts as members and reads what the bot did.

## The one seam

The bot must accept client options, and nothing else changes:

```ts
export function createBot(clientOptions: Partial<ClientOptions> = {}) {
  const client = new Client({ intents, ...clientOptions });
  // handlers…
  return { client };
}
```

If the bot builds its `Client` at module load, extract a factory like this first. If the bot also builds its own `new REST()` (for example to deploy commands), spread `clientOptions.rest` into it too, or its requests go to discord.com. Never add test-only branches to bot code.

## A test

```ts
import { createDiscord } from "discordjs-test-kit";

it("should record the result when the winner reports", async () => {
  // Arrange: two members, the bot logged in, and Alice's challenge to Bob
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const challengesChannel = discord.channel(server, "challenges");
  const leaderboardChannel = discord.channel(server, "leaderboard");
  const alice = discord.member(server, "Alice");
  const bob = discord.member(server, "Bob");
  await discord.start(createBot(discord.clientOptions).client, { commands });
  const opponentMenu = await alice.run(challengesChannel, "challenge");
  await alice.select(opponentMenu, "Bob");

  // Act: Bob reports winning 5-2
  const reportMenu = await bob.run(challengesChannel, "report");
  await bob.select(reportMenu, "I won");
  await bob.select(reportMenu, "5-2");

  // Assert
  expect(reportMenu.embeds.at(-1)?.title).toBe("Match Reported!");
  const board = await discord.waitForMessage(leaderboardChannel, /Bob/);
  expect(board.embeds[0]?.description).toMatch(/1\s+Bob/);
});
```

- `createDiscord()` per test. Teardown is automatic and fails the test if the bot hit a route the kit doesn't model.
- `start(client, { commands })` registers commands the way the bot's deploy script would: pass the same command JSON. Add `permissions` (from `Permission`; for a flag it lacks, discord.js's `PermissionFlagsBits` works, both are bigints) when the bot needs more than @everyone's. If the bot deploys its own commands instead, skip `commands` and let it: `client.application.id` is set once `start` resolves.
- Write every test as `// Arrange`, `// Act`, `// Assert`, separated by a blank line. The Act is the one thing the test is about: one member's action, which can take several steps of the same menu. Actions that only set the scene (joining, an earlier challenge) go in Arrange. Assert only after the Act; a second Act is a second test.
- Name variables for what they are: `challengesChannel`, `reportMenu`, `searchResults`, not `c`, `msg`, `res`.

## One way per action

| To…                                              | Write                                                                                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| run a slash command                              | `await alice.run(channel, "admin-config set", { ladder: "Season 1", channel: boardChannel })`                                                       |
| use an app from a context menu                   | `await alice.runApp(channel, bob, "View Profile")` (or a message for a message app)                                                                 |
| check autocomplete suggestions                   | `const choices = await alice.autocomplete(channel, "docs", "query", "Promise.al")`                                                                  |
| press a button                                   | `await alice.click(message, "Join Ladder")` (its label, or its emoji)                                                                               |
| fill the form (modal) the bot opens              | `await alice.click(panel, "Report", { Reason: "spam" })`: the form as the last argument, by field label                                             |
| reach the thread the bot started from a post     | `const thread = await discord.waitForThreadFrom(post)`, whatever the bot named it                                                                   |
| reach a thread the bot started                   | `const thread = await discord.waitForThread(channel, "ticket-alice")`, then `discord.waitForMessage(thread, …)` or `alice.post(thread, …)`          |
| a member who closed their DMs                    | `alice.closeDMs()`: the bot's DMs to them fail with 50007, so test what the bot says instead                                                        |
| pick from a select menu                          | `await alice.select(message, "5-2")`                                                                                                                |
| pick members, roles or channels                  | `await alice.select(setupPanel, [bob, discord.role(server, "mods")])`                                                                               |
| post, open a forum post, react                   | `alice.post(channel, { content })`, `alice.forumPost(forum, { title, content, tags: ["Bug"] })`, `alice.react(message, "✅")`                       |
| vote in a poll, take the vote back               | `alice.vote(poll, "Pizza")`, `alice.unvote(poll)`                                                                                                   |
| a member starts typing                           | `alice.startTyping(general)`: the bot hears `typingStart`                                                                                           |
| DM the bot                                       | `alice.dm({ content })`, then `await discord.waitForDM(alice, /text/)`                                                                              |
| a member with permissions                        | `discord.member(server, "Mod", { permissions: Permission.ModerateMembers })`                                                                        |
| a member Discord hasn't seen for a while (prune) | `discord.member(server, "Ghost", { inactiveDays: 40 })`                                                                                             |
| someone joins through an invite                  | `const code = alice.invite(general)`, then `discord.member(server, "Carol", { invite: code })`                                                      |
| join, move, leave voice                          | `const lobby = discord.voiceChannel(server, "lobby")`, `alice.joinVoice(lobby)`, `alice.leaveVoice()`                                               |
| a music bot plays in voice                       | `alice.joinVoice(lobby)`, `await alice.run(general, "play")`, `await discord.waitForSound(lobby)`; the bot's client needs GuildVoiceStates          |
| create, edit, delete an event                    | `const raid = host.createEvent("Raid", lobby, new Date("2026-12-01T20:00Z"))`, `host.editEvent(raid, { name: "Raid 2" })`, `host.deleteEvent(raid)` |
| add, rename, delete an emoji or sticker          | `const pog = mod.addEmoji("pog")`, `mod.renameExpression(pog, "poggers")`, `mod.deleteExpression(pog)`                                              |
| edit or delete their own message                 | `alice.edit(message, "fixed")`, `alice.delete(message)`                                                                                             |
| another bot posts                                | `discord.member(server, "Carl-bot", { bot: true })`: its posts carry `author.bot`                                                                   |
| deny or allow in one channel                     | `discord.deny(channel, "bot", Permission.SendMessages)` (or a member, a role, `"everyone"`), `discord.allow(…)`                                     |
| a moderator locks a thread                       | `discord.lock(thread)`                                                                                                                              |
| change nickname, leave the server                | `alice.nickname("Al")`, `alice.leave()`                                                                                                             |
| change their display name                        | `alice.displayName("Alicia")`: discord.js emits `userUpdate`                                                                                        |
| override who can use a command                   | `discord.commandPermissions(server, "ban", [{ target: mod, allow: true }])`, after `start`                                                          |
| a moderator kicks or bans someone                | `mod.kick(alice, "spam")`, `mod.ban(alice)`: the audit log names `mod`                                                                              |
| kick the bot from the server                     | `discord.kickBot(server)`: the bot gets `guildDelete`                                                                                               |
| a Discord outage                                 | `discord.outage(server)`, then `discord.endOutage(server)`: `guildUnavailable`, then `guildAvailable`                                               |
| open and end a stage                             | `const hall = discord.stageChannel(server, "hall")`, `mod.startStage(hall, "Q&A")`, `mod.endStage(hall)`                                            |
| rename the server                                | `discord.owner(server).renameGuild("SIN 2")`: the bot gets `guildUpdate`                                                                            |
| a bot that logs through a `WebhookClient`        | build it with `new WebhookClient({ id, token }, discord.clientOptions)`                                                                             |
| make Discord fail a route                        | `discord.fail("POST", "/channels/:id/messages", respond.serverError(503))`                                                                          |
| take a permission from the bot                   | `discord.deny(channel, Permission.SendMessages)`                                                                                                    |
| lose the gateway session                         | `discord.disconnect()`, act, `await discord.reconnect()` (give the test a 10 s timeout)                                                             |
| wait for a message                               | `await discord.waitForMessage(channel, /text/)`, or `waitForDM(member, /text/)`; only the bot's messages written since the latest action count      |
| check the bot sent nothing more                  | `await discord.waitForIdle()`, then assert                                                                                                          |
| wait for anything else, or absence               | `await vi.waitFor(() => expect(…).…)`                                                                                                               |
| read what's there now                            | `discord.messages(channel)`, `discord.dms(member)`                                                                                                  |

A message the bot updates in place is the same object the test holds, so keep one variable per menu and act on it line by line. When the bot answers with a new message, use the value `click` or `select` returns.

## What to test

One test is one journey a user takes: arrange the server, act as members, assert what they see. For each command or flow, cover:

- **The success path**, end to end through the bot's real handlers and, where the bot owns state, its real database. Assert the database too.
- **Every refusal the bot has**: a member missing a permission, the wrong state ("no pending challenge"), another member pressing someone's button. Each gets its own test, asserting the reply the user reads.
- **Discord failing**: `discord.fail(...)` with `respond.serverError(503)` or a rate limit on the route the flow depends on. Assert what the user sees then.
- **Interactions the bot must answer.** Await every `run`, `click` and `select`. A bot that ignores a press, an unknown button or a rate-limited command fails here with "The application did not respond", which is what the user sees.
- **Who can see the reply**: an ephemeral reply stays private (another member acting on it is refused), and a public one is in `discord.messages(channel)`.
- **Gateway events the bot listens to** (a member joins, leaves, changes nickname or display name; the bot is kicked), including for members who were there before the bot started.

Stub third parties (an AI model, a music source, a payment API) the way you would anywhere. Never stub Discord or discord.js. Before asserting "exactly one reply" or "no reply", `await discord.waitForIdle()`; never a sleep.

## Red lines

- No `vi.mock("discord.js")`, no hand-built interactions, no `as unknown as` casts, no spies on `interaction.reply`. If the test needs one, the mock is missing a feature: say so.
- No id lookups. Every handle has `.id`; pass handles, not ids.
- No type gymnastics such as `Awaited<ReturnType<…>>` to declare a variable.
- Assert what a user sees (embed titles, content, the board) and, where the bot owns state, the database. Don't assert that the bot called a function.

## Reading errors

The mock names messages by their text and lists what exists. Fix the test from the message, or the bot if the message shows the bot is wrong.

| Error says                                        | Meaning                                                                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `/x isn't registered. Registered: …`              | Typo in the test, or the bot didn't register it (check `commands`)                                                           |
| `can't click "x": "…" has buttons A, B`           | Wrong label, or the bot showed a different message                                                                           |
| `can't pick "x": "…" offers A, B`                 | Wrong option label                                                                                                           |
| `matches 2 buttons` / `matches 2 options`         | Make the label or RegExp more specific                                                                                       |
| `can't see "…": it's ephemeral, only alice can`   | Another member is acting on someone's private reply                                                                          |
| `can't use /x: it needs permissions …`            | Use `discord.owner(server)`, or a member built with `permissions`                                                            |
| `the bot didn't answer within 3s`                 | Discord would show "The application did not respond": a real bug                                                             |
| `the bot deferred, then went quiet`               | The bot deferred and never answered: a real bug, or a `fail` you set                                                         |
| `alice isn't a member of X`                       | The member acts in a server they never joined, or after `leave()`                                                            |
| `no message in #x matched … within 2s. Last 3: …` | The bot didn't post it; the last messages show what it did post                                                              |
| `unhandled requests: …`                           | The bot used a route the kit doesn't model yet: report it                                                                    |
| `AutoMod blocked alice's message: "…"`            | A rule (the bot's or the server's) blocked the post, as on Discord: `expect(() => alice.post(…)).toThrow("AutoMod blocked")` |
