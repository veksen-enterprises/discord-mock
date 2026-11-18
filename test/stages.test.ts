import { once } from "node:events";
import {
  AuditLogEvent,
  Client,
  Events,
  GatewayIntentBits,
  type StageInstance,
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
