---
name: discord-mock
description: Write or fix a test for a discord.js bot with discord-mock. Use when testing slash commands, buttons, select menus, messages, DMs, member changes or Discord failures, or when a discord-mock error needs reading.
---

# Testing a discord.js bot with discord-mock

The bot logs in to a fake Discord over real HTTP and WebSocket. Nothing in discord.js is mocked. A test builds a World, starts the bot, acts as members and reads what the bot did.

## The one seam

The bot must accept client options, and nothing else changes:

```ts
export function createBot(clientOptions: Partial<ClientOptions> = {}) {
  const client = new Client({ intents, ...clientOptions });
  // handlers…
  return { client };
}
```

If the bot builds its `Client` at module load, extract a factory like this first. Never add test-only branches to bot code.

## A test

```ts
import { createDiscord, respond } from "discord-mock";

it("should record the result when the winner reports", async () => {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const challengesChannel = discord.channel(server, "challenges");
  const leaderboardChannel = discord.channel(server, "leaderboard");
  const alice = discord.member(server, "Alice");
  const bob = discord.member(server, "Bob");
  await discord.start(createBot(discord.clientOptions).client, { commands });

  const opponentMenu = await alice.run(challengesChannel, "challenge");
  await alice.select(opponentMenu, "Bob");
  const reportMenu = await bob.run(challengesChannel, "report");
  await bob.select(reportMenu, "I won");
  await bob.select(reportMenu, "5-2");

  expect(reportMenu.embeds.at(-1)?.title).toBe("Match Reported!");
  await discord.find(leaderboardChannel, /Bob/);
});
```

- `createDiscord()` per test. Teardown is automatic and fails the test if the bot hit a route the mock doesn't model (a Gap).
- `start(client, { commands })` registers commands the way the bot's deploy script would: pass the same command JSON. Add `permissions` (from `Permission`) when the bot needs more than @everyone's.
- Name variables for what they are: `challengesChannel`, `reportMenu`, `searchResults`, not `c`, `msg`, `res`.

## One way per action

| To…                                | Write                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| run a slash command                | `await alice.run(channel, "admin-config set", { ladder: "Season 1", channel: boardChannel })`                           |
| press a button                     | `await alice.click(message, "Join Ladder")` (its label, or its emoji)                                                   |
| pick from a select menu            | `await alice.select(message, "5-2")`                                                                                    |
| post, open a forum post, react     | `alice.post(channel, { content })`, `alice.forumPost(forum, { title, content })`, `alice.react(message, "✅")`          |
| change nickname, leave the server  | `alice.nickname("Al")`, `alice.leave()`                                                                                 |
| make Discord fail a route          | `discord.fail("POST", "/channels/:id/messages", respond.serverError(503))`                                              |
| wait for a message                 | `await discord.find(channel, /text/)` (or a member, for their DMs); only messages written since the latest action count |
| wait for anything else, or absence | `await vi.waitFor(() => expect(…).…)`                                                                                   |
| read what's there now              | `discord.messages(channel)`, `discord.dms(member)`                                                                      |

A message the bot updates in place is the same object the test holds, so keep one variable per menu and act on it line by line. When the bot answers with a new message, use the value `click` or `select` returns.

## Red lines

- No `vi.mock("discord.js")`, no hand-built interactions, no `as unknown as` casts, no spies on `interaction.reply`. If the test needs one, the mock is missing a feature: say so.
- No id lookups. Every handle has `.id`; pass handles, not ids.
- No type gymnastics such as `Awaited<ReturnType<…>>` to declare a variable.
- Assert what a user sees (embed titles, content, the board) and, where the bot owns state, the database. Don't assert that the bot called a function.

## Reading errors

The mock names messages by their text and lists what exists. Fix the test from the message, or the bot if the message shows the bot is wrong.

| Error says                                        | Meaning                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `/x isn't registered. Registered: …`              | Typo in the test, or the bot didn't register it (check `commands`)   |
| `can't click "x": "…" has buttons A, B`           | Wrong label, or the bot showed a different message                   |
| `can't pick "x": "…" offers A, B`                 | Wrong option label                                                   |
| `matches 2 buttons` / `matches 2 options`         | Make the label or RegExp more specific                               |
| `can't see "…": it's ephemeral, only alice can`   | Another member is acting on someone's private reply                  |
| `can't use /x: it needs permissions …`            | Use `discord.owner(server)` for admin commands                       |
| `still "deferred"`                                | The bot deferred and never answered: a real bug, or a `fail` you set |
| `no message in #x matched … within 2s. Last 3: …` | The bot didn't post it; the last messages show what it did post      |
| `unhandled requests: …`                           | The bot used a route the mock doesn't model yet: a Gap, report it    |
