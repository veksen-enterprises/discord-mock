import { once } from "node:events";
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  const guild = mock.createGuild("g");
  const general = mock.createTextChannel(guild, "general");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    ...mock.clientOptions,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "vanish") {
      await interaction.deferReply();
      await interaction.deleteReply();
    }
    if (interaction.commandName === "notes") {
      await interaction.reply("notes");
      const note = await interaction.followUp("draft");
      await interaction.webhook.editMessage(note, { content: "final" });
      const scratch = await interaction.followUp("scratch");
      await interaction.deleteReply(scratch);
    }
    if (interaction.commandName === "secret") {
      await interaction.reply("public");
      const hidden = await interaction.followUp({
        content: "hidden",
        flags: MessageFlags.Ephemeral,
      });
      await interaction.webhook
        .editMessage(hidden, { content: "edited" })
        .catch(() => undefined);
    }
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  await client.application!.commands.set(
    ["vanish", "notes", "secret"].map((name) =>
      new SlashCommandBuilder().setName(name).setDescription(name).toJSON(),
    ),
  );
  return { general, alice };
}

it("deletes a deferred reply: the message is gone, the bot hears it, and the run says so", async () => {
  const { general, alice } = await start();
  const deleted = vi.fn();
  client.on(Events.MessageDelete, deleted);

  const run = mock.as(alice).slashCommand(general, "vanish", {});

  await expect(run.reply()).rejects.toThrow("the bot deleted its reply");
  expect(mock.messagesIn(general)).toEqual([]);
  await vi.waitFor(() => expect(deleted).toHaveBeenCalledOnce());
  mock.assertNoUnhandledRequests();
});

it("edits and deletes followups by id", async () => {
  const { general, alice } = await start();

  const run = mock.as(alice).slashCommand(general, "notes", {});

  await run.waitUntil((r) => r.followups.length === 1 && !!r.original);
  await mock.waitForIdle();
  expect(mock.messagesIn(general).map((m) => m.content)).toEqual([
    "notes",
    "final",
  ]);
  mock.assertNoUnhandledRequests();
});

it("records a Gap for editing an ephemeral followup, which Discord's docs don't support", async () => {
  const { general, alice } = await start();

  mock.as(alice).slashCommand(general, "secret", {});

  await vi.waitFor(() =>
    expect(() => mock.assertNoUnhandledRequests()).toThrow(
      /PATCH an ephemeral followup/,
    ),
  );
});
