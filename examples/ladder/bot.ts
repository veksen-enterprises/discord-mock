/**
 * Trimmed copies of two sin-bot commands. /join stores the member under their server nickname in the
 * ladder of the channel's category. /challenge offers the ladder's other players in a select menu;
 * picking one DMs them and announces the challenge in #updates. The store is an in-memory Map
 * standing in for the database.
 */
import {
  ActionRowBuilder,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type ClientOptions,
  type StringSelectMenuInteraction,
  type TextBasedChannel,
} from "discord.js";
import { reply } from "./reply.js";

/** Ladder name (= category name) → Discord user id → the name the ladder shows. */
export type Store = Map<string, Map<string, string>>;

export const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join this channel's ladder"),
  new SlashCommandBuilder()
    .setName("challenge")
    .setDescription("Challenge a player on this channel's ladder"),
].map((c) => c.toJSON());

const OPPONENT_MENU = "challenge-opponent";

/** Like sin-bot's LadderService.getLadderFromChannel: a ladder is a channel category. */
export const ladders = {
  fromChannel(channel: TextBasedChannel | null, store: Store) {
    const category = channel && "parent" in channel ? channel.parent : null;
    return category ? store.get(category.name) : undefined;
  },
};

export async function executeJoin(
  interaction: ChatInputCommandInteraction,
  store: Store,
) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const ladder = ladders.fromChannel(interaction.channel, store);
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

/** Answers /challenge privately with a menu of the ladder's other players. */
export async function executeChallenge(
  interaction: ChatInputCommandInteraction,
  store: Store,
) {
  const ladder = ladders.fromChannel(interaction.channel, store);
  const opponents = [...(ladder ?? [])].filter(
    ([id]) => id !== interaction.user.id,
  );
  if (opponents.length === 0)
    return interaction.reply({
      content: "Nobody else is on this ladder yet.",
      flags: MessageFlags.Ephemeral,
    });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(OPPONENT_MENU)
    .setPlaceholder("Pick an opponent")
    .addOptions(opponents.map(([id, name]) => ({ label: name, value: id })));
  return interaction.reply({
    content: "Who do you want to challenge?",
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

/** The pick from /challenge's menu: confirm it, DM the opponent, announce it in #updates. */
export async function executePickOpponent(
  interaction: StringSelectMenuInteraction,
  store: Store,
) {
  const ladder = ladders.fromChannel(interaction.channel, store);
  // The menu has min_values 1, so Discord always sends a pick
  const opponentId = interaction.values[0]!;
  const challenger = ladder?.get(interaction.user.id);
  const opponent = ladder?.get(opponentId);

  await interaction.update({
    content: `Challenge sent to ${opponent}.`,
    components: [],
  });
  await interaction.client.users.send(
    opponentId,
    `${challenger} challenged you. Play within 7 days.`,
  );
  const updates = interaction.guild?.channels.cache.find(
    (channel) => channel.name === "updates",
  );
  if (updates?.isSendable())
    await updates.send(`${challenger} challenged ${opponent}!`);
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
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "join")
          await executeJoin(interaction, store);
        if (interaction.commandName === "challenge")
          await executeChallenge(interaction, store);
      }
      if (
        interaction.isStringSelectMenu() &&
        interaction.customId === OPPONENT_MENU
      )
        await executePickOpponent(interaction, store);
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
