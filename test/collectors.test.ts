/**
 * Dashboards built on a component collector: the bot replies, fetches its reply and starts the
 * collector on it, then defers each click (type 6) and edits the dashboard through the command's
 * own interaction. A member clicks only once the dashboard is up, and sees it as the bot leaves it.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
} from "discord.js";
import { expect, it } from "vitest";
import { createDiscord } from "../src/index.js";

const commands = [
  new SlashCommandBuilder()
    .setName("dashboard")
    .setDescription("Settings")
    .toJSON(),
];

function createBot(options: object) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...options,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    let enabled = false;
    const view = () => ({
      content: `Welcome messages: ${enabled ? "on" : "off"}`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("toggle")
            .setLabel("Toggle")
            .setStyle(ButtonStyle.Primary),
        ),
      ],
    });
    await interaction.reply(view());
    const dashboard = await interaction.fetchReply();
    const collector = dashboard.createMessageComponentCollector({
      filter: (click) => click.user.id === interaction.user.id,
    });
    collector.on("collect", async (click) => {
      await click.deferUpdate();
      enabled = !enabled;
      await interaction.editReply(view());
    });
  });
  return client;
}

it("clicks a dashboard button once the bot is listening, and sees the edit it makes", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("Titan");
  const general = discord.channel(server, "general");
  const owner = discord.owner(server);
  await discord.start(createBot(discord.clientOptions), { commands });
  const dashboard = await owner.run(general, "dashboard");

  // Act
  const after = await owner.click(dashboard, "Toggle");

  // Assert
  expect(after.content).toBe("Welcome messages: on");
});
