import { Client, GatewayIntentBits } from "discord.js";
import { expect, it } from "vitest";
import { createDiscord, Permission } from "../src/index.js";

async function start(permissions: bigint) {
  const discord = await createDiscord();
  const server = discord.guild("g");
  discord.member(server, "ghost", { inactiveDays: 40 });
  discord.member(server, "lurker", { inactiveDays: 40, permissions: 0n });
  discord.member(server, "recent", { inactiveDays: 3 });
  discord.member(server, "alice");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    ...discord.clientOptions,
  });
  await discord.start(client, { permissions });
  return { discord, guild: client.guilds.cache.get(server.id)! };
}

it("prunes members unseen for the days given who have no roles, as Bastion's /prune does", async () => {
  const { guild } = await start(
    Permission.ManageGuild | Permission.KickMembers | Permission.ViewAuditLog,
  );

  expect(await guild.members.prune({ days: 7, dry: true })).toBe(1);
  const pruned = await guild.members.prune({ days: 7, count: true });

  expect(pruned).toBe(1);
  const left = await guild.members.fetch();
  expect(left.map((m) => m.user.username).sort()).toEqual(
    [
      "alice",
      "g-owner",
      "lurker",
      "recent",
      left.get(guild.client.user.id)!.user.username,
    ].sort(),
  );
  const log = await guild.fetchAuditLogs();
  expect(log.entries.first()?.extra).toMatchObject({
    removed: 1,
    days: 7,
  });
});

it("includes members whose roles are all in include_roles, and leaves the count out when asked", async () => {
  const { guild } = await start(
    Permission.ManageGuild | Permission.KickMembers,
  );
  const lurkers = guild.roles.cache.find((r) => r.name === "lurker's role")!;
  const lurker = (await guild.members.fetch()).find(
    (m) => m.user.username === "lurker",
  )!;

  expect(
    await guild.members.prune({ days: 7, dry: true, roles: [lurkers] }),
  ).toBe(2);
  expect(
    await guild.members.prune({ days: 7, roles: [lurkers], count: false }),
  ).toBeNull();
  await expect(guild.members.fetch(lurker.id)).rejects.toMatchObject({
    code: 10007,
  });
  await expect(
    guild.members.prune({ days: 31, dry: true }),
  ).rejects.toMatchObject({ code: 50035 });
});

it("refuses a prune without Kick Members", async () => {
  const { guild } = await start(Permission.ManageGuild);

  await expect(
    guild.members.prune({ days: 7, dry: true }),
  ).rejects.toMatchObject({ code: 50013 });
});
