import { MessageFlags } from "discord.js";
import { expect, it } from "vitest";
import { commands, createBot, type Store } from "../../examples/ladder/bot.js";
import { respond } from "../../src/internal/mock.js";
import { createDiscord } from "./index.js";

async function ladderServer() {
  const discord = await createDiscord();
  const sin = discord.guild("sin");
  const challenges = discord.channel(
    sin,
    "challenges",
    discord.category(sin, "Test Ladder"),
  );
  const general = discord.channel(sin, "general");
  const alice = discord.member(sin, "alice", "Bravo");
  const store: Store = new Map([["Test Ladder", new Map()]]);
  await discord.start(createBot(store, discord.clientOptions).client, {
    commands,
  });
  return { discord, challenges, general, alice, store };
}

it("adds the member under their server nickname and confirms privately", async () => {
  const { discord, challenges, alice, store } = await ladderServer();
  const reply = await discord.run(alice, challenges, "join");
  expect(reply.flags! & MessageFlags.Ephemeral).toBeTruthy();
  expect(reply.embeds[0]?.title).toBe("Joined the Ladder!");
  expect(store.get("Test Ladder")?.get(alice.id)).toBe("Bravo");
});

it("refuses a second join", async () => {
  const { discord, challenges, alice } = await ladderServer();
  await discord.run(alice, challenges, "join");
  const again = await discord.run(alice, challenges, "join");
  expect(again.embeds[0]?.title).toBe("Already Joined");
});

it("says so when the channel isn't in a ladder category", async () => {
  const { discord, general, alice } = await ladderServer();
  const reply = await discord.run(alice, general, "join");
  expect(reply.embeds[0]?.title).toBe("No Ladder");
});

it("keeps the member joined when Discord fails the confirmation", async () => {
  const { discord, challenges, alice, store } = await ladderServer();
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

it("sees a guild and channels created after the bot started", async () => {
  const { discord } = await ladderServer();
  // Built after start: the bot learns about them from GUILD_CREATE and CHANNEL_CREATE.
  const guild = discord.guild("late");
  const late = discord.channel(
    guild,
    "late",
    discord.category(guild, "Test Ladder"),
  );
  const bob = discord.member(guild, "bob");
  const reply = await discord.run(bob, late, "join");
  expect(reply.embeds[0]?.title).toBe("Joined the Ladder!");
});
