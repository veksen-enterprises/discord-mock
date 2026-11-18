import { expect, it } from "vitest";
import { createDiscord, respond } from "../../src/index.js";
import { commands, createBot } from "../fixtures/bot.js";

async function startBot() {
  const discord = await createDiscord();
  const server = discord.guild("My Server");
  const generalChannel = discord.channel(server, "general");
  const newsChannel = discord.channel(server, "news");
  const alice = discord.member(server, "alice");
  await discord.start(createBot(discord.clientOptions).client, { commands });
  return { discord, generalChannel, newsChannel, alice };
}

it("tells the member when the bot can't post in the channel", async () => {
  // Arrange
  const { discord, generalChannel, newsChannel, alice } = await startBot();
  discord.fail(
    "POST",
    `/channels/${newsChannel.id}/messages`,
    respond.missingPermissions(),
  );

  // Act
  const reply = await alice.runCommand(generalChannel, "announce", {
    channel: newsChannel.id,
  });

  // Assert
  expect(reply.content).toBe("failed: 50013");
});

it("tells the member when Discord keeps answering 503", async () => {
  // Arrange
  const { discord, generalChannel, newsChannel, alice } = await startBot();
  discord.fail("POST", "/channels/:id/messages", respond.serverError(503));

  // Act
  const reply = await alice.runCommand(generalChannel, "announce", {
    channel: newsChannel.id,
  });

  // Assert
  expect(reply.content).toBe("failed: 503");
});

it("tells the member when Discord drops the connection", async () => {
  // Arrange
  const { discord, generalChannel, newsChannel, alice } = await startBot();
  discord.fail("POST", "/channels/:id/messages", respond.connectionClosed());

  // Act
  const reply = await alice.runCommand(generalChannel, "announce", {
    channel: newsChannel.id,
  });

  // Assert
  expect(reply.content).toBe("failed: UND_ERR_SOCKET");
});
