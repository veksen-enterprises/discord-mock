/**
 * AFTER: the same bot, unchanged, logged in to discordjs-test-kit as it would log in to Discord. A
 * member runs /join; the test reads what Discord would show them. No vi.mock, no spies, no casts.
 */
import { MessageFlags } from "discord.js";
import { describe, expect, it } from "vitest";
import { createDiscord, respond } from "../../src/index.js";
import { commands, createBot, type Store } from "./bot.js";

/** A server with a "Test Ladder" category holding #challenges, plus a #general outside it. */
async function ladderServer() {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const ladderCategory = discord.category(server, "Test Ladder");
  const challengesChannel = discord.channel(
    server,
    "challenges",
    ladderCategory,
  );
  const generalChannel = discord.channel(server, "general");
  const alice = discord.member(server, "alice", { nickname: "Bravo" });
  const store: Store = new Map([["Test Ladder", new Map()]]);
  const bot = createBot(store, discord.clientOptions);
  await discord.start(bot.client, { commands });
  return {
    discord,
    challengesChannel,
    generalChannel,
    alice,
    store,
    errors: bot.errors,
  };
}

describe("/join", () => {
  it("adds the member under their server nickname and confirms privately", async () => {
    // Arrange
    const { challengesChannel, alice, store } = await ladderServer();

    // Act
    const reply = await alice.run(challengesChannel, "join");

    // Assert
    expect(reply.flags! & MessageFlags.Ephemeral).toBe(MessageFlags.Ephemeral);
    expect(reply.embeds[0]).toMatchObject({
      title: "Joined the Ladder!",
      description: "You have successfully joined the ladder. Good luck!",
    });
    expect(store.get("Test Ladder")?.get(alice.id)).toBe("Bravo");
  });

  it("refuses a second join", async () => {
    // Arrange
    const { challengesChannel, alice } = await ladderServer();
    await alice.run(challengesChannel, "join");

    // Act
    const again = await alice.run(challengesChannel, "join");

    // Assert
    expect(again.embeds[0]?.title).toBe("Already Joined");
  });

  it("says so when the channel isn't in a ladder category", async () => {
    // Arrange
    const { generalChannel, alice, store } = await ladderServer();

    // Act
    const reply = await alice.run(generalChannel, "join");

    // Assert
    expect(reply.embeds[0]?.title).toBe("No Ladder");
    expect(store.get("Test Ladder")?.size).toBe(0);
  });

  it("keeps the member joined when Discord fails the confirmation", async () => {
    // Arrange
    const { discord, challengesChannel, alice, store, errors } =
      await ladderServer();
    discord.fail(
      "PATCH",
      "/webhooks/:appId/:token/messages/@original",
      respond.serverError(503),
    );

    // Act
    const joining = alice.run(challengesChannel, "join");

    // Assert: discord.js retried the edit 3 times and gave up, so the member is left on "thinking…"
    await expect(joining).rejects.toThrow(/still "deferred"/);
    expect(errors[0]).toMatchObject({ status: 503 });
    expect(store.get("Test Ladder")?.get(alice.id)).toBe("Bravo");
  });

  it("sees a server and channels created after the bot started", async () => {
    // Arrange
    const { discord } = await ladderServer();
    // Built after start: the bot learns about them from GUILD_CREATE and CHANNEL_CREATE.
    const lateServer = discord.guild("late");
    const lateChannel = discord.channel(
      lateServer,
      "challenges",
      discord.category(lateServer, "Test Ladder"),
    );
    const bob = discord.member(lateServer, "bob");

    // Act
    const reply = await bob.run(lateChannel, "join");

    // Assert
    expect(reply.embeds[0]?.title).toBe("Joined the Ladder!");
  });
});
