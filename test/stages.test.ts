import { once } from "node:events";
import {
  AuditLogEvent,
  Client,
  Events,
  GatewayIntentBits,
  type StageInstance,
  type VoiceState,
} from "discord.js";
import { expect, it } from "vitest";
import { createDiscord, Permission } from "../src/index.js";

it("tells the bot when a moderator opens and ends a stage, as Zeppelin's logs expect", async () => {
  const discord = await createDiscord();
  const server = discord.guild("g");
  const townHall = discord.stageChannel(server, "town-hall");
  const mod = discord.member(server, "mod", {
    permissions:
      Permission.ManageChannels |
      Permission.MuteMembers |
      Permission.MoveMembers,
  });
  const alice = discord.member(server, "alice");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...discord.clientOptions,
  });
  await discord.start(client, { permissions: Permission.ViewAuditLog });
  const opened = once(client, Events.StageInstanceCreate);
  const closed = once(client, Events.StageInstanceDelete);

  expect(() => alice.startStage(townHall, "Q&A")).toThrow("isn't a moderator");
  mod.startStage(townHall, "Q&A");
  const [stage] = (await opened) as [StageInstance];
  expect([stage.topic, stage.channelId]).toEqual(["Q&A", townHall.id]);
  const guild = client.guilds.cache.get(server.id)!;
  expect((await guild.stageInstances.fetch(townHall.id)).topic).toBe("Q&A");
  mod.endStage(townHall);
  await closed;

  await expect(guild.stageInstances.fetch(townHall.id)).rejects.toMatchObject({
    code: 10067,
  });
  const log = await guild.fetchAuditLogs({
    type: AuditLogEvent.StageInstanceCreate,
  });
  expect(log.entries.first()?.executor?.username).toBe("mod");
});

const MODERATOR =
  Permission.ManageChannels | Permission.MuteMembers | Permission.MoveMembers;

async function botOnStage(permissions: bigint) {
  const discord = await createDiscord();
  const server = discord.guild("g");
  const townHall = discord.stageChannel(server, "town-hall");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...discord.clientOptions,
  });
  await discord.start(client, { permissions });
  const guild = client.guilds.cache.get(server.id)!;
  return { client, guild, townHall };
}

it("opens a stage as its moderator, and hears it open", async () => {
  // Arrange
  const { client, guild, townHall } = await botOnStage(MODERATOR);
  const opened = once(client, Events.StageInstanceCreate);

  // Act
  const stage = await guild.stageInstances.create(townHall.id, {
    topic: "Patch notes",
  });

  // Assert
  expect(stage.topic).toBe("Patch notes");
  expect(((await opened) as [StageInstance])[0].channelId).toBe(townHall.id);
});

it("refuses to open a stage without being its moderator", async () => {
  // Arrange
  const { guild, townHall } = await botOnStage(Permission.ManageChannels);

  // Act
  const opened = guild.stageInstances.create(townHall.id, { topic: "Q&A" });

  // Assert
  await expect(opened).rejects.toMatchObject({ code: 50013 });
});

it("changes the topic of its stage, and hears the update", async () => {
  // Arrange
  const { client, guild, townHall } = await botOnStage(MODERATOR);
  await guild.stageInstances.create(townHall.id, { topic: "Q&A" });
  const updated = once(client, Events.StageInstanceUpdate);

  // Act
  await guild.stageInstances.edit(townHall.id, { topic: "Q&A, part 2" });

  // Assert
  const [, after] = (await updated) as [StageInstance | null, StageInstance];
  expect(after.topic).toBe("Q&A, part 2");
});

it("ends its stage", async () => {
  // Arrange
  const { client, guild, townHall } = await botOnStage(MODERATOR);
  await guild.stageInstances.create(townHall.id, { topic: "Q&A" });
  const closed = once(client, Events.StageInstanceDelete);

  // Act
  await guild.stageInstances.delete(townHall.id);

  // Assert
  expect(((await closed) as [StageInstance])[0].channelId).toBe(townHall.id);
});

it("brings a member on stage up to speak with Mute Members, and hears it", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("g");
  const townHall = discord.stageChannel(server, "town-hall");
  const alice = discord.member(server, "alice");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    ...discord.clientOptions,
  });
  await discord.start(client, { permissions: Permission.MuteMembers });
  const joined = once(client, Events.VoiceStateUpdate);
  alice.joinVoice(townHall);
  const [, voice] = (await joined) as [unknown, VoiceState];
  const updated = once(client, Events.VoiceStateUpdate);

  // Act
  await voice.setSuppressed(false);

  // Assert
  const [, after] = (await updated) as [unknown, VoiceState];
  expect(after.suppress).toBe(false);
  // Discord stamps a member's raised hand when they're brought up.
  expect(after.requestToSpeakTimestamp).not.toBeNull();
});

it("refuses to bring a member up to speak without Mute Members", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("g");
  const townHall = discord.stageChannel(server, "town-hall");
  const alice = discord.member(server, "alice");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    ...discord.clientOptions,
  });
  await discord.start(client);
  const joined = once(client, Events.VoiceStateUpdate);
  alice.joinVoice(townHall);
  const [, voice] = (await joined) as [unknown, VoiceState];

  // Act
  const raised = voice.setSuppressed(false);

  // Assert
  await expect(raised).rejects.toMatchObject({ code: 50013 });
});

it("raises the bot's own hand on stage with Request to Speak", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("g");
  const townHall = discord.stageChannel(server, "town-hall");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    ...discord.clientOptions,
  });
  await discord.start(client, { permissions: Permission.RequestToSpeak });
  const guild = client.guilds.cache.get(server.id)!;
  const joined = once(client, Events.VoiceStateUpdate);
  guild.shard.send({
    op: 4,
    d: {
      guild_id: guild.id,
      channel_id: townHall.id,
      self_mute: false,
      self_deaf: false,
    },
  });
  await joined;
  const raised = once(client, Events.VoiceStateUpdate);

  // Act
  await guild.members.me!.voice.setRequestToSpeak(true);

  // Assert
  const [, after] = (await raised) as [unknown, VoiceState];
  expect(after.requestToSpeakTimestamp).not.toBeNull();
});
