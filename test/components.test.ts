import { once } from "node:events";
import {
  ActionRowBuilder,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  StringSelectMenuBuilder,
} from "discord.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDiscordMock, type DiscordMock } from "../src/index.js";

let mock: DiscordMock;
let client: Client;

beforeEach(async () => {
  mock = await createDiscordMock();
});

afterEach(async () => {
  await client?.destroy();
  await mock.close();
});

it("delivers a string select pick and shows the bot's update", async () => {
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

  expect(() => mock.as(bob).selectOption(menu, "Bob")).toThrow(/can't see/);
});
