import { once } from "node:events";
import {
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MentionableSelectMenuBuilder,
  RoleSelectMenuBuilder,
  UserSelectMenuBuilder,
} from "discord.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDiscordMock, type DiscordMock } from "../src/internal/mock.js";
import { Permission } from "../src/internal/payloads.js";

let mock: DiscordMock;
let client: Client;

beforeEach(async () => {
  mock = await createDiscordMock();
});

afterEach(async () => {
  await client?.destroy();
  await mock.close();
});

/** A bot whose /setup posts a user, a role and a channel select, and answers each pick with what discord.js resolved. */
async function setupBot() {
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand())
      await interaction.reply({
        components: [
          new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
            new UserSelectMenuBuilder().setCustomId("users").setMaxValues(2),
          ),
          new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
            new RoleSelectMenuBuilder().setCustomId("role"),
          ),
          new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId("log")
              .setChannelTypes(ChannelType.GuildText),
          ),
        ],
      });
    if (interaction.isUserSelectMenu())
      await interaction.reply(
        interaction.members
          .map((m) => ("displayName" in m ? m.displayName : "?"))
          .join(","),
      );
    if (interaction.isRoleSelectMenu())
      await interaction.reply(interaction.roles.map((r) => r.name).join(","));
    if (interaction.isChannelSelectMenu())
      await interaction.reply(
        interaction.channels.map((c) => ("name" in c ? c.name : "?")).join(","),
      );
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  await client.application!.commands.set([
    { name: "setup", description: "Set up the bot" },
  ]);
}

function world() {
  const guild = mock.createGuild("g");
  const general = mock.createTextChannel(guild, "general");
  const alice = mock.createUser("alice");
  const bob = mock.createUser("bob");
  mock.addMember(guild, alice);
  mock.addMember(guild, bob, { nick: "Bobby" });
  return { guild, general, alice, bob };
}

it("resolves the members, role and channel a user picks, as discord.js reads them", async () => {
  const { guild, general, alice, bob } = world();
  const mods = mock.createRole(guild, "mods", 0n);
  await setupBot();
  const panel = await mock.as(alice).slashCommand(general, "setup").reply();

  const users = await mock
    .as(alice)
    .pickEntities(panel, [alice.id, bob.id])
    .reply();
  const role = await mock.as(alice).pickEntities(panel, [mods.id]).reply();
  const channel = await mock
    .as(alice)
    .pickEntities(panel, [general.id])
    .reply();

  expect([users.content, role.content, channel.content]).toEqual([
    "alice,Bobby",
    "mods",
    "general",
  ]);
  mock.assertNoUnhandledRequests();
});

it("refuses picks no select on the message offers: a voice channel, a hidden channel, too many users", async () => {
  const { guild, general, alice, bob } = world();
  const lobby = mock.createVoiceChannel(guild, "lobby");
  const secret = mock.createTextChannel(guild, "secret");
  mock.setOverwrite(
    secret,
    { id: alice.id, type: 1 },
    { deny: Permission.ViewChannel },
  );
  const carol = mock.createUser("carol");
  mock.addMember(guild, carol);
  await setupBot();
  const panel = await mock.as(alice).slashCommand(general, "setup").reply();
  const as = mock.as(alice);

  expect(() => as.pickEntities(panel, [lobby.id])).toThrow(
    "no select menu that offers them",
  );
  expect(() => as.pickEntities(panel, [secret.id])).toThrow(
    "alice can't see secret",
  );
  expect(() => as.pickEntities(panel, [alice.id, bob.id, carol.id])).toThrow(
    "takes 1 to 2 picks, not 3",
  );
  expect(() => as.pickEntities(panel, [mock.createUser("dave").id])).toThrow(
    "dave isn't in g",
  );
});

it("sends a mentionable select both the users and the roles picked", async () => {
  const { guild, general, alice, bob } = world();
  const mods = mock.createRole(guild, "mods", 0n);
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand())
      await interaction.reply({
        components: [
          new ActionRowBuilder<MentionableSelectMenuBuilder>().addComponents(
            new MentionableSelectMenuBuilder()
              .setCustomId("ping")
              .setMaxValues(3),
          ),
        ],
      });
    if (interaction.isMentionableSelectMenu())
      await interaction.reply(
        `${interaction.users.size} users, ${interaction.roles.size} roles`,
      );
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  await client.application!.commands.set([
    { name: "setup", description: "Set up the bot" },
  ]);
  const panel = await mock.as(alice).slashCommand(general, "setup").reply();

  const answer = await mock
    .as(alice)
    .pickEntities(panel, [bob.id, mods.id])
    .reply();

  expect(answer.content).toBe("1 users, 1 roles");
});
