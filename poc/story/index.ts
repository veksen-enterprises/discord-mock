import type { APIMessage } from "discord-api-types/v10";
import { MessageFlags } from "discord-api-types/v10";
import { expect } from "vitest";
import {
  createDiscordMock,
  type DiscordMock,
  type RestResponse,
} from "../../src/internal/mock.js";

/**
 * A fake Discord you describe and drive by name, the way a user would talk about a server:
 * `discord.guild("sin").channel("#challenges", { category: "Test Ladder" }).member("alice")`, then
 * `discord.as("alice").in("#challenges").run("/join")`.
 */
export class Discord {
  /** Spread `clientOptions` into `new Client()` and log in with `token`. */
  readonly bot: {
    token: string;
    applicationId: string;
    clientOptions: { rest: { api: string } };
  };
  private guildIds = new Map<string, string>();

  constructor(private mock: DiscordMock) {
    this.bot = {
      token: mock.token,
      applicationId: mock.state.applicationId,
      clientOptions: mock.clientOptions,
    };
  }

  /** The guild called `name`, created on first use. Chain `.channel()` and `.member()` on it. */
  guild(name: string) {
    let id = this.guildIds.get(name);
    if (!id) {
      id = this.mock.createGuild(name).id;
      this.guildIds.set(name, id);
    }
    const guildId = id;
    const builder = {
      id: guildId,
      /** A text channel; name it with its `#`. `category` creates or reuses a category of that name. */
      channel: (name: string, opts: { category?: string } = {}) => {
        let parentId: string | undefined;
        if (opts.category) {
          parentId =
            this.findChannel(opts.category, guildId)?.id ??
            this.mock.state.createCategoryChannel(guildId, {
              name: opts.category,
            }).id;
        }
        this.mock.state.createTextChannel(guildId, {
          name: name.replace(/^#/, ""),
          parentId,
        });
        return builder;
      },
      /** A user called `name`, created on first use, joining this guild. */
      member: (name: string, opts: { nick?: string } = {}) => {
        const user =
          [...this.mock.state.users.values()].find(
            (u) => u.username === name,
          ) ?? this.mock.createUser(name);
        this.mock.state.addMember(guildId, user.id, opts);
        return builder;
      },
    };
    return builder;
  }

  /** Act as the user called `name`: `.in("#channel").run("/command", options)`. */
  as(name: string) {
    const user = [...this.mock.state.users.values()].find(
      (u) => u.username === name,
    );
    if (!user) throw new Error(`discord-mock: no user called "${name}"`);
    return {
      in: (channelName: string) => {
        const channel = this.findChannel(channelName.replace(/^#/, ""));
        if (!channel)
          throw new Error(`discord-mock: no channel called "${channelName}"`);
        return {
          /** Resolves with the reply once it's visible; rejects if the bot never gets there. */
          run: (
            command: string,
            options: Record<string, string | number | boolean> = {},
          ): Promise<APIMessage> =>
            this.mock
              .as(user)
              .slashCommand(channel, command.replace(/^\//, ""), options)
              .reply(),
        };
      },
    };
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

  private findChannel(name: string, guildId?: string) {
    const matches = [...this.mock.state.channels.values()].filter(
      (c) =>
        "name" in c &&
        c.name === name &&
        (!guildId || ("guild_id" in c && c.guild_id === guildId)),
    );
    if (matches.length > 1)
      throw new Error(
        `discord-mock: ${matches.length} channels called "${name}"`,
      );
    return matches[0];
  }
}

export async function createDiscord(): Promise<Discord> {
  return new Discord(await createDiscordMock());
}

/** Matchers that read like what the user sees. Registered when this module is imported. */
expect.extend({
  toBeEphemeral(received: APIMessage) {
    const pass = !!((received.flags ?? 0) & MessageFlags.Ephemeral);
    return {
      pass,
      message: () => `expected the reply ${pass ? "not " : ""}to be ephemeral`,
    };
  },
  toShowEmbed(received: APIMessage, title: string) {
    const titles = received.embeds.map((e) => e.title);
    const pass = titles.includes(title);
    return {
      pass,
      message: () =>
        `expected an embed titled "${title}", got ${JSON.stringify(titles)}`,
    };
  },
});

declare module "vitest" {
  interface Matchers<R extends void | Promise<void>, T = unknown> {
    toBeEphemeral(): R;
    toShowEmbed(title: string): R;
  }
}
