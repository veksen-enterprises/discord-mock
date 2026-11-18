import { expect, it } from "vitest";
import { createDiscord } from "../../src/index.js";
import { commands, createBot } from "../fixtures/bot.js";

it("answers !ping once, and nothing else", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("My Server");
  const generalChannel = discord.channel(server, "general");
  const alice = discord.member(server, "alice");
  await discord.start(createBot(discord.clientOptions).client, { commands });

  // Act
  alice.post(generalChannel, { content: "!ping" });
  await discord.waitForMessage(generalChannel, "pong");
  await discord.waitForIdle();

  // Assert
  expect(discord.messages(generalChannel).map((m) => m.content)).toEqual([
    "!ping",
    "pong",
  ]);
});
