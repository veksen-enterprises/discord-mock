import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ApplicationCommandType,
  ApplicationCommandOptionType,
  ChannelType,
  ComponentType,
  GatewayDispatchEvents,
  GatewayIntentBits,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type APIApplicationCommand,
  type APIApplicationCommandOption,
  type RESTPostAPIApplicationCommandsJSONBody,
  type APIChannel,
  type APIMessage,
  type APIUser,
} from "discord-api-types/v10";
import { Gateway } from "./gateway.js";
import {
  choicesLimitError,
  messageLimitError,
  modalLimitError,
} from "./limits.js";
import { registerMemberRoutes } from "./members.js";
import {
  ALL_PERMISSIONS,
  computePermissions,
  interactionMember,
  Permission,
} from "./payloads.js";
import { RestRouter, respond, type RestHandler } from "./rest.js";
import { snowflake } from "./snowflake.js";
import { DiscordState, type GuildRecord } from "./state.js";
import { registerThreadRoutes } from "./threads.js";

export { respond } from "./rest.js";
export type { RestHandler, RestRequest, RestResponse } from "./rest.js";
export { Permission } from "./payloads.js";

// Captured at import, before a test can fake timers: a wait must still time out after a test
// calls vi.useFakeTimers() to move the bot's clock.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** What a user posts: text, files, and the message it replies to. */
export interface UserMessage {
  content?: string;
  files?: { name: string; data: Uint8Array; contentType: string }[];
  replyTo?: APIMessage;
}

export interface DiscordMockOptions {
  /** Privileged intents enabled "in the developer portal". Default: all three. */
  privilegedIntents?: number;
  /** Discord voids an interaction not acknowledged within 3s. */
  interactionDeadlineMs?: number;
}

type InteractionState = "pending" | "deferred" | "replied" | "modal";

/** A user-triggered interaction, and what the bot did with it. */
export class InteractionRun extends EventEmitter<{ change: [] }> {
  state: InteractionState = "pending";
  /** The callback type the bot answered with (4 = reply, 5 = defer, 7 = update, ...). */
  responseType?: InteractionResponseType;
  /** The message @original points at: the reply, or the clicked message for component updates. */
  originalMessageId?: string;
  ephemeral = false;
  /** The modal the bot opened (callback type 9), while state is "modal". */
  modal?: Modal;
  /** The choices the bot suggested (callback type 8) to an autocomplete interaction. */
  choices?: { name: string; value: string | number }[];
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
      const timer = realSetTimeout(() => {
        cleanup();
        reject(
          new Error(
            `discordjs-test-kit: interaction ${this.id} still "${this.state}" after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      const cleanup = () => {
        realClearTimeout(timer);
        this.off("change", check);
      };
      this.on("change", check);
      check();
    });
  }

  /** Waits for the bot's first callback, within the deadline Discord gives it. */
  async acknowledged(): Promise<this> {
    // Discord gives the bot the whole deadline to acknowledge, so a shorter wait would fail a bot
    // that works on Discord. The margin covers the callback request landing just inside it.
    const deadlineMs = this.mock.interactionDeadlineMs;
    // What the Discord app shows for an unanswered autocomplete is from the app, not the docs.
    const shown =
      this.type === InteractionType.ApplicationCommandAutocomplete
        ? "Loading options failed"
        : "The application did not respond";
    return this.waitUntil((r) => r.state !== "pending", deadlineMs + 250).catch(
      () => {
        throw new Error(
          `discordjs-test-kit: the bot didn't answer within ${deadlineMs / 1000}s, so Discord shows the user "${shown}"`,
        );
      },
    );
  }

  /** The choices the bot suggested to this autocomplete interaction. */
  async suggestions(): Promise<{ name: string; value: string | number }[]> {
    await this.acknowledged();
    return this.choices!;
  }

  /** The visible reply: waits through a defer until the bot edits in real content. */
  async reply(timeoutMs?: number): Promise<APIMessage> {
    await this.acknowledged();
    if (this.modal)
      throw new Error(
        `discordjs-test-kit: the bot opened the form ${describeModal(this.modal)} instead of replying. Pass the values to fill it in`,
      );
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
  // Real tokens start with the bot's id in base64, and bots such as Needle decode it to find their
  // application id. Shape inferred from tokens in the wild, not documented.
  private readonly developerId = snowflake();
  readonly token = `${Buffer.from(this.state.applicationId).toString("base64").replace(/=+$/, "")}.${snowflake()}.mock`;
  readonly gateway: Gateway;
  private server: Server;
  private interactions = new Map<string, InteractionRun>();
  /** REST requests the bot has open. With `activity`, tells when the bot has gone quiet. */
  private inFlight = 0;
  private readonly activity = new EventEmitter<{ change: [] }>();
  readonly interactionDeadlineMs: number;
  apiUrl = "";

  constructor(options: DiscordMockOptions = {}) {
    this.interactionDeadlineMs = options.interactionDeadlineMs ?? 3_000;
    this.gateway = new Gateway(this.state, {
      token: this.token,
      privilegedIntents:
        options.privilegedIntents ??
        GatewayIntentBits.GuildMembers |
          GatewayIntentBits.GuildPresences |
          GatewayIntentBits.MessageContent,
      recordGap: (what) => void this.rest.gap(what),
      onDispatch: () => this.activity.emit("change"),
    });
    this.server = createServer((req, res) => {
      this.inFlight++;
      this.activity.emit("change");
      res.on("close", () => {
        this.inFlight--;
        this.activity.emit("change");
      });
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
    this.state.cdnUrl = `http://127.0.0.1:${port}`;
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
        `discordjs-test-kit: unhandled requests:\n  ${this.rest.unhandled.join("\n  ")}`,
      );
    }
  }

  // ---- world building -------------------------------------------------------

  createUser(username: string) {
    return this.state.createUser({ username });
  }

  // World changes after the bot connected are announced like Discord announces them, so
  // the bot's cache follows: GUILD_CREATE, CHANNEL_CREATE, GUILD_MEMBER_ADD (the last needs
  // GUILD_MEMBERS, docs.discord.food/gateway/gateway-events#guild-member-add).

  createGuild(name: string, opts: { ownerId?: string } = {}) {
    const guild = this.state.createGuild({ name, ownerId: opts.ownerId });
    this.gateway.announceGuild(guild);
    return guild;
  }

  /** A category; pass it as `parent` to `createTextChannel`. */
  createCategory(guild: GuildRecord, name: string) {
    return this.announceChannel(
      this.state.createCategoryChannel(guild.id, { name }),
    );
  }

  createTextChannel(
    guild: GuildRecord,
    name: string,
    opts: { parent?: APIChannel } = {},
  ) {
    return this.announceChannel(
      this.state.createTextChannel(guild.id, {
        name,
        parentId: opts.parent?.id,
      }),
    );
  }

  /** A forum: users post in it with `as(user).forumPost()`. */
  createForum(guild: GuildRecord, name: string) {
    return this.announceChannel(
      this.state.createForumChannel(guild.id, { name }),
    );
  }

  /**
   * Archive `thread`, as Discord does to an inactive one. docs.discord.food/topics/threads:
   * archiving sets archive_timestamp and is announced as THREAD_UPDATE with the full channel.
   */
  archiveThread(thread: APIChannel) {
    const record = this.state.requireChannel(thread.id);
    if (!("thread_metadata" in record) || !record.thread_metadata)
      throw new Error(`discordjs-test-kit: ${thread.id} is not a thread`);
    record.thread_metadata.archived = true;
    record.thread_metadata.archive_timestamp = new Date().toISOString();
    this.gateway.dispatch(
      GatewayDispatchEvents.ThreadUpdate,
      record,
      GatewayIntentBits.Guilds,
    );
    return record;
  }

  addMember(guild: GuildRecord, user: APIUser, opts: { nick?: string } = {}) {
    const member = this.state.addMember(guild.id, user.id, opts);
    this.gateway.dispatch(
      GatewayDispatchEvents.GuildMemberAdd,
      { ...member, guild_id: guild.id },
      GatewayIntentBits.GuildMembers,
    );
    return member;
  }

  /**
   * `user` sets their server nickname in `guild` (null clears it). Discord's docs,
   * gateway-events#guild-member-update: GUILD_MEMBER_UPDATE with the member and guild_id,
   * sent only with GUILD_MEMBERS.
   */
  setNickname(guild: GuildRecord, user: APIUser, nick: string | null) {
    const member = this.state.guilds.get(guild.id)?.members.get(user.id);
    if (!member)
      throw new Error(
        `discordjs-test-kit: ${user.username} isn't a member of ${guild.name}`,
      );
    member.nick = nick;
    this.gateway.dispatch(
      GatewayDispatchEvents.GuildMemberUpdate,
      { ...member, guild_id: guild.id },
      GatewayIntentBits.GuildMembers,
    );
  }

  /**
   * `user` leaves `guild` (or is kicked or banned). Discord's docs, gateway-events#guild-member-remove:
   * GUILD_MEMBER_REMOVE { guild_id, user }, sent only with GUILD_MEMBERS.
   */
  removeMember(guild: GuildRecord, user: APIUser) {
    if (!this.state.guilds.get(guild.id)?.members.delete(user.id))
      throw new Error(
        `discordjs-test-kit: ${user.username} isn't a member of ${guild.name}`,
      );
    this.gateway.dispatch(
      GatewayDispatchEvents.GuildMemberRemove,
      { guild_id: guild.id, user },
      GatewayIntentBits.GuildMembers,
    );
  }

  private announceChannel(channel: APIChannel) {
    this.gateway.dispatch(
      GatewayDispatchEvents.ChannelCreate,
      channel,
      GatewayIntentBits.Guilds,
    );
    return channel;
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

  /** What the bot's invite link grants: a "bot" role with `permissions` in every guild built so far. */
  grantBot(permissions: bigint) {
    for (const guild of this.state.guilds.values())
      this.createRole(guild, "bot", permissions, [this.state.bot]);
  }

  /** Deny (or allow) permissions for a role/member in a channel, as a channel overwrite. */
  setOverwrite(
    channel: APIChannel,
    target: { id: string; type: 0 | 1 },
    perms: { allow?: bigint; deny?: bigint },
  ) {
    if (!("permission_overwrites" in channel))
      throw new Error("discordjs-test-kit: channel has no overwrites");
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

  /**
   * Resolves once the bot has had no REST request open and been sent no Dispatch for `quietMs`.
   * A heuristic: a bot that thinks longer than `quietMs` before its first request looks idle.
   */
  waitForIdle(
    opts: { quietMs?: number; timeoutMs?: number } = {},
  ): Promise<void> {
    const { quietMs = 100, timeoutMs = 2_000 } = opts;
    return new Promise((resolve, reject) => {
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const restart = () => {
        realClearTimeout(quiet);
        quiet =
          this.inFlight === 0
            ? realSetTimeout(() => {
                cleanup();
                resolve();
              }, quietMs)
            : undefined;
      };
      const deadline = realSetTimeout(() => {
        cleanup();
        reject(
          new Error(
            `discordjs-test-kit: the bot was still busy after ${timeoutMs / 1000}s (${this.inFlight} requests open)`,
          ),
        );
      }, timeoutMs);
      const cleanup = () => {
        realClearTimeout(quiet);
        realClearTimeout(deadline);
        this.activity.off("change", restart);
      };
      this.activity.on("change", restart);
      restart();
    });
  }

  /** The next message created or edited that matches `predicate`. */
  waitForMessage(
    predicate: (m: APIMessage) => boolean,
    opts: { timeoutMs?: number } = {},
  ): Promise<APIMessage> {
    return this.waitForState(
      ["messageCreate", "messageUpdate"],
      predicate,
      opts.timeoutMs,
    );
  }

  /** Resolves with the first thread created from now on that `predicate` accepts. */
  waitForThread(
    predicate: (thread: APIChannel) => boolean,
    opts: { timeoutMs?: number } = {},
  ): Promise<APIChannel> {
    return this.waitForState(["threadCreate"], predicate, opts.timeoutMs);
  }

  private waitForState<T extends APIMessage | APIChannel>(
    events: ("messageCreate" | "messageUpdate" | "threadCreate")[],
    predicate: (value: T) => boolean,
    timeoutMs = 2_000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const listener = (value: T) => {
        if (!predicate(value)) return;
        cleanup();
        resolve(value);
      };
      const timer = realSetTimeout(() => {
        cleanup();
        reject(new Error(`discordjs-test-kit: no match within ${timeoutMs}ms`));
      }, timeoutMs);
      const on = this.state.on.bind(this.state) as (
        event: string,
        fn: (value: T) => void,
      ) => void;
      const off = this.state.off.bind(this.state) as typeof on;
      const cleanup = () => {
        realClearTimeout(timer);
        for (const event of events) off(event, listener);
      };
      for (const event of events) on(event, listener);
    });
  }

  // ---- acting as a user -----------------------------------------------------

  as(user: APIUser) {
    return {
      sendMessage: (channel: APIChannel, message: string | UserMessage) =>
        this.userSendsMessage(
          user,
          channel,
          typeof message === "string" ? { content: message } : message,
        ),
      /** Adds a unicode emoji reaction, dispatched as MESSAGE_REACTION_ADD. */
      react: (message: APIMessage, emoji: string) =>
        this.userReacts(user, message, emoji),
      /** A new forum post: a thread plus its starter message, which shares the thread's id. */
      forumPost: (forum: APIChannel, post: UserMessage & { title: string }) =>
        this.userPostsInForum(user, forum, post),
      slashCommand: (
        channel: APIChannel,
        name: string,
        options: Record<string, unknown> = {},
      ) => this.userRunsCommand(user, channel, name, options),
      /**
       * Types `value` into option `focused` of `/name`, with `input` already filled: an
       * autocomplete interaction. Resolve `.suggestions()` for the bot's choices.
       */
      autocomplete: (
        channel: APIChannel,
        name: string,
        focused: string,
        value: string | number,
        input: Record<string, unknown> = {},
      ) =>
        this.userRunsCommand(
          user,
          channel,
          name,
          { ...input, [focused]: value },
          focused,
        ),
      /** Picks the app `name` from the context menu of a member (or user) or a message in `channel`. */
      contextMenu: (
        channel: APIChannel,
        target: APIUser | APIMessage,
        name: string,
      ) => this.userRunsContextMenu(user, channel, target, name),
      /** Presses the button labelled `label` (or showing that emoji, when it has no label). */
      clickButton: (message: APIMessage, label: string | RegExp) =>
        this.userClicksButton(user, message, label),
      /** Fills the form the bot opened in answer to `run`, by field label, and submits it. */
      submitForm: (run: InteractionRun, values: Record<string, string>) =>
        this.userSubmitsForm(user, run, values),
      /** Picks the option labelled `label` from the string select on `message` that offers it. */
      selectOption: (
        message: APIMessage,
        label: string | RegExp | (string | RegExp)[],
      ) => this.userSelectsOption(user, message, label),
    };
  }

  private userSendsMessage(
    user: APIUser,
    channel: APIChannel,
    input: UserMessage,
    id?: string,
  ): APIMessage {
    this.requireMembership(user, channel);
    const content = input.content ?? "";
    const mentions = [...content.matchAll(/<@!?(\d+)>/g)].flatMap(
      ([, id]) => this.state.users.get(id!) ?? [],
    );
    const message = this.state.createMessage({
      channelId: channel.id,
      authorId: user.id,
      content,
      files: input.files,
      replyTo: input.replyTo?.id,
      id,
    });
    for (const user of mentions)
      if (!message.mentions.some((u) => u.id === user.id))
        message.mentions.push(user);
    this.gateway.dispatchMessage("MESSAGE_CREATE", message);
    return message;
  }

  private userReacts(user: APIUser, message: APIMessage, emoji: string) {
    const channel = this.state.requireChannel(message.channel_id);
    const member = this.requireMembership(user, channel)?.member;
    if (!this.state.addReaction(message.channel_id, message.id, emoji, user.id))
      return;
    const guildId = "guild_id" in channel ? channel.guild_id : undefined;
    // docs.discord.food/gateway/gateway-events#message-reaction-add; GUILD_MESSAGE_REACTIONS
    // in guilds, DIRECT_MESSAGE_REACTIONS in DMs.
    this.gateway.dispatch(
      GatewayDispatchEvents.MessageReactionAdd,
      {
        user_id: user.id,
        channel_id: channel.id,
        message_id: message.id,
        message_author_id: message.author.id,
        ...(guildId ? { guild_id: guildId } : {}),
        ...(member ? { member } : {}),
        emoji: { id: null, name: emoji },
        type: 0,
        burst: false,
      },
      guildId
        ? GatewayIntentBits.GuildMessageReactions
        : GatewayIntentBits.DirectMessageReactions,
    );
  }

  private userPostsInForum(
    user: APIUser,
    forum: APIChannel,
    post: UserMessage & { title: string },
  ) {
    if (forum.type !== ChannelType.GuildForum)
      throw new Error(`discordjs-test-kit: ${forum.id} isn't a forum`);
    this.requireMembership(user, forum);
    const thread = this.state.createThread({
      parentId: forum.id,
      name: post.title,
      ownerId: user.id,
    });
    // docs.discord.food/gateway/gateway-events#thread-create: newly_created on creation.
    this.gateway.dispatch(
      GatewayDispatchEvents.ThreadCreate,
      { ...thread, newly_created: true },
      GatewayIntentBits.Guilds,
    );
    const message = this.userSendsMessage(user, thread, post, thread.id);
    return { thread, message };
  }

  /** `name` is the command as a user types it: "ladder", or "admin-config set" for a subcommand. */
  private userRunsCommand(
    user: APIUser,
    channel: APIChannel,
    name: string,
    input: Record<string, unknown>,
    focused?: string,
  ) {
    const [commandName, ...path] = name.split(" ");
    const guildId = "guild_id" in channel ? channel.guild_id : undefined;
    const command = this.state.findCommand(guildId, commandName!);
    if (!command) {
      const registered = this.state
        .commandsVisibleIn(guildId)
        .map((c) => `/${c.name}`);
      throw new Error(
        `discordjs-test-kit: /${commandName} isn't registered. ${registered.length ? `Registered: ${registered.join(", ")}` : "The bot registered no commands (it never PUT any to /applications/.../commands)"}`,
      );
    }
    const guild = guildId ? this.state.requireGuild(guildId) : undefined;
    this.requireCommandAllowed(
      user,
      channel,
      guild,
      command,
      `/${commandName}`,
    );
    const { options, leaf } = commandOptions(
      command.options ?? [],
      path,
      input,
      name,
      focused,
    );
    return this.dispatchInteraction(
      user,
      channel,
      focused === undefined
        ? InteractionType.ApplicationCommand
        : InteractionType.ApplicationCommandAutocomplete,
      {
        id: command.id,
        name: command.name,
        type: command.type,
        options,
        resolved: resolvedFor(this.state, leaf, input, guild, user.id),
      },
    );
  }

  // Discord's docs, interactions/application-commands#permissions: default_member_permissions
  // is what a member needs to use the command; "0" leaves only admins. Discord hides it from
  // everyone else, so they can't run it at all.
  private requireCommandAllowed(
    user: APIUser,
    channel: APIChannel,
    guild: GuildRecord | undefined,
    command: APIApplicationCommand,
    shownName: string,
  ) {
    if (!guild || command.default_member_permissions == null) return;
    const needed = BigInt(command.default_member_permissions);
    const has = computePermissions(this.state, guild, user.id, channel);
    const allowed =
      has === ALL_PERMISSIONS || (needed !== 0n && (has & needed) === needed);
    if (!allowed)
      throw new Error(
        `discordjs-test-kit: ${user.username} can't use ${shownName}: it needs permissions ${needed}`,
      );
  }

  // Discord's docs, interactions/application-commands#user-commands and #message-commands: a
  // context-menu command is picked from the Apps menu of a user or a message. Its name keeps its
  // case and spaces. The interaction carries target_id and `resolved` with the target: the user
  // plus, in a guild, their partial member (no user, deaf or mute), or the full message.
  // discord.js reads resolved.users / resolved.messages without a guard
  // (ContextMenuCommandInteraction.resolveContextMenuOptions), so `resolved` is always sent.
  private userRunsContextMenu(
    user: APIUser,
    channel: APIChannel,
    target: APIUser | APIMessage,
    name: string,
  ) {
    const isMessage = "channel_id" in target;
    const type = isMessage
      ? ApplicationCommandType.Message
      : ApplicationCommandType.User;
    const guildId = "guild_id" in channel ? channel.guild_id : undefined;
    const command = this.state.findCommand(guildId, name, type);
    if (!command) {
      const kind = isMessage ? "message" : "user";
      const registered = this.state
        .commandsVisibleIn(guildId, type)
        .map((c) => `"${c.name}"`);
      throw new Error(
        `discordjs-test-kit: the ${kind} app "${name}" isn't registered. ${registered.length ? `Registered ${kind} apps: ${registered.join(", ")}` : `The bot registered no ${kind} apps (commands of type ${type})`}`,
      );
    }
    const guild = guildId ? this.state.requireGuild(guildId) : undefined;
    this.requireCommandAllowed(user, channel, guild, command, `"${name}"`);
    let resolved: Record<string, unknown>;
    if (isMessage) {
      if (target.channel_id !== channel.id)
        throw new Error(
          `discordjs-test-kit: ${shown(target)} isn't in #${(channel as { name?: string }).name ?? channel.id}`,
        );
      this.requireVisibleTo(user, target);
      resolved = { messages: { [target.id]: target } };
    } else {
      // "A user must have permission to send text messages in the channel they invoke a user
      // command in" (Discord's docs, #user-commands); Discord shows them "Permission Denied".
      if (
        guild &&
        (computePermissions(this.state, guild, user.id, channel) &
          Permission.SendMessages) ===
          0n
      )
        throw new Error(
          `discordjs-test-kit: ${user.username} can't use "${name}" in #${(channel as { name?: string }).name}: they can't send messages there, so Discord answers "Permission Denied"`,
        );
      const member = guild?.members.get(target.id);
      const { user: _, deaf: _d, mute: _m, ...partial } = member ?? {};
      resolved = {
        users: { [target.id]: target },
        ...(member ? { members: { [target.id]: partial } } : {}),
      };
    }
    return this.dispatchInteraction(
      user,
      channel,
      InteractionType.ApplicationCommand,
      {
        id: command.id,
        name: command.name,
        type,
        target_id: target.id,
        resolved,
      },
    );
  }

  // Discord's docs, resources/message#message-object-message-flags: an EPHEMERAL message "is only
  // visible to the user who invoked the Interaction", so nobody else can use its components.
  private requireVisibleTo(user: APIUser, message: APIMessage) {
    if (
      (message.flags ?? 0) & MessageFlags.Ephemeral &&
      message.interaction_metadata?.user.id !== user.id
    )
      throw new Error(
        `discordjs-test-kit: ${user.username} can't see ${shown(message)}: it's ephemeral, only ${message.interaction_metadata?.user.username} can`,
      );
  }

  // A user finds a button by what it shows: its label, or its emoji when it has none. A link
  // button has no custom_id (docs.discord.food/resources/components#button-object): it opens a
  // URL in the client and sends the bot nothing.
  private userClicksButton(
    user: APIUser,
    message: APIMessage,
    label: string | RegExp,
  ) {
    this.requireVisibleTo(user, message);
    const buttons = componentsIn(message).filter(
      (c: any) => c.type === ComponentType.Button,
    );
    const found = buttons.filter((b: any) => matches(buttonLabel(b), label));
    if (found.length !== 1)
      throw new Error(
        found.length
          ? `discordjs-test-kit: ${quote(label)} matches ${found.length} buttons on ${shown(message)}: ${found.map(buttonLabel).join(", ")}`
          : `discordjs-test-kit: ${user.username} can't click ${quote(label)}: ${shown(message)} has ${buttons.length ? `buttons ${buttons.map(buttonLabel).join(", ")}` : "no buttons"}`,
      );
    const button = found[0]!;
    if (button.disabled)
      throw new Error(
        `discordjs-test-kit: button ${buttonLabel(button)} on ${shown(message)} is disabled`,
      );
    // docs.discord.food/resources/components#button-object: a link button (style 5) opens its
    // URL and a premium button (style 6) opens a purchase; neither sends the bot an interaction.
    if (button.custom_id === undefined)
      throw new Error(
        `discordjs-test-kit: button ${buttonLabel(button)} ${button.style === 6 ? "opens a purchase" : "opens a URL"}; the bot gets no interaction`,
      );
    const channel = this.state.requireChannel(message.channel_id);
    return this.dispatchInteraction(
      user,
      channel,
      InteractionType.MessageComponent,
      { custom_id: button.custom_id, component_type: ComponentType.Button },
      message,
    );
  }

  // docs.discord.food/resources/components: a string select offers `options`; the user picks
  // between min_values and max_values (default 1) of them. Picking one option by its label is
  // what a user does; multi-select is not modelled yet.
  // docs.discord.food/interactions/receiving-and-responding: the bot receives custom_id,
  // component_type and `values` (the picked options' values).
  private userSelectsOption(
    user: APIUser,
    message: APIMessage,
    labels: string | RegExp | (string | RegExp)[],
  ) {
    this.requireVisibleTo(user, message);
    const offered = componentsIn(message)
      .filter((c: any) => c.type === ComponentType.StringSelect)
      .flatMap((select: any) =>
        (select.options ?? []).map((option: any) => ({ select, option })),
      );
    const picks = (Array.isArray(labels) ? labels : [labels]).map((label) => {
      const found = offered.filter(({ option }) =>
        matches(option.label, label),
      );
      if (found.length !== 1)
        throw new Error(
          found.length
            ? `discordjs-test-kit: ${quote(label)} matches ${found.length} options in ${shown(message)}: ${found.map(({ option }) => option.label).join(", ")}`
            : `discordjs-test-kit: ${user.username} can't pick ${quote(label)}: ${shown(message)} ${offered.length ? `offers ${offered.map(({ option }) => option.label).join(", ")}` : "has no select menu"}`,
        );
      return found[0]!;
    });
    const select = picks[0]!.select;
    if (picks.some((pick) => pick.select !== select))
      throw new Error(
        `discordjs-test-kit: the options picked on ${shown(message)} are in different select menus`,
      );
    if (select.disabled)
      throw new Error(
        `discordjs-test-kit: the select menu on ${shown(message)} is disabled`,
      );
    // components/reference#string-select: min_values defaults to 1, max_values to 1 (max 25). The
    // Discord app won't send fewer or more.
    const min = select.min_values ?? 1;
    const max = select.max_values ?? 1;
    if (picks.length < min || picks.length > max)
      throw new Error(
        `discordjs-test-kit: the select menu on ${shown(message)} takes ${min === max ? min : `${min} to ${max}`} picks, not ${picks.length}`,
      );
    const channel = this.state.requireChannel(message.channel_id);
    return this.dispatchInteraction(
      user,
      channel,
      InteractionType.MessageComponent,
      {
        custom_id: select.custom_id,
        component_type: ComponentType.StringSelect,
        values: picks.map(({ option }) => option.value),
      },
      message,
    );
  }

  // docs.discord.food/interactions/receiving-and-responding#modal-submit-component-data-structure:
  // the bot gets MODAL_SUBMIT (type 5) with the modal's custom_id and its components echoed back,
  // each text input carrying `value`; `message` only when a component opened the modal.
  // components/reference#text-input: `required` defaults to true, and min_length/max_length bound
  // what the Discord app lets the user submit.
  private userSubmitsForm(
    user: APIUser,
    run: InteractionRun,
    values: Record<string, string>,
  ) {
    const modal = run.modal;
    if (!modal || run.userId !== user.id)
      throw new Error(
        `discordjs-test-kit: the bot didn't open a form for ${user.username}`,
      );
    const fields = modalFields(modal);
    const unknown = Object.keys(values).filter(
      (label) => !fields.some((f) => f.label === label),
    );
    if (unknown.length)
      throw new Error(
        `discordjs-test-kit: the form ${describeModal(modal)} has no field ${unknown.map((l) => `"${l}"`).join(", ")}`,
      );
    for (const { label, input } of fields) {
      const value = values[label] ?? "";
      if (input.type !== ComponentType.TextInput)
        throw new Error(
          `discordjs-test-kit: field "${label}" is a component of type ${input.type}; only text inputs are modelled in forms`,
        );
      const at = `field "${label}" of ${describeModal(modal)}`;
      if ((input.required ?? true) && value === "")
        throw new Error(
          `discordjs-test-kit: ${at} is required, so the Discord app won't submit the form without it`,
        );
      if (value !== "" && value.length < (input.min_length ?? 0))
        throw new Error(
          `discordjs-test-kit: ${at} needs at least ${input.min_length} characters`,
        );
      if (value.length > (input.max_length ?? 4000))
        throw new Error(
          `discordjs-test-kit: ${at} takes at most ${input.max_length ?? 4000} characters`,
        );
    }
    // Discord numbers components it wasn't given an id for; the order here is inferred, not checked.
    let nextId = 1;
    const id = (c: any) => c.id ?? nextId++;
    const input = (c: any, label: string) => ({
      type: c.type,
      id: id(c),
      custom_id: c.custom_id,
      value: values[label] ?? "",
    });
    const submitted = (modal.components as any[]).map((top) => {
      if (top.type === ComponentType.ActionRow)
        return {
          type: top.type,
          id: id(top),
          components: top.components.map((c: any) => input(c, c.label)),
        };
      if (top.type === ComponentType.Label)
        return {
          type: top.type,
          id: id(top),
          component: input(top.component, top.label),
        };
      return { type: top.type, id: id(top) };
    });
    run.modal = undefined;
    const source = run.sourceMessageId
      ? this.state.requireMessage(run.channelId, run.sourceMessageId)
      : undefined;
    return this.dispatchInteraction(
      user,
      this.state.requireChannel(run.channelId),
      InteractionType.ModalSubmit,
      { custom_id: modal.custom_id, components: submitted },
      source,
    );
  }

  /**
   * `channel`'s server and `user`'s member record in it, or undefined in a DM. A non-member can't see a
   * server's channels at all (Discord answers 50001 Missing Access), so the World refuses the
   * action rather than let a test act as someone the bot would never hear from.
   */
  private requireMembership(user: APIUser, channel: APIChannel) {
    if (!("guild_id" in channel) || !channel.guild_id) return undefined;
    const guild = this.state.requireGuild(channel.guild_id);
    const member = guild.members.get(user.id);
    if (!member)
      throw new Error(
        `discordjs-test-kit: ${user.username} isn't a member of ${guild.name}`,
      );
    // topics/threads: a private thread is visible only to its members and to MANAGE_THREADS.
    if (
      channel.type === ChannelType.PrivateThread &&
      !this.state.threadMember(channel.id, user.id) &&
      !(
        computePermissions(this.state, guild, user.id, channel) &
        Permission.ManageThreads
      )
    )
      throw new Error(
        `discordjs-test-kit: ${user.username} isn't in the private thread "${(channel as { name?: string }).name}"; the bot adds them with thread.members.add`,
      );
    return { guild, member };
  }

  private dispatchInteraction(
    user: APIUser,
    channel: APIChannel,
    type: InteractionType,
    data: unknown,
    message?: APIMessage,
  ) {
    const { guild, member } = this.requireMembership(user, channel) ?? {};
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
    // docs.discord.food/resources/application, Get Current Application: "Returns the application
    // object associated with the requestor." Fields per the Application Structure table; the owner
    // and verify_key values are placeholders (the World has no developer account).
    rest.route(
      "GET",
      "/applications/@me",
      authed(() =>
        respond.json({
          id: state.applicationId,
          name: state.bot.username,
          icon: null,
          description: "",
          bot_public: true,
          bot_require_code_grant: false,
          owner: {
            id: this.developerId,
            username: "developer",
            discriminator: "0",
            avatar: null,
          },
          team: null,
          flags: 0,
          verify_key: "0".repeat(64),
        }),
      ),
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
    const scopeOf = (p: Record<string, string>) => p.guildId ?? "global";
    for (const base of [
      "/applications/:appId/commands",
      "/applications/:appId/guilds/:guildId/commands",
    ]) {
      rest.route(
        "GET",
        base,
        authed((req) =>
          respond.json([
            ...(state.commands.get(scopeOf(req.params))?.values() ?? []),
          ]),
        ),
      );
      // interactions/application-commands#create-global-application-command: an upsert, 201 for
      // a new name, 200 for one that exists.
      rest.route(
        "POST",
        base,
        authed((req) => {
          if (req.params.appId !== state.applicationId)
            return respond.error(403, 50001, "Missing Access");
          const body = req.body as RESTPostAPIApplicationCommandsJSONBody;
          if (
            (body.type ?? 1) === 1 &&
            !("description" in body && body.description)
          )
            return respond.invalidFormBody();
          const { command, created } = state.upsertCommand(
            scopeOf(req.params),
            body,
          );
          return respond.json(command, created ? 201 : 200);
        }),
      );
      rest.route(
        "GET",
        `${base}/:commandId`,
        authed((req) => {
          const command = state.commandById(
            scopeOf(req.params),
            req.params.commandId!,
          );
          return command ? respond.json(command) : unknownCommand();
        }),
      );
      // #edit-global-application-command: 200 with the command. Renaming onto a name the scope
      // already uses has an error code (40041) but no documented trigger: a Gap until checked.
      rest.route(
        "PATCH",
        `${base}/:commandId`,
        authed((req) => {
          const scope = scopeOf(req.params);
          const previous = state.commandById(scope, req.params.commandId!);
          if (!previous) return unknownCommand();
          const patch = {
            type: previous.type,
            name: previous.name,
            ...req.body,
          };
          if (state.commandNamed(scope, patch, previous.id))
            return rest.gap("rename a command onto an existing name");
          return respond.json(state.editCommand(scope, previous.id, req.body)!);
        }),
      );
      // #delete-global-application-command: "Returns 204 No Content".
      rest.route(
        "DELETE",
        `${base}/:commandId`,
        authed((req) =>
          state.deleteCommand(scopeOf(req.params), req.params.commandId!)
            ? respond.noContent()
            : unknownCommand(),
        ),
      );
    }

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
            `discordjs-test-kit: channel type ${req.body?.type} not implemented`,
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

    // resources/channel#delete-channel-permission: needs MANAGE_ROLES, "Returns a 204 empty response
    // on success. Fires a Channel Update Gateway event." 10009 for an overwrite that isn't there is
    // inferred from the code table.
    rest.route(
      "DELETE",
      "/channels/:channelId/permissions/:overwriteId",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        const denied = this.checkBotPerms(channel, Permission.ManageRoles);
        if (denied) return denied;
        const overwrites =
          "permission_overwrites" in channel
            ? channel.permission_overwrites
            : undefined;
        const i =
          overwrites?.findIndex((o) => o.id === req.params.overwriteId) ?? -1;
        if (i === -1) return respond.error(404, 10009, "Unknown Overwrite");
        overwrites!.splice(i, 1);
        this.gateway.dispatch(
          GatewayDispatchEvents.ChannelUpdate,
          channel,
          GatewayIntentBits.Guilds,
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
        const replyTo: string | undefined =
          req.body?.message_reference?.message_id;
        // docs.discord.food/resources/message#create-message: a reply also needs READ_MESSAGE_HISTORY.
        const denied = this.checkBotPerms(
          channel,
          Permission.SendMessages |
            (replyTo ? Permission.ReadMessageHistory : 0n),
        );
        if (denied) return denied;
        if (replyTo && !this.messagesIn(channel).some((m) => m.id === replyTo))
          return rest.gap(`reply to unknown message ${replyTo}`);
        const overLimit = messageLimitError(req.body);
        if (overLimit) return overLimit;
        // A user who turned off DMs from server members can't be messaged: 50007 "Cannot send
        // messages to this user" (Discord's code table). The 403 status is inferred, not checked.
        if (
          channel.type === ChannelType.DM &&
          channel.recipients?.some((u) => state.closedDms.has(u.id))
        )
          return respond.error(403, 50007, "Cannot send messages to this user");
        // topics/threads: "Sending a message will automatically unarchive the thread, unless the
        // thread has been locked by a moderator"; a locked one only unarchives with MANAGE_THREADS.
        // The 50083 for a locked one is inferred, not checked.
        const meta =
          "thread_metadata" in channel ? channel.thread_metadata : undefined;
        if (meta?.archived) {
          if (
            meta.locked &&
            this.checkBotPerms(channel, Permission.ManageThreads)
          )
            return respond.error(400, 50083, "Thread is archived");
          meta.archived = false;
          meta.archive_timestamp = new Date().toISOString();
          this.gateway.dispatch(
            GatewayDispatchEvents.ThreadUpdate,
            channel,
            GatewayIntentBits.Guilds,
          );
        }
        const message = state.createMessage({
          channelId: channel.id,
          authorId: state.bot.id,
          content: req.body?.content,
          embeds: req.body?.embeds,
          components: req.body?.components,
          flags: req.body?.flags,
          replyTo,
          pingReplied: req.body?.allowed_mentions?.replied_user ?? true,
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
        const overLimit = messageLimitError(req.body);
        if (overLimit) return overLimit;
        const updated = state.updateMessage(
          message.channel_id,
          message.id,
          pickMessageFields(req.body),
        );
        this.gateway.dispatchMessage("MESSAGE_UPDATE", updated);
        return respond.json(updated);
      }),
    );

    // Discord's docs, resources/message#delete-message: another user's message in a guild
    // channel needs MANAGE_MESSAGES. 204, fires MESSAGE_DELETE { id, channel_id, guild_id? }.
    rest.route(
      "DELETE",
      "/channels/:channelId/messages/:messageId",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        const message = this.messagesIn(channel).find(
          (m) => m.id === req.params.messageId,
        );
        if (!message) return respond.unknownMessage();
        if (message.author.id !== state.bot.id) {
          const denied = this.checkBotPerms(channel, Permission.ManageMessages);
          if (denied) return denied;
        }
        state.deleteMessage(channel.id, message.id);
        const guildId =
          "guild_id" in channel && channel.guild_id
            ? channel.guild_id
            : undefined;
        this.gateway.dispatch(
          GatewayDispatchEvents.MessageDelete,
          {
            id: message.id,
            channel_id: channel.id,
            ...(guildId ? { guild_id: guildId } : {}),
          },
          guildId
            ? GatewayIntentBits.GuildMessages
            : GatewayIntentBits.DirectMessages,
        );
        return respond.noContent();
      }),
    );

    // docs.discord.food/resources/message#get-message: READ_MESSAGE_HISTORY in guild channels.
    rest.route(
      "GET",
      "/channels/:channelId/messages/:messageId",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        const denied = this.checkBotPerms(
          channel,
          Permission.ReadMessageHistory,
        );
        if (denied) return denied;
        const message = this.messagesIn(channel).find(
          (m) => m.id === req.params.messageId,
        );
        return message ? respond.json(message) : respond.unknownMessage();
      }),
    );

    // docs.discord.food/resources/message#create-reaction: READ_MESSAGE_HISTORY, plus
    // ADD_REACTIONS when nobody has reacted with this emoji yet. 204, fires MESSAGE_REACTION_ADD.
    rest.route(
      "PUT",
      "/channels/:channelId/messages/:messageId/reactions/:emoji/@me",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        const message = this.messagesIn(channel).find(
          (m) => m.id === req.params.messageId,
        );
        if (!message) return respond.unknownMessage();
        const emoji = req.params.emoji!;
        const first = !message.reactions?.some((r) => r.emoji.name === emoji);
        const denied = this.checkBotPerms(
          channel,
          Permission.ReadMessageHistory |
            (first ? Permission.AddReactions : 0n),
        );
        if (denied) return denied;
        this.userReacts(state.bot, message, emoji);
        return respond.noContent();
      }),
    );

    // docs.discord.food/resources/message#delete-own-reaction: 204, fires MESSAGE_REACTION_REMOVE.
    rest.route(
      "DELETE",
      "/channels/:channelId/messages/:messageId/reactions/:emoji/@me",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        const message = this.messagesIn(channel).find(
          (m) => m.id === req.params.messageId,
        );
        if (!message) return respond.unknownMessage();
        const emoji = req.params.emoji!;
        if (state.removeReaction(channel.id, message.id, emoji, state.bot.id)) {
          const guildId = "guild_id" in channel ? channel.guild_id : undefined;
          this.gateway.dispatch(
            GatewayDispatchEvents.MessageReactionRemove,
            {
              user_id: state.bot.id,
              channel_id: channel.id,
              message_id: message.id,
              ...(guildId ? { guild_id: guildId } : {}),
              emoji: { id: null, name: emoji },
              type: 0,
              burst: false,
            },
            guildId
              ? GatewayIntentBits.GuildMessageReactions
              : GatewayIntentBits.DirectMessageReactions,
          );
        }
        return respond.noContent();
      }),
    );

    // docs.discord.food/resources/channel#list-guild-active-threads. Thread members aren't modelled.
    rest.route(
      "GET",
      "/guilds/:guildId/threads/active",
      authed((req) => {
        if (!state.guilds.has(req.params.guildId!))
          return respond.error(404, 10004, "Unknown Guild");
        const threads = [...state.channels.values()]
          .filter(
            (c) =>
              "thread_metadata" in c &&
              c.guild_id === req.params.guildId &&
              !c.thread_metadata?.archived,
          )
          .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
        return respond.json({ threads, members: [] });
      }),
    );

    // docs.discord.food/resources/channel#list-public-archived-threads: READ_MESSAGE_HISTORY,
    // newest archive_timestamp first, `before` an ISO timestamp, `limit` 2-100 (default 50).
    rest.route(
      "GET",
      "/channels/:channelId/threads/archived/public",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        const denied = this.checkBotPerms(
          channel,
          Permission.ReadMessageHistory,
        );
        if (denied) return denied;
        const before = req.query.get("before");
        const limit = Number(req.query.get("limit") ?? 50);
        const archived = [...state.channels.values()]
          .filter(
            (c) =>
              "thread_metadata" in c &&
              c.parent_id === channel.id &&
              !!c.thread_metadata?.archived &&
              (!before ||
                c.thread_metadata.archive_timestamp <
                  new Date(before).toISOString()),
          )
          .sort((a, b) =>
            (
              b as { thread_metadata: { archive_timestamp: string } }
            ).thread_metadata.archive_timestamp.localeCompare(
              (a as { thread_metadata: { archive_timestamp: string } })
                .thread_metadata.archive_timestamp,
            ),
          );
        return respond.json({
          threads: archived.slice(0, limit),
          members: [],
          has_more: archived.length > limit,
        });
      }),
    );

    // docs.discord.food/resources/user#get-user. 10013 Unknown User is from Discord's code table.
    rest.route(
      "GET",
      "/users/:userId",
      authed((req) => {
        const user = state.users.get(req.params.userId!);
        return user
          ? respond.json(user)
          : respond.error(404, 10013, "Unknown User");
      }),
    );

    // docs.discord.food/resources/channel#create-private-channel: one recipient returns the DM.
    rest.route(
      "POST",
      "/users/@me/channels",
      authed((req) => {
        const user = state.users.get(req.body?.recipient_id);
        if (!user) return respond.error(404, 10013, "Unknown User");
        return respond.json(state.dmChannel(user.id));
      }),
    );

    // The CDN: attachment bytes, unauthenticated like cdn.discordapp.com.
    rest.route("GET", "/attachments/:channelId/:attachmentId/:name", (req) => {
      const file = state.files.get(req.params.attachmentId!);
      return file
        ? { status: 200, file }
        : respond.error(404, 0, "404: Not Found");
    });

    // ---- interactions ----
    rest.route("POST", "/interactions/:id/:token/callback", (req) => {
      const run = this.interactions.get(req.params.id!);
      if (!run || run.token !== req.params.token)
        return respond.unknownInteraction();
      if (run.state !== "pending") return respond.alreadyAcknowledged();
      if (Date.now() - run.createdAt > this.interactionDeadlineMs)
        return respond.unknownInteraction();

      const { type, data } = req.body as {
        type: InteractionResponseType;
        data?: any;
      };
      // receiving-and-responding#interaction-callback-type: AUTOCOMPLETE_RESULT (8) answers an
      // autocomplete, and an autocomplete takes nothing else. Discord's answer otherwise is unchecked.
      const isAutocomplete =
        run.type === InteractionType.ApplicationCommandAutocomplete;
      if (
        isAutocomplete !==
        (type === InteractionResponseType.ApplicationCommandAutocompleteResult)
      )
        return rest.gap(`callback type ${type} on a ${run.type} interaction`);
      const overLimit =
        type === InteractionResponseType.Modal
          ? modalLimitError(data)
          : isAutocomplete
            ? choicesLimitError(data)
            : messageLimitError(data);
      if (overLimit) return overLimit;
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
        // docs.discord.food/interactions/receiving-and-responding: MODAL (9) is allowed by
        // APPLICATION_COMMAND and MESSAGE_COMPONENT only. What Discord answers otherwise is unchecked.
        case InteractionResponseType.ApplicationCommandAutocompleteResult:
          run.choices = data?.choices ?? [];
          run.state = "replied";
          break;
        case InteractionResponseType.Modal:
          if (
            run.type !== InteractionType.ApplicationCommand &&
            run.type !== InteractionType.MessageComponent
          )
            return rest.gap(`callback type 9 on a ${run.type} interaction`);
          run.modal = data as Modal;
          run.state = "modal";
          break;
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
      const overLimit = messageLimitError(req.body);
      if (overLimit) return overLimit;
      const original = run.original;
      if (!original) return respond.unknownMessage();
      const updated = state.updateMessage(run.channelId, original.id, {
        ...pickMessageFields(req.body),
        flags: (original.flags ?? 0) & ~MessageFlags.Loading,
      });
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
      const overLimit = messageLimitError(req.body);
      if (overLimit) return overLimit;
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
      this.gateway.dispatchMessage("MESSAGE_CREATE", message);
      run.emit("change");
      return respond.json(message);
    });
    registerMemberRoutes(this, authed);
    registerThreadRoutes(this, authed);
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

// 10063 is in Discord's code table; pairing it with an unknown command id is inferred, not checked.
const unknownCommand = () =>
  respond.error(404, 10063, "Unknown application command");

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
  [ApplicationCommandOptionType.Channel]: (v) => typeof v === "string",
};

const SUBCOMMAND_TYPES: ApplicationCommandOptionType[] = [
  ApplicationCommandOptionType.Subcommand,
  ApplicationCommandOptionType.SubcommandGroup,
];

/**
 * Walk `path` (subcommand group, subcommand) down the registered schema, and nest the typed
 * options under it the way Discord sends them. Returns the leaf schema for `resolved`.
 */
function commandOptions(
  schema: APIApplicationCommandOption[],
  path: string[],
  input: Record<string, unknown>,
  command: string,
  focused?: string,
): { options: unknown[]; leaf: APIApplicationCommandOption[] } {
  const subcommands = schema.filter((o) => SUBCOMMAND_TYPES.includes(o.type));
  if (!path.length) {
    if (subcommands.length)
      throw new Error(
        `discordjs-test-kit: /${command} needs a subcommand: ${subcommands.map((o) => o.name).join(", ")}`,
      );
    return {
      options: buildOptions(schema, input, command, focused),
      leaf: schema,
    };
  }
  const [next, ...rest] = path;
  const sub = subcommands.find((o) => o.name === next);
  if (!sub)
    throw new Error(
      `discordjs-test-kit: /${command} has no subcommand "${next}". It has: ${subcommands.map((o) => o.name).join(", ")}`,
    );
  const nested = commandOptions(
    ("options" in sub ? sub.options : undefined) ?? [],
    rest,
    input,
    command,
    focused,
  );
  return {
    options: [{ name: sub.name, type: sub.type, options: nested.options }],
    leaf: nested.leaf,
  };
}

/**
 * Turn `{ text: "hi" }` into Discord's typed option list, validated against what the bot registered.
 * With `focused`, it's an autocomplete: interactions/application-commands#autocomplete says the
 * focused option carries `focused: true` and may be partial, and required options "might not be
 * present". The option must have `autocomplete` set, or the Discord app never asks the bot.
 */
function buildOptions(
  schema: APIApplicationCommandOption[],
  input: Record<string, unknown>,
  command: string,
  focused?: string,
) {
  if (focused !== undefined) {
    const option = schema.find((o) => o.name === focused);
    if (!option || !("autocomplete" in option && option.autocomplete))
      throw new Error(
        `discordjs-test-kit: /${command} option "${focused}" ${option ? "doesn't have autocomplete" : "doesn't exist"}, so the Discord app doesn't ask the bot for suggestions`,
      );
  }
  for (const key of Object.keys(input)) {
    if (!schema.some((o) => o.name === key))
      throw new Error(
        `discordjs-test-kit: /${command} has no option "${key}". ${schema.length ? `It has: ${schema.map((o) => o.name).join(", ")}` : "It takes no options"}`,
      );
  }
  return schema.flatMap((opt) => {
    const value = input[opt.name];
    if (value === undefined) {
      if ("required" in opt && opt.required && focused === undefined)
        throw new Error(
          `discordjs-test-kit: /${command} requires option "${opt.name}"`,
        );
      return [];
    }
    const check = OPTION_CHECKS[opt.type];
    if (!check)
      throw new Error(
        `discordjs-test-kit: option type ${opt.type} not supported yet`,
      );
    if (!check(value))
      throw new Error(
        `discordjs-test-kit: /${command} option "${opt.name}" has the wrong type`,
      );
    const choices = "choices" in opt ? opt.choices : undefined;
    if (choices?.length && !choices.some((c) => c.value === value)) {
      throw new Error(
        `discordjs-test-kit: /${command} option "${opt.name}" must be one of: ${choices.map((c) => c.name).join(", ")}`,
      );
    }
    // discord-api-docs interactions/application-commands, option structure: min/max_value and
    // min/max_length bound what a user can submit. The Discord app enforces them before sending
    // ("client-side only"), so the Actor refuses what the app would.
    const bound = (key: string) =>
      key in opt
        ? (opt as unknown as Record<string, number | undefined>)[key]
        : undefined;
    const tooSmall = bound("min_value"),
      tooBig = bound("max_value");
    if (typeof value === "number") {
      if (tooSmall !== undefined && value < tooSmall)
        throw new Error(
          `discordjs-test-kit: /${command} option "${opt.name}" must be at least ${tooSmall}`,
        );
      if (tooBig !== undefined && value > tooBig)
        throw new Error(
          `discordjs-test-kit: /${command} option "${opt.name}" must be at most ${tooBig}`,
        );
    }
    const minLength = bound("min_length"),
      maxLength = bound("max_length");
    if (typeof value === "string") {
      if (
        minLength !== undefined &&
        value.length < minLength &&
        opt.name !== focused
      )
        throw new Error(
          `discordjs-test-kit: /${command} option "${opt.name}" must be at least ${minLength} characters`,
        );
      if (maxLength !== undefined && value.length > maxLength)
        throw new Error(
          `discordjs-test-kit: /${command} option "${opt.name}" must be at most ${maxLength} characters`,
        );
    }
    return [
      {
        name: opt.name,
        type: opt.type,
        value,
        ...(opt.name === focused ? { focused: true } : {}),
      },
    ];
  });
}

/** docs.discord.food/interactions/receiving-and-responding#resolved-data-object */
function resolvedFor(
  state: DiscordState,
  schema: APIApplicationCommandOption[],
  input: Record<string, unknown>,
  guild: GuildRecord | undefined,
  invokerId: string,
) {
  const idsOf = (type: ApplicationCommandOptionType) =>
    schema
      .filter((o) => o.type === type && typeof input[o.name] === "string")
      .map((o) => input[o.name] as string);
  const users = idsOf(ApplicationCommandOptionType.User).map((id) =>
    state.requireUser(id),
  );
  // Resolved members carry no user, deaf or mute; the user is in `users`.
  const members = users.flatMap((u) => {
    const m = guild?.members.get(u.id);
    if (!m) return [];
    const { user: _, deaf: _d, mute: _m, ...partial } = m;
    return [[u.id, partial] as const];
  });
  // Discord's docs: a resolved channel is partial (id, name, type, permissions, parent_id, …);
  // `permissions` are the invoker's in that channel. The option's channel_types limit what the
  // user can pick.
  const channelOptions = schema.filter(
    (o) =>
      o.type === ApplicationCommandOptionType.Channel &&
      typeof input[o.name] === "string",
  );
  const channels = channelOptions.map((o) => {
    const channel = state.requireChannel(input[o.name] as string);
    const allowed = "channel_types" in o ? o.channel_types : undefined;
    if (allowed?.length && !allowed.includes(channel.type as never))
      throw new Error(
        `discordjs-test-kit: option "${o.name}" only offers channel types ${allowed.join(", ")}`,
      );
    const c = channel as APIChannel & Record<string, unknown>;
    return [
      channel.id,
      {
        id: c.id,
        name: c.name,
        type: c.type,
        parent_id: c.parent_id ?? null,
        guild_id: c.guild_id,
        flags: c.flags ?? 0,
        ...("position" in c ? { position: c.position } : {}),
        ...("thread_metadata" in c
          ? { thread_metadata: c.thread_metadata }
          : {}),
        permissions: String(
          guild ? computePermissions(state, guild, invokerId, channel) : 0n,
        ),
      },
    ] as const;
  });
  if (!users.length && !channels.length) return undefined;
  return {
    ...(users.length
      ? { users: Object.fromEntries(users.map((u) => [u.id, u])) }
      : {}),
    ...(members.length ? { members: Object.fromEntries(members) } : {}),
    ...(channels.length ? { channels: Object.fromEntries(channels) } : {}),
  };
}

/** The text a user reads in a message: its content, then each embed's text. */
export function readable(message: APIMessage): string {
  return [
    message.content,
    ...(message.embeds ?? []).flatMap((embed) => [
      embed.title,
      embed.description,
      ...(embed.fields ?? []).flatMap((field) => [field.name, field.value]),
      embed.footer?.text,
    ]),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Names a message by the start of what a user reads in it, for error messages. */
export function shown(message: APIMessage): string {
  const text = readable(message).split("\n").find(Boolean);
  if (!text) return "a message with no text";
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 39)}…` : text);
}

/** Every component on `message`, nested ones included (rows, and Components V2 containers and accessories). */
function componentsIn(message: APIMessage): any[] {
  const found: any[] = [];
  const walk = (component: any) => {
    found.push(component);
    for (const child of component.components ?? []) walk(child);
    if (component.accessory) walk(component.accessory);
  };
  for (const component of message.components ?? []) walk(component);
  return found;
}

function buttonLabel(button: any): string {
  return button.label ?? button.emoji?.name ?? "(no label)";
}

/** `text` equals `want` (or contains it, with `partial`), or matches it when it's a RegExp. */
export function matches(
  text: string | undefined,
  want: string | RegExp,
  { partial = false } = {},
) {
  if (text === undefined) return false;
  if (typeof want === "string")
    return partial ? text.includes(want) : text === want;
  want.lastIndex = 0; // a /g RegExp would otherwise resume from its last match
  return want.test(text);
}

export function quote(label: string | RegExp) {
  return typeof label === "string" ? JSON.stringify(label) : String(label);
}

/** The modal a bot opens with callback type 9: docs.discord.food/interactions/receiving-and-responding#modal. */
export interface Modal {
  custom_id: string;
  title: string;
  components: unknown[];
}

/**
 * A modal's fields as the user sees them: each Label's input (components/reference#label), or a
 * text input in a deprecated action row, labelled by its own `label`.
 */
function modalFields(modal: Modal): { label: string; input: any }[] {
  return (modal.components as any[]).flatMap((top) => {
    if (top.type === ComponentType.Label)
      return [{ label: top.label as string, input: top.component }];
    if (top.type === ComponentType.ActionRow)
      return (top.components as any[]).map((input) => ({
        label: input.label as string,
        input,
      }));
    return [];
  });
}

function describeModal(modal: Modal): string {
  const labels = modalFields(modal).map((f) => `"${f.label}"`);
  return `"${modal.title}" (fields ${labels.join(", ") || "none"})`;
}
