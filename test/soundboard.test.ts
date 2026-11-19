import { once } from "node:events";
import { Client, Events, GatewayIntentBits } from "discord.js";
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

async function botWithSounds(botPermissions: bigint) {
  const record = mock.createGuild("g");
  mock.grantBot(botPermissions);
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildExpressions],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  return client.guilds.cache.get(record.id)!;
}

// The first bytes of an Ogg file; the kit doesn't decode audio.
const SOUND = { file: Buffer.from("OggS"), contentType: "audio/ogg" };

it("lets the bot upload a sound with Create Expressions, and hears it", async () => {
  // Arrange
  const guild = await botWithSounds(Permission.CreateGuildExpressions);
  const created = once(client, Events.GuildSoundboardSoundCreate);

  // Act
  const sound = await guild.soundboardSounds.create({
    ...SOUND,
    name: "airhorn",
    volume: 0.5,
  });

  // Assert
  expect([sound.name, sound.volume, sound.user?.id]).toEqual([
    "airhorn",
    0.5,
    client.user!.id,
  ]);
  expect((await created)[0].soundId).toBe(sound.soundId);
});

it("refuses a sound upload without Create Expressions", async () => {
  // Arrange
  const guild = await botWithSounds(0n);

  // Act
  const created = guild.soundboardSounds.create({ ...SOUND, name: "airhorn" });

  // Assert
  await expect(created).rejects.toMatchObject({ code: 50013 });
});

it("refuses a ninth sound", async () => {
  // Arrange
  const guild = await botWithSounds(Permission.CreateGuildExpressions);
  for (let i = 1; i <= 8; i++)
    await guild.soundboardSounds.create({ ...SOUND, name: `s${i}` });

  // Act
  const created = guild.soundboardSounds.create({ ...SOUND, name: "s9" });

  // Assert
  await expect(created).rejects.toMatchObject({ code: 30045 });
});

it("edits the bot's sound, and hears it", async () => {
  // Arrange
  const guild = await botWithSounds(Permission.CreateGuildExpressions);
  const sound = await guild.soundboardSounds.create({ ...SOUND, name: "horn" });
  const updated = once(client, Events.GuildSoundboardSoundUpdate);

  // Act
  const edited = await sound.edit({ name: "airhorn", emojiName: "📯" });

  // Assert
  expect([edited.name, edited.emoji?.name]).toEqual(["airhorn", "📯"]);
  expect((await updated)[1].name).toBe("airhorn");
});

it("deletes the bot's sound, and hears it", async () => {
  // Arrange
  const guild = await botWithSounds(Permission.CreateGuildExpressions);
  const sound = await guild.soundboardSounds.create({ ...SOUND, name: "horn" });
  const deleted = once(client, Events.GuildSoundboardSoundDelete);

  // Act
  await sound.delete();

  // Assert
  expect((await deleted)[0].soundId).toBe(sound.soundId);
  await expect(
    guild.soundboardSounds.fetch({
      soundboardSound: sound.soundId,
      force: true,
    }),
  ).rejects.toMatchObject({ code: 10097 });
});

it("lists the guild's sounds and fetches one by id", async () => {
  // Arrange
  const guild = await botWithSounds(Permission.CreateGuildExpressions);
  const horn = await guild.soundboardSounds.create({ ...SOUND, name: "horn" });
  await guild.soundboardSounds.create({ ...SOUND, name: "drum" });

  // Act
  const all = await guild.soundboardSounds.fetch();
  const one = await guild.soundboardSounds.fetch({
    soundboardSound: horn.soundId,
    force: true,
  });

  // Assert
  expect(all.map((s) => s.name).sort()).toEqual(["drum", "horn"]);
  expect(one.name).toBe("horn");
});

it("sends the guild's sounds over the gateway when the bot asks for them", async () => {
  // Arrange
  const guild = await botWithSounds(Permission.CreateGuildExpressions);
  await guild.soundboardSounds.create({ ...SOUND, name: "horn" });

  // Act
  const byGuild = await client.guilds.fetchSoundboardSounds({
    guildIds: [guild.id],
  });

  // Assert
  expect(byGuild.get(guild.id)!.map((s) => s.name)).toEqual(["horn"]);
  mock.assertNoUnhandledRequests();
});
