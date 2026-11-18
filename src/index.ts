import { once } from "node:events";
import type {
  APIMessage,
  RESTPostAPIApplicationCommandsJSONBody,
} from "discord-api-types/v10";
import type { Client } from "discord.js";
import { onTestFinished } from "vitest";
import {
  createDiscordMock,
  shown,
  type DiscordMock,
  type UserMessage,
} from "./internal/mock.js";
import type { RestResponse } from "./internal/rest.js";

export { respond } from "./internal/rest.js";
export type { RestResponse } from "./internal/rest.js";
export { Permission } from "./internal/payloads.js";
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
/** A forum: members open posts in it with `member.forumPost`. */
export type Forum<G extends string = string> = Handle<"forum", G>;
/** A thread, such as a forum post. */
export type Thread<G extends string = string> = Handle<"thread", G>;
/** A message as Discord stores it. The object is live: edits, reactions and updates show up on it. */
export type Message = APIMessage;

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
  ): Promise<Message>;
  /**
   * Presses the button labelled `label` on `message` (or showing that emoji, when it has no label).
   * Resolves with the message visible afterwards: the same one when the bot updates it in place.
   * @example await alice.click(panel, "Join Ladder");
   */
  click(message: Message, label: string | RegExp): Promise<Message>;
  /**
   * Picks the option labelled `label` from the select menu on `message`. Resolves with the message
   * visible afterwards: the same one when the bot updates it in place.
   * @example await bob.select(reportMenu, "5-2");
   */
  select(message: Message, label: string | RegExp): Promise<Message>;
  /**
   * Posts in `channel`. Files are served by the mock, so the bot can download them.
   * @example alice.post(isoChannel, { content: "ISO Shako" });
   */
  post(channel: TextChannel<G> | Thread<G>, message: UserMessage): Message;
  /** Opens a post in `forum`: a thread whose first message is `post`. */
  forumPost(
    forum: Forum<G>,
    post: UserMessage & { title: string },
  ): { thread: Thread<G>; message: Message };
  /** Reacts to `message` with a unicode emoji. */
  react(message: Message, emoji: string): void;
  /** Sets their server nickname; null goes back to their name. */
  nickname(nick: string | null): void;
  /** Leaves the guild. */
  leave(): void;
}

const FIND_TIMEOUT_MS = 2000;
const FIND_INTERVAL_MS = 20;
// Counted in polls, not read from Date.now(): tests fake Date to move a bot's clock, and a frozen
// Date would never reach the deadline.
const FIND_POLLS = FIND_TIMEOUT_MS / FIND_INTERVAL_MS;

/**
 * A fake Discord for one test. Build the World, `start` your bot, act as members, then read what
 * the bot did. It shuts down when the test ends, and fails the test if the bot hit a Gap.
 */
class Discord {
  /** Spread into your bot's `new Client()` options so it connects to this mock. */
  readonly clientOptions: { rest: { api: string } };
  private client?: Client;
  /** The Model's write count when the latest action started: `find` only sees writes after it. */
  private actionMark = 0;
  private readonly markAction = () => {
    this.actionMark = this.mock.state.writes;
  };

  constructor(private readonly mock: DiscordMock) {
    this.clientOptions = mock.clientOptions;
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

  forum<G extends string>(guild: Guild<G>, name: string): Forum<G> {
    return handle(this.mock.createForum(this.g(guild), name).id, name);
  }

  /**
   * A new user who has joined `guild`, optionally with a server nickname.
   * @example const alice = discord.member(server, "Alice");
   */
  member<G extends string>(
    guild: Guild<G>,
    name: string,
    nick?: string,
  ): Member<G> {
    const user = this.mock.createUser(name);
    this.mock.addMember(this.g(guild), user, { nick });
    return new MemberActor(
      this.mock,
      this.markAction,
      guild.id,
      user.id,
      name,
    ) as never;
  }

  /** The member who owns `guild`. They have every permission, so they can run admin commands. */
  owner<G extends string>(guild: Guild<G>): Member<G> {
    const user = this.mock.state.requireUser(this.g(guild).ownerId);
    return new MemberActor(
      this.mock,
      this.markAction,
      guild.id,
      user.id,
      user.username,
    ) as never;
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
      for (const guild of this.mock.state.guilds.values())
        this.mock.createRole(guild, "bot", options.permissions, [
          this.mock.state.bot,
        ]);
    const ready = once(client, "clientReady");
    await client.login(this.mock.token);
    await ready;
    if (options.commands)
      await client.application!.commands.set(options.commands);
  }

  /**
   * Answers every `method path` request with `response` instead of the Model.
   * @example discord.fail("PATCH", "/webhooks/:app/:token/messages/@original", respond.serverError(503));
   */
  fail(method: string, path: string, response: RestResponse): void {
    this.mock.use(method, path, () => response);
  }

  /** Discord archives `thread` for inactivity: it moves from the active list to the archived one. */
  archive(thread: Thread): void {
    this.markAction();
    this.mock.archiveThread(this.mock.state.requireChannel(thread.id));
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
   * title, description, fields and footer. Resolves with the newest match; rejects after 2 seconds,
   * showing the last messages. To wait for something to disappear, use `vi.waitFor`.
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
    const mark = this.actionMark;
    for (let poll = 0; ; poll++) {
      const all = this.mock.messagesIn(channelId);
      const match = all.findLast(
        (m) =>
          this.mock.state.lastWriteOf(m) > mark &&
          matchesText(readable(m), text),
      );
      if (match) return match;
      if (poll >= FIND_POLLS) {
        const place = isMember ? `${where.name}'s DMs` : `#${where.name}`;
        const last = all.slice(-3).map(shown);
        throw new Error(
          `discord-mock: no message in ${place} written since the last action matched ${quote(text)} within ${FIND_TIMEOUT_MS / 1000}s. ${last.length ? `Last ${last.length}: ${last.join(", ")}` : "It has no messages"}`,
        );
      }
      await new Promise((r) => setTimeout(r, FIND_INTERVAL_MS));
    }
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
  ): Promise<Message> {
    // Handles become the ids Discord sends for user and channel options.
    const values = Object.fromEntries(
      Object.entries(options).map(([name, value]) => [
        name,
        typeof value === "object" ? value.id : value,
      ]),
    );
    return this.actor()
      .slashCommand(this.mock.state.requireChannel(channel.id), command, values)
      .reply();
  }

  async click(message: Message, label: string | RegExp): Promise<Message> {
    return this.actor().clickButton(message, label).reply();
  }

  async select(message: Message, label: string | RegExp): Promise<Message> {
    return this.actor().selectOption(message, label).reply();
  }

  post(channel: TextChannel | Thread, message: UserMessage): Message {
    return this.actor().sendMessage(
      this.mock.state.requireChannel(channel.id),
      message,
    );
  }

  forumPost(
    forum: Forum,
    post: UserMessage & { title: string },
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

  nickname(nick: string | null): void {
    this.markAction();
    this.mock.setNickname(this.guild(), this.user(), nick);
  }

  leave(): void {
    this.markAction();
    this.mock.removeMember(this.guild(), this.user());
  }

  private actor() {
    this.markAction();
    return this.mock.as(this.user());
  }
  private user() {
    return this.mock.state.requireUser(this.id);
  }
  private guild() {
    return this.mock.state.requireGuild(this.guildId);
  }
}

/** Handles exist only in types; at run time they're the entity's id and name. */
function handle<T>(id: string, name: string): T {
  return { id, name } as T;
}

/** The text a user reads in a message: its content, then each embed's text. */
function readable(message: Message): string {
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

function matchesText(text: string, want: string | RegExp) {
  if (typeof want === "string") return text.includes(want);
  want.lastIndex = 0; // a /g RegExp would otherwise resume from its last match
  return want.test(text);
}

function quote(text: string | RegExp) {
  return typeof text === "string" ? JSON.stringify(text) : String(text);
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
