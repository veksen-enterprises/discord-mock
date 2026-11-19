import type { DiscordMock } from "./mock.js";
import { computePermissions, guildPayload, Permission } from "./payloads.js";
import { respond, type RestHandler } from "./rest.js";
import type { GuildRecord } from "./state.js";

// Guild Routes. Sources: discord-api-docs resources/user (Get Current User Guilds) and
// resources/guild (Get Guild, Modify Guild), events/gateway-events#guild-update.

const unknownGuild = () => respond.error(404, 10004, "Unknown Guild");

export function registerGuildRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state } = mock;
  const bot = state.bot.id;
  const counts = (guild: GuildRecord, withCounts: string | null) =>
    withCounts === "true"
      ? {
          approximate_member_count: guild.members.size,
          // The Model has no presences.
          approximate_presence_count: 0,
        }
      : {};

  // Get Current User Guilds: partial guilds, 200 by default, after/before by id. Ascending id
  // order is inferred, not checked.
  rest.route(
    "GET",
    "/users/@me/guilds",
    authed((req) => {
      const after = BigInt(req.query.get("after") ?? 0);
      const before = req.query.get("before");
      const limit = Math.min(200, Number(req.query.get("limit") ?? 200));
      const guilds = [...state.guilds.values()]
        .filter((g) => state.botIn(g.id))
        .filter((g) => BigInt(g.id) > after)
        .filter((g) => !before || BigInt(g.id) < BigInt(before))
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      return respond.json(
        guilds.slice(0, limit).map((guild) => ({
          id: guild.id,
          name: guild.name,
          icon: null,
          banner: null,
          owner: guild.ownerId === bot,
          permissions: String(computePermissions(state, guild, bot)),
          features: [],
          ...counts(guild, req.query.get("with_counts")),
        })),
      );
    }),
  );

  // Get Guild: approximate counts with `with_counts=true`, which discord.js's guilds.fetch sends.
  rest.route(
    "GET",
    "/guilds/:guildId",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return unknownGuild();
      return respond.json({
        ...guildPayload(guild),
        ...counts(guild, req.query.get("with_counts")),
      });
    }),
  );

  // Modify Guild: MANAGE_GUILD, returns the guild, fires GUILD_UPDATE. Only `name` (2 to 100
  // characters, trimmed) is modelled; another field is a Gap.
  rest.route(
    "PATCH",
    "/guilds/:guildId",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return unknownGuild();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const other = Object.keys(body).find((key) => key !== "name");
      if (other) return rest.gap(`PATCH guild ${other}`);
      if (!(computePermissions(state, guild, bot) & Permission.ManageGuild))
        return respond.missingPermissions();
      if ("name" in body) {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        // Which errors entry Discord gives is unchecked; the code is Invalid Form Body.
        if (name.length < 2 || name.length > 100)
          return respond.invalidFormBody();
        mock.renameGuild(guild, name);
      }
      return respond.json(guildPayload(guild));
    }),
  );

  // Get Guild Widget Settings and Modify Guild Widget (docs.discord.food/resources/guild), both
  // with Manage Server. 50013 without it is inferred, not checked. A channel that isn't one of the
  // guild's has no documented code: a Gap. The 30042 limit on changes isn't modelled.
  const widgetGuild = (guildId: string) => {
    const guild = state.guilds.get(guildId);
    if (!guild) return { refused: unknownGuild() };
    if (!(computePermissions(state, guild, bot) & Permission.ManageGuild))
      return { refused: respond.missingPermissions() };
    return { guild };
  };
  rest.route(
    "GET",
    "/guilds/:guildId/widget",
    authed((req) => {
      const { refused, guild } = widgetGuild(req.params.guildId!);
      return refused ?? respond.json(guild!.widget);
    }),
  );
  rest.route(
    "PATCH",
    "/guilds/:guildId/widget",
    authed((req) => {
      const { refused, guild } = widgetGuild(req.params.guildId!);
      if (refused) return refused;
      const body = (req.body ?? {}) as {
        enabled?: boolean;
        channel_id?: string | null;
      };
      const other = Object.keys(body).find(
        (k) => k !== "enabled" && k !== "channel_id",
      );
      if (other) return rest.gap(`PATCH widget ${other}`);
      if (
        typeof body.channel_id === "string" &&
        !guild!.channelIds.includes(body.channel_id)
      )
        return rest.gap("a widget channel outside the guild");
      if (body.enabled !== undefined) guild!.widget.enabled = body.enabled;
      if (body.channel_id !== undefined)
        guild!.widget.channel_id = body.channel_id;
      return respond.json(guild!.widget);
    }),
  );
}
