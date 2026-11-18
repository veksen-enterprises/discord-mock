import {
  ActionRowBuilder,
  Client,
  Events,
  GatewayIntentBits,
  RoleSelectMenuBuilder,
} from "discord.js";
import { expect, it, vi } from "vitest";
import {
  createDiscord,
  respond,
  Permission,
  type Guild,
  type Member,
} from "../src/index.js";
import { commands, createBot } from "./fixtures/bot.js";

async function startBot() {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const generalChannel = discord.channel(server, "general");
  const alice = discord.member(server, "alice");
  const bob = discord.member(server, "bob", { nickname: "Bobby" });
  await discord.start(createBot(discord.clientOptions).client, { commands });
  return { discord, server, generalChannel, alice, bob };
}

it("shows the bot's in-place update on the message the test already holds", async () => {
  const { generalChannel, alice } = await startBot();
  const panel = await alice.run(generalChannel, "panel");

  const after = await alice.click(panel, "+1");

  expect(after).toBe(panel);
  expect(panel.content).toBe("count 1");
});

it("finds a message the bot posts after the action returns", async () => {
  const { discord, generalChannel, alice } = await startBot();

  alice.post(generalChannel, { content: "!ping" });

  expect((await discord.find(generalChannel, "pong")).content).toBe("pong");
});

it("doesn't take the member's own message for the bot's", async () => {
  const { discord, generalChannel, alice } = await startBot();

  alice.post(generalChannel, { content: "!ping" });

  expect((await discord.find(generalChannel, /p.ng/)).content).toBe("pong");
});

it("waits until the bot has gone quiet, so a check for exactly one reply holds", async () => {
  const { discord, generalChannel, alice } = await startBot();
  alice.post(generalChannel, { content: "!ping" });
  await discord.find(generalChannel, "pong");
  alice.post(generalChannel, { content: "!ping" });

  await discord.idle();

  expect(discord.messages(generalChannel).map((m) => m.content)).toEqual([
    "!ping",
    "pong",
    "!ping",
    "pong",
  ]);
});

it("lets a member who holds Manage Server run an admin command, and refuses one who doesn't", async () => {
  const { discord } = await startBot();
  const server = discord.guild("mods");
  const modsChannel = discord.channel(server, "mods");
  const mod = discord.member(server, "mod", {
    permissions: Permission.ManageGuild,
  });
  const regular = discord.member(server, "regular");

  expect((await mod.run(modsChannel, "settings")).content).toBe(
    "settings saved",
  );
  await expect(regular.run(modsChannel, "settings")).rejects.toThrow(
    "can't use /settings",
  );
});

it("lets a member DM the bot and finds the answer in their DMs", async () => {
  const { discord, alice } = await startBot();

  alice.dm({ content: "!ping" });

  expect((await discord.find(alice, "pong")).content).toBe("pong");
});

it("lets the bot DM a member, and refuses with 50007 once they close their DMs", async () => {
  const { discord, generalChannel, alice } = await startBot();

  expect((await alice.run(generalChannel, "remind")).content).toBe(
    "check your DMs",
  );
  expect(discord.dms(alice).map((m) => m.content)).toEqual(["reminder set"]);
  alice.closeDMs();
  expect((await alice.run(generalChannel, "remind")).content).toBe(
    "I can't DM you",
  );
});

it("names the channel and its last messages when find gives up", async () => {
  const { discord, generalChannel, alice } = await startBot();
  alice.post(generalChannel, { content: "hello" });

  await expect(discord.find(generalChannel, /goodbye/)).rejects.toThrow(
    'no message in #general written since the last action matched /goodbye/ within 2s. Last 1: "hello"',
  );
});

it("quotes a message's first non-empty line when find gives up", async () => {
  const { discord, generalChannel, alice } = await startBot();
  alice.post(generalChannel, { content: "\nhello" });

  await expect(discord.find(generalChannel, /goodbye/)).rejects.toThrow(
    'Last 1: "hello"',
  );
});

it("passes a member handle as a user option, under their server nickname", async () => {
  const { generalChannel, alice, bob } = await startBot();

  const reply = await alice.run(generalChannel, "whois", { user: bob });

  expect(reply.content).toBe("member Bobby");
});

it("applies a nickname change and a leave to the member", async () => {
  const { generalChannel, alice, bob } = await startBot();

  bob.nickname("Robert");
  expect(
    (await alice.run(generalChannel, "whois", { user: bob })).content,
  ).toBe("member Robert");
  bob.leave();

  await expect(bob.run(generalChannel, "echo", { text: "hi" })).rejects.toThrow(
    "bob isn't a member of SIN",
  );
});

it("shows a member's new display name where they have no nickname", async () => {
  const { generalChannel, alice } = await startBot();

  alice.displayName("Alicia");

  expect(
    (await alice.run(generalChannel, "whois", { user: alice })).content,
  ).toBe("member Alicia");
});

it("ignores a matching message the bot wrote before the latest action", async () => {
  const { discord, generalChannel, alice } = await startBot();
  alice.post(generalChannel, { content: "!ping" });
  await discord.find(generalChannel, "pong");

  alice.post(generalChannel, { content: "hello" });

  await expect(discord.find(generalChannel, "pong")).rejects.toThrow(
    "no message in #general written since the last action",
  );
});

it("still gives up when the test has faked timers and Date", async () => {
  const { discord, generalChannel } = await startBot();
  vi.useFakeTimers();
  try {
    await expect(discord.find(generalChannel, "never")).rejects.toThrow(
      "It has no messages",
    );
  } finally {
    vi.useRealTimers();
  }
});

it("refuses to let a member act in a server they aren't in, even when the types are widened", async () => {
  const { discord, alice } = await startBot();
  const elsewhere: Guild = discord.guild("elsewhere");
  const strangers = discord.channel(elsewhere, "strangers");
  const forum = discord.forum(elsewhere, "listings");
  const outsider: Member = alice;
  const insider = discord.member(elsewhere, "carol");
  const message = insider.post(strangers, { content: "hi" });

  expect(() => outsider.post(strangers, { content: "hi" })).toThrow(
    "alice isn't a member of elsewhere",
  );
  expect(() => outsider.react(message, "👍")).toThrow(
    "alice isn't a member of elsewhere",
  );
  expect(() =>
    outsider.forumPost(forum, { title: "wts", content: "x" }),
  ).toThrow("alice isn't a member of elsewhere");
  expect(message.reactions ?? []).toEqual([]);
});

it("runs a user app on a member and a message app on a message, from the Apps menu", async () => {
  const { generalChannel, alice, bob } = await startBot();
  const said = alice.post(generalChannel, { content: "gg" });

  const nickname = await alice.runApp(generalChannel, bob, "View Nickname");
  const quote = await bob.runApp(generalChannel, said, "Quote");

  expect(nickname.content).toBe("nickname Bobby");
  expect(quote.content).toBe("> gg");
});

it("names the registered apps of that kind when the app isn't one", async () => {
  const { generalChannel, alice, bob } = await startBot();

  await expect(alice.runApp(generalChannel, bob, "Quote")).rejects.toThrow(
    'the user app "Quote" isn\'t registered. Registered user apps: "View Nickname"',
  );
});

it("fills the form a command opens, and gets the bot's answer to it", async () => {
  const { generalChannel, alice } = await startBot();

  const thanks = await alice.run(
    generalChannel,
    "feedback",
    {},
    { Topic: "ladder" },
  );

  expect(thanks.content).toBe('thanks for "ladder"');
});

it("fills the form a button opens, and sees the message the bot updated", async () => {
  const { generalChannel, alice } = await startBot();
  const sign = await alice.run(generalChannel, "sign");

  const after = await alice.click(sign, "Rename", { "New text": "Closed" });

  expect(after).toBe(sign);
  expect(sign.content).toBe("Closed");
});

it("refuses a form the Discord app wouldn't submit, and says when the bot opened one", async () => {
  const { generalChannel, alice } = await startBot();

  await expect(alice.run(generalChannel, "feedback")).rejects.toThrow(
    'the bot opened the form "Feedback" (fields "Topic", "Details") instead of replying',
  );
  await expect(
    alice.run(generalChannel, "feedback", {}, { Details: "no topic" }),
  ).rejects.toThrow('field "Topic" of "Feedback"');
  await expect(
    alice.run(generalChannel, "feedback", {}, { Topic: "x".repeat(21) }),
  ).rejects.toThrow("takes at most 20 characters");
  await expect(
    alice.run(generalChannel, "feedback", {}, { Title: "x" }),
  ).rejects.toThrow('has no field "Title"');
});

it("fails one channel by its literal path, and leaves the others working", async () => {
  const { discord, generalChannel, alice } = await startBot();
  const server = discord.guild("news");
  const board = discord.channel(server, "board");
  const news = discord.channel(server, "news");
  discord.fail(
    "POST",
    `/channels/${board.id}/messages`,
    respond.missingPermissions(),
  );

  const failed = await alice.run(generalChannel, "announce", {
    channel: board.id,
  });
  const posted = await alice.run(generalChannel, "announce", {
    channel: news.id,
  });

  expect(failed.content).toBe("failed: 50013");
  expect(posted.content).toBe("posted");
});

it("shows the bot's suggestions while a member types, then runs the command with one", async () => {
  const { generalChannel, alice } = await startBot();

  const choices = await alice.autocomplete(
    generalChannel,
    "docs",
    "query",
    "Promise.al",
  );
  const reply = await alice.run(generalChannel, "docs", {
    query: choices[1]!.value,
  });

  expect(choices.map((c) => c.name)).toEqual([
    "Promise.all",
    "Promise.allSettled",
  ]);
  expect(reply.content).toBe("docs for Promise.allSettled");
  await expect(
    alice.autocomplete(generalChannel, "echo", "text", "hi"),
  ).rejects.toThrow('option "text" doesn\'t have autocomplete');
});

it("stops members using the bot's commands once it's kicked", async () => {
  const { discord, server, generalChannel, alice } = await startBot();

  discord.kickBot(server);

  await expect(
    alice.run(generalChannel, "echo", { text: "hi" }),
  ).rejects.toThrow("the bot isn't in SIN any more");
});

it("renames the guild as its owner, which a member without Manage Server can't", async () => {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const alice = discord.member(server, "alice");
  const { client } = createBot(discord.clientOptions);
  await discord.start(client, { commands });

  expect(() => alice.renameGuild("mine")).toThrow("without Manage Server");
  discord.owner(server).renameGuild("SIN 2");

  await vi.waitFor(() =>
    expect(client.guilds.cache.get(server.id)!.name).toBe("SIN 2"),
  );
});

it("counts a join through a member's invite, and refuses a used-up one", async () => {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const general = discord.channel(server, "general");
  const alice = discord.member(server, "alice");
  const { client } = createBot(discord.clientOptions);
  await discord.start(client, {
    commands,
    permissions: Permission.ManageGuild,
  });
  const code = alice.invite(general, { maxUses: 2 });

  discord.member(server, "carol", { invite: code });

  const invites = await client.guilds.cache.get(server.id)!.invites.fetch();
  expect(invites.get(code)?.uses).toBe(1);
  const once = alice.invite(general, { maxUses: 1 });
  discord.member(server, "dave", { invite: once });
  expect(() => discord.member(server, "erin", { invite: once })).toThrow(
    "used up",
  );
});

it("tells the bot a member joined and left voice", async () => {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const lobby = discord.voiceChannel(server, "lobby");
  const alice = discord.member(server, "alice");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    ...discord.clientOptions,
  });
  const seen: (string | null)[] = [];
  client.on(Events.VoiceStateUpdate, (_, after) =>
    seen.push(after.channel?.name ?? null),
  );
  await discord.start(client);

  alice.joinVoice(lobby);
  alice.leaveVoice();

  await vi.waitFor(() => expect(seen).toEqual(["lobby", null]));
  expect(() => alice.leaveVoice()).toThrow("isn't in voice");
});

it("lets an admin open an admin-only command to one member", async () => {
  const { discord, server, generalChannel, alice, bob } = await startBot();
  await expect(alice.run(generalChannel, "settings")).rejects.toThrow(
    "needs permissions",
  );

  discord.commandPermissions(server, "settings", [
    { target: alice, allow: true },
    { target: bob, allow: false },
  ]);

  await expect(alice.run(generalChannel, "settings")).resolves.toBeTruthy();
  await expect(bob.run(generalChannel, "settings")).rejects.toThrow(
    "an override denies them",
  );
});

it("lets a moderator kick a member, which the audit log credits to them", async () => {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const mod = discord.member(server, "mod", {
    permissions: Permission.KickMembers,
  });
  const alice = discord.member(server, "alice");
  const { client } = createBot(discord.clientOptions);
  await discord.start(client, {
    commands,
    permissions: Permission.ViewAuditLog,
  });

  expect(() => alice.kick(mod)).toThrow("Kick Members");
  mod.kick(alice, "spam");

  const log = await client.guilds.cache.get(server.id)!.fetchAuditLogs();
  expect(log.entries.first()?.executor?.username).toBe("mod");
});

it("picks roles in a role select by handle, and refuses a member there", async () => {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const general = discord.channel(server, "general");
  const alice = discord.member(server, "alice");
  const ranked = discord.role(server, "ranked");
  const casual = discord.role(server, "casual");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...discord.clientOptions,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand())
      await interaction.reply({
        components: [
          new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
            new RoleSelectMenuBuilder().setCustomId("roles").setMaxValues(2),
          ),
        ],
      });
    if (interaction.isRoleSelectMenu())
      await interaction.update({
        content: interaction.roles.map((r) => r.name).join(","),
        components: [],
      });
  });
  await discord.start(client, {
    commands: [{ name: "roles", description: "Pick your roles" }],
  });
  const menu = await alice.run(general, "roles");

  await expect(alice.select(menu, alice)).rejects.toThrow(
    "no select menu that offers them",
  );
  const picked = await alice.select(menu, [ranked, casual]);

  expect(picked.content).toBe("ranked,casual");
});

it("tells a bot with the intent about a member's event, which an ordinary member can't create", async () => {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const lobby = discord.voiceChannel(server, "lobby");
  const alice = discord.member(server, "alice");
  const host = discord.member(server, "host", {
    permissions: Permission.CreateEvents,
  });
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildScheduledEvents],
    ...discord.clientOptions,
  });
  const heard: string[] = [];
  client.on(Events.GuildScheduledEventCreate, (e) => heard.push(e.name));
  await discord.start(client, { commands: [] });

  expect(() => alice.createEvent("x", "the park", new Date())).toThrow(
    "Create Events",
  );
  host.createEvent("Raid night", lobby, new Date("2026-12-01T20:00Z"));
  await discord.idle();

  expect(heard).toEqual(["Raid night"]);
});

it("tells a bot that logs expressions about a moderator's new emoji, which a member can't add", async () => {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const alice = discord.member(server, "alice");
  const mod = discord.member(server, "mod", {
    permissions: Permission.CreateGuildExpressions,
  });
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildExpressions],
    ...discord.clientOptions,
  });
  const heard: string[] = [];
  client.on(Events.GuildEmojiCreate, (e) => heard.push(e.name!));
  client.on(Events.GuildEmojiUpdate, (_, e) => heard.push(e.name!));
  await discord.start(client, { commands: [] });

  expect(() => alice.addEmoji("pog")).toThrow("Create Expressions");
  const pog = mod.addEmoji("pog");
  mod.renameExpression(pog, "poggers");
  await discord.idle();

  expect(heard).toEqual(["pog", "poggers"]);
});
