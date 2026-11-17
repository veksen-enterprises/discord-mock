import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ApplicationCommandOptionType,
  ChannelType,
  ComponentType,
  GatewayDispatchEvents,
  GatewayIntentBits,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type APIApplicationCommandOption,
  type APIChannel,
  type APIMessage,
  type APIUser,
} from "discord-api-types/v10";
import { Gateway } from "./gateway.js";
import {
  computePermissions,
  interactionMember,
  Permission,
} from "./payloads.js";
import { RestRouter, respond, type RestHandler } from "./rest.js";
import { snowflake } from "./snowflake.js";
import { DiscordState, type GuildRecord } from "./state.js";

export { respond } from "./rest.js";
export type { RestHandler, RestRequest, RestResponse } from "./rest.js";
export { Permission } from "./payloads.js";

export interface DiscordMockOptions {
  /** Privileged intents enabled "in the developer portal". Default: all three. */
  privilegedIntents?: number;
  /** Discord voids an interaction not acknowledged within 3s. */
  interactionDeadlineMs?: number;
}

type InteractionState = "pending" | "deferred" | "replied";

/** A user-triggered interaction, and what the bot did with it. */
export class InteractionRun extends EventEmitter<{ change: [] }> {
  state: InteractionState = "pending";
  /** The callback type the bot answered with (4 = reply, 5 = defer, 7 = update, ...). */
  responseType?: InteractionResponseType;
  /** The message @original points at: the reply, or the clicked message for component updates. */
  originalMessageId?: string;
  ephemeral = false;
  readonly followups: APIMessage[] = [];
  readonly createdAt = Date.now();

  constructor(
    private mock: DiscordMock,
    readonly id: string,
    readonly token: string,
    readonly type: InteractionType,
    /** The user who triggered it. */
    readonly userId: string,
    readonly channelId: string,
    readonly guildId?: string,
    readonly sourceMessageId?: string,
  ) {
    super();
  }

  get original(): APIMessage | undefined {
    return this.originalMessageId
      ? this.mock.state.requireMessage(this.channelId, this.originalMessageId)
      : undefined;
  }

  /** Resolves when `predicate` holds, re-checked after every callback/edit/followup. */
  waitUntil(
    predicate: (run: this) => boolean,
    timeoutMs = 2_000,
  ): Promise<this> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!predicate(this)) return;
        cleanup();
        resolve(this);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `discord-mock: interaction ${this.id} still "${this.state}" after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("change", check);
      };
      this.on("change", check);
      check();
    });
  }

  /** The visible reply: waits through a defer until the bot edits in real content. */
  async reply(timeoutMs?: number): Promise<APIMessage> {
    await this.waitUntil(
      (r) =>
        r.state === "replied" &&
        !!r.original &&
        !((r.original.flags ?? 0) & MessageFlags.Loading),
      timeoutMs,
    );
    return this.original!;
  }
}

export class DiscordMock {
  readonly state = new DiscordState();
  readonly rest = new RestRouter();
  readonly token = `mock.${snowflake()}.token`;
  readonly gateway: Gateway;
  private server: Server;
  private interactions = new Map<string, InteractionRun>();
  private deadlineMs: number;
  apiUrl = "";

  constructor(options: DiscordMockOptions = {}) {
    this.deadlineMs = options.interactionDeadlineMs ?? 3_000;
    this.gateway = new Gateway(this.state, {
      token: this.token,
      privilegedIntents:
        options.privilegedIntents ??
        GatewayIntentBits.GuildMembers |
          GatewayIntentBits.GuildPresences |
          GatewayIntentBits.MessageContent,
      recordGap: (what) => void this.rest.gap(what),
    });
    this.server = createServer((req, res) => {
      this.rest.handle(req, res, /^\/api(\/v\d+)?/).catch((error) => {
        res.writeHead(500).end(String(error));
      });
    });
    this.server.on("upgrade", (req, socket, head) =>
      this.gateway.upgrade(req, socket, head),
    );
    this.registerRoutes();
  }

  async listen(): Promise<this> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = this.server.address() as AddressInfo;
    this.apiUrl = `http://127.0.0.1:${port}/api`;
    this.gateway.url = `ws://127.0.0.1:${port}/gateway`;
    return this;
  }

  /** Spread into `new Client({...})`. Points REST here; the gateway URL follows from GET /gateway/bot. */
  get clientOptions() {
    return { rest: { api: this.apiUrl } };
  }

  async close() {
    this.gateway.close();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  /** msw-style override for one route; checked before the stateful handlers. Return undefined to fall through. */
  use(
    method: string,
    path: string,
    handler: RestHandler,
    opts?: { once?: boolean },
  ) {
    this.rest.use(method, path, handler, opts);
  }

  /** Throws if the bot hit a route the mock doesn't implement: the mock can't vouch for that code path. */
  assertNoUnhandledRequests() {
    if (this.rest.unhandled.length) {
      throw new Error(
        `discord-mock: unhandled requests:\n  ${this.rest.unhandled.join("\n  ")}`,
      );
    }
  }

  // ---- world building -------------------------------------------------------

  createUser(username: string) {
    return this.state.createUser({ username });
  }

  createGuild(name: string, opts: { ownerId?: string } = {}) {
    return this.state.createGuild({ name, ownerId: opts.ownerId });
  }

  /** A category; pass it as `parent` to `createTextChannel`. */
  createCategory(guild: GuildRecord, name: string) {
    return this.state.createCategoryChannel(guild.id, { name });
  }

  createTextChannel(
    guild: GuildRecord,
    name: string,
    opts: { parent?: APIChannel } = {},
  ) {
    return this.state.createTextChannel(guild.id, {
      name,
      parentId: opts.parent?.id,
    });
  }

  addMember(guild: GuildRecord, user: APIUser, opts: { nick?: string } = {}) {
    return this.state.addMember(guild.id, user.id, opts);
  }

  /** A guild role with these permissions, given to `members`. */
  createRole(
    guild: GuildRecord,
    name: string,
    permissions: bigint,
    members: APIUser[] = [],
  ) {
    const role = this.state.createRole(guild.id, { name, permissions });
    for (const user of members)
      this.state.assignRole(guild.id, user.id, role.id);
    return role;
  }

  /** Deny (or allow) permissions for a role/member in a channel, as a channel overwrite. */
  setOverwrite(
    channel: APIChannel,
    target: { id: string; type: 0 | 1 },
    perms: { allow?: bigint; deny?: bigint },
  ) {
    if (!("permission_overwrites" in channel))
      throw new Error("discord-mock: channel has no overwrites");
    const overwrites = (channel.permission_overwrites ??= []);
    const next = {
      id: target.id,
      type: target.type,
      allow: String(perms.allow ?? 0n),
      deny: String(perms.deny ?? 0n),
    };
    const i = overwrites.findIndex((o) => o.id === target.id);
    if (i === -1) overwrites.push(next);
    else overwrites[i] = next;
    this.gateway.dispatch(
      GatewayDispatchEvents.ChannelUpdate,
      channel,
      GatewayIntentBits.Guilds,
    );
  }

  // ---- assertions -----------------------------------------------------------

  messagesIn(channel: APIChannel | string): APIMessage[] {
    return (
      this.state.messages.get(
        typeof channel === "string" ? channel : channel.id,
      ) ?? []
    );
  }

  /** Next message matching `predicate` (including ones already sent since `since`). */
  waitForMessage(
    predicate: (m: APIMessage) => boolean,
    opts: { timeoutMs?: number } = {},
  ): Promise<APIMessage> {
    return new Promise((resolve, reject) => {
      const onMessage = (m: APIMessage) => {
        if (!predicate(m)) return;
        cleanup();
        resolve(m);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `discord-mock: no matching message within ${opts.timeoutMs ?? 2_000}ms`,
          ),
        );
      }, opts.timeoutMs ?? 2_000);
      const cleanup = () => {
        clearTimeout(timer);
        this.state.off("messageCreate", onMessage);
      };
      this.state.on("messageCreate", onMessage);
    });
  }

  // ---- acting as a user -----------------------------------------------------

  as(user: APIUser) {
    return {
      sendMessage: (channel: APIChannel, content: string) =>
        this.userSendsMessage(user, channel, content),
      slashCommand: (
        channel: APIChannel,
        name: string,
        options: Record<string, unknown> = {},
      ) => this.userRunsCommand(user, channel, name, options),
      clickButton: (message: APIMessage, customId: string) =>
        this.userClicksButton(user, message, customId),
    };
  }

  private userSendsMessage(
    user: APIUser,
    channel: APIChannel,
    content: string,
  ): APIMessage {
    const mentions = [...content.matchAll(/<@!?(\d+)>/g)].flatMap(
      ([, id]) => this.state.users.get(id!) ?? [],
    );
    const message = this.state.createMessage({
      channelId: channel.id,
      authorId: user.id,
      content,
    });
    message.mentions = mentions;
    this.gateway.dispatchMessage("MESSAGE_CREATE", message);
    return message;
  }

  private userRunsCommand(
    user: APIUser,
    channel: APIChannel,
    name: string,
    input: Record<string, unknown>,
  ) {
    const guildId = "guild_id" in channel ? channel.guild_id : undefined;
    const command = this.state.findCommand(guildId, name);
    if (!command) {
      throw new Error(
        `discord-mock: /${name} isn't registered (bot never PUT it to /applications/.../commands)`,
      );
    }
    const options = buildOptions(command.options ?? [], input, name);
    return this.dispatchInteraction(
      user,
      channel,
      InteractionType.ApplicationCommand,
      {
        id: command.id,
        name: command.name,
        type: command.type,
        options,
        resolved: resolvedFor(
          this.state,
          command.options ?? [],
          input,
          guildId,
        ),
      },
    );
  }

  private userClicksButton(
    user: APIUser,
    message: APIMessage,
    customId: string,
  ) {
    const button = (message.components ?? [])
      .flatMap((row: any) => row.components ?? [])
      .find(
        (c: any) => c.type === ComponentType.Button && c.custom_id === customId,
      );
    if (!button)
      throw new Error(
        `discord-mock: message ${message.id} has no button "${customId}"`,
      );
    if (button.disabled)
      throw new Error(`discord-mock: button "${customId}" is disabled`);
    const channel = this.state.requireChannel(message.channel_id);
    return this.dispatchInteraction(
      user,
      channel,
      InteractionType.MessageComponent,
      { custom_id: customId, component_type: ComponentType.Button },
      message,
    );
  }

  private dispatchInteraction(
    user: APIUser,
    channel: APIChannel,
    type: InteractionType,
    data: unknown,
    message?: APIMessage,
  ) {
    const guild =
      "guild_id" in channel && channel.guild_id
        ? this.state.requireGuild(channel.guild_id)
        : undefined;
    const member = guild?.members.get(user.id);
    if (guild && !member)
      throw new Error(
        `discord-mock: ${user.username} isn't a member of ${guild.name}`,
      );
    const run = new InteractionRun(
      this,
      snowflake(),
      `itoken-${snowflake()}`,
      type,
      user.id,
      channel.id,
      guild?.id,
      message?.id,
    );
    if (message) run.originalMessageId = message.id;
    this.interactions.set(run.id, run);
    const botPerms = guild
      ? computePermissions(this.state, guild, this.state.bot.id, channel)
      : 0n;
    this.gateway.dispatch(GatewayDispatchEvents.InteractionCreate, {
      id: run.id,
      application_id: this.state.applicationId,
      type,
      data,
      token: run.token,
      version: 1,
      channel,
      channel_id: channel.id,
      ...(guild
        ? {
            guild_id: guild.id,
            guild: { id: guild.id, locale: "en-US", features: [] },
            member: interactionMember(this.state, guild, member!, channel),
          }
        : { user }),
      ...(message ? { message } : {}),
      app_permissions: String(botPerms),
      locale: "en-US",
      guild_locale: "en-US",
      entitlements: [],
      authorizing_integration_owners: { 0: guild?.id ?? "0" },
      context: guild ? 0 : 1,
      attachment_size_limit: 10 * 1024 * 1024,
    });
    return run;
  }

  // ---- REST: the bot's side ---------------------------------------------------

  private registerRoutes() {
    const { rest, state } = this;
    const authed =
      (handler: RestHandler): RestHandler =>
      (req) => {
        if (req.headers.authorization !== `Bot ${this.token}`)
          return respond.unauthorized();
        return handler(req);
      };

    rest.route(
      "GET",
      "/gateway/bot",
      authed(() =>
        respond.json({
          url: this.gateway.url,
          shards: 1,
          session_start_limit: {
            total: 1000,
            remaining: 1000,
            reset_after: 86_400_000,
            max_concurrency: 1,
          },
        }),
      ),
    );
    rest.route(
      "GET",
      "/users/@me",
      authed(() => respond.json(state.bot)),
    );

    const putCommands = (
      scope: (p: Record<string, string>) => string,
    ): RestHandler =>
      authed((req) => {
        if (req.params.appId !== state.applicationId)
          return respond.error(403, 50001, "Missing Access");
        // docs.discord.food/interactions/application-commands: a CHAT_INPUT command needs a description.
        const bodies = req.body as { type?: number; description?: string }[];
        if (bodies.some((c) => (c.type ?? 1) === 1 && !c.description))
          return respond.invalidFormBody();
        return respond.json(state.setCommands(scope(req.params), req.body));
      });
    rest.route(
      "PUT",
      "/applications/:appId/commands",
      putCommands(() => "global"),
    );
    rest.route(
      "PUT",
      "/applications/:appId/guilds/:guildId/commands",
      putCommands((p) => p.guildId!),
    );
    rest.route(
      "GET",
      "/applications/:appId/commands",
      authed(() =>
        respond.json([...(state.commands.get("global")?.values() ?? [])]),
      ),
    );

    rest.route(
      "GET",
      "/channels/:channelId",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        // docs.discord.food/resources/channel: requires VIEW_CHANNEL. 50001 is inferred, not checked.
        return this.checkBotPerms(channel, 0n) ?? respond.json(channel);
      }),
    );

    // MANAGE_CHANNELS at guild level. Only text channels so far: another type is a 400, not a guess.
    rest.route(
      "POST",
      "/guilds/:guildId/channels",
      authed((req) => {
        const guild = state.guilds.get(req.params.guildId!);
        if (!guild) return respond.error(404, 10004, "Unknown Guild");
        const perms = computePermissions(state, guild, state.bot.id);
        if (!(perms & Permission.ManageChannels))
          return respond.missingPermissions();
        if ((req.body?.type ?? 0) !== ChannelType.GuildText)
          return respond.error(
            400,
            50035,
            `discord-mock: channel type ${req.body?.type} not implemented`,
          );
        const channel = state.createTextChannel(guild.id, {
          name: req.body.name,
        });
        this.gateway.dispatch(
          GatewayDispatchEvents.ChannelCreate,
          channel,
          GatewayIntentBits.Guilds,
        );
        // 201 is inferred, not checked; the contract test settles it.
        return respond.json(channel, 201);
      }),
    );

    rest.route(
      "DELETE",
      "/channels/:channelId",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        const denied = this.checkBotPerms(channel, Permission.ManageChannels);
        if (denied) return denied;
        state.deleteChannel(channel.id);
        this.gateway.dispatch(
          GatewayDispatchEvents.ChannelDelete,
          channel,
          GatewayIntentBits.Guilds,
        );
        return respond.json(channel);
      }),
    );

    // Needs MANAGE_ROLES on the channel. Inferred, not checked: Discord also refuses to
    // allow a permission the bot doesn't have itself; the mock doesn't enforce that yet.
    rest.route(
      "PUT",
      "/channels/:channelId/permissions/:overwriteId",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        const denied = this.checkBotPerms(channel, Permission.ManageRoles);
        if (denied) return denied;
        this.setOverwrite(
          channel,
          { id: req.params.overwriteId!, type: req.body?.type ?? 0 },
          {
            allow: BigInt(req.body?.allow ?? 0),
            deny: BigInt(req.body?.deny ?? 0),
          },
        );
        return respond.noContent();
      }),
    );

    // Permission-checked like Discord: VIEW_CHANNEL then SEND_MESSAGES, 50001 vs 50013.
    rest.route(
      "POST",
      "/channels/:channelId/messages",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        const denied = this.checkBotPerms(channel, Permission.SendMessages);
        if (denied) return denied;
        const message = state.createMessage({
          channelId: channel.id,
          authorId: state.bot.id,
          content: req.body?.content,
          embeds: req.body?.embeds,
          components: req.body?.components,
        });
        this.gateway.dispatchMessage("MESSAGE_CREATE", message);
        return respond.json(message);
      }),
    );

    rest.route(
      "GET",
      "/channels/:channelId/messages",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        // docs.discord.food/resources/message#list-messages: needs VIEW_CHANNEL; without
        // READ_MESSAGE_HISTORY "this will return no messages".
        const denied = this.checkBotPerms(channel, 0n);
        if (denied) return denied;
        if (this.checkBotPerms(channel, Permission.ReadMessageHistory))
          return respond.json([]);
        const limit = Number(req.query.get("limit") ?? 50);
        const before = req.query.get("before");
        const after = req.query.get("after");
        let list = [...this.messagesIn(channel)].reverse(); // newest first, as Discord returns
        if (before) list = list.filter((m) => BigInt(m.id) < BigInt(before));
        if (after)
          list = list
            .filter((m) => BigInt(m.id) > BigInt(after))
            .reverse()
            .slice(0, limit)
            .reverse();
        return respond.json(list.slice(0, limit));
      }),
    );

    rest.route(
      "PATCH",
      "/channels/:channelId/messages/:messageId",
      authed((req) => {
        const message = this.messagesIn(req.params.channelId!).find(
          (m) => m.id === req.params.messageId,
        );
        if (!message) return respond.unknownMessage();
        if (message.author.id !== state.bot.id)
          return respond.error(
            403,
            50005,
            "Cannot edit a message authored by another user",
          );
        const updated = state.updateMessage(
          message.channel_id,
          message.id,
          pickMessageFields(req.body),
        );
        this.gateway.dispatchMessage("MESSAGE_UPDATE", updated);
        return respond.json(updated);
      }),
    );

    // ---- interactions ----
    rest.route("POST", "/interactions/:id/:token/callback", (req) => {
      const run = this.interactions.get(req.params.id!);
      if (!run || run.token !== req.params.token)
        return respond.unknownInteraction();
      if (run.state !== "pending") return respond.alreadyAcknowledged();
      if (Date.now() - run.createdAt > this.deadlineMs)
        return respond.unknownInteraction();

      const { type, data } = req.body as {
        type: InteractionResponseType;
        data?: any;
      };
      const ephemeral = !!((data?.flags ?? 0) & MessageFlags.Ephemeral);
      run.responseType = type;
      switch (type) {
        case InteractionResponseType.ChannelMessageWithSource:
        case InteractionResponseType.DeferredChannelMessageWithSource: {
          const deferred =
            type === InteractionResponseType.DeferredChannelMessageWithSource;
          run.ephemeral = ephemeral;
          const message = state.createMessage({
            channelId: run.channelId,
            authorId: state.bot.id,
            ...(deferred ? {} : pickMessageFields(data)),
            flags: (data?.flags ?? 0) | (deferred ? MessageFlags.Loading : 0),
            interaction: interactionMetadata(run),
            webhookId: state.applicationId,
          });
          run.originalMessageId = message.id;
          run.state = deferred ? "deferred" : "replied";
          if (!ephemeral)
            this.gateway.dispatchMessage("MESSAGE_CREATE", message);
          break;
        }
        // docs.discord.food/interactions/receiving-and-responding: types 6 and 7 are for
        // MESSAGE_COMPONENT and MODAL_SUBMIT only. What Discord answers otherwise is unchecked: a Gap.
        case InteractionResponseType.DeferredMessageUpdate:
          if (!run.sourceMessageId)
            return rest.gap(`callback type 6 on a ${run.type} interaction`);
          run.state = "deferred";
          break;
        case InteractionResponseType.UpdateMessage: {
          if (!run.sourceMessageId)
            return rest.gap(`callback type 7 on a ${run.type} interaction`);
          const updated = state.updateMessage(
            run.channelId,
            run.sourceMessageId,
            pickMessageFields(data),
          );
          this.gateway.dispatchMessage("MESSAGE_UPDATE", updated);
          run.state = "replied";
          break;
        }
        default:
          return rest.gap(`interaction callback type ${type}`);
      }
      run.emit("change");
      if (req.query.get("with_response") !== "true") return respond.noContent();
      const original = run.original;
      // resource.message: "only if type is CHANNEL_MESSAGE_WITH_SOURCE or UPDATE_MESSAGE".
      const withMessage =
        type === InteractionResponseType.ChannelMessageWithSource ||
        type === InteractionResponseType.UpdateMessage;
      return respond.json({
        interaction: {
          id: run.id,
          type: run.type,
          activity_instance_id: null,
          response_message_id: original?.id ?? null,
          response_message_loading: run.state === "deferred",
          response_message_ephemeral: run.ephemeral,
        },
        resource:
          withMessage && original ? { type, message: original } : { type },
      });
    });

    const runFor = (req: { params: Record<string, string> }) => {
      if (req.params.appId !== state.applicationId) return undefined;
      return [...this.interactions.values()].find(
        (r) => r.token === req.params.token,
      );
    };

    rest.route("PATCH", "/webhooks/:appId/:token/messages/@original", (req) => {
      const run = runFor(req);
      if (!run || run.state === "pending") return respond.unknownWebhook();
      const original = run.original;
      if (!original) return respond.unknownMessage();
      const updated = state.updateMessage(run.channelId, original.id, {
        ...pickMessageFields(req.body),
        flags: (original.flags ?? 0) & ~MessageFlags.Loading,
      });
      if (!run.ephemeral)
        this.gateway.dispatchMessage("MESSAGE_UPDATE", updated);
      run.state = "replied";
      run.emit("change");
      return respond.json(updated);
    });

    rest.route("GET", "/webhooks/:appId/:token/messages/@original", (req) => {
      const run = runFor(req);
      return run?.original
        ? respond.json(run.original)
        : respond.unknownMessage();
    });

    rest.route("POST", "/webhooks/:appId/:token", (req) => {
      const run = runFor(req);
      if (!run || run.state === "pending") return respond.unknownWebhook();
      // Discord's docs (discord-api-docs, Create Followup Message): right after a
      // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, a followup edits the loading message instead of
      // creating one, and the ephemeral flag is ignored.
      const original = run.original;
      if (
        run.state === "deferred" &&
        run.responseType ===
          InteractionResponseType.DeferredChannelMessageWithSource &&
        original
      ) {
        const updated = state.updateMessage(run.channelId, original.id, {
          ...pickMessageFields(req.body),
          flags: (original.flags ?? 0) & ~MessageFlags.Loading,
        });
        if (!run.ephemeral)
          this.gateway.dispatchMessage("MESSAGE_UPDATE", updated);
        run.state = "replied";
        run.emit("change");
        return respond.json(updated);
      }
      const message = state.createMessage({
        channelId: run.channelId,
        authorId: state.bot.id,
        ...pickMessageFields(req.body),
        flags: req.body?.flags ?? 0,
        interaction: {
          ...interactionMetadata(run),
          originalResponseMessageId: run.originalMessageId,
        },
        webhookId: state.applicationId,
      });
      run.followups.push(message);
      if (!((message.flags ?? 0) & MessageFlags.Ephemeral))
        this.gateway.dispatchMessage("MESSAGE_CREATE", message);
      run.emit("change");
      return respond.json(message);
    });
  }

  /** VIEW_CHANNEL first: without it "other channel permissions are effectively ignored" (docs.discord.food/topics/permissions). */
  private checkBotPerms(channel: APIChannel, needed: bigint) {
    if (!("guild_id" in channel) || !channel.guild_id) return undefined;
    const guild = this.state.requireGuild(channel.guild_id);
    const perms = computePermissions(
      this.state,
      guild,
      this.state.bot.id,
      channel,
    );
    if (!(perms & Permission.ViewChannel)) return respond.missingAccess();
    if ((perms & needed) !== needed) return respond.missingPermissions();
    return undefined;
  }
}

export async function createDiscordMock(
  options?: DiscordMockOptions,
): Promise<DiscordMock> {
  return new DiscordMock(options).listen();
}

function interactionMetadata(run: InteractionRun) {
  return {
    id: run.id,
    type: run.type,
    userId: run.userId,
    guildId: run.guildId,
    interactedMessageId: run.sourceMessageId,
  };
}

function pickMessageFields(body: any) {
  if (!body) return {};
  const out: Partial<Pick<APIMessage, "content" | "embeds" | "components">> =
    {};
  if ("content" in body) out.content = body.content ?? "";
  if ("embeds" in body) out.embeds = body.embeds ?? [];
  if ("components" in body) out.components = body.components ?? [];
  return out;
}

const OPTION_CHECKS: Partial<
  Record<ApplicationCommandOptionType, (v: unknown) => boolean>
> = {
  [ApplicationCommandOptionType.String]: (v) => typeof v === "string",
  [ApplicationCommandOptionType.Integer]: (v) => Number.isInteger(v),
  [ApplicationCommandOptionType.Number]: (v) => typeof v === "number",
  [ApplicationCommandOptionType.Boolean]: (v) => typeof v === "boolean",
  [ApplicationCommandOptionType.User]: (v) => typeof v === "string",
};

/** Turn `{ text: "hi" }` into Discord's typed option list, validated against what the bot registered. */
function buildOptions(
  schema: APIApplicationCommandOption[],
  input: Record<string, unknown>,
  command: string,
) {
  for (const key of Object.keys(input)) {
    if (!schema.some((o) => o.name === key))
      throw new Error(`discord-mock: /${command} has no option "${key}"`);
  }
  return schema.flatMap((opt) => {
    const value = input[opt.name];
    if (value === undefined) {
      if ("required" in opt && opt.required)
        throw new Error(
          `discord-mock: /${command} requires option "${opt.name}"`,
        );
      return [];
    }
    const check = OPTION_CHECKS[opt.type];
    if (!check)
      throw new Error(
        `discord-mock: option type ${opt.type} not supported yet`,
      );
    if (!check(value))
      throw new Error(
        `discord-mock: /${command} option "${opt.name}" has the wrong type`,
      );
    const choices = "choices" in opt ? opt.choices : undefined;
    if (choices?.length && !choices.some((c) => c.value === value)) {
      throw new Error(
        `discord-mock: /${command} option "${opt.name}" must be one of its choices`,
      );
    }
    return [{ name: opt.name, type: opt.type, value }];
  });
}

/** docs.discord.food/interactions/receiving-and-responding#resolved-data-object */
function resolvedFor(
  state: DiscordState,
  schema: APIApplicationCommandOption[],
  input: Record<string, unknown>,
  guildId: string | undefined,
) {
  const users = schema
    .filter(
      (o) =>
        o.type === ApplicationCommandOptionType.User &&
        typeof input[o.name] === "string",
    )
    .map((o) => state.requireUser(input[o.name] as string));
  if (!users.length) return undefined;
  const guild = guildId ? state.requireGuild(guildId) : undefined;
  // Resolved members carry no user, deaf or mute; the user is in `users`.
  const members = users.flatMap((u) => {
    const m = guild?.members.get(u.id);
    if (!m) return [];
    const { user: _, deaf: _d, mute: _m, ...partial } = m;
    return [[u.id, partial] as const];
  });
  return {
    users: Object.fromEntries(users.map((u) => [u.id, u])),
    ...(members.length ? { members: Object.fromEntries(members) } : {}),
  };
}
