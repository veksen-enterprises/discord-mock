import type { APIMessage } from "discord-api-types/v10";
import {
  createDiscordMock,
  type DiscordMock,
  type RestResponse,
} from "../../src/index.js";

declare const kind: unique symbol;
/** A guild in the World. */
export type Guild = { id: string; name: string; [kind]: "guild" };
/** A channel category. Pass it as a text channel's `parent`. */
export type Category = { id: string; name: string; [kind]: "category" };
/** A text channel users can run commands in. */
export type TextChannel = { id: string; name: string; [kind]: "text" };
/** A user who is a member of one guild. */
export type Member = { id: string; name: string; [kind]: "member" };

/**
 * A fake Discord. Build the World with `guild`, `category`, `channel` and `member`, log your bot in
 * with `bot`, act with `run`, and `close` at the end (it fails the test if the bot hit a Gap).
 */
export class Discord {
  /** Spread `clientOptions` into `new Client()` and log in with `token`. */
  readonly bot: {
    token: string;
    applicationId: string;
    clientOptions: { rest: { api: string } };
  };

  constructor(private mock: DiscordMock) {
    this.bot = {
      token: mock.token,
      applicationId: mock.state.applicationId,
      clientOptions: mock.clientOptions,
    };
  }

  guild(name: string): Guild {
    const g = this.mock.createGuild(name);
    return { id: g.id, name } as Guild;
  }

  category(guild: Guild, name: string): Category {
    const c = this.mock.state.createCategoryChannel(guild.id, { name });
    return { id: c.id, name } as Category;
  }

  channel(guild: Guild, name: string, parent?: Category): TextChannel {
    const c = this.mock.state.createTextChannel(guild.id, {
      name,
      parentId: parent?.id,
    });
    return { id: c.id, name } as TextChannel;
  }

  /** A new user who has joined `guild`, optionally with a server nickname. */
  member(guild: Guild, name: string, nick?: string): Member {
    const user = this.mock.createUser(name);
    this.mock.state.addMember(guild.id, user.id, { nick });
    return { id: user.id, name } as Member;
  }

  /**
   * `member` runs `/command` in `channel`. Resolves with the reply once it's visible (after any
   * defer); rejects if the bot never gets there.
   */
  run(
    member: Member,
    channel: TextChannel,
    command: string,
    options: Record<string, string | number | boolean> = {},
  ): Promise<APIMessage> {
    return this.mock
      .as(this.mock.state.requireUser(member.id))
      .slashCommand(
        this.mock.state.requireChannel(channel.id),
        command,
        options,
      )
      .reply();
  }

  /** Answer every `method path` request with `response` instead of the Model, e.g. a 503. */
  fail(method: string, path: string, response: RestResponse) {
    this.mock.use(method, path, () => response);
  }

  /** Shut down; throws if the bot made a request the mock can't answer truthfully. */
  async close() {
    try {
      this.mock.assertNoUnhandledRequests();
    } finally {
      await this.mock.close();
    }
  }
}

export async function createDiscord(): Promise<Discord> {
  return new Discord(await createDiscordMock());
}
