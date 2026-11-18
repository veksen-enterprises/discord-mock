/**
 * A trimmed copy of sin-bot's /join: the ladder is found from the channel's category, the member's
 * server display name is stored, and the answer is an ephemeral embed. The store is an in-memory
 * Map standing in for the database.
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type ClientOptions,
} from "discord.js";
import { reply } from "./reply.js";

/** Ladder name (= category name) → Discord user id → display name. */
export type Store = Map<string, Map<string, string>>;

export const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join this channel's ladder"),
].map((c) => c.toJSON());

/** Like sin-bot's LadderService.getLadderFromChannel: a ladder is a channel category. */
export const ladders = {
  fromChannel(interaction: ChatInputCommandInteraction, store: Store) {
    const channel = interaction.channel;
    const category = channel && "parent" in channel ? channel.parent : null;
    return category ? store.get(category.name) : undefined;
  },
};

export async function executeJoin(
  interaction: ChatInputCommandInteraction,
  store: Store,
) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const ladder = ladders.fromChannel(interaction, store);
  if (!ladder)
    return reply(interaction).withError({
      title: "No Ladder",
      description: "This channel isn't part of a ladder.",
    });

  if (ladder.has(interaction.user.id))
    return reply(interaction).withError({
      title: "Already Joined",
      description: "You are already part of the ladder!",
    });

  const member = interaction.member;
  const name =
    member && "displayName" in member
      ? member.displayName
      : interaction.user.username;
  ladder.set(interaction.user.id, name);
  return reply(interaction).withSuccess({
    title: "Joined the Ladder!",
    description: "You have successfully joined the ladder. Good luck!",
  });
}

/** The one seam a bot needs: client options are injectable, so a test can point REST at the mock. */
export function createBot(
  store: Store,
  clientOptions: Partial<ClientOptions> = {},
) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...clientOptions,
  });
  const errors: unknown[] = [];
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      if (interaction.commandName === "join")
        await executeJoin(interaction, store);
    } catch (error) {
      errors.push(error);
    }
  });
  return { client, errors };
}

export async function registerCommands(opts: {
  token: string;
  applicationId: string;
  guildId: string;
  api?: string;
}) {
  await new REST({ api: opts.api })
    .setToken(opts.token)
    .put(Routes.applicationGuildCommands(opts.applicationId, opts.guildId), {
      body: commands,
    });
}
