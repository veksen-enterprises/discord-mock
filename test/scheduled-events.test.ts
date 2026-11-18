import { once } from "node:events";
import {
  Client,
  Events,
  GatewayIntentBits,
  GuildScheduledEventEntityType,
} from "discord.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDiscordMock, type DiscordMock } from "../src/internal/mock.js";
import { Permission } from "../src/internal/payloads.js";
import {
  createScheduledEvent,
  deleteScheduledEvent,
  editScheduledEvent,
} from "../src/internal/scheduled-events.js";

let mock: DiscordMock;
let client: Client;

beforeEach(async () => {
  mock = await createDiscordMock();
});

afterEach(async () => {
  await client?.destroy();
  await mock.close();
});

async function login(intents: GatewayIntentBits[]) {
  client = new Client({ intents, ...mock.clientOptions });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
}

const start = new Date("2026-12-01T20:00:00Z");

it("tells the bot when a member creates, edits and deletes an event", async () => {
  const guild = mock.createGuild("g");
  const lobby = mock.createVoiceChannel(guild, "lobby");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  mock.createRole(guild, "hosts", Permission.CreateEvents, [alice]);
  await login([
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildScheduledEvents,
  ]);

  const created = once(client, Events.GuildScheduledEventCreate);
  const event = createScheduledEvent(mock, guild, alice, {
    name: "Raid night",
    start,
    place: { channel: lobby },
  });
  const [heard] = await created;
  // discord.js patches the cached event in place, so read it before the edit.
  expect([heard.name, heard.creatorId, heard.channelId]).toEqual([
    "Raid night",
    alice.id,
    lobby.id,
  ]);
  expect(heard.entityType).toBe(GuildScheduledEventEntityType.Voice);
  expect(heard.scheduledStartTimestamp).toBe(start.getTime());
  const updated = once(client, Events.GuildScheduledEventUpdate);
  editScheduledEvent(mock, guild, alice, event, { name: "Raid night 2" });
  const [before, after] = await updated;
  const deleted = once(client, Events.GuildScheduledEventDelete);
  deleteScheduledEvent(mock, guild, alice, event);
  await deleted;

  expect([before?.name, after.name]).toEqual(["Raid night", "Raid night 2"]);
  expect(client.guilds.cache.get(guild.id)!.scheduledEvents.cache.size).toBe(0);
});

it("refuses an event from a member without Create Events, and someone else's edit without Manage Events", async () => {
  const guild = mock.createGuild("g");
  const alice = mock.createUser("alice");
  const bob = mock.createUser("bob");
  mock.addMember(guild, alice);
  mock.addMember(guild, bob);
  mock.createRole(guild, "hosts", Permission.CreateEvents, [alice, bob]);

  expect(() =>
    createScheduledEvent(mock, guild, mock.createUser("carol"), {
      name: "x",
      start,
      place: { location: "the park" },
    }),
  ).toThrow("without Create Events");
  const event = createScheduledEvent(mock, guild, alice, {
    name: "Meetup",
    start,
    place: { location: "the park" },
  });

  expect(() =>
    editScheduledEvent(mock, guild, bob, event, { name: "mine" }),
  ).toThrow("without Manage Events");
});

it("lists the guild's events, with ones made before the bot connected in its guild", async () => {
  const guild = mock.createGuild("g");
  const owner = mock.state.requireUser(guild.ownerId);
  const event = createScheduledEvent(mock, guild, owner, {
    name: "Meetup",
    start,
    place: { location: "the park" },
  });
  await login([GatewayIntentBits.Guilds]);
  const cached = client.guilds.cache.get(guild.id)!;

  const fetched = await cached.scheduledEvents.fetch({ withUserCount: true });
  const one = await cached.scheduledEvents.fetch({
    guildScheduledEvent: event.id,
    force: true,
  });

  expect(cached.scheduledEvents.cache.has(event.id)).toBe(true);
  expect(fetched.map((e) => e.entityMetadata?.location)).toEqual(["the park"]);
  expect(one.scheduledEndTimestamp).toBe(start.getTime() + 3_600_000);
  await expect(
    cached.scheduledEvents.fetch({ guildScheduledEvent: "1", force: true }),
  ).rejects.toMatchObject({ code: 10070 });
  mock.assertNoUnhandledRequests();
});
