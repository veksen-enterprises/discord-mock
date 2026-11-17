import { once } from "node:events";
import { Events, type Client } from "discord.js";
import { afterEach, expect, it } from "vitest";
import {
  createBot,
  registerCommands,
  type Store,
} from "../../examples/ladder/bot.js";
import { respond } from "../../src/index.js";
import { createDiscord, type Discord } from "./index.js";

let discord: Discord;
let client: Client;
let store: Store;

async function start() {
  discord = await createDiscord();
  const sin = discord
    .guild("sin")
    .channel("#challenges", { category: "Test Ladder" })
    .channel("#general")
    .member("alice", { nick: "Bravo" });

  store = new Map([["Test Ladder", new Map()]]);
  const { token, applicationId, clientOptions } = discord.bot;
  await registerCommands({
    token,
    applicationId,
    guildId: sin.id,
    api: clientOptions.rest.api,
  });
  client = createBot(store, clientOptions).client;
  const ready = once(client, Events.ClientReady);
  await client.login(token);
  await ready;
}

const aliceId = () => [...store.get("Test Ladder")!.keys()][0];

afterEach(async () => {
  await client.destroy();
  await discord.close();
});

it("adds the member under their server nickname and confirms privately", async () => {
  await start();
  const reply = await discord.as("alice").in("#challenges").run("/join");
  expect(reply).toBeEphemeral();
  expect(reply).toShowEmbed("Joined the Ladder!");
  expect(store.get("Test Ladder")?.get(aliceId()!)).toBe("Bravo");
});

it("refuses a second join", async () => {
  await start();
  await discord.as("alice").in("#challenges").run("/join");
  const again = await discord.as("alice").in("#challenges").run("/join");
  expect(again).toShowEmbed("Already Joined");
});

it("says so when the channel isn't in a ladder category", async () => {
  await start();
  const reply = await discord.as("alice").in("#general").run("/join");
  expect(reply).toShowEmbed("No Ladder");
});

it("keeps the member joined when Discord fails the confirmation", async () => {
  await start();
  discord.fail(
    "PATCH",
    "/webhooks/:app/:token/messages/@original",
    respond.serverError(503),
  );
  await expect(
    discord.as("alice").in("#challenges").run("/join"),
  ).rejects.toThrow(/still "deferred"/);
  expect(store.get("Test Ladder")?.size).toBe(1);
});
