import { once } from "node:events";
import {
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  type TextChannel,
} from "discord.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDiscordMock, type DiscordMock } from "../src/internal/mock.js";
import { Permission } from "../src/internal/payloads.js";

let mock: DiscordMock;
let client: Client;

beforeEach(async () => {
  mock = await createDiscordMock({ interactionDeadlineMs: 200 });
});

afterEach(async () => {
  await client?.destroy();
  await mock.close();
});

async function start() {
  const guild = mock.createGuild("g");
  const general = mock.createTextChannel(guild, "general");
  mock.grantBot(Permission.SendMessages | Permission.ViewChannel);
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  return client.channels.cache.get(general.id) as TextChannel;
}

async function rejection(promise: Promise<unknown>): Promise<DiscordAPIError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DiscordAPIError);
  return error as DiscordAPIError;
}

it("refuses content over 2000 characters, and accepts exactly 2000", async () => {
  const channel = await start();

  const error = await rejection(channel.send("x".repeat(2001)));

  expect(error.code).toBe(50035);
  expect(error.message).toContain("content[BASE_TYPE_MAX_LENGTH]");
  expect((await channel.send("x".repeat(2000))).content).toHaveLength(2000);
  expect(mock.messagesIn(channel.id)).toHaveLength(1);
});

it("refuses an embed with 26 fields, which discord.js lets through as a raw object", async () => {
  const channel = await start();
  const fields = Array.from({ length: 26 }, (_, i) => ({
    name: `#${i + 1}`,
    value: "x",
  }));

  const error = await rejection(channel.send({ embeds: [{ fields }] }));

  expect(error.message).toContain("embeds[0].fields[BASE_TYPE_MAX_LENGTH]");
});

it("refuses embeds over 6000 characters in total, though each field fits", async () => {
  const channel = await start();
  const embeds = [1, 2].map(() => ({ description: "x".repeat(3001) }));

  const error = await rejection(channel.send({ embeds }));

  expect(error.code).toBe(50035);
});

it("refuses an edit over the limit and keeps the message as it was", async () => {
  const channel = await start();
  const message = await channel.send("short");

  const error = await rejection(message.edit("x".repeat(2001)));

  expect(error.code).toBe(50035);
  expect(mock.messagesIn(channel.id)[0]!.content).toBe("short");
});

it("refuses an interaction reply over the limit, so the interaction stays unanswered", async () => {
  const channel = await start();
  const alice = mock.createUser("alice");
  mock.addMember(mock.state.requireGuild(channel.guildId), alice);
  const errors: unknown[] = [];
  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isChatInputCommand())
      interaction.reply("x".repeat(2001)).catch((e) => errors.push(e));
  });
  await client.application!.commands.set(
    [{ name: "long", description: "Replies too long" }],
    channel.guildId,
  );

  const run = mock
    .as(alice)
    .slashCommand(mock.state.requireChannel(channel.id), "long");

  await expect(run.reply()).rejects.toThrow("didn't answer within 0.2s");
  expect(errors[0]).toMatchObject({ code: 50035 });
});

it("refuses option values the Discord app wouldn't send: below min_value, over max_length", async () => {
  const channel = await start();
  const alice = mock.createUser("alice");
  mock.addMember(mock.state.requireGuild(channel.guildId), alice);
  await client.application!.commands.set(
    [
      {
        name: "limit",
        description: "Set a limit",
        options: [
          {
            type: 4,
            name: "max",
            description: "1 to 25",
            min_value: 1,
            max_value: 25,
            required: true,
          },
          { type: 3, name: "note", description: "short", max_length: 5 },
        ],
      },
    ],
    channel.guildId,
  );
  const general = mock.state.requireChannel(channel.id);

  expect(() =>
    mock.as(alice).slashCommand(general, "limit", { max: 0 }),
  ).toThrow('/limit option "max" must be at least 1');
  expect(() =>
    mock.as(alice).slashCommand(general, "limit", { max: 26 }),
  ).toThrow('/limit option "max" must be at most 25');
  expect(() =>
    mock.as(alice).slashCommand(general, "limit", { max: 3, note: "too long" }),
  ).toThrow('/limit option "note" must be at most 5 characters');
});
