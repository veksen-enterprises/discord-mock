/**
 * A bot that keeps working after deferring but never edits in its reply fails after 10s in all.
 * In its own file because it runs 10s: test files run in parallel, the tests in a file one by one.
 */
import { expect, it } from "vitest";
import { createDiscord, Permission } from "../src/index.js";
import { commands, createBot } from "./fixtures/deferring-bot.js";

it("fails a deferred reply when the bot keeps working without ever answering, naming its requests", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("Titan");
  const general = discord.textChannel(server, "general");
  const alice = discord.member(server, "Alice");
  await discord.start(createBot(discord.clientOptions), {
    commands,
    permissions: Permission.SendMessages,
  });

  // Act
  const reply = alice.runCommand(general, "spin");

  // Assert
  await expect(reply).rejects.toThrow(
    /still working 10s after this interaction.*POST \/channels\/\d+\/typing/,
  );
}, 15_000);
