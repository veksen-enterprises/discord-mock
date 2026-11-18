import { once } from "node:events";
import { Events, MessageFlags, type Client } from "discord.js";
import { afterEach, expect, it } from "vitest";
import {
  createBot,
  registerCommands,
  type Store,
} from "../../examples/ladder/bot.js";
import { respond } from "../../src/internal/mock.js";
import { createDiscord } from "./index.js";

const world = {
  guilds: {
    sin: {
      channels: { challenges: { category: "Test Ladder" }, general: {} },
    },
  },
  users: { alice: { guilds: { sin: { nick: "Bravo" } } } },
} as const;

let discord: Awaited<
  ReturnType<typeof createDiscord<typeof world.guilds, typeof world.users>>
>;
let client: Client;
let store: Store;

async function start() {
  discord = await createDiscord(world);
  store = new Map([["Test Ladder", new Map()]]);
  const { token, applicationId, clientOptions } = discord.bot;
  await registerCommands({
    token,
    applicationId,
    guildId: discord.guilds.sin.id,
    api: clientOptions.rest.api,
  });
  client = createBot(store, clientOptions).client;
  const ready = once(client, Events.ClientReady);
  await client.login(token);
  await ready;
  return { ...discord.guilds.sin.channels, ...discord.users };
}

afterEach(async () => {
  await client.destroy();
  await discord.close();
});

it("adds the member under their server nickname and confirms privately", async () => {
  const { challenges, alice } = await start();
  const reply = await discord.run(alice, challenges, "join");
  expect(reply.flags! & MessageFlags.Ephemeral).toBeTruthy();
  expect(reply.embeds[0]?.title).toBe("Joined the Ladder!");
  expect(store.get("Test Ladder")?.get(alice.id)).toBe("Bravo");
});

it("refuses a second join", async () => {
  const { challenges, alice } = await start();
  await discord.run(alice, challenges, "join");
  const again = await discord.run(alice, challenges, "join");
  expect(again.embeds[0]?.title).toBe("Already Joined");
});

it("says so when the channel isn't in a ladder category", async () => {
  const { general, alice } = await start();
  const reply = await discord.run(alice, general, "join");
  expect(reply.embeds[0]?.title).toBe("No Ladder");
});

it("keeps the member joined when Discord fails the confirmation", async () => {
  const { challenges, alice } = await start();
  discord.fail(
    "PATCH",
    "/webhooks/:app/:token/messages/@original",
    respond.serverError(503),
  );
  await expect(discord.run(alice, challenges, "join")).rejects.toThrow(
    /still "deferred"/,
  );
  expect(store.get("Test Ladder")?.get(alice.id)).toBe("Bravo");
});
