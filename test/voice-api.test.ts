import { Readable } from "node:stream";
import {
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  StreamType,
} from "@discordjs/voice";
import {
  Client,
  Events,
  GatewayIntentBits,
  type GuildMember,
} from "discord.js";
import { expect, it } from "vitest";
import { createDiscord, Permission } from "../src/index.js";

/** A music bot's /play: join the member's voice channel and play an already-encoded track. */
function musicBot(options: ConstructorParameters<typeof Client>[0]) {
  const client = new Client(options);
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const channel = (interaction.member as GuildMember).voice.channel;
    if (!channel)
      return void (await interaction.reply("Join a voice channel first."));
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });
    const player = createAudioPlayer();
    connection.subscribe(player);
    const frames = Array.from({ length: 25 }, () =>
      Buffer.from([0xfc, 0xff, 0xfe, 0x01]),
    );
    player.play(
      createAudioResource(Readable.from(frames), {
        inputType: StreamType.Opus,
      }),
    );
    await interaction.reply(`Playing in ${channel.name}`);
  });
  return client;
}

it("hears a music bot play in the member's voice channel", async () => {
  const discord = await createDiscord();
  const server = discord.guild("g");
  const general = discord.textChannel(server, "general");
  const lobby = discord.voiceChannel(server, "lobby");
  const alice = discord.member(server, "alice");
  const client = musicBot({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    ...discord.clientOptions,
  });
  await discord.start(client, {
    commands: [{ name: "play", description: "Play a song" }],
    permissions: Permission.ViewChannel | Permission.Connect | Permission.Speak,
  });

  alice.joinVoice(lobby);
  await alice.runCommand(general, "play");
  await discord.waitForSound(lobby);

  expect(discord.botVoiceChannel(server)?.id).toBe(lobby.id);
});

it("says why it didn't hear the bot", async () => {
  const discord = await createDiscord();
  const server = discord.guild("g");
  const lobby = discord.voiceChannel(server, "lobby");
  await discord.start(
    new Client({
      intents: [GatewayIntentBits.Guilds],
      ...discord.clientOptions,
    }),
  );

  await expect(discord.waitForSound(lobby)).rejects.toThrow(
    "didn't hear the bot in lobby within 2s: the bot has no voice connection in that server",
  );
  expect(discord.botVoiceChannel(server)).toBeNull();
});
