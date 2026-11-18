/**
 * Role, mentionable, attachment and voice channel options, the way discord.js reads them
 * (CommandInteractionOptionResolver.getRole / getMentionable / getAttachment / getChannel).
 */
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
} from "discord.js";
import { expect, it } from "vitest";
import { createDiscord } from "../src/index.js";

const commands = [
  new SlashCommandBuilder()
    .setName("autorole")
    .setDescription("Give new members a role")
    .addRoleOption((o) =>
      o.setName("role").setDescription("The role").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("notify")
    .setDescription("Ping someone or a role")
    .addMentionableOption((o) =>
      o.setName("who").setDescription("Who").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("upload")
    .setDescription("Read a file")
    .addAttachmentOption((o) =>
      o.setName("file").setDescription("The file").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("jointocreate")
    .setDescription("Set the hub")
    .addChannelOption((o) =>
      o
        .setName("hub")
        .setDescription("Voice hub")
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildVoice),
    ),
].map((c) => c.toJSON());

function createBot(options: object) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...options,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "autorole") {
      const role = interaction.options.getRole("role", true);
      await interaction.reply(`Autorole set to ${role.name}.`);
    }
    if (interaction.commandName === "notify") {
      const who = interaction.options.getMentionable("who", true);
      const kind = "permissions" in who && "hoist" in who ? "role" : "user";
      await interaction.reply(`Notifying a ${kind}.`);
    }
    if (interaction.commandName === "upload") {
      const file = interaction.options.getAttachment("file", true);
      const text = await (await fetch(file.url)).text();
      await interaction.reply(`${file.name} (${file.size} bytes): ${text}`);
    }
    if (interaction.commandName === "jointocreate") {
      const hub = interaction.options.getChannel("hub", true);
      await interaction.reply(`Hub is ${hub.name}.`);
    }
  });
  return client;
}

it("gives the bot the role picked in a role option", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("Titan");
  const general = discord.channel(server, "general");
  const owner = discord.owner(server);
  const members = discord.role(server, "Members");
  await discord.start(createBot(discord.clientOptions), { commands });

  // Act
  const reply = await owner.run(general, "autorole", { role: members });

  // Assert
  expect(reply.content).toBe("Autorole set to Members.");
});

it("resolves a mentionable option to a role or a member", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("Titan");
  const general = discord.channel(server, "general");
  const owner = discord.owner(server);
  const mods = discord.role(server, "Mods");
  await discord.start(createBot(discord.clientOptions), { commands });

  // Act
  const reply = await owner.run(general, "notify", { who: mods });

  // Assert
  expect(reply.content).toBe("Notifying a role.");
});

it("resolves a mentionable option given a member to a user", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("Titan");
  const general = discord.channel(server, "general");
  const owner = discord.owner(server);
  const bob = discord.member(server, "Bob");
  await discord.start(createBot(discord.clientOptions), { commands });

  // Act
  const reply = await owner.run(general, "notify", { who: bob });

  // Assert
  expect(reply.content).toBe("Notifying a user.");
});

it("uploads the file given as an attachment option, so the bot can download it", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("Titan");
  const general = discord.channel(server, "general");
  const alice = discord.member(server, "Alice");
  await discord.start(createBot(discord.clientOptions), { commands });
  const file = {
    name: "notes.txt",
    data: new TextEncoder().encode("hello"),
    contentType: "text/plain",
  };

  // Act
  const reply = await alice.run(general, "upload", { file });

  // Assert
  expect(reply.content).toBe("notes.txt (5 bytes): hello");
});

it("takes a voice channel where the option offers only voice channels", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("Titan");
  const general = discord.channel(server, "general");
  const owner = discord.owner(server);
  const lobby = discord.voiceChannel(server, "Lobby");
  await discord.start(createBot(discord.clientOptions), { commands });

  // Act
  const reply = await owner.run(general, "jointocreate", { hub: lobby });

  // Assert
  expect(reply.content).toBe("Hub is Lobby.");
});
