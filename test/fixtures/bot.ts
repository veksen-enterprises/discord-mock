/**
 * A small stock discord.js bot, written the way the real bots are: a factory taking config,
 * with nothing about the mock in it except the injectable client options.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  type ClientOptions,
  type TextChannel,
} from "discord.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("echo")
    .setDescription("Echo text back")
    .addStringOption((o) => o.setName("text").setDescription("what to say").setRequired(true))
    .addBooleanOption((o) => o.setName("secret").setDescription("only you see it")),
  new SlashCommandBuilder().setName("slow").setDescription("Defers, then answers"),
  new SlashCommandBuilder().setName("lazy").setDescription("Replies after 100ms without deferring (a bug)"),
  new SlashCommandBuilder().setName("panel").setDescription("Posts a button panel"),
  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Posts in a channel; reports failures")
    .addStringOption((o) => o.setName("channel").setDescription("channel id").setRequired(true)),
].map((c) => c.toJSON());

export async function deployCommands(opts: { token: string; applicationId: string; guildId: string; api?: string }) {
  const rest = new REST({ api: opts.api }).setToken(opts.token);
  await rest.put(Routes.applicationGuildCommands(opts.applicationId, opts.guildId), { body: commands });
}

export function createBot(clientOptions: Partial<ClientOptions> = {}, intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
]) {
  const client = new Client({ intents, ...clientOptions });
  const errors: unknown[] = [];

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (message.content === "!ping") await message.reply("pong");
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isButton() && interaction.customId === "count") {
        const n = Number(interaction.message.content.split(" ")[1]) + 1;
        await interaction.update({ content: `count ${n}` });
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      switch (interaction.commandName) {
        case "echo": {
          const secret = interaction.options.getBoolean("secret") ?? false;
          await interaction.reply({
            content: interaction.options.getString("text", true),
            flags: secret ? MessageFlags.Ephemeral : undefined,
          });
          return;
        }
        case "slow":
          await interaction.deferReply();
          await new Promise((r) => setTimeout(r, 50));
          await interaction.editReply("done thinking");
          return;
        case "lazy":
          await new Promise((r) => setTimeout(r, 100));
          await interaction.reply("too late?");
          return;
        case "panel":
          await interaction.reply({
            content: "count 0",
            components: [
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId("count").setLabel("+1").setStyle(ButtonStyle.Primary),
              ),
            ],
          });
          return;
        case "announce": {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const channel = (await client.channels.fetch(interaction.options.getString("channel", true))) as TextChannel;
          try {
            await channel.send("📣 announcement");
            await interaction.editReply("posted");
          } catch (error: any) {
            errors.push(error);
            await interaction.editReply(`failed: ${error.code ?? error.status ?? error.message}`);
          }
          return;
        }
      }
    } catch (error) {
      errors.push(error);
    }
  });

  return { client, errors };
}
