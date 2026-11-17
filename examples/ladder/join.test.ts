/**
 * AFTER: the same bot, unchanged, logged in to discord-mock as it would log in to Discord. A user
 * runs /join; the test reads what Discord would show them. No vi.mock, no spies, no casts.
 */
import { once } from "node:events";
import { Events, type Client } from "discord.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDiscordMock,
  respond,
  type DiscordMock,
} from "../../src/index.js";
import { createBot, registerCommands, type Store } from "./bot.js";

let mock: DiscordMock;
let client: Client;
let store: Store;
let errors: unknown[];

/** The World: a guild with a "Test Ladder" category holding #challenges, plus a #general outside it. */
async function start() {
  mock = await createDiscordMock();
  const guild = mock.createGuild("sin");
  const ladder = mock.createCategory(guild, "Test Ladder");
  const challenges = mock.createTextChannel(guild, "challenges", {
    parent: ladder,
  });
  const general = mock.createTextChannel(guild, "general");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice, { nick: "Bravo" });

  store = new Map([["Test Ladder", new Map()]]);
  await registerCommands({
    token: mock.token,
    applicationId: mock.state.applicationId,
    guildId: guild.id,
    api: mock.apiUrl,
  });
  const bot = createBot(store, mock.clientOptions);
  client = bot.client;
  errors = bot.errors;
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  return { challenges, general, alice };
}

afterEach(async () => {
  await client?.destroy();
  mock.assertNoUnhandledRequests();
  await mock.close();
});

describe("/join", () => {
  it("adds the member under their server nickname and confirms privately", async () => {
    const { challenges, alice } = await start();

    const run = mock.as(alice).slashCommand(challenges, "join");
    const reply = await run.reply();

    expect(run.ephemeral).toBe(true);
    expect(reply.embeds[0]).toMatchObject({
      title: "Joined the Ladder!",
      description: "You have successfully joined the ladder. Good luck!",
    });
    expect(store.get("Test Ladder")?.get(alice.id)).toBe("Bravo");
  });

  it("refuses a second join", async () => {
    const { challenges, alice } = await start();
    await mock.as(alice).slashCommand(challenges, "join").reply();

    const again = await mock.as(alice).slashCommand(challenges, "join").reply();

    expect(again.embeds[0]?.title).toBe("Already Joined");
  });

  it("says so when the channel isn't in a ladder category", async () => {
    const { general, alice } = await start();

    const reply = await mock.as(alice).slashCommand(general, "join").reply();

    expect(reply.embeds[0]?.title).toBe("No Ladder");
    expect(store.get("Test Ladder")?.size).toBe(0);
  });

  it("keeps the member joined when Discord fails the confirmation", async () => {
    const { challenges, alice } = await start();
    mock.use("PATCH", "/webhooks/:appId/:token/messages/@original", () =>
      respond.serverError(503),
    );

    const run = mock.as(alice).slashCommand(challenges, "join");
    await run.waitUntil((r) => r.state === "deferred");

    // discord.js retried the edit 3 times and gave up; the user is left on "thinking…"
    await expect(run.reply(1_000)).rejects.toThrow(/still "deferred"/);
    expect(errors[0]).toMatchObject({ status: 503 });
    expect(store.get("Test Ladder")?.get(alice.id)).toBe("Bravo");
  });
});
