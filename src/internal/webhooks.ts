import { randomBytes } from "node:crypto";
import {
  ChannelType,
  GatewayDispatchEvents,
  GatewayIntentBits,
  MessageFlags,
  type APIChannel,
} from "discord-api-types/v10";
import { messageLimitError } from "./limits.js";
import { pickMessageFields, pollEditGap, type DiscordMock } from "./mock.js";
import { computePermissions, Permission } from "./payloads.js";
import { respond, type RestHandler, type RestRequest } from "./rest.js";
import { snowflake } from "./snowflake.js";
import type { WebhookRecord } from "./state.js";

// Channel webhooks the bot creates and executes. Sources: discord-api-docs resources/webhook
// (the webhook object, Create, Get Channel/Guild Webhooks, Get, Modify and Delete Webhook with and
// without token, Execute Webhook), events/gateway-events#webhooks-update, events/gateway
// (GUILD_WEBHOOKS). `/webhooks/:id/:token` is also where interaction followups go: these Routes
// pass a request for the application's own id on to them.

const invalidName = () =>
  // Which errors entry Discord gives is unchecked; the code is Invalid Form Body.
  respond.invalidFormBody();

/** "Does not contain the substrings clyde or discord (case-insensitive)", 1 to 80 characters. */
const nameError = (name: unknown) =>
  typeof name !== "string" ||
  name.length < 1 ||
  name.length > 80 ||
  /clyde|discord/i.test(name);

export function registerWebhookRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state, gateway } = mock;
  const bot = state.bot.id;

  // A channel follower webhook (type 2) carries source_guild and source_channel and no token
  // (resources/webhook#webhook-object).
  const payload = (webhook: WebhookRecord, withUser = true) => {
    const source = webhook.sourceChannelId
      ? state.requireChannel(webhook.sourceChannelId)
      : undefined;
    const sourceGuild =
      source && "guild_id" in source
        ? state.requireGuild(source.guild_id!)
        : undefined;
    return {
      id: webhook.id,
      type: source ? 2 : 1,
      guild_id: webhook.guildId,
      channel_id: webhook.channelId,
      ...(withUser ? { user: state.requireUser(webhook.creatorId) } : {}),
      name: webhook.name,
      avatar: null,
      ...(webhook.token ? { token: webhook.token } : {}),
      application_id: webhook.creatorId === bot ? state.applicationId : null,
      ...(source && sourceGuild
        ? {
            source_guild: {
              id: sourceGuild.id,
              name: sourceGuild.name,
              icon: null,
            },
            source_channel: { id: source.id, name: source.name },
          }
        : {}),
    };
  };
  const announce = (webhook: WebhookRecord) =>
    gateway.dispatch(
      GatewayDispatchEvents.WebhooksUpdate,
      { guild_id: webhook.guildId, channel_id: webhook.channelId },
      GatewayIntentBits.GuildWebhooks,
    );
  const canManage = (channel: APIChannel) =>
    mock.checkBotPerms(channel, Permission.ManageWebhooks);
  /** The webhook a `/webhooks/:webhookId[/:token]` Route names, or the refusal. */
  const named = (req: RestRequest) => {
    const webhook = state.webhooks.get(req.params.webhookId!);
    if (!webhook || (req.params.token && req.params.token !== webhook.token))
      return { refused: respond.unknownWebhook() };
    return { webhook };
  };
  const isApp = (req: RestRequest) =>
    req.params.webhookId === state.applicationId;

  rest.route(
    "POST",
    "/channels/:channelId/webhooks",
    authed((req) => {
      const channel = state.channels.get(req.params.channelId!);
      if (!channel) return respond.unknownChannel();
      if (!("guild_id" in channel) || !channel.guild_id)
        return rest.gap("a webhook in a DM channel");
      const denied = canManage(channel);
      if (denied) return denied;
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.avatar != null) return rest.gap("a webhook with an avatar");
      if (nameError(body.name)) return invalidName();
      const webhook: WebhookRecord = {
        id: snowflake(),
        guildId: channel.guild_id,
        channelId: channel.id,
        creatorId: bot,
        name: body.name as string,
        token: randomBytes(34).toString("base64url"),
      };
      state.webhooks.set(webhook.id, webhook);
      announce(webhook);
      return respond.json(payload(webhook));
    }),
  );

  rest.route(
    "GET",
    "/channels/:channelId/webhooks",
    authed((req) => {
      const channel = state.channels.get(req.params.channelId!);
      if (!channel) return respond.unknownChannel();
      const denied = canManage(channel);
      if (denied) return denied;
      return respond.json(
        [...state.webhooks.values()]
          .filter((w) => w.channelId === channel.id)
          .map((w) => payload(w)),
      );
    }),
  );

  rest.route(
    "GET",
    "/guilds/:guildId/webhooks",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return respond.error(404, 10004, "Unknown Guild");
      if (!(computePermissions(state, guild, bot) & Permission.ManageWebhooks))
        return respond.missingPermissions();
      return respond.json(
        [...state.webhooks.values()]
          .filter((w) => w.guildId === guild.id)
          .map((w) => payload(w)),
      );
    }),
  );

  // Get Webhook: MANAGE_WEBHOOKS "unless the application making the request owns the webhook".
  rest.route(
    "GET",
    "/webhooks/:webhookId",
    authed((req) => {
      const { refused, webhook } = named(req);
      if (refused) return refused;
      if (webhook.creatorId !== bot) {
        const denied = canManage(state.requireChannel(webhook.channelId));
        if (denied) return denied;
      }
      return respond.json(payload(webhook));
    }),
  );

  // With the token: "does not require authentication and returns no user".
  rest.route("GET", "/webhooks/:webhookId/:token", (req) => {
    if (isApp(req)) return undefined;
    const { refused, webhook } = named(req);
    return refused ?? respond.json(payload(webhook, false));
  });

  // Modify Webhook: `name`, and `channel_id` without a token ("this call ... does not accept a
  // channel_id parameter" with one; docs.discord.food/resources/webhook#modify-webhook-with-token).
  // `avatar` is a Gap. Moving needs MANAGE_WEBHOOKS in the new channel too, and a channel in the
  // same guild; both are inferred, not checked. WEBHOOKS_UPDATE goes out for each channel.
  const modify = (req: RestRequest) => {
    const { refused, webhook } = named(req);
    if (refused) return refused;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields = req.params.token ? ["name"] : ["name", "channel_id"];
    const other = Object.keys(body).find((key) => !fields.includes(key));
    if (other) return rest.gap(`PATCH webhook ${other}`);
    if ("name" in body && nameError(body.name)) return invalidName();
    let target: APIChannel | undefined;
    if ("channel_id" in body) {
      target = state.channels.get(body.channel_id as string);
      if (
        !target ||
        !("guild_id" in target) ||
        target.guild_id !== webhook.guildId
      )
        return respond.unknownChannel();
      const denied = canManage(target);
      if (denied) return denied;
    }
    if ("name" in body) webhook.name = body.name as string;
    if (target && target.id !== webhook.channelId) {
      announce(webhook);
      webhook.channelId = target.id;
    }
    announce(webhook);
    return respond.json(payload(webhook, !req.params.token));
  };
  rest.route(
    "PATCH",
    "/webhooks/:webhookId",
    authed((req) => {
      const webhook = state.webhooks.get(req.params.webhookId!);
      const denied =
        webhook && canManage(state.requireChannel(webhook.channelId));
      return denied || modify(req);
    }),
  );
  rest.route("PATCH", "/webhooks/:webhookId/:token", (req) =>
    isApp(req) ? undefined : modify(req),
  );

  const remove = (req: RestRequest) => {
    const { refused, webhook } = named(req);
    if (refused) return refused;
    state.webhooks.delete(webhook.id);
    announce(webhook);
    return respond.noContent();
  };
  rest.route(
    "DELETE",
    "/webhooks/:webhookId",
    authed((req) => {
      const webhook = state.webhooks.get(req.params.webhookId!);
      const denied =
        webhook && canManage(state.requireChannel(webhook.channelId));
      return denied || remove(req);
    }),
  );
  rest.route("DELETE", "/webhooks/:webhookId/:token", (req) =>
    isApp(req) ? undefined : remove(req),
  );

  // Execute Webhook: the message's author is the webhook (its name, or `username` for this
  // message), with webhook_id. `wait=true` answers the message, otherwise 204. Threads, files and
  // forum channels are a Gap.
  rest.route("POST", "/webhooks/:webhookId/:token", (req) => {
    if (isApp(req)) return undefined;
    const { refused, webhook } = named(req);
    if (refused) return refused;
    const channel = state.requireChannel(webhook.channelId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (req.query.get("thread_id") || body.thread_name)
      return rest.gap("executing a webhook into a thread");
    if (!state.messages.has(channel.id))
      return rest.gap("executing a webhook in a channel without messages");
    if (body.content == null && body.embeds == null && body.components == null)
      // "You must provide a value for at least one of content, embeds, components, file, or poll":
      // 50006 "Cannot send an empty message" from the code table (pairing inferred).
      return respond.error(400, 50006, "Cannot send an empty message");
    const overLimit = messageLimitError(body);
    if (overLimit) return overLimit;
    const username = (body.username as string | undefined) ?? webhook.name;
    const message = state.createMessage({
      channelId: channel.id,
      authorId: bot,
      content: body.content as string | undefined,
      embeds: body.embeds as never,
      components: body.components as never,
      webhookId: webhook.id,
    });
    message.author = {
      id: webhook.id,
      username,
      discriminator: "0000",
      global_name: null,
      avatar: null,
      bot: true,
    };
    gateway.dispatchMessage("MESSAGE_CREATE", message);
    return req.query.get("wait") === "true"
      ? respond.json(message)
      : respond.noContent();
  });

  // Get, Edit and Delete Webhook Message (docs.discord.food/resources/webhook): a message this
  // webhook sent, else 10008 Unknown Message (pairing inferred). A message in a thread
  // (`thread_id`) is a Gap, like executing into one.
  const sentBy = (req: RestRequest) => {
    if (req.query.get("thread_id"))
      return {
        refused: rest.gap(`${req.method} a webhook message in a thread`),
      };
    const { refused, webhook } = named(req);
    if (refused) return { refused };
    const message = state.messages
      .get(webhook.channelId)
      ?.find(
        (m) => m.id === req.params.messageId && m.webhook_id === webhook.id,
      );
    return message ? { message } : { refused: respond.unknownMessage() };
  };
  rest.route(
    "GET",
    "/webhooks/:webhookId/:token/messages/:messageId",
    (req) => {
      if (isApp(req)) return undefined;
      const { refused, message } = sentBy(req);
      return refused ?? respond.json(message);
    },
  );
  rest.route(
    "PATCH",
    "/webhooks/:webhookId/:token/messages/:messageId",
    (req) => {
      if (isApp(req)) return undefined;
      const { refused, message } = sentBy(req);
      if (refused) return refused;
      const overLimit =
        pollEditGap(rest, message, req.body) ?? messageLimitError(req.body);
      if (overLimit) return overLimit;
      const updated = state.updateMessage(
        message.channel_id,
        message.id,
        pickMessageFields(req.body),
      );
      gateway.dispatchMessage("MESSAGE_UPDATE", updated);
      return respond.json(updated);
    },
  );
  rest.route(
    "DELETE",
    "/webhooks/:webhookId/:token/messages/:messageId",
    (req) => {
      if (isApp(req)) return undefined;
      const { refused, message } = sentBy(req);
      if (refused) return refused;
      mock.deleteMessage(message);
      return respond.noContent();
    },
  );

  // Follow Channel (docs.discord.food/resources/channel#follow-channel): an announcement channel's
  // posts go to `webhook_channel_id` through a new channel follower webhook. Needs MANAGE_WEBHOOKS
  // in the target; returns the followed channel object { channel_id, webhook_id } and fires
  // WEBHOOKS_UPDATE for the target. The webhook takes the source channel's name, and following a
  // channel that isn't an announcement channel answers 50024 (RESTJSONErrorCodes
  // CannotExecuteActionOnThisChannelType); both are inferred, not checked.
  rest.route(
    "POST",
    "/channels/:channelId/followers",
    authed((req) => {
      const source = state.channels.get(req.params.channelId!);
      if (!source) return respond.unknownChannel();
      const body = (req.body ?? {}) as { webhook_channel_id?: string };
      const target = body.webhook_channel_id
        ? state.channels.get(body.webhook_channel_id)
        : undefined;
      if (!target) return respond.unknownChannel();
      if (source.type !== ChannelType.GuildAnnouncement)
        return respond.error(
          400,
          50024,
          "Cannot execute action on this channel type",
        );
      if (!("guild_id" in target) || !target.guild_id)
        return rest.gap("following into a DM channel");
      const denied = canManage(target);
      if (denied) return denied;
      const webhook: WebhookRecord = {
        id: snowflake(),
        guildId: target.guild_id,
        channelId: target.id,
        creatorId: bot,
        name: source.name ?? "announcements",
        sourceChannelId: source.id,
      };
      state.webhooks.set(webhook.id, webhook);
      announce(webhook);
      return respond.json({ channel_id: source.id, webhook_id: webhook.id });
    }),
  );

  // Crosspost Message (docs.discord.food/resources/message#crosspost-message): SEND_MESSAGES for
  // the bot's own message, MANAGE_MESSAGES as well for anyone else's. Sets CROSSPOSTED (1 << 0),
  // fires MESSAGE_UPDATE, and each following channel gets a copy flagged IS_CROSSPOST (1 << 1)
  // with a message_reference to the original (resources/message#message-flags,
  // #message-reference-object). A second crosspost is 40033 (RESTJSONErrorCodes
  // ThisMessageWasAlreadyCrossposted); a channel that isn't an announcement channel is 50024 as
  // above. The copy's author being the follower webhook named after the source is inferred.
  rest.route(
    "POST",
    "/channels/:channelId/messages/:messageId/crosspost",
    authed((req) => {
      const channel = state.channels.get(req.params.channelId!);
      if (!channel) return respond.unknownChannel();
      const message = state.messages
        .get(channel.id)
        ?.find((m) => m.id === req.params.messageId);
      if (!message) return respond.unknownMessage();
      if (channel.type !== ChannelType.GuildAnnouncement)
        return respond.error(
          400,
          50024,
          "Cannot execute action on this channel type",
        );
      const denied = mock.checkBotPerms(
        channel,
        Permission.SendMessages |
          (message.author.id === bot ? 0n : Permission.ManageMessages),
      );
      if (denied) return denied;
      if ((message.flags ?? 0) & MessageFlags.Crossposted)
        return respond.error(
          400,
          40033,
          "This message has already been crossposted.",
        );
      const updated = state.updateMessage(channel.id, message.id, {
        flags: (message.flags ?? 0) | MessageFlags.Crossposted,
      });
      gateway.dispatchMessage("MESSAGE_UPDATE", updated);
      for (const follower of state.webhooks.values()) {
        if (follower.sourceChannelId !== channel.id) continue;
        const copy = state.createMessage({
          channelId: follower.channelId,
          authorId: bot,
          content: message.content,
          embeds: message.embeds,
          webhookId: follower.id,
          flags: MessageFlags.IsCrosspost,
        });
        copy.author = {
          id: follower.id,
          username: follower.name,
          discriminator: "0000",
          global_name: null,
          avatar: null,
          bot: true,
        };
        copy.message_reference = {
          type: 0,
          message_id: message.id,
          channel_id: channel.id,
          guild_id: channel.guild_id,
        };
        gateway.dispatchMessage("MESSAGE_CREATE", copy);
      }
      return respond.json(updated);
    }),
  );
}
