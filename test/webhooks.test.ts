import { once } from "node:events";
import {
  Client,
  Events,
  GatewayIntentBits,
  WebhookClient,
  type TextChannel,
} from "discord.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDiscordMock, type DiscordMock } from "../src/internal/mock.js";
import { Permission } from "../src/internal/payloads.js";

let mock: DiscordMock;
let client: Client;

beforeEach(async () => {
  mock = await createDiscordMock();
});

afterEach(async () => {
  await client?.destroy();
  await mock.close();
});

async function start(botPermissions: bigint) {
  const guild = mock.createGuild("g");
  const general = mock.createTextChannel(guild, "general");
  mock.grantBot(botPermissions);
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildWebhooks,
      GatewayIntentBits.GuildMessages,
    ],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  const channel = client.channels.cache.get(general.id) as TextChannel;
  return { guild, general, channel };
}

it("creates a webhook, posts through it under another name, lists it and deletes it", async () => {
  const { general, channel } = await start(Permission.ManageWebhooks);
  const updated = once(client, Events.WebhooksUpdate);

  const webhook = await channel.createWebhook({ name: "Relay" });
  expect((await updated)[0].id).toBe(channel.id);
  const sent = await webhook.send({
    content: "hi",
    username: "alice (relayed)",
  });

  expect([sent.author.username, sent.webhookId]).toEqual([
    "alice (relayed)",
    webhook.id,
  ]);
  expect(mock.messagesIn(general).map((m) => m.content)).toEqual(["hi"]);
  expect((await channel.fetchWebhooks()).map((w) => w.name)).toEqual(["Relay"]);
  await webhook.delete();
  expect((await channel.guild.fetchWebhooks()).size).toBe(0);
  mock.assertNoUnhandledRequests();
});

it("sends through a WebhookClient built from the webhook's id and token", async () => {
  const { general, channel } = await start(Permission.ManageWebhooks);
  const { id, token } = await channel.createWebhook({ name: "Logs" });
  const logs = new WebhookClient({ id, token: token! }, mock.clientOptions);

  await logs.send("started");

  expect(mock.messagesIn(general)[0]?.author.username).toBe("Logs");
  logs.destroy();
  mock.assertNoUnhandledRequests();
});

it("refuses a webhook without Manage Webhooks, or named after Discord", async () => {
  const { channel } = await start(0n);
  await expect(channel.createWebhook({ name: "Relay" })).rejects.toMatchObject({
    code: 50013,
  });
  mock.grantBot(Permission.ManageWebhooks);

  await expect(
    channel.createWebhook({ name: "Discord Relay" }),
  ).rejects.toMatchObject({ code: 50035 });
});
