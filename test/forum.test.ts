import { once } from "node:events";
import {
  ChannelFlags,
  Client,
  Events,
  GatewayIntentBits,
  type ForumChannel,
  type ThreadChannel,
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

async function start(tags: string[]) {
  const guild = mock.createGuild("g");
  const forum = mock.createForum(guild, "help", tags);
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  return {
    guild,
    forum,
    alice,
    cached: client.channels.cache.get(forum.id) as ForumChannel,
  };
}

it("opens a tagged post for the bot, with its first message", async () => {
  const { forum, cached } = await start(["Bug", "Solved"]);
  const bug = cached.availableTags.find((t) => t.name === "Bug")!;
  const created = once(client, Events.ThreadCreate);

  const thread = await cached.threads.create({
    name: "Crash on start",
    message: { content: "Steps to reproduce" },
    appliedTags: [bug.id],
  });

  expect(thread.appliedTags).toEqual([bug.id]);
  expect((await created)[1]).toBe(true); // newlyCreated
  const [starter] = mock.state.messages.get(thread.id)!;
  expect([starter!.id, starter!.content]).toEqual([
    thread.id,
    "Steps to reproduce",
  ]);
  expect(thread.parentId).toBe(forum.id);
  mock.assertNoUnhandledRequests();
});

it("marks a member's post solved, as AnswerOverflow does, which needs Manage Threads", async () => {
  const { forum, alice, cached } = await start(["Bug", "Solved"]);
  const [bug, solved] = cached.availableTags;
  const created = once(client, Events.ThreadCreate);
  const { thread } = mock
    .as(alice)
    .forumPost(forum, { title: "Help", content: "?", tags: ["Bug"] });
  const [post] = (await created) as [ThreadChannel];
  expect(post.id).toBe(thread.id);

  await expect(post.setAppliedTags([solved!.id])).rejects.toMatchObject({
    code: 50013,
  });
  mock.grantBot(Permission.ManageThreads);
  await post.setAppliedTags([bug!.id, solved!.id]);

  expect(post.appliedTags).toEqual([bug!.id, solved!.id]);
  await expect(post.setAppliedTags(["1"])).rejects.toMatchObject({
    code: 50035,
  });
});

it("refuses a post without a tag where the forum requires one, and an empty one", async () => {
  const { forum, cached } = await start(["Bug"]);
  (forum as { flags?: number }).flags = ChannelFlags.RequireTag;

  await expect(
    cached.threads.create({ name: "x", message: { content: "y" } }),
  ).rejects.toMatchObject({ code: 40067 });
  await expect(
    cached.threads.create({ name: "x", message: {} }),
  ).rejects.toMatchObject({ code: 50006 });
});

it("names the forum's tags when a member picks one it doesn't have", async () => {
  const { forum, alice } = await start(["Bug"]);

  expect(() =>
    mock.as(alice).forumPost(forum, { title: "x", tags: ["Solved"] }),
  ).toThrow('help has no tag "Solved"; it has Bug');
});
