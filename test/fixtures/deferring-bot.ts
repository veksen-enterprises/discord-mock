import { setTimeout as sleep } from "node:timers/promises";
import {
  Client,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
} from "discord.js";

/**
 * A bot that defers every command: /poll works for about 3s before editing in its reply, /forget
 * never answers, and /spin keeps sending requests without ever answering.
 */
const EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣"];

export const commands = [
  new SlashCommandBuilder().setName("poll").setDescription("Start a poll"),
  new SlashCommandBuilder().setName("forget").setDescription("Never answers"),
  new SlashCommandBuilder().setName("spin").setDescription("Busy forever"),
].map((c) => c.toJSON());

export function createBot(options: object) {
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
