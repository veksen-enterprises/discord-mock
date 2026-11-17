import { once } from "node:events";
import { Events, GatewayIntentBits, type Client } from "discord.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDiscordMock, type DiscordMock } from "../src/index.js";
import { createBot, deployCommands } from "./fixtures/bot.js";

let mock: DiscordMock;
let client: Client;

async function start(intents?: GatewayIntentBits[]) {
  const guild = mock.createGuild("test guild");
  const general = mock.createTextChannel(guild, "general");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  await deployCommands({
    token: mock.token,
    applicationId: mock.state.applicationId,
    guildId: guild.id,
    api: mock.apiUrl,
  });
  const bot = createBot(mock.clientOptions, intents);
  client = bot.client;
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  return { guild, general, alice, bot };
}

beforeEach(async () => {
  mock = await createDiscordMock();
});

afterEach(async () => {
  await client?.destroy();
  await mock.close();
});

describe("a stock discord.js Client against the mock", () => {
  it("reaches ready with the guild cached", async () => {
    const { guild, general } = await start();
    expect(client.user?.id).toBe(mock.state.applicationId);
    expect(client.guilds.cache.get(guild.id)?.name).toBe("test guild");
    expect(client.channels.cache.has(general.id)).toBe(true);
    mock.assertNoUnhandledRequests();
  });

  it("replies to a message", async () => {
    const { general, alice } = await start();
    const sent = mock.as(alice).sendMessage(general, "!ping");
    const reply = await mock.waitForMessage(
      (m) => m.author.id === mock.state.bot.id,
    );
    expect(reply.content).toBe("pong");
    expect(reply.channel_id).toBe(general.id);
    expect(mock.rest.log.at(-1)?.body).toMatchObject({
      message_reference: { message_id: sent.id },
    });
  });

  it("answers a slash command", async () => {
    const { general, alice } = await start();
    const run = mock.as(alice).slashCommand(general, "echo", { text: "hello" });
    expect((await run.reply()).content).toBe("hello");
    expect(run.ephemeral).toBe(false);
  });

  it("answers ephemerally when asked", async () => {
    const { general, alice } = await start();
    const run = mock
      .as(alice)
      .slashCommand(general, "echo", { text: "psst", secret: true });
    await run.reply();
    expect(run.ephemeral).toBe(true);
  });

  it("follows a defer through to the edited reply", async () => {
    const { general, alice } = await start();
    const run = mock.as(alice).slashCommand(general, "slow");
    await run.waitUntil((r) => r.state === "deferred");
    expect((await run.reply()).content).toBe("done thinking");
  });

  it("handles a button press that updates the message", async () => {
    const { general, alice } = await start();
    const panel = await mock.as(alice).slashCommand(general, "panel").reply();
    const click = mock.as(alice).clickButton(panel, "count");
    await click.waitUntil((r) => r.state === "replied");
    expect(
      mock.messagesIn(general).find((m) => m.id === panel.id)?.content,
    ).toBe("count 1");
  });

  it("a followUp right after a defer edits the loading message, like Discord", async () => {
    const { general, alice } = await start();
    const run = mock.as(alice).slashCommand(general, "thinking");
    const reply = await run.reply();
    expect(reply.content).toBe("thought");
    expect(run.followups).toHaveLength(0);
    expect(mock.messagesIn(general)).toHaveLength(1);
  });

  it("credits the reply to the user who ran the command", async () => {
    const { guild, general, alice } = await start();
    const reply = await mock
      .as(alice)
      .slashCommand(general, "echo", { text: "hi" })
      .reply();
    expect(reply.interaction_metadata).toMatchObject({
      type: 2,
      user: { id: alice.id },
      authorizing_integration_owners: { 0: guild.id },
    });
  });

  it("resolves a user option to its guild member", async () => {
    const { general, alice } = await start();
    const run = mock
      .as(alice)
      .slashCommand(general, "whois", { user: alice.id });
    expect((await run.reply()).content).toBe("member alice");
  });

  it("refuses a slash command registered without a description", async () => {
    const { guild } = await start();
    const { REST, Routes } = await import("discord.js");
    const rest = new REST({ api: mock.apiUrl }).setToken(mock.token);
    await expect(
      rest.put(
        Routes.applicationGuildCommands(mock.state.applicationId, guild.id),
        { body: [{ name: "bare" }] },
      ),
    ).rejects.toMatchObject({ code: 50035, status: 400 });
  });

  it("reports a gateway op the mock doesn't answer as a Gap", async () => {
    const { guild } = await start([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
    ]);
    await expect(
      client.guilds.cache.get(guild.id)!.members.fetch({ time: 100 }),
    ).rejects.toThrow();
    expect(() => mock.assertNoUnhandledRequests()).toThrow(/gateway op 8/);
  });

  it("rejects commands the bot never registered, and bad options", async () => {
    const { general, alice } = await start();
    expect(() => mock.as(alice).slashCommand(general, "nope")).toThrow(
      /isn't registered/,
    );
    expect(() => mock.as(alice).slashCommand(general, "echo", {})).toThrow(
      /requires option "text"/,
    );
    expect(() =>
      mock.as(alice).slashCommand(general, "echo", { text: 1 }),
    ).toThrow(/wrong type/);
  });
});

describe("intents behave like Discord", () => {
  it("without MESSAGE_CONTENT the bot sees empty content and stays silent", async () => {
    const { general, alice } = await start([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
    ]);
    const seen = once(client, Events.MessageCreate);
    mock.as(alice).sendMessage(general, "!ping");
    const [message] = await seen;
    expect(message.content).toBe("");
    await expect(
      mock.waitForMessage((m) => m.author.bot === true, { timeoutMs: 200 }),
    ).rejects.toThrow();
  });

  it("without GUILD_PRESENCES, GUILD_CREATE carries only the bot's own member", async () => {
    const { guild, alice } = await start([GatewayIntentBits.Guilds]);
    const cached = client.guilds.cache.get(guild.id)!.members.cache;
    expect(cached.has(mock.state.bot.id)).toBe(true);
    expect(cached.has(alice.id)).toBe(false);
  });

  it("with GUILD_PRESENCES, a small guild's GUILD_CREATE carries every member", async () => {
    const { guild, alice } = await start([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildPresences,
    ]);
    expect(client.guilds.cache.get(guild.id)!.members.cache.has(alice.id)).toBe(
      true,
    );
  });

  it("login fails with 4014 when a privileged intent isn't enabled in the portal", async () => {
    mock = await createDiscordMock({ privilegedIntents: 0 });
    mock.createGuild("g");
    const { client: c } = createBot(mock.clientOptions);
    client = c;
    await expect(c.login(mock.token)).rejects.toThrow(/disallowed intents/i);
  });
});
