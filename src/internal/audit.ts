import {
  AuditLogEvent,
  GatewayDispatchEvents,
  GatewayIntentBits,
  type APIAuditLogChange,
  type APIAuditLogEntry,
} from "discord-api-types/v10";
import type { DiscordMock } from "./mock.js";
import { computePermissions, Permission } from "./payloads.js";
import { respond, type RestHandler, type RestRequest } from "./rest.js";
import { snowflake } from "./snowflake.js";
import type { GuildRecord } from "./state.js";

// The audit log, for member moderation and message deletes. Sources: discord-api-docs
// resources/audit-log (entry, change and optional info objects, $add/$remove for roles, Get Guild
// Audit Log, X-Audit-Log-Reason), events/gateway-events#guild-audit-log-entry-create ("only sent
// to bots with the VIEW_AUDIT_LOG permission"), events/gateway (GUILD_MODERATION).

/** The `X-Audit-Log-Reason` header, which carries "URL-encoded UTF-8 characters". */
export function reasonOf(req: RestRequest): string | undefined {
  const header = req.headers["x-audit-log-reason"];
  return typeof header === "string" ? decodeURIComponent(header) : undefined;
}

export function recordAudit(
  mock: DiscordMock,
  guild: GuildRecord,
  entry: {
    action_type: AuditLogEvent;
    user_id: string;
    target_id: string | null;
    changes?: APIAuditLogChange[];
    options?: APIAuditLogEntry["options"];
    reason?: string;
  },
) {
  const { state } = mock;
  const full = { id: snowflake(), ...entry } as APIAuditLogEntry;
  const log = state.auditLog.get(guild.id) ?? [];
  state.auditLog.set(guild.id, log);
  log.push(full);
  if (
    state.botIn(guild.id) &&
    computePermissions(state, guild, state.bot.id) & Permission.ViewAuditLog
  )
    mock.gateway.dispatch(
      GatewayDispatchEvents.GuildAuditLogEntryCreate,
      { ...full, guild_id: guild.id },
      GatewayIntentBits.GuildModeration,
    );
}

export function registerAuditLogRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state } = mock;

  // Get Guild Audit Log: VIEW_AUDIT_LOG; filters user_id and action_type; newest first, or oldest
  // first with `after`; limit 1-100, 50 by default.
  rest.route(
    "GET",
    "/guilds/:guildId/audit-logs",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return respond.error(404, 10004, "Unknown Guild");
      if (
        !(
          computePermissions(state, guild, state.bot.id) &
          Permission.ViewAuditLog
        )
      )
        return respond.missingPermissions();
      const q = (name: string) => req.query.get(name);
      const after = q("after");
      const limit = Math.min(100, Number(q("limit") ?? 50));
      const entries = (state.auditLog.get(guild.id) ?? [])
        .filter((e) => !q("user_id") || e.user_id === q("user_id"))
        .filter(
          (e) =>
            !q("action_type") || e.action_type === Number(q("action_type")),
        )
        .filter((e) => !q("before") || BigInt(e.id) < BigInt(q("before")!))
        .filter((e) => !after || BigInt(e.id) > BigInt(after));
      const ordered = after ? entries : [...entries].reverse();
      const page = ordered.slice(0, limit);
      const userIds = new Set(
        page
          .flatMap((e) => [e.user_id, e.target_id])
          .filter((id) => id && state.users.has(id)),
      );
      return respond.json({
        application_commands: [],
        audit_log_entries: page,
        auto_moderation_rules: [],
        guild_scheduled_events: [],
        integrations: [],
        threads: [],
        users: [...userIds].map((id) => state.requireUser(id!)),
        webhooks: [],
      });
    }),
  );
}
