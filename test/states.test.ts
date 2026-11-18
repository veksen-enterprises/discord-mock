/**
 * Discord states a consumer can put the bot in through the facade: a permission taken away, a
 * route failing and recovering, and a gateway outage that costs the bot its session.
 */
import { expect, it } from "vitest";
import { createDiscord, Permission, respond } from "../src/index.js";
import { commands, createBot } from "./fixtures/bot.js";

async function startBot() {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const generalChannel = discord.textChannel(server, "general");
  const newsChannel = discord.textChannel(server, "news");
  const alice = discord.member(server, "alice");
  await discord.start(createBot(discord.clientOptions).client, { commands });
  return { discord, generalChannel, newsChannel, alice };
}

it("answers 50013 once the bot is denied Send Messages in a channel", async () => {
  const { discord, generalChannel, newsChannel, alice } = await startBot();

  discord.deny(newsChannel, "bot", Permission.SendMessages);

  const reply = await alice.runCommand(generalChannel, "announce", {
    channel: newsChannel.id,
  });
  expect(reply.content).toBe("failed: 50013");
});

it("answers 50001 Missing Access once the bot is denied View Channel, whatever else it was denied", async () => {
  const { discord, generalChannel, newsChannel, alice } = await startBot();

  discord.deny(newsChannel, "bot", Permission.ViewChannel);
  discord.deny(newsChannel, "bot", Permission.SendMessages);

  const reply = await alice.runCommand(generalChannel, "announce", {
    channel: newsChannel.id,
  });
  expect(reply.content).toBe("failed: 50001");
});

it("serves the Model again once a failure is recovered", async () => {
  const { discord, generalChannel, newsChannel, alice } = await startBot();
  const recover = discord.answerWith(
    "POST",
    "/channels/:channelId/messages",
    respond.serverError(503),
  );
  const options = { channel: newsChannel.id };
  expect(
    (await alice.runCommand(generalChannel, "announce", options)).content,
  ).toBe("failed: 503");

  recover();

  expect(
    (await alice.runCommand(generalChannel, "announce", options)).content,
  ).toBe("posted");
});

// reconnect waits out discord.js's identify throttle: 5s since the last identify, plus up to 1.5s.
it(
  "loses what happened during an outage: the bot never sees a message posted while it was disconnected",
  { timeout: 10_000 },
  async () => {
    const { discord, generalChannel, alice } = await startBot();

    discord.disconnect();
    alice.post(generalChannel, { content: "!ping" });
    await discord.reconnect();
    alice.post(generalChannel, { content: "!ping" });

    await discord.waitForMessage(generalChannel, "pong");
    expect(
      discord.messages(generalChannel).filter((m) => m.content === "pong"),
    ).toHaveLength(1);
  },
);
