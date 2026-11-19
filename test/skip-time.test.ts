/**
 * A menu whose collector times out. discord.js runs a collector's `time` on the `setTimeout` it
 * took from `node:timers` when it loaded (Collector.js), so faked timers can't reach it;
 * `skipTime` ends the collector instead, as its timer would.
 */
import {
  ActionRowBuilder,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { expect, it } from "vitest";
import { createDiscord } from "../src/index.js";

const commands = [
  new SlashCommandBuilder().setName("pick").setDescription("Pick").toJSON(),
];

function createBot(
  options: object,
  timing: { time?: number; idle?: number } = { time: 60_000 },
) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...options,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const response = await interaction.reply({
      content: "Pick a colour",
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("colour")
            .addOptions({ label: "Red", value: "red" }),
        ),
      ],
      flags: MessageFlags.Ephemeral,
      withResponse: true,
    });
    const collector =
      response.resource!.message!.createMessageComponentCollector(timing);
    collector.on("collect", (pick) =>
      pick.update({ content: "Red it is", components: [] }),
    );
    collector.on("end", async (picked) => {
      if (picked.size === 0)
        await interaction.editReply({ content: "Timed out", components: [] });
    });
  });
  return client;
}

it("ends a menu's collector when its time runs out", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const general = discord.textChannel(server, "general");
  const alice = discord.member(server, "Alice");
  await discord.start(createBot(discord.clientOptions), { commands });
  const menu = await alice.runCommand(general, "pick");

  // Act
  await discord.skipTime(60_000);

  // Assert
  expect(menu.content).toBe("Timed out");
  expect(menu.components).toEqual([]);
});

it("leaves a collector running when less than its time passes", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const general = discord.textChannel(server, "general");
  const alice = discord.member(server, "Alice");
  await discord.start(createBot(discord.clientOptions), { commands });
  const menu = await alice.runCommand(general, "pick");
  await discord.skipTime(59_000);

  // Act
  await alice.select(menu, "Red");

  // Assert
  expect(menu.content).toBe("Red it is");
});

it("ends a collector left idle, before its time runs out", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const general = discord.textChannel(server, "general");
  const alice = discord.member(server, "Alice");
  await discord.start(
    createBot(discord.clientOptions, { time: 60_000, idle: 15_000 }),
    { commands },
  );
  const menu = await alice.runCommand(general, "pick");

  // Act
  await discord.skipTime(15_000);

  // Assert
  expect(menu.content).toBe("Timed out");
});
