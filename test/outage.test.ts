import { once } from "node:events";
import { Client, Events, GatewayIntentBits, type Guild } from "discord.js";
import { expect, it } from "vitest";
import { createDiscord } from "../src/index.js";

it("takes a guild away in an outage, keeps its events from the bot, and brings it back", async () => {
  const discord = await createDiscord();
  const server = discord.guild("g");
  const general = discord.channel(server, "general");
  const alice = discord.member(server, "alice");
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    ...discord.clientOptions,
  });
  await discord.start(client);
  const heard: string[] = [];
  client.on(Events.MessageCreate, (m) => heard.push(m.content));
  const gone = once(client, Events.GuildUnavailable);

  discord.outage(server);
  const [guild] = (await gone) as [Guild];
  alice.post(general, { content: "anyone?" });
  const back = once(client, Events.GuildAvailable);
  discord.endOutage(server);
  await back;
  const heardBack = once(client, Events.MessageCreate);
  alice.post(general, { content: "back" });
  await heardBack;

  expect(guild.available).toBe(true);
  expect(heard).toEqual(["back"]);
});

it("sends a guild in an outage as unavailable when the bot connects", async () => {
  const discord = await createDiscord();
  const server = discord.guild("g");
  discord.outage(server);
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...discord.clientOptions,
  });

  await discord.start(client);

  expect(client.guilds.cache.get(server.id)?.available).toBe(false);
});
