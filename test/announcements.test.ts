import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  type NewsChannel,
  type TextChannel,
} from "discord.js";
import { expect, it } from "vitest";
import { createDiscord, Permission } from "../src/index.js";

async function world(permissions: bigint) {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const news = discord.announcementChannel(server, "patch-notes");
  const general = discord.textChannel(server, "general");
  const mod = discord.member(server, "mod", {
    permissions: Permission.SendMessages,
  });
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    ...discord.clientOptions,
  });
  await discord.start(client, { commands: [], permissions });
  const channel = (id: string) => client.channels.cache.get(id);
  return { discord, news, general, mod, client, channel };
}

const POSTING =
  Permission.ViewChannel | Permission.SendMessages | Permission.ManageWebhooks;

it("follows an announcement channel into another channel", async () => {
  // Arrange
  const { news, general, channel } = await world(POSTING);
  const announcements = channel(news.id) as NewsChannel;

  // Act
  await announcements.addFollower(general.id);

  // Assert
  const hooks = await (channel(general.id) as TextChannel).fetchWebhooks();
  expect(hooks.first()?.sourceChannel?.id).toBe(news.id);
});

it("crossposts the bot's announcement to the channels following it", async () => {
  // Arrange
  const { discord, news, general, channel } = await world(POSTING);
  const announcements = channel(news.id) as NewsChannel;
  await announcements.addFollower(general.id);
  const posted = await announcements.send("Patch 2.6 is live");

  // Act
  const crossposted = await posted.crosspost();

  // Assert
  expect(crossposted.flags.has(MessageFlags.Crossposted)).toBe(true);
  const copy = await discord.waitForMessage(general, "Patch 2.6 is live");
  expect(copy.flags! & MessageFlags.IsCrosspost).toBe(MessageFlags.IsCrosspost);
});

it("refuses to crosspost someone else's announcement without Manage Messages", async () => {
  // Arrange
  const { news, mod, channel } = await world(POSTING);
  const theirs = mod.post(news, { content: "hi" });
  const message = await (channel(news.id) as NewsChannel).messages.fetch(
    theirs.id,
  );

  // Act
  const crossposted = message.crosspost();

  // Assert
  await expect(crossposted).rejects.toMatchObject({ code: 50013 });
});

it("refuses to crosspost a message twice", async () => {
  // Arrange
  const { news, channel } = await world(POSTING);
  const posted = await (channel(news.id) as NewsChannel).send("once");
  await posted.crosspost();

  // Act
  const again = posted.crosspost();

  // Assert
  await expect(again).rejects.toMatchObject({ code: 40033 });
});
