import { once } from "node:events";
import { Client, Events, GatewayIntentBits, Routes } from "discord.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  deleteExpression,
  renameExpression,
  uploadExpression,
} from "../src/internal/expressions.js";
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

async function login(intents: GatewayIntentBits[]) {
  client = new Client({ intents, ...mock.clientOptions });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
}

// A 1x1 PNG, as discord.js sends an image: a data URI.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

it("tells the bot when a member adds, renames and deletes an emoji and a sticker", async () => {
  const guild = mock.createGuild("g");
  const mod = mock.createUser("mod");
  mock.addMember(guild, mod);
  mock.createRole(guild, "mods", Permission.CreateGuildExpressions, [mod]);
  await login([GatewayIntentBits.Guilds, GatewayIntentBits.GuildExpressions]);
  const heard: string[] = [];
  client.on(Events.GuildEmojiCreate, (e) => heard.push(`emoji+ ${e.name}`));
  client.on(Events.GuildEmojiUpdate, (a, b) =>
    heard.push(`emoji ${a.name}>${b.name}`),
  );
  client.on(Events.GuildEmojiDelete, (e) => heard.push(`emoji- ${e.name}`));
  client.on(Events.GuildStickerCreate, (s) => heard.push(`sticker+ ${s.name}`));
  client.on(Events.GuildStickerDelete, (s) => heard.push(`sticker- ${s.name}`));

  const pog = uploadExpression(mock, guild, mod, "emoji", "pog");
  renameExpression(mock, guild, mod, "emoji", pog, "poggers");
  deleteExpression(mock, guild, mod, "emoji", pog);
  const wave = uploadExpression(mock, guild, mod, "sticker", "wave");
  const deleted = once(client, Events.GuildStickerDelete);
  deleteExpression(mock, guild, mod, "sticker", wave);
  await deleted;

  expect(heard).toEqual([
    "emoji+ pog",
    "emoji pog>poggers",
    "emoji- poggers",
    "sticker+ wave",
    "sticker- wave",
  ]);
});

it("refuses an upload without Create Expressions, and someone else's emoji without Manage Expressions", () => {
  const guild = mock.createGuild("g");
  const alice = mock.createUser("alice");
  const bob = mock.createUser("bob");
  mock.addMember(guild, alice);
  mock.addMember(guild, bob);

  expect(() => uploadExpression(mock, guild, alice, "emoji", "pog")).toThrow(
    "without Create Expressions",
  );
  mock.createRole(guild, "makers", Permission.CreateGuildExpressions, [
    alice,
    bob,
  ]);
  const pog = uploadExpression(mock, guild, alice, "emoji", "pog");
  expect(() => deleteExpression(mock, guild, bob, "emoji", pog)).toThrow(
    "without Manage Expressions",
  );
});

it("lets the bot create, list, restrict and delete emojis with Create Expressions", async () => {
  const guild = mock.createGuild("g");
  const owner = mock.state.requireUser(guild.ownerId);
  const theirs = uploadExpression(mock, guild, owner, "emoji", "theirs");
  const mods = mock.createRole(guild, "mods", 0n);
  await login([GatewayIntentBits.Guilds]);
  const emojis = client.guilds.cache.get(guild.id)!.emojis;

  await expect(
    emojis.create({ attachment: PNG, name: "x1" }),
  ).rejects.toMatchObject({ code: 50013 });
  mock.grantBot(Permission.CreateGuildExpressions);
  const created = await emojis.create({ attachment: PNG, name: "mine" });
  await created.edit({ roles: [mods.id] });
  const fetched = await emojis.fetch(undefined, { force: true });
  // discord.js's fetchAuthor checks its cached permissions first; ask the Route directly.
  const raw = (await client.rest.get(
    Routes.guildEmoji(guild.id, created.id),
  )) as { user?: { id: string } };

  expect(fetched.map((e) => e.name).sort()).toEqual(["mine", "theirs"]);
  expect([...created.roles.cache.keys()]).toEqual([mods.id]);
  expect(raw.user?.id).toBe(client.user!.id);
  await expect(emojis.cache.get(theirs)!.delete()).rejects.toMatchObject({
    code: 50013,
  });
  await created.delete();
  await expect(emojis.fetch(created.id, { force: true })).rejects.toMatchObject(
    { code: 10014 },
  );
  mock.assertNoUnhandledRequests();
});
