import { once } from "node:events";
import {
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  SnowflakeUtil,
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
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  const bob = mock.createUser("bob");
  mock.addMember(guild, bob);
  mock.grantBot(botPermissions);
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  const channel = client.channels.cache.get(general.id) as TextChannel;
  return { general, channel, alice, bob };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DiscordAPIError);
  return error as DiscordAPIError;
}

it("pins and unpins with Pin Messages, lists pins newest first, and announces each change", async () => {
  const { general, channel, alice } = await start(Permission.PinMessages);
  const first = mock.as(alice).sendMessage(general, "rules");
  const second = mock.as(alice).sendMessage(general, "faq");
  const pinsChanged = once(client, Events.ChannelPinsUpdate);

  await channel.messages.pin(first.id);
  await channel.messages.pin(second.id);

  expect((await pinsChanged)[0].id).toBe(channel.id);
  const pins = await channel.messages.fetchPins();
  expect(pins.items.map((p) => p.message.content)).toEqual(["faq", "rules"]);
  expect(pins.hasMore).toBe(false);
  await channel.messages.unpin(second.id);
  const pinned = await channel.messages.fetchPinned();
  expect(pinned.map((m) => m.content)).toEqual(["rules"]);
  mock.assertNoUnhandledRequests();
});

it("refuses to pin with only Manage Messages, which no longer grants it", async () => {
  const { general, channel, alice } = await start(Permission.ManageMessages);
  const message = mock.as(alice).sendMessage(general, "rules");

  expect((await refusal(channel.messages.pin(message.id))).code).toBe(50013);
});
