import { once } from "node:events";
import {
  Client,
  Events,
  GatewayIntentBits,
  type TextChannel,
} from "discord.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDiscordMock, type DiscordMock } from "../src/internal/mock.js";

let mock: DiscordMock;
let client: Client;

beforeEach(async () => {
  mock = await createDiscordMock();
});

afterEach(async () => {
  await client?.destroy();
  await mock.close();
});

async function start() {
  const guild = mock.createGuild("ladder");
  const general = mock.createTextChannel(guild, "general");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  const channel = (await client.channels.fetch(general.id)) as TextChannel;
  return { general, alice, channel };
}

it("deletes the bot's own message and announces it", async () => {
  const { general, channel } = await start();
  const sent = await channel.send("leaderboard");
  const deleted = once(client, Events.MessageDelete);

  await sent.delete();

  const [message] = await deleted;
  expect(message.id).toBe(sent.id);
  expect(mock.messagesIn(general)).toEqual([]);
  mock.assertNoUnhandledRequests();
});

it("refuses to delete another user's message without MANAGE_MESSAGES", async () => {
  const { general, alice, channel } = await start();
  const theirs = mock.as(alice).sendMessage(general, "hi");

  await expect(channel.messages.delete(theirs.id)).rejects.toMatchObject({
    status: 403,
    code: 50013,
  });
  expect(mock.messagesIn(general)).toHaveLength(1);
});
