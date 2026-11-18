import { expect, it } from "vitest";
import { createDiscord } from "../../src/index.js";
import { commands, createBot } from "../fixtures/bot.js";

it("echoes what a member types in /echo", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("My Server");
  const generalChannel = discord.channel(server, "general");
  const alice = discord.member(server, "alice");
  await discord.start(createBot(discord.clientOptions).client, { commands });

  // Act
  const reply = await alice.runCommand(generalChannel, "echo", {
    text: "hello",
  });

  // Assert
  expect(reply.content).toBe("hello");
});
