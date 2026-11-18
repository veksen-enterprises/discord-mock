import { once } from "node:events";
import { Client, DiscordAPIError, Events, GatewayIntentBits } from "discord.js";
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
  const record = mock.createGuild("g");
  const alice = mock.createUser("alice");
  mock.addMember(record, alice);
  const admin = mock.createUser("admin");
  mock.addMember(record, admin);
  mock.createRole(record, "admins", Permission.Administrator, [admin]);
  mock.grantBot(botPermissions);
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
    ],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  const guild = client.guilds.cache.get(record.id)!;
  return { guild, record, alice, admin };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DiscordAPIError);
  return error as DiscordAPIError;
}

it("fetches a member, and answers 10007 for someone who isn't one", async () => {
  const { guild, alice } = await start(0n);
  const stranger = mock.createUser("stranger");

  expect((await guild.members.fetch(alice.id)).user.username).toBe("alice");
  expect((await refusal(guild.members.fetch(stranger.id))).code).toBe(10007);
});

it("times a member out with Moderate Members, and the bot hears the update", async () => {
  const { guild, record, alice } = await start(Permission.ModerateMembers);
  const member = await guild.members.fetch(alice.id);
  const updated = once(client, Events.GuildMemberUpdate);

  await member.timeout(60_000, "spam");

  const [, after] = await updated;
  expect(after.isCommunicationDisabled()).toBe(true);
  expect(record.members.get(alice.id)!.communication_disabled_until).not.toBe(
    null,
  );
});

it("refuses a timeout without the permission, for an admin, and past 28 days", async () => {
  const { guild, alice, admin } = await start(Permission.ModerateMembers);
  const target = await guild.members.fetch(alice.id);

  expect(
    (await refusal((await guild.members.fetch(admin.id)).timeout(60_000))).code,
  ).toBe(50013);
  expect((await refusal(target.timeout(29 * 24 * 60 * 60 * 1000))).code).toBe(
    50035,
  );
});

it("refuses a timeout to a bot without Moderate Members", async () => {
  const { guild, alice } = await start(0n);

  const error = await refusal(
    (await guild.members.fetch(alice.id)).timeout(60_000),
  );

  expect(error.code).toBe(50013);
});

it("kicks a member below the bot, and refuses one ranked above it", async () => {
  const { guild, record, alice, admin } = await start(Permission.KickMembers);
  const removed = once(client, Events.GuildMemberRemove);

  await (await guild.members.fetch(alice.id)).kick();

  expect((await removed)[0].id).toBe(alice.id);
  expect(record.members.has(alice.id)).toBe(false);
  // The admins role was created before the bot's, so it sits below it: move it above.
  record.roles.get([...record.members.get(admin.id)!.roles][0]!)!.position = 99;
  expect((await refusal(guild.members.kick(admin.id))).code).toBe(50013);
});

it("bans and unbans, firing the ban events and removing the member", async () => {
  const { guild, record, alice } = await start(Permission.BanMembers);
  const banned = once(client, Events.GuildBanAdd);

  await guild.members.ban(alice.id, { reason: "spam" });

  expect((await banned)[0].user.id).toBe(alice.id);
  expect(record.members.has(alice.id)).toBe(false);
  expect((await guild.bans.fetch(alice.id)).reason).toBe("spam");
  const unbanned = once(client, Events.GuildBanRemove);
  await guild.members.unban(alice.id);
  await unbanned;
  expect(
    (await refusal(guild.bans.fetch({ user: alice.id, force: true }))).code,
  ).toBe(10026);
});

it("refuses a role above the bot's, and adds and removes one below it", async () => {
  const { guild, record, alice } = await start(Permission.ManageRoles);
  const helpers = mock.createRole(record, "helpers", 0n);
  const member = await guild.members.fetch(alice.id);
  // Created after the bot's role, so above it until moved below.
  expect((await refusal(member.roles.add(helpers.id))).code).toBe(50013);
  record.roles.get(helpers.id)!.position = 1;

  await member.roles.add(helpers.id);
  expect(record.members.get(alice.id)!.roles).toContain(helpers.id);
  await member.roles.remove(helpers.id);
  expect(record.members.get(alice.id)!.roles).not.toContain(helpers.id);
});

it("creates a role just above @everyone, edits and deletes it, and refuses to grant what the bot lacks", async () => {
  const { guild, record, alice } = await start(Permission.ManageRoles);
  const created = once(client, Events.GuildRoleCreate);

  const role = await guild.roles.create({ name: "helpers" });
  await (await guild.members.fetch(alice.id)).roles.add(role);
  const renamed = await role.edit({ name: "helpers+" });

  expect((await created)[0].id).toBe(role.id);
  expect(role.position).toBe(1);
  expect(renamed.name).toBe("helpers+");
  expect(
    (await refusal(guild.roles.create({ permissions: Permission.BanMembers })))
      .code,
  ).toBe(50013);
  const deleted = once(client, Events.GuildRoleDelete);
  await role.delete();
  expect((await deleted)[0].id).toBe(role.id);
  expect(record.members.get(alice.id)!.roles).not.toContain(role.id);
});

it("deletes a channel overwrite, and the bot hears the channel update", async () => {
  const { guild, record, alice } = await start(Permission.ManageRoles);
  const channel = await guild.channels.fetch(
    mock.createTextChannel(record, "general").id,
  );
  if (!channel?.isTextBased() || channel.isThread()) throw new Error("text");
  const member = await guild.members.fetch(alice.id);
  await channel.permissionOverwrites.create(member, { SendMessages: false });
  const cleared = new Promise((resolve) =>
    client.on(Events.ChannelUpdate, (_, after) => {
      if (
        "permissionOverwrites" in after &&
        !after.permissionOverwrites.cache.has(alice.id)
      )
        resolve(after.id);
    }),
  );

  await channel.permissionOverwrites.delete(member);

  expect(await cleared).toBe(channel.id);
  expect(
    (await refusal(channel.permissionOverwrites.delete(member))).code,
  ).toBe(10009);
});

it("lists every role, including one made since the bot connected", async () => {
  const { guild, record } = await start(0n);
  const added = mock.createRole(record, "late", 0n);

  const roles = await guild.roles.fetch();

  expect(roles.map((r) => r.name).sort()).toEqual(
    ["@everyone", "admins", "bot", "late"].sort(),
  );
  expect(guild.roles.cache.has(added.id)).toBe(true);
  mock.assertNoUnhandledRequests();
});
