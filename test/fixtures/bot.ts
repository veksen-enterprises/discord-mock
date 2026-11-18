/**
 * A small stock discord.js bot, written the way the real bots are: a factory taking config,
 * with nothing about the mock in it except the injectable client options.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ApplicationCommandType,
  Client,
  ContextMenuCommandBuilder,
  Events,
  GatewayIntentBits,
  LabelBuilder,
  ModalBuilder,
  Partials,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  PermissionFlagsBits,
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
    .addStringOption((o) =>
      o.setName("text").setDescription("what to say").setRequired(true),
    )
    .addBooleanOption((o) =>
      o.setName("secret").setDescription("only you see it"),
    ),
  new SlashCommandBuilder()
    .setName("slow")
    .setDescription("Defers, then answers"),
  new SlashCommandBuilder()
    .setName("lazy")
    .setDescription("Replies after 100ms without deferring (a bug)"),
  new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Posts a button panel"),
  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Posts in a channel; reports failures")
    .addStringOption((o) =>
      o.setName("channel").setDescription("channel id").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("whois")
    .setDescription("Names a member by nickname or username")
    .addUserOption((o) =>
      o.setName("user").setDescription("who").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("thinking")
    .setDescription("Defers, then answers with followUp"),
  new SlashCommandBuilder()
    .setName("settings")
    .setDescription("Server settings, for whoever can manage the server")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName("docs")
    .setDescription("Links a docs page, suggested as you type")
    .addStringOption((o) =>
      o
        .setName("query")
        .setDescription("page")
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("remind")
    .setDescription("DMs you a reminder, or says it can't"),
  new SlashCommandBuilder()
    .setName("feedback")
    .setDescription("Opens a feedback form"),
  new SlashCommandBuilder()
    .setName("sign")
    .setDescription("Posts a sign with a Rename button"),
  new ContextMenuCommandBuilder()
    .setName("View Nickname")
    .setType(ApplicationCommandType.User),
  new ContextMenuCommandBuilder()
    .setName("Quote")
    .setType(ApplicationCommandType.Message),
].map((c) => c.toJSON());

const DOC_PAGES = [
  "Promise.all",
  "Promise.allSettled",
  "Promise.any",
  "Array.from",
];

export async function deployCommands(opts: {
  token: string;
  applicationId: string;
  guildId: string;
  api?: string;
}) {
  const rest = new REST({ api: opts.api }).setToken(opts.token);
  await rest.put(
    Routes.applicationGuildCommands(opts.applicationId, opts.guildId),
    { body: commands },
  );
}

export function createBot(
  clientOptions: Partial<ClientOptions> = {},
  intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
) {
  // Partials.Channel: discord.js drops a DM whose channel isn't cached (Action.getChannel).
  const client = new Client({
    intents,
    partials: [Partials.Channel],
    ...clientOptions,
  });
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
      if (interaction.isAutocomplete()) {
        const typed = interaction.options.getFocused();
        await interaction.respond(
          DOC_PAGES.filter((page) => page.startsWith(typed)).map((page) => ({
            name: page,
            value: page,
          })),
        );
        return;
      }
      if (interaction.isButton() && interaction.customId === "rename") {
        // The deprecated shape: a text input in an action row, labelled by its own label.
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId("rename")
            .setTitle("Rename the sign")
            .addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                  .setCustomId("text")
                  .setLabel("New text")
                  .setStyle(TextInputStyle.Short),
              ),
            ),
        );
        return;
      }
      if (interaction.isModalSubmit()) {
        if (interaction.customId === "rename" && interaction.isFromMessage())
          await interaction.update({
            content: interaction.fields.getTextInputValue("text"),
          });
        if (interaction.customId === "feedback")
          await interaction.reply(
            `thanks for "${interaction.fields.getTextInputValue("topic")}"`,
          );
        return;
      }
      if (interaction.isUserContextMenuCommand()) {
        const member = interaction.targetMember;
        await interaction.reply(
          member && "displayName" in member
            ? `nickname ${member.displayName}`
            : `user ${interaction.targetUser.username}`,
        );
        return;
      }
      if (interaction.isMessageContextMenuCommand()) {
        await interaction.reply(`> ${interaction.targetMessage.content}`);
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
        case "docs":
          await interaction.reply(
            `docs for ${interaction.options.getString("query", true)}`,
          );
          return;
        case "remind":
          try {
            await interaction.user.send("reminder set");
            await interaction.reply("check your DMs");
          } catch (error) {
            if ((error as { code?: number }).code !== 50007) throw error;
            await interaction.reply("I can't DM you");
          }
          return;
        case "feedback":
          await interaction.showModal(
            new ModalBuilder()
              .setCustomId("feedback")
              .setTitle("Feedback")
              .addLabelComponents(
                new LabelBuilder()
                  .setLabel("Topic")
                  .setTextInputComponent(
                    new TextInputBuilder()
                      .setCustomId("topic")
                      .setStyle(TextInputStyle.Short)
                      .setMaxLength(20),
                  ),
                new LabelBuilder()
                  .setLabel("Details")
                  .setTextInputComponent(
                    new TextInputBuilder()
                      .setCustomId("details")
                      .setStyle(TextInputStyle.Paragraph)
                      .setRequired(false),
                  ),
              ),
          );
          return;
        case "sign":
          await interaction.reply({
            content: "Open",
            components: [
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId("rename")
                  .setLabel("Rename")
                  .setStyle(ButtonStyle.Secondary),
              ),
            ],
          });
          return;
        case "settings":
          await interaction.reply("settings saved");
          return;
        case "whois": {
          const member = interaction.options.getMember("user");
          await interaction.reply(
            member && "displayName" in member
              ? `member ${member.displayName}`
              : "not a member",
          );
          return;
        }
        case "thinking":
          await interaction.deferReply();
          await interaction.followUp("thought");
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
                new ButtonBuilder()
                  .setCustomId("count")
                  .setLabel("+1")
                  .setStyle(ButtonStyle.Primary),
              ),
            ],
          });
          return;
        case "announce": {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const channel = (await client.channels.fetch(
            interaction.options.getString("channel", true),
          )) as TextChannel;
          try {
            await channel.send("📣 announcement");
            await interaction.editReply("posted");
          } catch (error) {
            errors.push(error);
            const { code, status, message } = error as {
              code?: number | string;
              status?: number;
              message?: string;
            };
            await interaction.editReply(`failed: ${code ?? status ?? message}`);
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
