import { once } from "node:events";
import type {
  APIMessage,
  RESTPostAPIApplicationCommandsJSONBody,
} from "discord-api-types/v10";
import type { Client } from "discord.js";
import { onTestFinished } from "vitest";
import {
  createDiscordMock,
  type DiscordMock,
  type RestResponse,
  type UserMessage,
} from "../../src/index.js";

declare const kind: unique symbol;
/** A guild in the World. */
export type Guild = { id: string; name: string; [kind]: "guild" };
/** A channel category. Pass it as a text channel's `parent`. */
export type Category = { id: string; name: string; [kind]: "category" };
/** A text channel. */
export type TextChannel = { id: string; name: string; [kind]: "text" };
/** A forum: users post in it with `forumPost`. */
export type Forum = { id: string; name: string; [kind]: "forum" };
/** A thread, e.g. a forum post. */
export type Thread = { id: string; name: string; [kind]: "thread" };
/** A user who is a member of one guild. */
export type Member = { id: string; name: string; [kind]: "member" };
/** A message as Discord stores it. The object is live: reactions and edits show up on it. */
export type Message = APIMessage;

/**
 * A fake Discord for one test. Build the World, `start` your bot, act as users, then read what
 * the bot did. It shuts down when the test ends, and fails the test if the bot hit a Gap.
 */
export class Discord {
  /** Spread into your bot's `new Client()` options. */
  readonly clientOptions: { rest: { api: string } };
  private client?: Client;

  constructor(private mock: DiscordMock) {
    this.clientOptions = mock.clientOptions;
  }

  // ---- the World --------------------------------------------------------------

  guild(name: string): Guild {
    return brand(this.mock.createGuild(name), name);
  }

  category(guild: Guild, name: string): Category {
    return brand(this.mock.createCategory(this.g(guild), name), name);
  }

  channel(guild: Guild, name: string, parent?: Category): TextChannel {
    const parentChannel = parent
      ? this.mock.state.requireChannel(parent.id)
      : undefined;
    return brand(
      this.mock.createTextChannel(this.g(guild), name, {
        parent: parentChannel,
      }),
      name,
    );
  }

  forum(guild: Guild, name: string): Forum {
    return brand(this.mock.createForum(this.g(guild), name), name);
  }

  /** A new user who has joined `guild`, optionally with a server nickname. */
  member(guild: Guild, name: string, nick?: string): Member {
    const user = this.mock.createUser(name);
    this.mock.addMember(this.g(guild), user, { nick });
    return brand(user, name);
  }

  // ---- the bot ----------------------------------------------------------------

  /**
   * Log `client` in (it must have been built with `clientOptions`), wait for ready, and register
   * `commands` the way a deploy script would. The client is destroyed when the test ends.
   */
  async start(
    client: Client,
    opts: { commands?: RESTPostAPIApplicationCommandsJSONBody[] } = {},
  ) {
    this.client = client;
    const ready = once(client, "clientReady");
    await client.login(this.mock.token);
    await ready;
    if (opts.commands) await client.application!.commands.set(opts.commands);
  }

  // ---- acting as users --------------------------------------------------------

  /** `member` posts in `channel`. Files are served by the mock, so the bot can download them. */
  post(
    member: Member,
    channel: TextChannel | Thread,
    message: UserMessage,
  ): Message {
    return this.mock
      .as(this.u(member))
      .sendMessage(this.mock.state.requireChannel(channel.id), message);
  }

  /** `member` opens a forum post: a thread whose first message is `message`. */
  forumPost(
    member: Member,
    forum: Forum,
    post: UserMessage & { title: string },
  ): { thread: Thread; message: Message } {
    const { thread, message } = this.mock
      .as(this.u(member))
      .forumPost(this.mock.state.requireChannel(forum.id), post);
    return { thread: brand(thread, post.title), message };
  }

  react(member: Member, message: Message, emoji: string) {
    this.mock.as(this.u(member)).react(message, emoji);
  }

  /**
   * `member` runs `/command` in `channel`. Resolves with the reply once it's visible (after any
   * defer); rejects if the bot never gets there.
   */
  run(
    member: Member,
    channel: TextChannel | Thread,
    command: string,
    options: Record<string, string | number | boolean> = {},
  ): Promise<Message> {
    return this.mock
      .as(this.u(member))
      .slashCommand(
        this.mock.state.requireChannel(channel.id),
        command,
        options,
      )
      .reply();
  }

  /** `member` presses the button `customId` on `message`. Resolves with the visible response. */
  click(member: Member, message: Message, customId: string): Promise<Message> {
    return this.mock.as(this.u(member)).clickButton(message, customId).reply();
  }

  /** Answer every `method path` request with `response` instead of the Model, e.g. a 503. */
  fail(method: string, path: string, response: RestResponse) {
    this.mock.use(method, path, () => response);
  }

  // ---- reading what happened ---------------------------------------------------

  /** Every message in `channel`, oldest first. To wait for one, use `vi.waitFor`. */
  messages(channel: TextChannel | Thread): Message[] {
    return this.mock.messagesIn(channel.id);
  }

  /** The bot's DMs with `member`, oldest first. */
  dms(member: Member): Message[] {
    return this.mock.messagesIn(this.mock.state.dmChannel(member.id).id);
  }

  /** @internal Called when the test finishes. */
  async close() {
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
  private u(member: Member) {
    return this.mock.state.requireUser(member.id);
  }
}

function brand<T>(entity: { id: string }, name: string): T {
  return { id: entity.id, name } as T;
}

/** A fake Discord for the current test, shut down when the test finishes. */
export async function createDiscord(): Promise<Discord> {
  const discord = new Discord(await createDiscordMock());
  onTestFinished(() => discord.close());
  return discord;
}
