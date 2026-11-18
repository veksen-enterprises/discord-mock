/**
 * Discord keeps a deferred interaction's token for 15 minutes, so the run waits as long as the bot
 * keeps working, and fails only once it has gone quiet without editing in its reply.
 */
import { expect, it } from "vitest";
import { createDiscord, Permission } from "../src/index.js";
import { commands, createBot } from "./fixtures/deferring-bot.js";

it("waits through a deferred reply for as long as the bot keeps working", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("Titan");
  const general = discord.textChannel(server, "general");
  const alice = discord.member(server, "Alice");
  await discord.start(createBot(discord.clientOptions), {
    commands,
    permissions:
      Permission.SendMessages |
      Permission.AddReactions |
      Permission.ReadMessageHistory,
  });

  // Act
  const reply = await alice.runCommand(general, "poll");

  // Assert
  expect(reply.content).toBe("Poll posted.");
}, 10_000);

it("fails a deferred reply once the bot goes quiet without answering", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("Titan");
  const general = discord.textChannel(server, "general");
  const alice = discord.member(server, "Alice");
  await discord.start(createBot(discord.clientOptions), { commands });

  // Act
  const reply = alice.runCommand(general, "forget");

  // Assert
  await expect(reply).rejects.toThrow(
    "the bot deferred, then went quiet for 2s",
  );
});
