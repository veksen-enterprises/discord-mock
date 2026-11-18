import { once } from "node:events";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type ForumChannel,
} from "discord.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDiscordMock, type DiscordMock } from "../src/internal/mock.js";

let mock: DiscordMock;
let client: Client;

beforeEach(async () => {
  mock = await createDiscordMock();
});

afterEach(async () => {
  await client?.destroy();
  await mock.close();
});

async function start() {
  const guild = mock.createGuild("trade");
  const forum = mock.createForum(guild, "listings");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  return { forum, alice };
}

it("moves an archived forum post from the active list to the archived one", async () => {
  const { forum, alice } = await start();
  const { thread } = mock.as(alice).forumPost(forum, { title: "old post" });
  const updated = once(client, Events.ThreadUpdate);

  mock.archiveThread(thread);

  const [, after] = await updated;
  expect(after.archived).toBe(true);
  const channel = (await client.channels.fetch(forum.id)) as ForumChannel;
  expect(channel.type).toBe(ChannelType.GuildForum);
  expect([...(await channel.threads.fetchActive()).threads.keys()]).toEqual([]);
  const archived = await channel.threads.fetchArchived({ type: "public" });
  expect([...archived.threads.keys()]).toEqual([thread.id]);
  mock.assertNoUnhandledRequests();
});
