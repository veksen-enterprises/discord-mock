import { once } from "node:events";
import { ActivityType, Client, Events, GatewayIntentBits } from "discord.js";
import { expect, it } from "vitest";
import { createDiscord } from "../src/index.js";

async function world(intents: GatewayIntentBits[]) {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const alice = discord.member(server, "alice");
  const client = new Client({ intents, ...discord.clientOptions });
  return { discord, server, alice, client };
}

it("tells a bot with the presences intent when a member comes online and starts playing", async () => {
  // Arrange
  const { discord, alice, client } = await world([
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildPresences,
  ]);
  await discord.start(client, { commands: [] });
  const updated = once(client, Events.PresenceUpdate);

  // Act
  alice.setPresence({
    status: "online",
    activity: { name: "Diablo II", type: ActivityType.Playing },
  });

  // Assert
  const [, presence] = await updated;
  expect([presence.status, presence.activities[0]?.name]).toEqual([
    "online",
    "Diablo II",
  ]);
});

it("sends a bot without the presences intent nothing", async () => {
  // Arrange
  const { discord, alice, client } = await world([GatewayIntentBits.Guilds]);
  await discord.start(client, { commands: [] });
  const heard: string[] = [];
  client.on(Events.PresenceUpdate, (_, p) => heard.push(p.status));

  // Act
  alice.setPresence({ status: "idle" });

  // Assert
  await discord.waitForIdle();
  expect(heard).toEqual([]);
});

it("shows a member who was online before the bot connected", async () => {
  // Arrange
  const { discord, server, alice, client } = await world([
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildPresences,
  ]);
  alice.setPresence({ status: "dnd" });

  // Act
  await discord.start(client, { commands: [] });

  // Assert
  const guild = client.guilds.cache.get(server.id)!;
  expect(guild.presences.cache.get(alice.id)?.status).toBe("dnd");
});
