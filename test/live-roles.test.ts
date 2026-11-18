/**
 * Roles made or given while the bot is connected reach it (GUILD_ROLE_CREATE, GUILD_MEMBER_UPDATE),
 * so discord.js's GuildMember.permissions, computed from its cached roles, sees them.
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
} from "discord.js";
import { expect, it } from "vitest";
import { createDiscord, Permission } from "../src/index.js";

// Like an invite filter: members who can manage the server may post invites.
function createBot(options: object) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    ...options,
  });
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.content.includes("discord.gg/")) return;
    if (message.member?.permissions.has(PermissionFlagsBits.ManageGuild))
      return;
    await message.delete();
  });
  return client;
}

it("lets a moderator who joined after the bot connected keep their invite", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("TPH");
  const general = discord.channel(server, "general");
  await discord.start(createBot(discord.clientOptions), {
    permissions: Permission.ManageMessages,
  });
  const mod = discord.member(server, "Mod", {
    permissions: Permission.ManageGuild,
  });

  // Act
  mod.post(general, { content: "join discord.gg/partner" });
  await discord.idle();

  // Assert
  expect(discord.messages(general).map((m) => m.content)).toEqual([
    "join discord.gg/partner",
  ]);
});

it("still deletes the invite of a member without Manage Server", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("TPH");
  const general = discord.channel(server, "general");
  await discord.start(createBot(discord.clientOptions), {
    permissions: Permission.ManageMessages,
  });
  const alice = discord.member(server, "Alice");

  // Act
  alice.post(general, { content: "join discord.gg/spam" });
  await discord.idle();

  // Assert
  expect(discord.messages(general)).toEqual([]);
});
