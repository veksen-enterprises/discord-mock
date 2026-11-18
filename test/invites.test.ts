import { once } from "node:events";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createInvite } from "../src/internal/invites.js";
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
  mock.grantBot(botPermissions);
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildInvites,
    ],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  const cachedGuild = client.guilds.cache.get(guild.id)!;
  const channel = cachedGuild.channels.cache.get(general.id)!;
  if (!channel.isTextBased() || channel.isDMBased() || channel.isThread())
    throw new Error("general isn't a guild text channel");
  return { guild, general, alice, cachedGuild, channel };
}

it("creates an invite, reuses a similar one unless unique, looks it up by code, and deletes it", async () => {
  const { channel } = await start(
    Permission.CreateInstantInvite | Permission.ManageChannels,
  );
  const created = once(client, Events.InviteCreate);

  const invite = await channel.createInvite({ maxUses: 5 });
  const again = await channel.createInvite({ maxUses: 5 });
  const unique = await channel.createInvite({ maxUses: 5, unique: true });

  expect((await created)[0].code).toBe(invite.code);
  expect(again.code).toBe(invite.code);
  expect(unique.code).not.toBe(invite.code);
  expect((await channel.fetchInvites()).size).toBe(2);
  const fetched = await client.fetchInvite(invite.code);
  expect([fetched.channelId, fetched.inviter?.username]).toEqual([
    channel.id,
    "bot",
  ]);
  const deleted = once(client, Events.InviteDelete);
  await fetched.delete();
  expect((await deleted)[0].code).toBe(invite.code);
  await expect(client.fetchInvite(invite.code)).rejects.toMatchObject({
    code: 10006,
  });
  mock.assertNoUnhandledRequests();
});

it("refuses an invite without Create Invite, and the guild's list without Manage Server or View Audit Log", async () => {
  const { channel, cachedGuild } = await start(0n);

  await expect(channel.createInvite()).rejects.toMatchObject({ code: 50013 });
  await expect(cachedGuild.invites.fetch()).rejects.toMatchObject({
    code: 50013,
  });
});

it("tracks who invited a new member: the invite's uses go up, and a used-up one is deleted", async () => {
  const { guild, general, alice, cachedGuild } = await start(
    Permission.ManageGuild | Permission.ManageChannels,
  );
  const created = once(client, Events.InviteCreate);
  const invite = createInvite(mock, general, alice, { max_uses: 2 });
  expect((await created)[0].inviter?.username).toBe("alice");

  const joined = once(client, Events.GuildMemberAdd);
  mock.joinWithInvite(guild, invite.code, mock.createUser("carol"));
  await joined;

  const invites = await cachedGuild.invites.fetch();
  expect(invites.get(invite.code)?.uses).toBe(1);
  const usedUp = once(client, Events.InviteDelete);
  mock.joinWithInvite(guild, invite.code, mock.createUser("dave"));
  expect((await usedUp)[0].code).toBe(invite.code);
  expect(guild.members.size).toBe(5);
  mock.assertNoUnhandledRequests();
});

it("doesn't tell a bot without Manage Channels about invites", async () => {
  const { general, alice } = await start(0n);
  let heard = false;
  client.on(Events.InviteCreate, () => (heard = true));

  createInvite(mock, general, alice);
  await mock.waitForIdle();

  expect(heard).toBe(false);
});
