import { once } from "node:events";
import { Client, Events, GatewayIntentBits } from "discord.js";
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

async function login(intents = [GatewayIntentBits.Guilds]) {
  client = new Client({ intents, ...mock.clientOptions });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
}

it("lists the guild's channels the bot can view, with a hidden category whose child it can view", async () => {
  const guild = mock.createGuild("g");
  const general = mock.createTextChannel(guild, "general");
  const staff = mock.createCategory(guild, "staff");
  const mods = mock.createTextChannel(guild, "mods", { parent: staff });
  const secret = mock.createTextChannel(guild, "secret", { parent: staff });
  const hidden = mock.createCategory(guild, "hidden");
  const everyone = { id: guild.id, type: 0 } as const;
  for (const channel of [staff, secret, hidden])
    mock.setOverwrite(channel, everyone, { deny: Permission.ViewChannel });
  mock.setOverwrite(mods, everyone, { allow: Permission.ViewChannel });
  await login();

  const channels = await client.guilds.cache.get(guild.id)!.channels.fetch();

  expect([...channels.keys()].sort()).toEqual(
    [general.id, staff.id, mods.id].sort(),
  );
  mock.assertNoUnhandledRequests();
});
