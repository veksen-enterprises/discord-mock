# discordjs-test-kit

A fake Discord your discord.js bot logs in to, so a test runs the bot as it ships. It refuses what Discord refuses, and a request it doesn't know fails the test.

```ts
import { createDiscord } from "discordjs-test-kit";
import { expect, it } from "vitest";
import { commands, createBot, type Store } from "./bot";

it("challenges another player from the menu", async () => {
  // Arrange: Alice and Bob on a ladder, and the bot logged in
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const category = discord.category(server, "Test Ladder");
  const challenges = discord.channel(server, "challenges", category);
  const updates = discord.channel(server, "updates");
  const alice = discord.member(server, "Alice");
  const bob = discord.member(server, "Bob");
  const store: Store = new Map([
    [
      "Test Ladder",
      new Map([
        [alice.id, "Alice"],
        [bob.id, "Bob"],
      ]),
    ],
  ]);
  const bot = createBot(store, discord.clientOptions);
  await discord.start(bot.client, { commands });

  // Act
  const menu = await alice.run(challenges, "challenge");
  await alice.select(menu, "Bob");

  // Assert
  expect(menu.content).toBe("Challenge sent to Bob.");
  const dm = await discord.find(bob, "challenged you");
  expect(dm.content).toBe("Alice challenged you. Play within 7 days.");
  const announcement = await discord.find(updates, "challenged");
  expect(announcement.content).toBe("Alice challenged Bob!");
});
```

The one change a bot needs: spread `discord.clientOptions` into its `new Client(...)`. The bot is in [`examples/ladder/`](examples/ladder), and this test runs as [`test/docs/readme.test.ts`](test/docs/readme.test.ts).

## Install

```sh
npm install --save-dev discordjs-test-kit
```

Needs `discord.js` 14.26.4 or later, `vitest` 4.1.2+ or 5, and Node 22, 24 or 26.

## Start with an agent

The package ships a skill for coding agents. Paste this into Claude Code, or any coding agent, at the root of your bot's repo:

```text
Add tests for this discord.js bot with discordjs-test-kit.
1. Install it: npm install --save-dev discordjs-test-kit vitest
2. Read node_modules/discordjs-test-kit/skills/discordjs-test-kit/SKILL.md and follow it.
3. Make the bot's Client accept client options, as the skill shows.
4. Write one test per thing a user does with the bot: each slash command, button and message
   flow, acting as members and asserting what they see.
5. Run the tests. If one fails with "unhandled requests", the kit doesn't model that Discord
   route yet: tell me which, and don't stub it. If one fails on the bot's behaviour, show me.
```

To keep the skill loaded in later sessions: `npm i -D skills-npm && npx skills-npm setup`.

## Compared with hand-rolled fakes

The same pick from the `/challenge` menu, tested the way sin-bot tests it today:

```ts
import { expect, it, vi } from "vitest";
import { executePickOpponent, ladders, type Store } from "./bot";
import { createMockStringSelectMenuInteraction } from "./fakes";

it("challenges another player from the menu", async () => {
  // Arrange
  const store: Store = new Map([
    [
      "Test Ladder",
      new Map([
        ["111", "Alice"],
        ["222", "Bob"],
      ]),
    ],
  ]);
  const updates = { name: "updates", isSendable: () => true, send: vi.fn() };
  const interaction = createMockStringSelectMenuInteraction({
    userId: "111",
    values: ["222"],
    channels: [updates],
  });
  vi.spyOn(ladders, "fromChannel").mockReturnValue(store.get("Test Ladder"));

  // Act
  await executePickOpponent(interaction, store);

  // Assert
  expect(interaction.update).toHaveBeenCalledWith({
    content: "Challenge sent to Bob.",
    components: [],
  });
  expect(interaction.client.users.send).toHaveBeenCalledWith(
    "222",
    "Alice challenged you. Play within 7 days.",
  );
  expect(updates.send).toHaveBeenCalledWith("Alice challenged Bob!");
});
```

This test calls the menu handler directly with a hand-built interaction. The command is never registered, the menu is never sent, and the test supplies the pick itself. The kit test at the top runs all of that.

### Bugs the fakes miss

Each bug was planted in [`examples/ladder/bot.ts`](examples/ladder/bot.ts), then both tests were run. The fakes test passed every time.

| Planted bug                                            | Kit test fails with                                                                            |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| The menu's custom id doesn't match the handler's       | `the bot didn't answer within 3s, so Discord shows the user "The application did not respond"` |
| The menu's option values are names instead of user ids | Alice reads `Challenge sent to undefined.`                                                     |
| The command is registered as `/challenge-player`       | `/challenge isn't registered. Registered: /join, /challenge-player`                            |

## Not modelled yet

- Most of Discord's API. A request the kit doesn't model fails the test and names the route.
- Gateway compression. If `zlib-sync` is installed, discord.js asks for it and the bot reconnects in a loop until the test times out.
- Partials, and form fields other than text inputs.

## Docs

- [Every action](site/src/content/docs/reference/actions.md) a test can take, with what it returns
- [Discord rules the kit enforces](site/src/content/docs/reference/discord-rules.md), by area
- [Discord failing](site/src/content/docs/recipes/discord-failing.mdx): 5xx, rate limits, lost sessions
- [Testing guide](skills/discordjs-test-kit/SKILL.md): the skill agents read
