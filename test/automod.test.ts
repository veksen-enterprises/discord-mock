import { once } from "node:events";
import {
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  Client,
  Events,
  GatewayIntentBits,
  MessageType,
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

async function login(intents: GatewayIntentBits[]) {
  client = new Client({ intents, ...mock.clientOptions });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
}

function world() {
  const guild = mock.createGuild("g");
  const general = mock.createTextChannel(guild, "general");
  const modLog = mock.createTextChannel(guild, "mod-log");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  return { guild, general, modLog, alice };
}

it("blocks a member's link with the bot's rule, times them out, alerts the log channel and tells the bot", async () => {
  const { guild, general, modLog, alice } = world();
  mock.grantBot(Permission.ManageGuild | Permission.ModerateMembers);
  await login([
    GatewayIntentBits.Guilds,
    GatewayIntentBits.AutoModerationExecution,
  ]);
  const executed: AutoModerationActionType[] = [];
  client.on(Events.AutoModerationActionExecution, (e) =>
    executed.push(e.action.type),
  );

  // The rule Bastion's /filter links creates.
  const rule = await client.guilds.cache
    .get(guild.id)!
    .autoModerationRules.create({
      enabled: true,
      name: "Block Links",
      eventType: AutoModerationRuleEventType.MessageSend,
      triggerType: AutoModerationRuleTriggerType.Keyword,
      triggerMetadata: {
        regexPatterns: ["https?://(?:[-;:&=+$,\\w]+@)?[A-Za-z0-9.-]+"],
      },
      actions: [
        {
          type: AutoModerationActionType.BlockMessage,
          metadata: { customMessage: "No links here." },
        },
        {
          type: AutoModerationActionType.Timeout,
          metadata: { durationSeconds: 60 },
        },
        {
          type: AutoModerationActionType.SendAlertMessage,
          metadata: { channel: modLog.id },
        },
      ],
    });
  const heard = new Promise<void>((resolve) =>
    client.on(Events.AutoModerationActionExecution, () => {
      if (executed.length === 3) resolve();
    }),
  );

  expect(() =>
    mock.as(alice).sendMessage(general, "see https://example.com"),
  ).toThrow('AutoMod blocked alice\'s message: "No links here."');
  mock.as(alice).sendMessage(general, "no link in this one");
  await heard;

  expect(mock.state.messages.get(general.id)!.map((m) => m.content)).toEqual([
    "no link in this one",
  ]);
  const [alert] = mock.state.messages.get(modLog.id)!;
  expect(alert!.type).toBe(MessageType.AutoModerationAction);
  expect(alert!.embeds[0]!.description).toBe("see https://example.com");
  expect(
    guild.members.get(alice.id)!.communication_disabled_until,
  ).toBeTruthy();
  expect(executed).toEqual([
    AutoModerationActionType.BlockMessage,
    AutoModerationActionType.Timeout,
    AutoModerationActionType.SendAlertMessage,
  ]);

  await rule.setEnabled(false);
  expect(() =>
    mock.as(alice).sendMessage(general, "https://example.com"),
  ).not.toThrow();
});

it("matches keywords by Discord's strategies, honours the allow list and exempt roles", async () => {
  const { guild, general, alice } = world();
  const bob = mock.createUser("bob");
  mock.addMember(guild, bob);
  const trusted = mock.createRole(guild, "trusted", 0n, [bob]);
  mock.grantBot(Permission.ManageGuild);
  await login([GatewayIntentBits.Guilds]);
  await client.guilds.cache.get(guild.id)!.autoModerationRules.create({
    enabled: true,
    name: "words",
    eventType: AutoModerationRuleEventType.MessageSend,
    triggerType: AutoModerationRuleTriggerType.Keyword,
    triggerMetadata: {
      keywordFilter: ["cat*", "*dog", "rat"],
      allowList: ["category"],
    },
    actions: [{ type: AutoModerationActionType.BlockMessage }],
    exemptRoles: [trusted.id],
  });
  const blocked = (content: string) => {
    try {
      mock.as(alice).sendMessage(general, content);
      return false;
    } catch {
      return true;
    }
  };

  expect(
    [
      "Catapult",
      "a hotdog",
      "rat",
      "pirate",
      "rations",
      "category",
      "dogma",
    ].map(blocked),
  ).toEqual([true, true, true, false, false, false, false]);
  expect(() => mock.as(bob).sendMessage(general, "rat")).not.toThrow();
});

it("refuses the bot AutoMod without Manage Server, and a timeout action without Moderate Members", async () => {
  const { guild } = world();
  await login([GatewayIntentBits.Guilds]);
  const rules = client.guilds.cache.get(guild.id)!.autoModerationRules;
  const create = () =>
    rules.create({
      name: "x",
      eventType: AutoModerationRuleEventType.MessageSend,
      triggerType: AutoModerationRuleTriggerType.Keyword,
      triggerMetadata: { keywordFilter: ["x"] },
      actions: [
        {
          type: AutoModerationActionType.Timeout,
          metadata: { durationSeconds: 60 },
        },
      ],
    });

  await expect(rules.fetch()).rejects.toMatchObject({ code: 50013 });
  mock.grantBot(Permission.ManageGuild);
  await expect(create()).rejects.toMatchObject({ code: 50013 });
  mock.grantBot(Permission.ModerateMembers);
  await expect(create()).resolves.toMatchObject({ enabled: false });
  expect((await rules.fetch()).size).toBe(1);
  mock.assertNoUnhandledRequests();
});

const keywordRule = {
  name: "No rats",
  eventType: AutoModerationRuleEventType.MessageSend,
  triggerType: AutoModerationRuleTriggerType.Keyword,
  triggerMetadata: { keywordFilter: ["rat"] },
  actions: [{ type: AutoModerationActionType.BlockMessage }],
  enabled: true,
};

async function loginForRules() {
  const { guild } = world();
  mock.grantBot(Permission.ManageGuild);
  await login([
    GatewayIntentBits.Guilds,
    GatewayIntentBits.AutoModerationConfiguration,
  ]);
  return client.guilds.cache.get(guild.id)!.autoModerationRules;
}

it("tells the bot when it creates a rule", async () => {
  // Arrange
  const rules = await loginForRules();
  const created = once(client, Events.AutoModerationRuleCreate);

  // Act
  const rule = await rules.create(keywordRule);

  // Assert
  expect((await created)[0].id).toBe(rule.id);
});

it("tells the bot when it edits a rule", async () => {
  // Arrange
  const rules = await loginForRules();
  const rule = await rules.create(keywordRule);
  const updated = once(client, Events.AutoModerationRuleUpdate);

  // Act
  await rule.setName("No rodents");

  // Assert
  expect((await updated)[1].name).toBe("No rodents");
});

it("fetches one rule by id", async () => {
  // Arrange
  const rules = await loginForRules();
  const { id } = await rules.create(keywordRule);

  // Act
  const rule = await rules.fetch({ autoModerationRule: id, force: true });

  // Assert
  expect(rule.name).toBe("No rats");
});

it("deletes a rule and tells the bot", async () => {
  // Arrange
  const rules = await loginForRules();
  const rule = await rules.create(keywordRule);
  const deleted = once(client, Events.AutoModerationRuleDelete);

  // Act
  await rule.delete();

  // Assert
  expect((await deleted)[0].id).toBe(rule.id);
});
