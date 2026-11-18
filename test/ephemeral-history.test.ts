/**
 * An ephemeral reply lives only in the invoker's client, so channel history doesn't show it to the
 * bot. A purge command that defers ephemerally and fetches the latest message gets the member's.
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { expect, it } from "vitest";
import { createDiscord, Permission } from "../src/index.js";

const commands = [
  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Delete recent messages")
    .addIntegerOption((o) =>
      o.setName("amount").setDescription("How many").setRequired(true),
    )
    .toJSON(),
];

function createBot(options: object) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...options,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || !interaction.inCachedGuild())
      return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = interaction.channel!;
    const recent = await channel.messages.fetch({
      limit: interaction.options.getInteger("amount", true),
    });
    const deleted = await channel.bulkDelete(recent, true);
    await interaction.editReply(`Deleted ${deleted.size} message(s).`);
  });
  return client;
}

it("purges the member's message, not the bot's ephemeral reply", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("Titan");
  const general = discord.channel(server, "general");
  const owner = discord.owner(server);
  await discord.start(createBot(discord.clientOptions), {
    commands,
    permissions: Permission.ManageMessages | Permission.ReadMessageHistory,
  });
  owner.post(general, { content: "spam" });

  // Act
  const reply = await owner.runCommand(general, "purge", { amount: 1 });

  // Assert
  expect(reply.content).toBe("Deleted 1 message(s).");
  expect(discord.messages(general).map((m) => m.content)).not.toContain("spam");
});
