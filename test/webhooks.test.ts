import { once } from "node:events";
import {
  Client,
  Events,
  GatewayIntentBits,
  WebhookClient,
  type TextChannel,
} from "discord.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

it("renames a webhook through a WebhookClient, with its token", async () => {
  // Arrange
  const { channel } = await start(Permission.ManageWebhooks);
  const { id, token } = await channel.createWebhook({ name: "Logs" });
  const logs = new WebhookClient({ id, token: token! }, mock.clientOptions);

  // Act
  await logs.edit({ name: "Audit" });

  // Assert
  expect((await channel.fetchWebhooks()).get(id)?.name).toBe("Audit");
  logs.destroy();
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

it("fetches a webhook by id with the bot token", async () => {
  // Arrange
  const { channel } = await start(Permission.ManageWebhooks);
  const { id } = await channel.createWebhook({ name: "Relay" });

  // Act
  const webhook = await client.fetchWebhook(id);

  // Assert
  expect([webhook.name, webhook.owner?.id]).toEqual(["Relay", client.user!.id]);
});

it("fetches a webhook with its token, without the creator", async () => {
  // Arrange
  const { channel } = await start(Permission.ManageWebhooks);
  const { id, token } = await channel.createWebhook({ name: "Relay" });

  // Act
  const webhook = await client.fetchWebhook(id, token!);

  // Assert
  expect([webhook.name, webhook.owner]).toEqual(["Relay", null]);
});

it("moves a webhook to another channel and tells the bot about both", async () => {
  // Arrange
  const { guild, general, channel } = await start(Permission.ManageWebhooks);
  const logs = mock.createTextChannel(guild, "logs");
  const webhook = await channel.createWebhook({ name: "Relay" });
  const updates: string[] = [];
  client.on(Events.WebhooksUpdate, (c) => updates.push(c.id));

  // Act
  const moved = await webhook.edit({ channel: logs.id });

  // Assert
  expect(moved.channelId).toBe(logs.id);
  await vi.waitFor(() =>
    expect(updates.sort()).toEqual([general.id, logs.id].sort()),
  );
});

it("deletes a webhook by id with the bot token", async () => {
  // Arrange
  const { channel } = await start(Permission.ManageWebhooks);
  const { id } = await channel.createWebhook({ name: "Relay" });

  // Act
  await client.deleteWebhook(id);

  // Assert
  expect((await channel.fetchWebhooks()).size).toBe(0);
});

it("fetches a message the webhook sent", async () => {
  // Arrange
  const { channel } = await start(Permission.ManageWebhooks);
  const webhook = await channel.createWebhook({ name: "Logs" });
  const sent = await webhook.send("started");

  // Act
  const fetched = await webhook.fetchMessage(sent.id);

  // Assert
  expect(fetched.content).toBe("started");
});

it("edits a message the webhook sent, and the channel shows the edit", async () => {
  // Arrange
  const { general, channel } = await start(Permission.ManageWebhooks);
  const webhook = await channel.createWebhook({ name: "Logs" });
  const sent = await webhook.send("starting");

  // Act
  await webhook.editMessage(sent.id, "started");

  // Assert
  expect(mock.messagesIn(general).map((m) => m.content)).toEqual(["started"]);
});

it("deletes a message the webhook sent", async () => {
  // Arrange
  const { general, channel } = await start(Permission.ManageWebhooks);
  const webhook = await channel.createWebhook({ name: "Logs" });
  const sent = await webhook.send("oops");

  // Act
  await webhook.deleteMessage(sent.id);

  // Assert
  expect(mock.messagesIn(general)).toEqual([]);
});

it("refuses a message the webhook didn't send", async () => {
  // Arrange
  const { general, channel, guild } = await start(Permission.ManageWebhooks);
  const webhook = await channel.createWebhook({ name: "Logs" });
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  const posted = mock.as(alice).sendMessage(general, "mine");

  // Act
  const refused = webhook.fetchMessage(posted.id);

  // Assert
  await expect(refused).rejects.toMatchObject({ code: 10008 });
});
