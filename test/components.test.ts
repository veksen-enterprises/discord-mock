import { once } from "node:events";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ContainerBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  StringSelectMenuBuilder,
} from "discord.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDiscordMock, type DiscordMock } from "../src/internal/mock.js";

let mock: DiscordMock;
let client: Client;

beforeEach(async () => {
  mock = await createDiscordMock();
});

afterEach(async () => {
  await client?.destroy();
  await mock.close();
});

it("delivers a pick on an ephemeral menu and shows the bot's update to that user only", async () => {
  const guild = mock.createGuild("ladder");
  const general = mock.createTextChannel(guild, "general");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    ...mock.clientOptions,
  });
  const heard: string[] = [];
  client.on(Events.Raw, (packet: { t: string | null }) => {
    if (packet.t?.startsWith("MESSAGE_")) heard.push(packet.t);
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand())
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("opponent")
              .addOptions(
                { label: "Bob", value: "222" },
                { label: "Carol", value: "333" },
              ),
          ),
        ],
      });
    if (interaction.isStringSelectMenu())
      await interaction.update({
        content: `${interaction.customId}=${interaction.values.join(",")}`,
        components: [],
      });
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  await client.application!.commands.set([
    { name: "challenge", description: "Challenge someone" },
  ]);

  const menu = await mock.as(alice).slashCommand(general, "challenge").reply();
  const picked = await mock.as(alice).selectOption(menu, "Carol").reply();

  expect(picked.content).toBe("opponent=333");
  expect(picked.flags! & MessageFlags.Ephemeral).toBe(MessageFlags.Ephemeral);
  // Frames arrive in order on one socket, so once alice's post is heard, a leaked update would be too.
  const barrier = once(client, Events.MessageCreate);
  mock.as(alice).sendMessage(general, "after");
  await barrier;
  expect(heard).toEqual(["MESSAGE_CREATE"]);
  mock.assertNoUnhandledRequests();
});

it("doesn't let another user pick from an ephemeral menu they can't see", async () => {
  const guild = mock.createGuild("ladder");
  const general = mock.createTextChannel(guild, "general");
  const alice = mock.createUser("alice");
  const bob = mock.createUser("bob");
  mock.addMember(guild, alice);
  mock.addMember(guild, bob);
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand())
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("opponent")
              .addOptions({ label: "Bob", value: "222" }),
          ),
        ],
      });
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  await client.application!.commands.set([
    { name: "challenge", description: "Challenge someone" },
  ]);

  const menu = await mock.as(alice).slashCommand(general, "challenge").reply();

  expect(() => mock.as(bob).selectOption(menu, "Bob")).toThrow(
    "bob can't see a message with no text: it's ephemeral, only alice can",
  );
});

it("names what a message offers when the test asks for a button or option it doesn't have", async () => {
  const guild = mock.createGuild("ladder");
  const general = mock.createTextChannel(guild, "general");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand())
      await interaction.reply({
        content: "Pick a score",
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("score")
              .addOptions(
                { label: "5-0", value: "50" },
                { label: "5-2", value: "52" },
              ),
          ),
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("confirm")
              .setLabel("Confirm")
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId("retry")
              .setEmoji({ name: "🔄" })
              .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
              .setURL("https://example.com/rules")
              .setLabel("Rules")
              .setStyle(ButtonStyle.Link),
          ),
        ],
      });
    if (interaction.isButton())
      await interaction.update({ content: `pressed ${interaction.customId}` });
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  await client.application!.commands.set([
    { name: "report", description: "Report a score" },
  ]);
  const actor = mock.as(alice);

  expect(() => actor.slashCommand(general, "reprot")).toThrow(
    "/reprot isn't registered. Registered: /report",
  );
  const menu = await actor.slashCommand(general, "report").reply();
  expect(() => actor.selectOption(menu, "5-1")).toThrow(
    'alice can\'t pick "5-1": "Pick a score" offers 5-0, 5-2',
  );
  expect(() => actor.selectOption(menu, /5/)).toThrow(
    '/5/ matches 2 options in "Pick a score": 5-0, 5-2',
  );
  expect(() => actor.clickButton(menu, "Cancel")).toThrow(
    'alice can\'t click "Cancel": "Pick a score" has buttons Confirm, 🔄, Rules',
  );
  expect(() => actor.clickButton(menu, "Rules")).toThrow(
    "button Rules opens a URL; the bot gets no interaction",
  );
  const pressed = await actor.clickButton(menu, "🔄").reply();
  expect(pressed.content).toBe("pressed retry");
  mock.assertNoUnhandledRequests();
});

it("presses a button inside a Components V2 container", async () => {
  const guild = mock.createGuild("ladder");
  const general = mock.createTextChannel(guild, "general");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand())
      await interaction.reply({
        flags: MessageFlags.IsComponentsV2,
        components: [
          new ContainerBuilder().addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId("join")
                .setLabel("Join")
                .setStyle(ButtonStyle.Primary),
            ),
          ),
        ],
      });
    if (interaction.isButton())
      await interaction.reply({ content: `pressed ${interaction.customId}` });
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  await client.application!.commands.set([
    { name: "panel", description: "Show the panel" },
  ]);

  const panel = await mock.as(alice).slashCommand(general, "panel").reply();
  const pressed = await mock.as(alice).clickButton(panel, "Join").reply();

  expect(pressed.content).toBe("pressed join");
  mock.assertNoUnhandledRequests();
});

it("sends several picks from a multi-select, and refuses a count outside its min and max", async () => {
  const guild = mock.createGuild("ladder");
  const general = mock.createTextChannel(guild, "general");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand())
      await interaction.reply({
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("roles")
              .setMinValues(2)
              .setMaxValues(3)
              .addOptions(
                { label: "Ranked", value: "ranked" },
                { label: "Casual", value: "casual" },
                { label: "Events", value: "events" },
                { label: "News", value: "news" },
              ),
          ),
        ],
      });
    if (interaction.isStringSelectMenu())
      await interaction.update({ content: interaction.values.join(",") });
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  await client.application!.commands.set([
    { name: "roles", description: "Pick your roles" },
  ]);
  const menu = await mock.as(alice).slashCommand(general, "roles").reply();

  const picked = await mock
    .as(alice)
    .selectOption(menu, ["Ranked", "Events"])
    .reply();

  expect(picked.content).toBe("ranked,events");
  expect(() => mock.as(alice).selectOption(menu, "News")).toThrow(
    "takes 2 to 3 picks, not 1",
  );
});
