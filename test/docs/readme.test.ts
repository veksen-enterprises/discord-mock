/**
 * The README's first example, as it runs. Only the import paths differ: the README imports the
 * package and the bot's own module.
 */
import { expect, it } from "vitest";
import { commands, createBot, type Store } from "../../examples/ladder/bot.js";
import { createDiscord } from "../../src/index.js";

it("adds a member to the ladder when they run /join", async () => {
  // Arrange: a server with a ladder channel, a member, and the bot logged in
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const category = discord.category(server, "Test Ladder");
  const challenges = discord.channel(server, "challenges", category);
  const alice = discord.member(server, "Alice", { nickname: "Bravo" });
  const store: Store = new Map([["Test Ladder", new Map()]]);
  const bot = createBot(store, discord.clientOptions);
  await discord.start(bot.client, { commands });

  // Act
  const reply = await alice.run(challenges, "join");

  // Assert
  expect(reply.embeds[0]?.title).toBe("Joined the Ladder!");
  expect(store.get("Test Ladder")?.get(alice.id)).toBe("Bravo");
});
