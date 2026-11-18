/**
 * The README's first example, as it runs. Only the import paths differ: the README imports the
 * package and the bot's own module.
 */
import { expect, it } from "vitest";
import { commands, createBot } from "../../examples/challenge/bot.js";
import { createDiscord } from "../../src/index.js";

it("DMs the player you challenge", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const channel = discord.textChannel(server, "challenges");
  const alice = discord.member(server, "Alice");
  const bob = discord.member(server, "Bob");
  await discord.start(createBot(discord.clientOptions), { commands });

  // Act
  const reply = await alice.runCommand(channel, "challenge", { opponent: bob });

  // Assert
  expect(reply.content).toBe("Challenge sent to Bob.");
  const dm = await discord.waitForDM(bob, "challenged you");
  expect(dm.content).toBe("Alice challenged you.");
});
