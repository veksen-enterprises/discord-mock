import { setTimeout as sleep } from "node:timers/promises";
/**
 * Discord keeps a deferred interaction's token for 15 minutes, so the run waits as long as the bot
 * keeps working, and fails only once it has gone quiet without editing in its reply.
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
} from "discord.js";
import { expect, it } from "vitest";
import { createDiscord, Permission } from "../src/index.js";

const EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣"];

const commands = [
  new SlashCommandBuilder().setName("poll").setDescription("Start a poll"),
  new SlashCommandBuilder().setName("forget").setDescription("Never answers"),
  new SlashCommandBuilder().setName("spin").setDescription("Busy forever"),
].map((c) => c.toJSON());

function createBot(options: object) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...options,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || !interaction.inCachedGuild())
      return;
    await interaction.deferReply();
    if (interaction.commandName === "forget") return;
    if (interaction.commandName === "spin") {
      // A polling loop that never edits in the reply.
      while (client.isReady()) {
        await interaction.channel!.sendTyping();
        await sleep(200);
      }
      return;
    }
    const poll = await interaction.channel!.send("Lunch?");
    // Spaced out to stay clear of the reaction rate limit, as TitanBot's /poll does.
    for (const emoji of EMOJIS) {
      await poll.react(emoji);
      await sleep(500);
    }
    await interaction.editReply("Poll posted.");
  });
  return client;
}

it("waits through a deferred reply for as long as the bot keeps working", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("Titan");
  const general = discord.textChannel(server, "general");
  const alice = discord.member(server, "Alice");
  await discord.start(createBot(discord.clientOptions), {
    commands,
    permissions:
      Permission.SendMessages |
      Permission.AddReactions |
      Permission.ReadMessageHistory,
  });

  // Act
  const reply = await alice.runCommand(general, "poll");

  // Assert
  expect(reply.content).toBe("Poll posted.");
}, 10_000);

it("fails a deferred reply once the bot goes quiet without answering", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("Titan");
  const general = discord.textChannel(server, "general");
  const alice = discord.member(server, "Alice");
  await discord.start(createBot(discord.clientOptions), { commands });

  // Act
  const reply = alice.runCommand(general, "forget");

  // Assert
  await expect(reply).rejects.toThrow(
    "the bot deferred, then went quiet for 2s",
  );
});

it("fails a deferred reply when the bot keeps working without ever answering, naming its requests", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("Titan");
  const general = discord.textChannel(server, "general");
  const alice = discord.member(server, "Alice");
  await discord.start(createBot(discord.clientOptions), {
    commands,
    permissions: Permission.SendMessages,
  });

  // Act
  const reply = alice.runCommand(general, "spin");

  // Assert
  await expect(reply).rejects.toThrow(
    /still working 10s after this interaction.*POST \/channels\/\d+\/typing/,
  );
}, 15_000);
