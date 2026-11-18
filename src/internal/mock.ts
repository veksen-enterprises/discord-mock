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
  ALL_PERMISSIONS,
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

  /** The visible reply: waits through a defer until the bot edits in real content. */
  async reply(timeoutMs?: number): Promise<APIMessage> {
    // Discord gives the bot the whole deadline to acknowledge, so a shorter wait would fail a bot
    // that works on Discord. The margin covers the callback request landing just inside it.
    const deadlineMs = this.mock.interactionDeadlineMs;
    await this.waitUntil((r) => r.state !== "pending", deadlineMs + 250).catch(
      () => {
        throw new Error(
          `discordjs-test-kit: the bot didn't answer within ${deadlineMs / 1000}s, so Discord shows the user "The application did not respond"`,
        );
      },
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
    return new Promise((resolve, reject) => {
      const onMessage = (m: APIMessage) => {
        if (!predicate(m)) return;
        cleanup();
        resolve(m);
      };
      const timer = realSetTimeout(() => {
        cleanup();
        reject(
          new Error(
            `discordjs-test-kit: no matching message within ${opts.timeoutMs ?? 2_000}ms`,
          ),
        );
      }, opts.timeoutMs ?? 2_000);
      const cleanup = () => {
        realClearTimeout(timer);
        this.state.off("messageCreate", onMessage);
        this.state.off("messageUpdate", onMessage);
      };
      this.state.on("messageCreate", onMessage);
      this.state.on("messageUpdate", onMessage);
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
      /** Presses the button labelled `label` (or showing that emoji, when it has no label). */
      clickButton: (message: APIMessage, label: string | RegExp) =>
        this.userClicksButton(user, message, label),
      /** Picks the option labelled `label` from the string select on `message` that offers it. */
      selectOption: (message: APIMessage, label: string | RegExp) =>
        this.userSelectsOption(user, message, label),
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
    // Discord's docs, interactions/application-commands#permissions: default_member_permissions
    // is what a member needs to use the command; "0" leaves only admins. Discord hides it from
    // everyone else, so they can't run it at all.
    if (guild && command.default_member_permissions != null) {
      const needed = BigInt(command.default_member_permissions);
      const has = computePermissions(this.state, guild, user.id, channel);
      const allowed =
        has === ALL_PERMISSIONS || (needed !== 0n && (has & needed) === needed);
      if (!allowed)
        throw new Error(
          `discordjs-test-kit: ${user.username} can't use /${commandName}: it needs permissions ${needed}`,
        );
    }
    const { options, leaf } = commandOptions(
      command.options ?? [],
      path,
      input,
      name,
    );
    return this.dispatchInteraction(
      user,
      channel,
      InteractionType.ApplicationCommand,
      {
        id: command.id,
        name: command.name,
        type: command.type,
        options,
        resolved: resolvedFor(this.state, leaf, input, guild, user.id),
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
    label: string | RegExp,
  ) {
    this.requireVisibleTo(user, message);
    const offered = componentsIn(message)
      .filter((c: any) => c.type === ComponentType.StringSelect)
      .flatMap((select: any) =>
        (select.options ?? []).map((option: any) => ({ select, option })),
      );
    const found = offered.filter(({ option }) => matches(option.label, label));
    if (found.length !== 1)
      throw new Error(
        found.length
          ? `discordjs-test-kit: ${quote(label)} matches ${found.length} options in ${shown(message)}: ${found.map(({ option }) => option.label).join(", ")}`
          : `discordjs-test-kit: ${user.username} can't pick ${quote(label)}: ${shown(message)} ${offered.length ? `offers ${offered.map(({ option }) => option.label).join(", ")}` : "has no select menu"}`,
      );
    const { select, option } = found[0]!;
    if (select.disabled)
      throw new Error(
        `discordjs-test-kit: the select menu on ${shown(message)} is disabled`,
      );
    if ((select.min_values ?? 1) > 1)
      throw new Error(
        `discordjs-test-kit: the select menu on ${shown(message)} needs ${select.min_values} picks; multi-select is not modelled`,
      );
    const channel = this.state.requireChannel(message.channel_id);
    return this.dispatchInteraction(
      user,
      channel,
      InteractionType.MessageComponent,
      {
        custom_id: select.custom_id,
        component_type: ComponentType.StringSelect,
        values: [option.value],
      },
      message,
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
): { options: unknown[]; leaf: APIApplicationCommandOption[] } {
  const subcommands = schema.filter((o) => SUBCOMMAND_TYPES.includes(o.type));
  if (!path.length) {
    if (subcommands.length)
      throw new Error(
        `discordjs-test-kit: /${command} needs a subcommand: ${subcommands.map((o) => o.name).join(", ")}`,
      );
    return { options: buildOptions(schema, input, command), leaf: schema };
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
  );
  return {
    options: [{ name: sub.name, type: sub.type, options: nested.options }],
    leaf: nested.leaf,
  };
}

/** Turn `{ text: "hi" }` into Discord's typed option list, validated against what the bot registered. */
function buildOptions(
  schema: APIApplicationCommandOption[],
  input: Record<string, unknown>,
  command: string,
) {
  for (const key of Object.keys(input)) {
    if (!schema.some((o) => o.name === key))
      throw new Error(
        `discordjs-test-kit: /${command} has no option "${key}". ${schema.length ? `It has: ${schema.map((o) => o.name).join(", ")}` : "It takes no options"}`,
      );
  }
  return schema.flatMap((opt) => {
    const value = input[opt.name];
    if (value === undefined) {
      if ("required" in opt && opt.required)
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
    return [{ name: opt.name, type: opt.type, value }];
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
