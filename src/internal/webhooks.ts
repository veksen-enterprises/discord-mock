import { randomBytes } from "node:crypto";
import {
  GatewayDispatchEvents,
  GatewayIntentBits,
  type APIChannel,
} from "discord-api-types/v10";
import { messageLimitError } from "./limits.js";
import type { DiscordMock } from "./mock.js";
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

  const payload = (webhook: WebhookRecord, withUser = true) => ({
    id: webhook.id,
    type: 1,
    guild_id: webhook.guildId,
    channel_id: webhook.channelId,
    ...(withUser ? { user: state.requireUser(webhook.creatorId) } : {}),
    name: webhook.name,
    avatar: null,
    token: webhook.token,
    application_id: webhook.creatorId === bot ? state.applicationId : null,
  });
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

  // Modify Webhook: only `name` is modelled; avatar and channel_id (and channel_id with a token,
  // which the docs forbid) are a Gap.
  const modify = (req: RestRequest) => {
    const { refused, webhook } = named(req);
    if (refused) return refused;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const other = Object.keys(body).find((key) => key !== "name");
    if (other) return rest.gap(`PATCH webhook ${other}`);
    if ("name" in body) {
      if (nameError(body.name)) return invalidName();
      webhook.name = body.name as string;
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
    if (req.query.get("thread_id") || req.body?.thread_name)
      return rest.gap("executing a webhook into a thread");
    if (!state.messages.has(channel.id))
      return rest.gap("executing a webhook in a channel without messages");
    const body = (req.body ?? {}) as Record<string, unknown>;
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

  // Get, Edit and Delete Webhook Message for a channel webhook aren't modelled yet.
  for (const method of ["GET", "PATCH", "DELETE"])
    rest.route(
      method,
      "/webhooks/:webhookId/:token/messages/:messageId",
      (req) =>
        isApp(req)
          ? undefined
          : rest.gap(`${method} a channel webhook's message`),
    );
}
