import { once } from "node:events";
import {
  ApplicationCommandPermissionType,
  type APIMessage,
  type APIUser,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord-api-types/v10";
import type { Client } from "discord.js";
import { onTestFinished } from "vitest";
import { setCommandPermissions } from "./internal/command-permissions.js";
import {
  deleteExpression,
  renameExpression,
  uploadExpression,
} from "./internal/expressions.js";
import { createInvite } from "./internal/invites.js";
import {
  createDiscordMock,
  matches,
  quote,
  readable,
  shown,
  type DiscordMock,
  type InteractionRun,
  type UserMessage,
} from "./internal/mock.js";
import { computePermissions, Permission } from "./internal/payloads.js";
import type { RestResponse } from "./internal/rest.js";
import {
  createScheduledEvent,
  deleteScheduledEvent,
  editScheduledEvent,
} from "./internal/scheduled-events.js";

export { respond } from "./internal/rest.js";
export type { RestResponse } from "./internal/rest.js";
export { Permission };
export type { UserMessage } from "./internal/mock.js";

declare const kind: unique symbol;
declare const inGuild: unique symbol;

/**
 * What every handle carries in its type: what it is, and which guild it belongs to, so a test
 * can't pass one guild's channel to another guild's member.
 */
interface Handle<Kind extends string, G extends string> {
  readonly id: string;
  readonly name: string;
  readonly [kind]: Kind;
  readonly [inGuild]: G;
}

/** A guild (a server). `G` is its name, so handles made in it can't be used in another. */
export type Guild<G extends string = string> = Handle<"guild", G>;
/** A channel category. Pass it as a text channel's category. */
export type Category<G extends string = string> = Handle<"category", G>;
/** A text channel. */
export type TextChannel<G extends string = string> = Handle<"text", G>;
/** A voice channel: members join it with `member.joinVoice`. */
export type VoiceChannel<G extends string = string> = Handle<"voice", G>;
/** A stage channel, made with `discord.stageChannel`. */
export type StageChannel<G extends string = string> = Handle<"stage", G>;
/** A forum: members open posts in it with `member.forumPost`. */
export type Forum<G extends string = string> = Handle<"forum", G>;
/** A thread, such as a forum post. */
export type Thread<G extends string = string> = Handle<"thread", G>;
/** A role. Members pick it in a role select. */
export type Role<G extends string = string> = Handle<"role", G>;
/** A custom emoji, which members upload with `member.addEmoji`. */
export type Emoji<G extends string = string> = Handle<"emoji", G>;
/** A guild sticker, which members upload with `member.addSticker`. */
export type Sticker<G extends string = string> = Handle<"sticker", G>;
/** A scheduled event, which members create with `member.createEvent`. */
export type ScheduledEvent<G extends string = string> = Handle<"event", G>;
/** What a member can pick in a user, role, mentionable or channel select. */
export type Pickable<G extends string = string> =
  | Member<G>
  | Role<G>
  | Category<G>
  | TextChannel<G>
  | VoiceChannel<G>
  | Forum<G>
  | Thread<G>;
/** A message as Discord stores it. The object is live: edits, reactions and updates show up on it. */
export type Message = APIMessage;

/**
 * What the member types into the form (modal) the bot opens, by each field's label. Pass it as the
 * last argument of the action that opens the form; the action then resolves with the bot's answer
 * to the submitted form.
 * @example await alice.click(panel, "Report", { Reason: "spam" });
 */
export type Form = Record<string, string>;

/** One autocomplete suggestion: `name` is what the member sees, `value` what the command receives. */
export interface Choice {
  name: string;
  value: string | number;
}

/** What a slash command option can be given: a value, or a handle where the option is a user or channel. */
export type OptionValue<G extends string = string> =
  | string
  | number
  | boolean
  | Member<G>
  | Category<G>
  | TextChannel<G>
  | Forum<G>
  | Thread<G>;

/** A user who has joined a guild. The test acts as them. */
export interface Member<G extends string = string> extends Handle<"member", G> {
  /**
   * Runs `/command` in `channel`, typed as a user would: `"report"`, or `"admin-config set"` for a
   * subcommand. Resolves with the reply once it's visible, after any defer.
   * @example const reportMenu = await bob.run(challengesChannel, "report");
   */
  run(
    channel: TextChannel<G> | Thread<G>,
    command: string,
    options?: Record<string, OptionValue<G>>,
    form?: Form,
  ): Promise<Message>;
  /**
   * Types `typed` into `option` of `/command`, with `filled` already entered, and resolves with the
   * choices the bot suggests (its autocomplete answer). Run the command with a choice's value after.
   * @example const choices = await alice.autocomplete(general, "docs", "query", "Promise.al");
   */
  autocomplete(
    channel: TextChannel<G> | Thread<G>,
    command: string,
    option: string,
    typed: string | number,
    filled?: Record<string, OptionValue<G>>,
  ): Promise<Choice[]>;
  /**
   * Picks the app `command` from the Apps menu of `target` (a member or a message) while in
   * `channel`: a context-menu command, registered with type User or Message. Resolves with the reply.
   * @example const card = await alice.runApp(general, bob, "View Profile");
   */
  runApp(
    channel: TextChannel<G> | Thread<G>,
    target: Member<G> | Message,
    command: string,
    form?: Form,
  ): Promise<Message>;
  /**
   * Presses the button labelled `label` on `message` (or showing that emoji, when it has no label).
   * Resolves with the message visible afterwards: the same one when the bot updates it in place.
   * @example await alice.click(panel, "Join Ladder");
   */
  click(
    message: Message,
    label: string | RegExp,
    form?: Form,
  ): Promise<Message>;
  /**
   * Picks the option labelled `label` from the select menu on `message`, or several labels for a
   * multi-select (between its min_values and max_values). Resolves with the message
   * visible afterwards: the same one when the bot updates it in place.
   * @example await bob.select(reportMenu, "5-2");
   */
  select(
    message: Message,
    label: string | RegExp | (string | RegExp)[],
    form?: Form,
  ): Promise<Message>;
  /**
   * Picks members, roles or channels in the user, role, mentionable or channel select on `message`
   * that offers them, one or several (between its min_values and max_values). Resolves like the
   * label form.
   * @example await alice.select(setupPanel, [modRole, adminRole]);
   */
  select(
    message: Message,
    picks: Pickable<G> | Pickable<G>[],
    form?: Form,
  ): Promise<Message>;
  /**
   * Posts in `channel`. Files are served by the mock, so the bot can download them.
   * @example alice.post(isoChannel, { content: "ISO Shako" });
   */
  post(channel: TextChannel<G> | Thread<G>, message: UserMessage): Message;
  /**
   * Sends the bot a direct message. The bot needs the DirectMessages intent (and Partials.Channel)
   * to hear it, as on Discord. Read its answer with `discord.find(member, …)`.
   * @example alice.dm({ content: "!help" }); await discord.find(alice, /commands/);
   */
  dm(message: UserMessage): Message;
  /** Opens a post in `forum`: a thread whose first message is `post`, with the forum's tags named in `tags`. */
  forumPost(
    forum: Forum<G>,
    post: UserMessage & { title: string; tags?: string[] },
  ): { thread: Thread<G>; message: Message };
  /** Reacts to `message` with a unicode emoji. */
  react(message: Message, emoji: string): void;
  /**
   * Votes in the poll on `message` for the answer labelled `answer`, or several where the poll
   * allows it. The bot hears `messagePollVoteAdd` with GuildMessagePolls. Voting again needs `unvote`
   * first, as in the Discord app.
   * @example alice.vote(poll, "Pizza");
   */
  vote(message: Message, answer: string | string[]): void;
  /** Takes back their vote; the bot hears `messagePollVoteRemove`. */
  unvote(message: Message): void;
  /**
   * Makes `stage` live with `topic`. They need Manage Channels, Mute Members and Move Members there;
   * the bot hears `stageInstanceCreate`.
   * @example mod.startStage(townHall, "Q&A");
   */
  startStage(stage: StageChannel<G>, topic: string): void;
  /** Ends the live stage; the bot hears `stageInstanceDelete`. */
  endStage(stage: StageChannel<G>): void;
  /**
   * Starts typing in `channel`. The bot hears `typingStart` with GuildMessageTyping.
   * @example alice.startTyping(general);
   */
  startTyping(channel: TextChannel<G> | Thread<G>): void;
  /**
   * Turns off DMs from server members, as a privacy setting: the bot's DMs to them fail with 50007.
   * @example alice.closeDMs(); await alice.run(general, "remind-me"); // the bot should say it can't DM
   */
  closeDMs(): void;
  /** Sets their server nickname; null goes back to their name. */
  nickname(nick: string | null): void;
  /**
   * Changes their display name, shown in every server where they have no nickname; null goes back
   * to their username. The bot hears it as a member update in each server they share, which
   * discord.js also emits as `userUpdate`.
   * @example alice.displayName("Alicia"); // a bot that stores display names should update
   */
  displayName(name: string | null): void;
  /** Leaves the guild. */
  leave(): void;
  /**
   * Kicks `member` from the Discord app: needs Kick Members and a higher role. The bot sees them
   * leave and, with View Audit Log, the audit log entry naming who did it.
   * @example mod.kick(alice, "spam"); // a bot that logs kicks should name mod
   */
  kick(member: Member<G>, reason?: string): void;
  /** Bans `member` from the Discord app: needs Ban Members and a higher role. Like `kick`. */
  ban(member: Member<G>, reason?: string): void;
  /**
   * Renames the guild, which needs Manage Server (the owner has it). The bot hears `guildUpdate`.
   * @example discord.owner(server).renameGuild("SIN 2"); // a bot that shows the guild name should follow
   */
  renameGuild(name: string): void;
  /**
   * Joins `channel`, or moves there from another voice channel. The bot hears `voiceStateUpdate`
   * with GUILD_VOICE_STATES. Needs Connect there, which @everyone has unless an overwrite denies it.
   * @example alice.joinVoice(lobby); // a bot that logs voice activity should post
   */
  joinVoice(channel: VoiceChannel<G>): void;
  /** Leaves voice. */
  leaveVoice(): void;
  /**
   * Creates an invite to `channel` and returns its code; the bot hears `inviteCreate` when it has
   * Manage Channels there. Pass the code to `discord.member(…, { invite })` for someone to join.
   * @example const code = alice.invite(general, { maxUses: 1 });
   */
  invite(channel: TextChannel<G>, options?: { maxUses?: number }): string;
  /**
   * Creates a scheduled event starting at `start`, in voice channel `where` or at a place outside
   * Discord named by the string. Needs Create Events (and View Channel and Connect in the channel).
   * The bot hears `guildScheduledEventCreate` with GUILD_SCHEDULED_EVENTS. A place event ends an
   * hour after it starts.
   * @example const raid = alice.createEvent("Raid night", lobby, new Date("2026-12-01T20:00Z"));
   */
  createEvent(
    name: string,
    where: VoiceChannel<G> | string,
    start: Date,
  ): ScheduledEvent<G>;
  /**
   * Changes an event's name, description or start; the bot hears `guildScheduledEventUpdate`.
   * Someone else's event needs Manage Events.
   */
  editEvent(
    event: ScheduledEvent<G>,
    changes: { name?: string; description?: string; start?: Date },
  ): void;
  /** Deletes an event; the bot hears `guildScheduledEventDelete`. Like `editEvent`. */
  deleteEvent(event: ScheduledEvent<G>): void;
  /**
   * Uploads a custom emoji named `name` (2-32 characters), which needs Create Expressions. The bot
   * hears `emojiCreate` with GUILD_EXPRESSIONS (GuildExpressions).
   * @example const pog = mod.addEmoji("pog"); // a bot that logs emoji changes should post
   */
  addEmoji(name: string): Emoji<G>;
  /** Uploads a sticker named `name` (2-30 characters), like `addEmoji`; the bot hears `stickerCreate`. */
  addSticker(name: string): Sticker<G>;
  /**
   * Renames an emoji or sticker; the bot hears `emojiUpdate` or `stickerUpdate`. Someone else's needs
   * Manage Expressions.
   */
  renameExpression(expression: Emoji<G> | Sticker<G>, name: string): void;
  /** Deletes an emoji or sticker; the bot hears `emojiDelete` or `stickerDelete`. Like `renameExpression`. */
  deleteExpression(expression: Emoji<G> | Sticker<G>): void;
}

const FIND_TIMEOUT_MS = 2000;

/**
 * A fake Discord for one test. Build the World, `start` your bot, act as members, then read what
 * the bot did. It shuts down when the test ends, and fails the test if the bot hit a Gap.
 */
class Discord {
  private client?: Client;
  /** Messages the bot created or edited since the latest action: the ones `find` looks at. */
  private readonly written = new Set<Message>();
  private readonly markAction = () => this.written.clear();

  constructor(private readonly mock: DiscordMock) {
    const record = (message: Message) => {
      if (message.author.id === mock.state.bot.id) this.written.add(message);
    };
    mock.state.on("messageCreate", record);
    mock.state.on("messageUpdate", record);
  }

  /** Spread into your bot's `new Client()` options so it connects to this mock. */
  get clientOptions(): { rest: { api: string } } {
    return this.mock.clientOptions;
  }

  /** @example const server = discord.guild("SIN"); */
  guild<const G extends string>(name: G): Guild<G> {
    return handle(this.mock.createGuild(name).id, name);
  }

  category<G extends string>(guild: Guild<G>, name: string): Category<G> {
    return handle(this.mock.createCategory(this.g(guild), name).id, name);
  }

  /** @example const challengesChannel = discord.channel(server, "challenges", ladderCategory); */
  channel<G extends string>(
    guild: Guild<G>,
    name: string,
    category?: Category<NoInfer<G>>,
  ): TextChannel<G> {
    const parent = category
      ? this.mock.state.requireChannel(category.id)
      : undefined;
    return handle(
      this.mock.createTextChannel(this.g(guild), name, { parent }).id,
      name,
    );
  }

  voiceChannel<G extends string>(
    guild: Guild<G>,
    name: string,
  ): VoiceChannel<G> {
    return handle(this.mock.createVoiceChannel(this.g(guild), name).id, name);
  }

  /** A stage channel in `guild`, which a moderator makes live with `startStage`. */
  stageChannel<G extends string>(
    guild: Guild<G>,
    name: string,
  ): StageChannel<G> {
    return handle(this.mock.createStageChannel(this.g(guild), name).id, name);
  }

  /** A role in `guild` with no permissions, for members to pick in a role select. */
  role<G extends string>(guild: Guild<G>, name: string): Role<G> {
    return handle(this.mock.createRole(this.g(guild), name, 0n).id, name);
  }

  /** A forum offering these tags to its posts. @example discord.forum(server, "help", ["Solved"]) */
  forum<G extends string>(
    guild: Guild<G>,
    name: string,
    tags: string[] = [],
  ): Forum<G> {
    return handle(this.mock.createForum(this.g(guild), name, tags).id, name);
  }

  /**
   * A new user who has joined `guild`. `nickname` is their server nickname. `permissions` gives them
   * a role holding those permissions, for a moderator or admin who isn't the owner. `invite` is the
   * code they join through, from `Member.invite`: its uses go up, as invite trackers expect.
   * `inactiveDays` is how long since Discord last saw them, for prune; everyone else was seen now.
   * @example const alice = discord.member(server, "Alice");
   * @example const mod = discord.member(server, "Mod", { permissions: Permission.ModerateMembers });
   * @example const carol = discord.member(server, "Carol", { invite: alice.invite(general) });
   */
  member<G extends string>(
    guild: Guild<G>,
    name: string,
    options: {
      nickname?: string;
      permissions?: bigint;
      invite?: string;
      inactiveDays?: number;
    } = {},
  ): Member<G> {
    const user = this.mock.createUser(name);
    const record = this.g(guild);
    if (options.invite === undefined)
      this.mock.addMember(record, user, { nick: options.nickname });
    else
      this.mock.joinWithInvite(record, options.invite, user, {
        nick: options.nickname,
      });
    if (options.permissions !== undefined)
      this.mock.createRole(record, `${name}'s role`, options.permissions, [
        user,
      ]);
    if (options.inactiveDays !== undefined)
      record.lastSeen.set(
        user.id,
        Date.now() - options.inactiveDays * 86_400_000,
      );
    return this.actorFor(guild, user);
  }

  /** The member who owns `guild`. They have every permission, so they can run admin commands. */
  owner<G extends string>(guild: Guild<G>): Member<G> {
    return this.actorFor(
      guild,
      this.mock.state.requireUser(this.g(guild).ownerId),
    );
  }

  /**
   * Logs `client` in (it must have been built with `clientOptions`), waits for ready, and registers
   * `commands` the way a deploy script would. The client is destroyed when the test ends.
   *
   * `permissions` are what the bot's invite link grants: the bot gets a role with them in every
   * guild built before `start`. Without it, or in a guild built later, it has only @everyone's.
   * @example await discord.start(bot.client, { commands, permissions: Permission.SendMessages });
   */
  async start(
    client: Client,
    options: {
      commands?: RESTPostAPIApplicationCommandsJSONBody[];
      permissions?: bigint;
    } = {},
  ): Promise<void> {
    this.client = client;
    this.markAction();
    if (options.permissions !== undefined)
      this.mock.grantBot(options.permissions);
    const ready = once(client, "clientReady");
    await client.login(this.mock.token);
    await ready;
    if (options.commands)
      await client.application!.commands.set(options.commands);
  }

  /**
   * Answers every `method path` request with `response` instead of the Model. `:name` segments match
   * anything; a literal id fails only that channel, message or member.
   * @example discord.fail("PATCH", "/webhooks/:app/:token/messages/@original", respond.serverError(503));
   * @example discord.fail("POST", `/channels/${leaderboardChannel.id}/messages`, respond.missingPermissions());
   */
  fail(method: string, path: string, response: RestResponse): void {
    this.mock.use(method, path, () => response);
  }

  /**
   * An admin overrides who can use `command` in `guild` (Server Settings > Integrations): each
   * `target` is a member, a channel, or the guild itself for @everyone. The bot hears
   * `applicationCommandPermissionsUpdate` and can fetch them. Call it after `start`, once the
   * command is registered. Only an override naming a member changes whether they can run it here.
   * @example discord.commandPermissions(server, "ban", [{ target: mod, allow: true }]);
   */
  commandPermissions<G extends string>(
    guild: Guild<G>,
    command: string,
    overrides: {
      target: Member<NoInfer<G>> | TextChannel<NoInfer<G>> | Guild<NoInfer<G>>;
      allow: boolean;
    }[],
  ): void {
    const record = this.g(guild);
    const found = this.mock.state.findCommand(record.id, command);
    if (!found)
      throw new Error(
        `discordjs-test-kit: no command "${command}" in ${record.name}; call this after start`,
      );
    const { users, channels } = this.mock.state;
    this.markAction();
    setCommandPermissions(
      this.mock,
      record,
      found.id,
      overrides.map(({ target, allow }) => ({
        id: target.id,
        type: users.has(target.id)
          ? ApplicationCommandPermissionType.User
          : channels.has(target.id)
            ? ApplicationCommandPermissionType.Channel
            : ApplicationCommandPermissionType.Role,
        permission: allow,
      })),
    );
  }

  /**
   * The admins of `guild` kick the bot. It gets `guildDelete` and hears nothing from the guild
   * after, as on Discord; its members can no longer use its commands there.
   * @example discord.kickBot(server); // a bot that cleans up its settings on guildDelete should
   */
  kickBot(guild: Guild): void {
    this.markAction();
    this.mock.removeBot(this.g(guild));
  }

  /**
   * A Discord outage takes `guild` away: the bot gets `guildUnavailable` and hears nothing from it
   * until `endOutage`, which brings `guildAvailable`. REST still answers during the outage.
   * @example discord.outage(server); discord.endOutage(server);
   */
  outage(guild: Guild): void {
    this.markAction();
    this.mock.gateway.startOutage(this.g(guild));
  }

  /** Ends `outage`: the bot gets the guild again, with `guildAvailable`. */
  endOutage(guild: Guild): void {
    this.markAction();
    this.mock.gateway.endOutage(this.g(guild));
  }

  /** Discord archives `thread` for inactivity: it moves from the active list to the archived one. */
  archive(thread: Thread): void {
    this.markAction();
    this.mock.archiveThread(this.mock.state.requireChannel(thread.id));
  }

  /**
   * Waits for a thread in `channel` whose name contains `name` (or matches it when it's a RegExp):
   * one the bot started, from a message or not. Resolves with the newest match; rejects after 2
   * seconds, naming the threads there.
   * @example const ticket = await discord.findThread(supportChannel, "ticket-alice");
   */
  async findThread(
    channel: TextChannel,
    name: string | RegExp,
  ): Promise<Thread> {
    const state = this.mock.state;
    const threads = () =>
      [...state.channels.values()].filter(
        (c) =>
          "parent_id" in c &&
          c.parent_id === channel.id &&
          "thread_metadata" in c,
      );
    const wanted = (c: { name?: string | null }) =>
      matches(c.name ?? "", name, { partial: true });
    const found =
      threads().findLast(wanted) ??
      (await this.mock
        .waitForThread((t) => threads().includes(t) && wanted(t), {
          timeoutMs: FIND_TIMEOUT_MS,
        })
        .catch(() => undefined));
    if (!found) {
      const names = threads().map((t) => `"${t.name}"`);
      throw new Error(
        `discordjs-test-kit: no thread in #${channel.name} matched ${quote(name)} within ${FIND_TIMEOUT_MS / 1000}s. ${names.length ? `Threads there: ${names.join(", ")}` : "It has no threads"}`,
      );
    }
    return handle(found.id, found.name ?? "");
  }

  /** Every message in `channel`, oldest first. To wait for one, use `find`. */
  messages(channel: TextChannel | Thread): Message[] {
    return this.mock.messagesIn(channel.id);
  }

  /** The bot's DMs with `member`, oldest first. */
  dms(member: Member): Message[] {
    return this.mock.messagesIn(this.mock.state.dmChannel(member.id).id);
  }

  /**
   * Waits for a message the bot created or edited since the latest action (a member's action,
   * `start` or `archive`) in `where`: a channel, a thread, or a member's DMs with the bot. Its text
   * must contain `text`, or match it when it's a RegExp; the text is the content plus each embed's
   * title, description, fields and footer. Resolves with the newest match already written, else the
   * first one to land; rejects after 2 seconds, showing the last messages. To check the bot did
   * nothing more, or nothing at all, `await discord.idle()` first.
   * @example await discord.find(leaderboardChannel, /Bobby/);
   */
  async find(
    where: TextChannel | Thread | Member,
    text: string | RegExp,
  ): Promise<Message> {
    const isMember = where instanceof MemberActor;
    const channelId = isMember
      ? this.mock.state.dmChannel(where.id).id
      : where.id;
    const wanted = (m: Message) =>
      m.channel_id === channelId &&
      matches(readable(m), text, { partial: true });
    const match = this.mock
      .messagesIn(channelId)
      .findLast((m) => this.written.has(m) && wanted(m));
    if (match) return match;
    try {
      return await this.mock.waitForMessage(wanted, {
        timeoutMs: FIND_TIMEOUT_MS,
      });
    } catch {
      const place = isMember ? `${where.name}'s DMs` : `#${where.name}`;
      const last = this.mock.messagesIn(channelId).slice(-3).map(shown);
      throw new Error(
        `discordjs-test-kit: no message in ${place} written since the last action matched ${quote(text)} within ${FIND_TIMEOUT_MS / 1000}s. ${last.length ? `Last ${last.length}: ${last.join(", ")}` : "It has no messages"}`,
      );
    }
  }

  /**
   * Waits until the bot has gone quiet: no request to Discord open and nothing new for it for 100ms.
   * Use it before asserting the bot sent exactly one reply, or none. A bot that works longer than
   * 100ms before its first request looks done, so wait on `find` for what it should send.
   * @example alice.post(generalChannel, { content: "hello" }); await discord.idle(); expect(discord.messages(generalChannel)).toHaveLength(1);
   */
  idle(): Promise<void> {
    return this.mock.waitForIdle();
  }

  /** Called when the test finishes. */
  async close(): Promise<void> {
    await this.client?.destroy();
    try {
      this.mock.assertNoUnhandledRequests();
    } finally {
      await this.mock.close();
    }
  }

  private g(guild: Guild) {
    return this.mock.state.requireGuild(guild.id);
  }

  private actorFor<G extends string>(
    guild: Guild<G>,
    user: APIUser,
  ): Member<G> {
    return new MemberActor(
      this.mock,
      this.markAction,
      guild.id,
      user.id,
      user.username,
    ) as never;
  }
}

export type { Discord };

class MemberActor {
  constructor(
    private readonly mock: DiscordMock,
    private readonly markAction: () => void,
    private readonly guildId: string,
    readonly id: string,
    readonly name: string,
  ) {}

  async run(
    channel: TextChannel | Thread,
    command: string,
    options: Record<string, OptionValue> = {},
    form?: Form,
  ): Promise<Message> {
    const values = optionIds(options);
    return this.answer(
      this.actor().slashCommand(
        this.mock.state.requireChannel(channel.id),
        command,
        values,
      ),
      form,
    );
  }

  async autocomplete(
    channel: TextChannel | Thread,
    command: string,
    option: string,
    typed: string | number,
    filled: Record<string, OptionValue> = {},
  ): Promise<Choice[]> {
    return this.actor()
      .autocomplete(
        this.mock.state.requireChannel(channel.id),
        command,
        option,
        typed,
        optionIds(filled),
      )
      .suggestions();
  }

  async runApp(
    channel: TextChannel | Thread,
    target: Member | Message,
    command: string,
    form?: Form,
  ): Promise<Message> {
    const state = this.mock.state;
    return this.answer(
      this.actor().contextMenu(
        state.requireChannel(channel.id),
        "channel_id" in target
          ? state.requireMessage(target.channel_id, target.id)
          : state.requireUser(target.id),
        command,
      ),
      form,
    );
  }

  async click(
    message: Message,
    label: string | RegExp,
    form?: Form,
  ): Promise<Message> {
    return this.answer(this.actor().clickButton(message, label), form);
  }

  async select(
    message: Message,
    picks: string | RegExp | Pickable | (string | RegExp)[] | Pickable[],
    form?: Form,
  ): Promise<Message> {
    const list = Array.isArray(picks) ? picks : [picks];
    const labels = list.filter(
      (pick): pick is string | RegExp =>
        typeof pick === "string" || pick instanceof RegExp,
    );
    return this.answer(
      labels.length
        ? this.actor().selectOption(message, labels)
        : this.actor().pickEntities(
            message,
            (list as Pickable[]).map((pick) => pick.id),
          ),
      form,
    );
  }

  /** The visible reply to `run`, filling and submitting the form first when the bot opens one. */
  private async answer(run: InteractionRun, form?: Form): Promise<Message> {
    await run.acknowledged();
    if (!form) return run.reply();
    if (!run.modal)
      throw new Error(
        `discordjs-test-kit: ${this.name} was given a form to fill, but the bot answered without opening one`,
      );
    return this.mock.as(this.user()).submitForm(run, form).reply();
  }

  post(channel: TextChannel | Thread, message: UserMessage): Message {
    return this.actor().sendMessage(
      this.mock.state.requireChannel(channel.id),
      message,
    );
  }

  /** Sends the bot a direct message. Read its answer with `discord.find(member, …)`. */
  dm(message: UserMessage): Message {
    return this.actor().sendMessage(
      this.mock.state.dmChannel(this.id),
      message,
    );
  }

  forumPost(
    forum: Forum,
    post: UserMessage & { title: string; tags?: string[] },
  ): { thread: Thread; message: Message } {
    const { thread, message } = this.actor().forumPost(
      this.mock.state.requireChannel(forum.id),
      post,
    );
    return { thread: handle(thread.id, post.title), message };
  }

  react(message: Message, emoji: string): void {
    this.actor().react(message, emoji);
  }

  vote(message: Message, answer: string | string[]): void {
    this.actor().vote(message, [answer].flat());
  }

  unvote(message: Message): void {
    this.actor().removeVote(message);
  }

  startStage(stage: StageChannel, topic: string): void {
    this.actor().startStage(this.mock.state.requireChannel(stage.id), topic);
  }

  endStage(stage: StageChannel): void {
    this.actor().endStage(this.mock.state.requireChannel(stage.id));
  }

  startTyping(channel: TextChannel | Thread): void {
    this.actor().startTyping(this.mock.state.requireChannel(channel.id));
  }

  closeDMs(): void {
    this.markAction();
    this.mock.state.closedDms.add(this.id);
  }

  nickname(nick: string | null): void {
    this.markAction();
    this.mock.setNickname(this.guild(), this.user(), nick);
  }

  displayName(name: string | null): void {
    this.markAction();
    this.mock.setDisplayName(this.user(), name);
  }

  leave(): void {
    this.markAction();
    this.mock.removeMember(this.guild(), this.user());
  }

  kick(member: Member, reason?: string): void {
    this.markAction();
    this.mock.moderate(
      this.guild(),
      this.user(),
      this.userOf(member),
      "kick",
      reason,
    );
  }

  ban(member: Member, reason?: string): void {
    this.markAction();
    this.mock.moderate(
      this.guild(),
      this.user(),
      this.userOf(member),
      "ban",
      reason,
    );
  }

  invite(channel: TextChannel, options: { maxUses?: number } = {}): string {
    this.markAction();
    return createInvite(
      this.mock,
      this.mock.state.requireChannel(channel.id),
      this.user(),
      { max_uses: options.maxUses },
    ).code;
  }

  joinVoice(channel: VoiceChannel): void {
    this.markAction();
    this.mock.joinVoice(
      this.guild(),
      this.user(),
      this.mock.state.requireChannel(channel.id),
    );
  }

  leaveVoice(): void {
    this.markAction();
    this.mock.joinVoice(this.guild(), this.user(), null);
  }

  renameGuild(name: string): void {
    const guild = this.guild();
    if (
      !(
        computePermissions(this.mock.state, guild, this.id) &
        Permission.ManageGuild
      )
    )
      throw new Error(
        `discordjs-test-kit: ${this.name} can't rename ${guild.name} without Manage Server`,
      );
    this.markAction();
    this.mock.renameGuild(guild, name);
  }

  createEvent(
    name: string,
    where: VoiceChannel | string,
    start: Date,
  ): ScheduledEvent {
    this.markAction();
    const event = createScheduledEvent(this.mock, this.guild(), this.user(), {
      name,
      start,
      place:
        typeof where === "string"
          ? { location: where }
          : { channel: this.mock.state.requireChannel(where.id) },
    });
    return handle(event.id, name);
  }

  editEvent(
    event: ScheduledEvent,
    changes: { name?: string; description?: string; start?: Date },
  ): void {
    this.markAction();
    editScheduledEvent(
      this.mock,
      this.guild(),
      this.user(),
      this.eventOf(event),
      changes,
    );
  }

  deleteEvent(event: ScheduledEvent): void {
    this.markAction();
    deleteScheduledEvent(
      this.mock,
      this.guild(),
      this.user(),
      this.eventOf(event),
    );
  }

  addEmoji(name: string): Emoji {
    this.markAction();
    const id = uploadExpression(
      this.mock,
      this.guild(),
      this.user(),
      "emoji",
      name,
    );
    return handle(id, name);
  }

  addSticker(name: string): Sticker {
    this.markAction();
    const id = uploadExpression(
      this.mock,
      this.guild(),
      this.user(),
      "sticker",
      name,
    );
    return handle(id, name);
  }

  renameExpression(expression: Emoji | Sticker, name: string): void {
    this.markAction();
    const guild = this.guild();
    renameExpression(
      this.mock,
      guild,
      this.user(),
      this.kindOf(expression),
      expression.id,
      name,
    );
  }

  deleteExpression(expression: Emoji | Sticker): void {
    this.markAction();
    const guild = this.guild();
    deleteExpression(
      this.mock,
      guild,
      this.user(),
      this.kindOf(expression),
      expression.id,
    );
  }

  private kindOf(expression: Emoji | Sticker) {
    const guild = this.guild();
    if (guild.emojis.has(expression.id)) return "emoji";
    if (guild.stickers.has(expression.id)) return "sticker";
    throw new Error(`discordjs-test-kit: ${expression.name} was deleted`);
  }

  private eventOf(event: ScheduledEvent) {
    const found = this.mock.state.scheduledEvents.get(event.id);
    if (!found)
      throw new Error(`discordjs-test-kit: event ${event.name} was deleted`);
    return found;
  }

  private actor() {
    this.markAction();
    return this.mock.as(this.user());
  }
  private user() {
    return this.mock.state.requireUser(this.id);
  }
  private userOf(member: Member) {
    return this.mock.state.requireUser(member.id);
  }
  private guild() {
    return this.mock.state.requireGuild(this.guildId);
  }
}

/** Handles become the ids Discord sends for user and channel options. */
function optionIds(options: Record<string, OptionValue>) {
  return Object.fromEntries(
    Object.entries(options).map(([name, value]) => [
      name,
      typeof value === "object" ? value.id : value,
    ]),
  );
}

/** Handles exist only in types; at run time they're the entity's id and name. */
function handle<T>(id: string, name: string): T {
  return { id, name } as T;
}

/**
 * A fake Discord for the current test, on its own port, shut down when the test finishes.
 * @example const discord = await createDiscord();
 */
export async function createDiscord(): Promise<Discord> {
  const discord = new Discord(await createDiscordMock());
  onTestFinished(() => discord.close());
  return discord;
}
