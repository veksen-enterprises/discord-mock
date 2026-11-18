/**
 * Forms (modals) whose labels wrap more than text inputs: selects, radio groups, checkboxes and
 * file uploads (docs.discord.food/resources/components#label), read with discord.js's
 * ModalSubmitFields getters.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ComponentType,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
} from "discord.js";
import { expect, it } from "vitest";
import { createDiscord } from "../src/index.js";

const commands = [
  new SlashCommandBuilder()
    .setName("economy")
    .setDescription("Economy")
    .toJSON(),
];

// What an economy dashboard's "Add Currency" form asks, like TitanBot's. A form holds at most 5.
const addCurrencyForm = {
  custom_id: "add-currency",
  title: "Add Currency",
  components: [
    {
      type: ComponentType.Label,
      label: "Target User",
      component: { type: ComponentType.UserSelect, custom_id: "user" },
    },
    {
      type: ComponentType.Label,
      label: "Wallet",
      component: {
        type: ComponentType.RadioGroup,
        custom_id: "wallet",
        options: [
          { label: "Cash", value: "cash" },
          { label: "Bank", value: "bank" },
        ],
      },
    },
    {
      type: ComponentType.Label,
      label: "Badges",
      component: {
        type: ComponentType.CheckboxGroup,
        custom_id: "badges",
        options: [
          { label: "Gold", value: "gold" },
          { label: "Silver", value: "silver" },
          { label: "Bronze", value: "bronze" },
        ],
      },
    },
    {
      type: ComponentType.Label,
      label: "Notify them?",
      component: { type: ComponentType.Checkbox, custom_id: "notify" },
    },
    {
      type: ComponentType.Label,
      label: "Receipt",
      component: { type: ComponentType.FileUpload, custom_id: "receipt" },
    },
  ],
};

function createBot(options: object) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...options,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand())
      await interaction.reply({
        content: "Economy",
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("add")
              .setLabel("Add Currency")
              .setStyle(ButtonStyle.Primary),
          ),
        ],
      });
    if (interaction.isButton())
      await interaction.showModal(addCurrencyForm as never);
    if (interaction.isModalSubmit()) {
      const fields = interaction.fields;
      const user = fields.getSelectedUsers("user", true)!.first()!;
      const receipt = fields.getUploadedFiles("receipt")?.first();
      await interaction.reply(
        [
          user.username,
          fields.getRadioGroup("wallet"),
          fields.getCheckboxGroup("badges").join("+"),
          fields.getCheckbox("notify"),
          receipt?.name,
        ].join(" | "),
      );
    }
  });
  return client;
}

it("submits selects, a radio group, checkboxes and a file in a form", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("Titan");
  const general = discord.channel(server, "general");
  const owner = discord.owner(server);
  const bob = discord.member(server, "Bob");
  await discord.start(createBot(discord.clientOptions), { commands });
  const dashboard = await owner.runCommand(general, "economy");
  const receipt = {
    name: "receipt.png",
    data: new Uint8Array([1, 2, 3]),
    contentType: "image/png",
  };

  // Act
  const reply = await owner.click(dashboard, "Add Currency", {
    "Target User": bob,
    Wallet: "Bank",
    Badges: ["Gold", "Bronze"],
    "Notify them?": true,
    Receipt: receipt,
  });

  // Assert
  expect(reply.content).toBe("Bob | bank | gold+bronze | true | receipt.png");
});

it("refuses to submit a form whose required radio group is left empty", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("Titan");
  const general = discord.channel(server, "general");
  const owner = discord.owner(server);
  const bob = discord.member(server, "Bob");
  await discord.start(createBot(discord.clientOptions), { commands });
  const dashboard = await owner.runCommand(general, "economy");

  // Act
  const submitting = owner.click(dashboard, "Add Currency", {
    "Target User": bob,
    Badges: ["Gold"],
  });

  // Assert
  await expect(submitting).rejects.toThrow(
    'field "Wallet" of "Add Currency" (fields "Target User", "Wallet", "Badges", "Notify them?", "Receipt") is required',
  );
});
