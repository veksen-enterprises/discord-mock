/** A bot with one command: /challenge @player replies to the challenger and DMs the player. */
import {
  Client,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type ClientOptions,
} from "discord.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("challenge")
    .setDescription("Challenge another player")
    .addUserOption((option) =>
      option
        .setName("opponent")
        .setDescription("Who to challenge")
        .setRequired(true),
    ),
].map((command) => command.toJSON());

export async function executeChallenge(
  interaction: ChatInputCommandInteraction,
) {
  const opponent = interaction.options.getUser("opponent", true);
  await interaction.reply(`Challenge sent to ${opponent.displayName}.`);
  await opponent.send(`${interaction.user.displayName} challenged you.`);
}

/** The one change a bot needs: its client options can be passed in. */
export function createBot(clientOptions: Partial<ClientOptions> = {}) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...clientOptions,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "challenge"
    )
      await executeChallenge(interaction);
  });
  return client;
}
