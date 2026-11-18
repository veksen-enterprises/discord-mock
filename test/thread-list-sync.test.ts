import { once } from "node:events";
import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
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

it("syncs a channel's threads when the bot gains access, so it can join them as Zeppelin does", async () => {
  const guild = mock.createGuild("g");
  const help = mock.createForum(guild, "help");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  const bot = { id: mock.state.bot.id, type: 1 as const };
  mock.setOverwrite(help, bot, { deny: Permission.ViewChannel });
  const { thread } = mock
    .as(alice)
    .forumPost(help, { title: "Crash", content: "?" });
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  const synced = once(client, Events.ThreadListSync);

  mock.setOverwrite(help, bot, {});
  const [threads] = (await synced) as [Collection<string, ThreadChannel>];
  const post = threads.get(thread.id)!;
  expect(post.joined).toBe(false);
  await post.join();

  expect(mock.state.threadMember(thread.id, bot.id)).toBeTruthy();
  mock.assertNoUnhandledRequests();
});
