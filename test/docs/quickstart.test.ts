import { expect, it } from "vitest";
import { createDiscord } from "../../src/index.js";
import { commands, createBot } from "../fixtures/bot.js";

it("echoes what a member types in /echo", async () => {
  const discord = await createDiscord();
  const server = discord.guild("My Server");
  const generalChannel = discord.channel(server, "general");
  const alice = discord.member(server, "alice");
  await discord.start(createBot(discord.clientOptions).client, { commands });

  const reply = await alice.run(generalChannel, "echo", { text: "hello" });

  expect(reply.content).toBe("hello");
});
