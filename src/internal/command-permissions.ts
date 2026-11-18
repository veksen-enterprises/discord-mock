import {
  GatewayDispatchEvents,
  type APIApplicationCommandPermission,
} from "discord-api-types/v10";
import type { DiscordMock } from "./mock.js";
import { respond, type RestHandler } from "./rest.js";
import type { GuildRecord } from "./state.js";

// Command permission overrides, which a guild's admins set in Server Settings > Integrations.
// Sources: discord-api-docs interactions/application-commands#permissions (the guild application
// command permissions object; "When the id field is the application ID instead of a command ID,
// the permissions apply to all commands"; Get Guild Application Command Permissions; Get
// Application Command Permissions; Edit needs a Bearer token), events/gateway-events
// #application-command-permissions-update, change-log "Upcoming Application Command Permission
// Changes" (command-level overrides beat default_member_permissions).

/** The overrides for `id` (a command id, or the application id for all commands) in `guild`. */
export function overridesFor(
  mock: DiscordMock,
  guild: GuildRecord,
  id: string,
) {
  return mock.state.commandPermissions.get(guild.id)?.get(id);
}

/**
 * An admin sets the overrides for `id` in `guild`, replacing what was there, and the bot hears
 * APPLICATION_COMMAND_PERMISSIONS_UPDATE. No intent gates it in the docs' intents list.
 */
export function setCommandPermissions(
  mock: DiscordMock,
  guild: GuildRecord,
  id: string,
  permissions: APIApplicationCommandPermission[],
) {
  const { state } = mock;
  const byId = state.commandPermissions.get(guild.id) ?? new Map();
  state.commandPermissions.set(guild.id, byId);
  byId.set(id, permissions);
  mock.gateway.dispatch(
    GatewayDispatchEvents.ApplicationCommandPermissionsUpdate,
    payload(mock, guild.id, id, permissions),
  );
}

function payload(
  mock: DiscordMock,
  guildId: string,
  id: string,
  permissions: APIApplicationCommandPermission[],
) {
  return {
    id,
    application_id: mock.state.applicationId,
    guild_id: guildId,
    permissions,
  };
}

/** Registered before the command Routes: `/commands/permissions` would match `/commands/:commandId`. */
export function registerCommandPermissionRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state } = mock;
  const base = "/applications/:appId/guilds/:guildId/commands";

  rest.route(
    "GET",
    `${base}/permissions`,
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return respond.error(404, 10004, "Unknown Guild");
      return respond.json(
        [...(state.commandPermissions.get(guild.id) ?? [])].map(
          ([id, permissions]) => payload(mock, guild.id, id, permissions),
        ),
      );
    }),
  );

  // A command without overrides: 10066 "Unknown application command permissions" from the code
  // table (pairing inferred, not checked).
  rest.route(
    "GET",
    `${base}/:commandId/permissions`,
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return respond.error(404, 10004, "Unknown Guild");
      const permissions = overridesFor(mock, guild, req.params.commandId!);
      if (!permissions)
        return respond.error(
          404,
          10066,
          "Unknown application command permissions",
        );
      return respond.json(
        payload(mock, guild.id, req.params.commandId!, permissions),
      );
    }),
  );

  // Edit needs an admin's Bearer token, which the mock has no OAuth for, and "authenticating with
  // a bot token will result in an error" the docs don't give. Either way, a Gap.
  rest.route("PUT", `${base}/:commandId/permissions`, () =>
    rest.gap("editing command permissions, which needs a Bearer token"),
  );
}
