import { once } from "node:events";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDiscordMock, type DiscordMock } from "../src/index.js";

let mock: DiscordMock;
let client: Client;

beforeEach(async () => {
  mock = await createDiscordMock();
});

afterEach(async () => {
  await client?.destroy();
  await mock.close();
});

async function start(intents: GatewayIntentBits[]) {
  const guild = mock.createGuild("ladder");
  for (const name of ["alice", "albert", "bob"])
    mock.addMember(guild, mock.createUser(name));
  client = new Client({ intents, ...mock.clientOptions });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  return client.guilds.cache.get(guild.id)!;
}

it("fetches every member over the gateway with GUILD_MEMBERS", async () => {
  const guild = await start([
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ]);

  const members = await guild.members.fetch();

  expect(members.map((m) => m.user.username).sort()).toEqual([
    "albert",
    "alice",
    "bob",
    "bot",
    "ladder-owner",
  ]);
  mock.assertNoUnhandledRequests();
});

it("fetches members by username prefix", async () => {
  const guild = await start([GatewayIntentBits.Guilds]);

  const members = await guild.members.fetch({ query: "al", limit: 10 });

  expect(members.map((m) => m.user.username).sort()).toEqual([
    "albert",
    "alice",
  ]);
  mock.assertNoUnhandledRequests();
});

it("records a Gap when the whole list is asked for without GUILD_MEMBERS", async () => {
  const guild = await start([GatewayIntentBits.Guilds]);

  await expect(guild.members.fetch({ time: 200 })).rejects.toThrow();

  expect(() => mock.assertNoUnhandledRequests()).toThrow(
    /without GUILD_MEMBERS/,
  );
});

it("announces a member leaving to a bot with GUILD_MEMBERS", async () => {
  const guild = await start([
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ]);
  const record = mock.state.requireGuild(guild.id);
  const carol = mock.createUser("carol");
  mock.addMember(record, carol);
  // GUILD_MEMBER_ADD caches her; discord.js drops a removal for an uncached member.
  await vi.waitFor(() => expect(guild.members.cache.has(carol.id)).toBe(true));
  const removed = once(client, Events.GuildMemberRemove);

  mock.removeMember(record, carol);

  const [member] = await removed;
  expect(member.id).toBe(carol.id);
  expect(member.guild.id).toBe(guild.id);
});

it("announces a nickname change to a bot with GUILD_MEMBERS", async () => {
  const guild = await start([
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ]);
  const record = mock.state.requireGuild(guild.id);
  const carol = mock.createUser("carol");
  mock.addMember(record, carol);
  await vi.waitFor(() => expect(guild.members.cache.has(carol.id)).toBe(true));
  const updated = once(client, Events.GuildMemberUpdate);

  mock.setNickname(record, carol, "Caz");

  const [before, after] = await updated;
  expect(before.displayName).toBe("carol");
  expect(after.displayName).toBe("Caz");
});
