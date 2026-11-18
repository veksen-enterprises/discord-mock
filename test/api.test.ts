import { expect, it, vi } from "vitest";
import { createDiscord, type Guild, type Member } from "../src/index.js";
import { commands, createBot } from "./fixtures/bot.js";

async function startBot() {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const generalChannel = discord.channel(server, "general");
  const alice = discord.member(server, "alice");
  const bob = discord.member(server, "bob", "Bobby");
  await discord.start(createBot(discord.clientOptions).client, { commands });
  return { discord, generalChannel, alice, bob };
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

it("names the channel and its last messages when find gives up", async () => {
  const { discord, generalChannel, alice } = await startBot();
  alice.post(generalChannel, { content: "hello" });

  await expect(discord.find(generalChannel, /goodbye/)).rejects.toThrow(
    'no message in #general written since the last action matched /goodbye/ within 2s. Last 1: "hello"',
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
