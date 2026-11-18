/**
 * The README's first example, as it runs. Only the import paths differ: the README imports the
 * package and the bot's own module.
 */
import { expect, it } from "vitest";
import { commands, createBot, type Store } from "../../examples/ladder/bot.js";
import { createDiscord } from "../../src/index.js";

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
