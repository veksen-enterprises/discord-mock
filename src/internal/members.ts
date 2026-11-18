import {
  GatewayDispatchEvents,
  GatewayIntentBits,
  type APIBan,
  type APIGuildMember,
  type APIRole,
} from "discord-api-types/v10";
import type { DiscordMock } from "./mock.js";
import { computePermissions, Permission } from "./payloads.js";
import { respond, type RestHandler, type RestRequest } from "./rest.js";
import { snowflake } from "./snowflake.js";
import type { GuildRecord } from "./state.js";

// Guild member, ban and role Routes. Sources: discord-api-docs resources/guild (Get/Modify Guild
// Member, Add/Remove Guild Member Role, Remove Guild Member, Create/Remove/Get Guild Ban, Get Guild
// Bans, Create/Modify/Delete Guild Role),
// topics/permissions#permission-hierarchy, and docs.discord.food/resources/guild. Which JSON code
// each refusal carries isn't documented per route: the pairings below come from Discord's code
// table and are inferred, not checked.

const unknownMember = () => respond.error(404, 10007, "Unknown Member");
const unknownRole = () => respond.error(404, 10011, "Unknown Role");
const unknownBan = () => respond.error(404, 10026, "Unknown Ban");
const unknownGuild = () => respond.error(404, 10004, "Unknown Guild");
// "up to 28 days in the future" (Modify Guild Member, communication_disabled_until).
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

export function registerMemberRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state, gateway } = mock;
  const bot = state.bot.id;

  const guildOf = (req: RestRequest) => state.guilds.get(req.params.guildId!);
  const userOf = (req: RestRequest) =>
    req.params.userId === "@me" ? bot : req.params.userId!;
  const botHas = (guild: GuildRecord, needed: bigint) =>
    (computePermissions(state, guild, bot) & needed) === needed;
  const highest = (guild: GuildRecord, userId: string) =>
    Math.max(
      0,
      ...(guild.members.get(userId)?.roles ?? []).map(
        (id) => guild.roles.get(id)?.position ?? 0,
      ),
    );
  // "A bot can only kick, ban, and edit nicknames for users whose highest role is lower than the
  // bot's highest role." Nobody acts on the owner (discord.js GuildMember.manageable).
  const outranks = (guild: GuildRecord, targetId: string) =>
    targetId !== guild.ownerId &&
    (guild.ownerId === bot || highest(guild, bot) > highest(guild, targetId));
  const announceUpdate = (guild: GuildRecord, member: APIGuildMember) =>
    gateway.dispatch(
      GatewayDispatchEvents.GuildMemberUpdate,
      { ...member, guild_id: guild.id },
      GatewayIntentBits.GuildMembers,
    );

  // docs.discord.food/resources/guild#leave-guild: 204. An owner can't leave without handing the
  // guild over; what Discord answers then is unchecked, so it's a Gap.
  rest.route(
    "DELETE",
    "/users/@me/guilds/:guildId",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      if (guild.ownerId === bot)
        return rest.gap("the bot leaving a guild it owns");
      mock.removeBot(guild);
      return respond.noContent();
    }),
  );

  rest.route(
    "GET",
    "/guilds/:guildId/members/:userId",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const member = guild.members.get(userOf(req));
      return member ? respond.json(member) : unknownMember();
    }),
  );

  rest.route(
    "PATCH",
    "/guilds/:guildId/members/:userId",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const userId = userOf(req);
      const member = guild.members.get(userId);
      if (!member) return unknownMember();
      const body = (req.body ?? {}) as Record<string, unknown>;
      for (const key of ["mute", "deaf", "channel_id", "flags"])
        if (key in body) return rest.gap(`PATCH member ${key}`);
      const self = userId === bot;

      if ("nick" in body) {
        // Your own nickname needs CHANGE_NICKNAME; someone else's MANAGE_NICKNAMES and the hierarchy.
        const allowed = self
          ? botHas(guild, Permission.ChangeNickname)
          : botHas(guild, Permission.ManageNicknames) &&
            outranks(guild, userId);
        if (!allowed) return respond.missingPermissions();
      }
      if ("roles" in body) {
        const roles = (body.roles as string[] | null) ?? [];
        if (roles.some((id) => !guild.roles.has(id))) return unknownRole();
        // "A bot can grant roles to other users that are of a lower position than its own highest role."
        const changed = [
          ...roles.filter((id) => !member.roles.includes(id)),
          ...member.roles.filter((id) => !roles.includes(id)),
        ];
        if (
          !botHas(guild, Permission.ManageRoles) ||
          changed.some(
            (id) => guild.roles.get(id)!.position >= highest(guild, bot),
          )
        )
          return respond.missingPermissions();
      }
      if ("communication_disabled_until" in body) {
        const until = body.communication_disabled_until as string | null;
        // "Will throw a 403 error if the user has the ADMINISTRATOR permission or is the owner."
        const isAdmin =
          (computePermissions(state, guild, userId) &
            Permission.Administrator) !==
          0n;
        if (
          !botHas(guild, Permission.ModerateMembers) ||
          !outranks(guild, userId) ||
          isAdmin
        )
          return respond.missingPermissions();
        if (until && Date.parse(until) - Date.now() > MAX_TIMEOUT_MS)
          return respond.invalidFormBody();
      }

      if ("nick" in body) member.nick = (body.nick as string | null) || null;
      if ("roles" in body)
        member.roles = [...((body.roles as string[] | null) ?? [])];
      if ("communication_disabled_until" in body)
        member.communication_disabled_until =
          (body.communication_disabled_until as string | null) ?? null;
      announceUpdate(guild, member);
      return respond.json(member);
    }),
  );

  const memberRole = (add: boolean) =>
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const member = guild.members.get(req.params.userId!);
      if (!member) return unknownMember();
      const role = guild.roles.get(req.params.roleId!);
      if (!role) return unknownRole();
      if (
        !botHas(guild, Permission.ManageRoles) ||
        role.position >= highest(guild, bot)
      )
        return respond.missingPermissions();
      const had = member.roles.includes(role.id);
      if (add && !had) member.roles.push(role.id);
      if (!add && had)
        member.roles = member.roles.filter((id) => id !== role.id);
      if (add !== had) announceUpdate(guild, member);
      return respond.noContent();
    });
  rest.route(
    "PUT",
    "/guilds/:guildId/members/:userId/roles/:roleId",
    memberRole(true),
  );
  rest.route(
    "DELETE",
    "/guilds/:guildId/members/:userId/roles/:roleId",
    memberRole(false),
  );

  rest.route(
    "DELETE",
    "/guilds/:guildId/members/:userId",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const userId = req.params.userId!;
      if (!guild.members.has(userId)) return unknownMember();
      if (!botHas(guild, Permission.KickMembers) || !outranks(guild, userId))
        return respond.missingPermissions();
      mock.removeMember(guild, state.requireUser(userId));
      return respond.noContent();
    }),
  );

  // GUILD_BAN_ADD/REMOVE: GUILD_MODERATION intent, "only sent to bots with the BAN_MEMBERS or
  // VIEW_AUDIT_LOG permission".
  const announceBan = (guild: GuildRecord, t: string, ban: APIBan) => {
    if (
      botHas(guild, Permission.BanMembers) ||
      botHas(guild, Permission.ViewAuditLog)
    )
      gateway.dispatch(
        t,
        { guild_id: guild.id, user: ban.user },
        GatewayIntentBits.GuildModeration,
      );
  };

  rest.route(
    "PUT",
    "/guilds/:guildId/bans/:userId",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const userId = req.params.userId!;
      const user = state.users.get(userId);
      if (!user) return respond.error(404, 10013, "Unknown User");
      if (
        !botHas(guild, Permission.BanMembers) ||
        (guild.members.has(userId) && !outranks(guild, userId))
      )
        return respond.missingPermissions();
      // Deleting the user's recent messages isn't modelled: say so rather than pretend.
      const seconds = Number(req.body?.delete_message_seconds ?? 0);
      if (seconds > 0) return rest.gap("ban with delete_message_seconds");
      const ban: APIBan = {
        user,
        reason:
          (req.headers["x-audit-log-reason"] as string | undefined) ?? null,
      };
      guild.bans.set(userId, ban);
      // docs.discord.food: "Fires a Guild Ban Add and optionally a Guild Member Remove".
      if (guild.members.has(userId)) mock.removeMember(guild, user);
      announceBan(guild, GatewayDispatchEvents.GuildBanAdd, ban);
      return respond.noContent();
    }),
  );

  rest.route(
    "DELETE",
    "/guilds/:guildId/bans/:userId",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      if (!botHas(guild, Permission.BanMembers))
        return respond.missingPermissions();
      const ban = guild.bans.get(req.params.userId!);
      if (!ban) return unknownBan();
      guild.bans.delete(req.params.userId!);
      announceBan(guild, GatewayDispatchEvents.GuildBanRemove, ban);
      return respond.noContent();
    }),
  );

  const canReadBans = (guild: GuildRecord) =>
    botHas(guild, Permission.BanMembers) ||
    botHas(guild, Permission.ViewAuditLog);

  rest.route(
    "GET",
    "/guilds/:guildId/bans/:userId",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      if (!canReadBans(guild)) return respond.missingPermissions();
      const ban = guild.bans.get(req.params.userId!);
      return ban ? respond.json(ban) : unknownBan();
    }),
  );

  rest.route(
    "GET",
    "/guilds/:guildId/bans",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      if (!canReadBans(guild)) return respond.missingPermissions();
      // "Users will always be returned in ascending order by user.id. If both before and after are
      // provided, only before is respected."
      const limit = Number(req.query.get("limit") ?? 1000);
      const before = req.query.get("before");
      const after = before ? null : req.query.get("after");
      const ids = [...guild.bans.keys()]
        .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
        .filter((id) => !before || BigInt(id) < BigInt(before))
        .filter((id) => !after || BigInt(id) > BigInt(after));
      const page = before ? ids.slice(-limit) : ids.slice(0, limit);
      return respond.json(page.map((id) => guild.bans.get(id)!));
    }),
  );

  // topics/permissions#permission-hierarchy: "A bot can edit roles of a lower position than its
  // highest role, but it can only grant permissions it has to those roles." The 50013 for either
  // is inferred, not checked.
  const grantable = (guild: GuildRecord, permissions: unknown) =>
    permissions == null ||
    botHas(guild, BigInt(permissions as string | number));
  const announceRole = (
    guild: GuildRecord,
    t: string,
    payload: { role: APIRole } | { role_id: string },
  ) =>
    gateway.dispatch(
      t,
      { guild_id: guild.id, ...payload },
      GatewayIntentBits.Guilds,
    );
  const ROLE_FIELDS = ["name", "permissions", "colors", "hoist", "mentionable"];

  // docs.discord.food/resources/guild#list-guild-roles: every role. "User must be a member of the guild."
  rest.route(
    "GET",
    "/guilds/:guildId/roles",
    authed((req) => {
      const guild = guildOf(req);
      return guild ? respond.json([...guild.roles.values()]) : unknownGuild();
    }),
  );

  // Create Guild Role: "All JSON params are optional"; name defaults to "new role", permissions to
  // @everyone's. Fires GUILD_ROLE_CREATE. Where the new role sits isn't documented: the mock puts
  // it at position 1, just above @everyone, as Discord's app shows new roles (inferred, not checked).
  rest.route(
    "POST",
    "/guilds/:guildId/roles",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const other = Object.keys(body).find((key) => !ROLE_FIELDS.includes(key));
      if (other) return rest.gap(`create role with ${other}`);
      if (
        !botHas(guild, Permission.ManageRoles) ||
        !grantable(guild, body.permissions)
      )
        return respond.missingPermissions();
      for (const role of guild.roles.values())
        if (role.position >= 1) role.position++;
      const everyone = guild.roles.get(guild.id)!;
      const role: APIRole = {
        ...everyone,
        ...body,
        id: snowflake(),
        name: (body.name as string | undefined) ?? "new role",
        permissions: String(body.permissions ?? everyone.permissions),
        position: 1,
      };
      guild.roles.set(role.id, role);
      announceRole(guild, GatewayDispatchEvents.GuildRoleCreate, { role });
      return respond.json(role);
    }),
  );

  // Modify Guild Role: "All parameters to this endpoint are optional and nullable." Fires
  // GUILD_ROLE_UPDATE.
  rest.route(
    "PATCH",
    "/guilds/:guildId/roles/:roleId",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const role = guild.roles.get(req.params.roleId!);
      if (!role) return unknownRole();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const other = Object.keys(body).find((key) => !ROLE_FIELDS.includes(key));
      if (other) return rest.gap(`modify role ${other}`);
      if (
        !botHas(guild, Permission.ManageRoles) ||
        (guild.ownerId !== bot && role.position >= highest(guild, bot)) ||
        !grantable(guild, body.permissions)
      )
        return respond.missingPermissions();
      Object.assign(role, body, {
        ...(body.permissions == null
          ? {}
          : { permissions: String(body.permissions) }),
      });
      announceRole(guild, GatewayDispatchEvents.GuildRoleUpdate, { role });
      return respond.json(role);
    }),
  );

  // Delete Guild Role: 204, fires GUILD_ROLE_DELETE. @everyone can't be deleted; 50028 Invalid
  // Role is the code table's closest entry, so the pairing is inferred.
  rest.route(
    "DELETE",
    "/guilds/:guildId/roles/:roleId",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const role = guild.roles.get(req.params.roleId!);
      if (!role) return unknownRole();
      if (role.id === guild.id)
        return respond.error(400, 50028, "Invalid Role");
      if (
        !botHas(guild, Permission.ManageRoles) ||
        (guild.ownerId !== bot && role.position >= highest(guild, bot))
      )
        return respond.missingPermissions();
      guild.roles.delete(role.id);
      for (const member of guild.members.values())
        member.roles = member.roles.filter((id) => id !== role.id);
      announceRole(guild, GatewayDispatchEvents.GuildRoleDelete, {
        role_id: role.id,
      });
      return respond.noContent();
    }),
  );
}
