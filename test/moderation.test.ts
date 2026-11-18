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
