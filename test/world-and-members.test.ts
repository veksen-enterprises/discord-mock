/**
 * World and member verbs a bot's flows need: the token, bot members, channel overwrites, invite
 * permissions in servers that add the bot later, the application's owner, members editing and
 * deleting their own messages, and moderators locking threads.
 */
import { once } from "node:events";
import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { expect, it } from "vitest";
import { createDiscord, Permission } from "../src/index.js";
import { commands, createBot } from "./fixtures/bot.js";

it("hands out its token, so a deploy script can register commands before the bot logs in", async () => {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const general = discord.channel(server, "general");
  const alice = discord.member(server, "alice");
  // What deploy scripts do: the application id is the token's first part, in base64.
  const appId = Buffer.from(discord.token.split(".")[0]!, "base64").toString();
  await new REST({ api: discord.clientOptions.rest.api })
    .setToken(discord.token)
    .put(Routes.applicationCommands(appId), { body: commands });

  await discord.start(createBot(discord.clientOptions).client);

  expect((await alice.run(general, "echo", { text: "hi" })).content).toBe("hi");
});

it("makes a member that is another bot", async () => {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const general = discord.channel(server, "general");
  const otherBot = discord.member(server, "Carl-bot", { bot: true });
  const { client } = createBot(discord.clientOptions);
  await discord.start(client);
  const seen = once(client, Events.MessageCreate);

  otherBot.post(general, { content: "!ping" });

  expect((await seen)[0].author.bot).toBe(true);
  expect(discord.messages(general)).toHaveLength(1);
});

it("denies the bot a permission in one channel, and allows it back", async () => {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const general = discord.channel(server, "general");
  const news = discord.channel(server, "news");
  const alice = discord.member(server, "alice");
  await discord.start(createBot(discord.clientOptions).client, {
    commands,
    permissions: Permission.ViewChannel | Permission.SendMessages,
  });

  discord.deny(news, "bot", Permission.SendMessages);
  const refused = await alice.run(general, "announce", { channel: news.id });
  discord.allow(news, "bot", Permission.SendMessages);
  const posted = await alice.run(general, "announce", { channel: news.id });

  expect(refused.content).toBe("failed: 50013");
  expect(posted.content).toBe("posted");
});

it("gives the bot its invite permissions in a server that adds it after start", async () => {
  const discord = await createDiscord();
  discord.guild("first");
  const { client } = createBot(discord.clientOptions);
  await discord.start(client, {
    permissions: Permission.ViewChannel | Permission.EmbedLinks,
  });
  const joined = once(client, Events.GuildCreate);

  const later = discord.guild("later");

  const [guild] = await joined;
  expect(guild.id).toBe(later.id);
  const me = await guild.members.fetchMe();
  expect(me.permissions.has(Permission.EmbedLinks)).toBe(true);
});

it("names the application's owner", async () => {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const general = discord.channel(server, "general");
  const alice = discord.member(server, "alice");
  const bob = discord.member(server, "bob");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...discord.clientOptions,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    await interaction.client.application.fetch();
    const owner = interaction.client.application.owner;
    await interaction.reply(
      interaction.user.id === owner?.id
        ? `owner ${interaction.user.username}`
        : "someone",
    );
  });
  await discord.start(client, {
    appOwner: alice,
    commands: [
      new SlashCommandBuilder().setName("whoami").setDescription("w").toJSON(),
    ],
  });

  expect((await alice.run(general, "whoami")).content).toBe("owner alice");
  expect((await bob.run(general, "whoami")).content).toBe("someone");
});

async function watcher() {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const general = discord.channel(server, "general");
  const alice = discord.member(server, "alice");
  const bob = discord.member(server, "bob");
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    ...discord.clientOptions,
  });
  await discord.start(client);
  return { discord, server, general, alice, bob, client };
}

it("announces a member's edit with the new text and an edit time", async () => {
  const { general, alice, client } = await watcher();
  const post = alice.post(general, { content: "helo" });
  const updated = once(client, Events.MessageUpdate);

  alice.edit(post, "hello");

  const [, after] = await updated;
  expect(after.content).toBe("hello");
  expect(after.editedTimestamp).not.toBeNull();
});

it("announces a member deleting their own message", async () => {
  const { discord, general, alice, client } = await watcher();
  const post = alice.post(general, { content: "oops" });
  const deleted = once(client, Events.MessageDelete);

  alice.delete(post);

  expect((await deleted)[0].id).toBe(post.id);
  expect(discord.messages(general)).toEqual([]);
});

it("refuses to let a member edit or delete someone else's message", async () => {
  const { general, alice, bob } = await watcher();
  const post = alice.post(general, { content: "mine" });

  expect(() => bob.edit(post, "x")).toThrow("it's not theirs");
  expect(() => bob.delete(post)).toThrow("only its author can");
});

it("locks a thread without archiving it", async () => {
  const { discord, server, alice, client } = await watcher();
  const listings = discord.forum(server, "listings");
  const { thread } = alice.forumPost(listings, { title: "wts", content: "x" });
  const updated = once(client, Events.ThreadUpdate);

  discord.lock(thread);

  const [, after] = await updated;
  expect(after).toMatchObject({ locked: true, archived: false });
});
