import type { APIMessage } from "discord-api-types/v10";
import {
  createDiscordMock,
  type DiscordMock,
  type RestResponse,
} from "../../src/internal/mock.js";

/** Channels by name; `category` puts the channel in a category of that name. */
type GuildSpec = { channels: Record<string, { category?: string }> };
/** Users by name; `guilds` lists the guilds they're a member of, with an optional nickname. */
type UserSpec<G extends string> = {
  guilds: Partial<Record<G, { nick?: string }>>;
};

declare const guildOf: unique symbol;
declare const kind: unique symbol;
/** A text channel in guild `G`. */
export type TextChannel<G extends string> = {
  id: string;
  [guildOf]: G;
  [kind]: "text";
};
/** A user who is a member of the guilds `G`. */
export type Member<G extends string> = {
  id: string;
  [guildOf]: G;
  [kind]: "member";
};

type MemberGuilds<U> = U extends { guilds: infer M } ? keyof M & string : never;

export type World<
  Gs extends Record<string, GuildSpec>,
  Us extends Record<string, UserSpec<keyof Gs & string>>,
> = {
  guilds: {
    [g in keyof Gs & string]: {
      id: string;
      channels: { [c in keyof Gs[g]["channels"]]: TextChannel<g> };
    };
  };
  users: { [u in keyof Us]: Member<MemberGuilds<Us[u]>> };
};

/**
 * A fake Discord built from a World spec. The handles in `guilds` and `users` are typed from the
 * spec, so a misspelled channel, or a user running a command in a guild they aren't in, doesn't compile.
 */
export class Discord<
  Gs extends Record<string, GuildSpec>,
  Us extends Record<string, UserSpec<keyof Gs & string>>,
> {
  /** Spread `clientOptions` into `new Client()` and log in with `token`. */
  readonly bot: {
    token: string;
    applicationId: string;
    clientOptions: { rest: { api: string } };
  };
  readonly guilds: World<Gs, Us>["guilds"];
  readonly users: World<Gs, Us>["users"];

  constructor(
    private mock: DiscordMock,
    spec: { guilds: Gs; users: Us },
  ) {
    this.bot = {
      token: mock.token,
      applicationId: mock.state.applicationId,
      clientOptions: mock.clientOptions,
    };
    const guilds: Record<
      string,
      { id: string; channels: Record<string, unknown> }
    > = {};
    for (const [name, g] of Object.entries(spec.guilds)) {
      const guild = mock.createGuild(name);
      const categories = new Map<string, string>();
      const channels: Record<string, unknown> = {};
      for (const [channelName, c] of Object.entries(g.channels)) {
        let parentId: string | undefined;
        if (c.category) {
          parentId = categories.get(c.category);
          if (!parentId) {
            parentId = mock.state.createCategoryChannel(guild.id, {
              name: c.category,
            }).id;
            categories.set(c.category, parentId);
          }
        }
        channels[channelName] = mock.state.createTextChannel(guild.id, {
          name: channelName,
          parentId,
        });
      }
      guilds[name] = { id: guild.id, channels };
    }
    const users: Record<string, unknown> = {};
    for (const [name, u] of Object.entries(spec.users)) {
      const user = mock.createUser(name);
      for (const [guildName, m] of Object.entries(u.guilds))
        mock.state.addMember(guilds[guildName]!.id, user.id, {
          nick: (m as { nick?: string } | undefined)?.nick,
        });
      users[name] = { id: user.id };
    }
    this.guilds = guilds as World<Gs, Us>["guilds"];
    this.users = users as World<Gs, Us>["users"];
  }

  /**
   * `member` runs `/command` in `channel`. Resolves with the reply once it's visible (after any
   * defer); rejects if the bot never gets there.
   */
  run<G extends string>(
    member: Member<G>,
    channel: TextChannel<NoInfer<G>>,
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

export async function createDiscord<
  const Gs extends Record<string, GuildSpec>,
  const Us extends Record<string, UserSpec<keyof Gs & string>>,
>(spec: { guilds: Gs; users: Us }): Promise<Discord<Gs, Us>> {
  return new Discord(await createDiscordMock(), spec);
}
