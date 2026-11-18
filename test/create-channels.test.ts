/**
 * Creating guild channels of every type a bot makes (docs.discord.food/resources/channel#create-guild-channel),
 * as a server-stats command (a category of locked voice counters) or a join-to-create hub does.
 */
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { expect, it } from "vitest";
import { createDiscord, Permission } from "../src/index.js";

const commands = [
  new SlashCommandBuilder()
    .setName("serverstats")
    .setDescription("Add counters"),
  new SlashCommandBuilder()
    .setName("lockdown-role")
    .setDescription("Hand out Manage Roles"),
].map((c) => c.toJSON());

function createBot(options: object) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...options,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || !interaction.inCachedGuild())
      return;
    const guild = interaction.guild;
    try {
      if (interaction.commandName === "serverstats") {
        const category = await guild.channels.create({
          name: "Stats",
          type: ChannelType.GuildCategory,
        });
        const counter = await guild.channels.create({
          name: `Members: ${guild.memberCount}`,
          type: ChannelType.GuildVoice,
          parent: category,
          permissionOverwrites: [
            { id: guild.roles.everyone, deny: [PermissionFlagsBits.Connect] },
          ],
        });
        const locked = !counter
          .permissionsFor(guild.roles.everyone)
          .has(PermissionFlagsBits.Connect);
        await interaction.reply(
          `${counter.parent!.name} / ${counter.name}, locked: ${locked}`,
        );
      }
      if (interaction.commandName === "lockdown-role") {
        await guild.channels.create({
          name: "mods",
          permissionOverwrites: [
            {
              id: guild.roles.everyone,
              allow: [PermissionFlagsBits.ManageRoles],
            },
          ],
        });
        await interaction.reply("Created.");
      }
    } catch (error) {
      await interaction.reply(`Failed: ${(error as Error).message}`);
    }
  });
  return client;
}

it("creates a category and a locked voice channel in it", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("Titan");
  const general = discord.textChannel(server, "general");
  const owner = discord.owner(server);
  await discord.start(createBot(discord.clientOptions), {
    commands,
    permissions: Permission.ManageChannels | Permission.Connect,
  });

  // Act
  const reply = await owner.runCommand(general, "serverstats");

  // Assert
  expect(reply.content).toBe("Stats / Members: 2, locked: true");
});

it("refuses an overwrite granting Manage Roles from a bot that isn't an administrator", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("Titan");
  const general = discord.textChannel(server, "general");
  const owner = discord.owner(server);
  await discord.start(createBot(discord.clientOptions), {
    commands,
    permissions: Permission.ManageChannels | Permission.ManageRoles,
  });

  // Act
  const reply = await owner.runCommand(general, "lockdown-role");

  // Assert
  expect(reply.content).toBe("Failed: Missing Permissions");
});
