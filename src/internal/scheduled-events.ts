import {
  AuditLogEvent,
  ChannelType,
  GatewayDispatchEvents,
  GatewayIntentBits,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  type APIChannel,
  type APIGuildScheduledEvent,
  type APIUser,
} from "discord-api-types/v10";
import { recordAudit } from "./audit.js";
import type { DiscordMock } from "./mock.js";
import { computePermissions, Permission } from "./payloads.js";
import { respond, type RestHandler } from "./rest.js";
import { snowflake } from "./snowflake.js";
import type { GuildRecord } from "./state.js";

// Guild scheduled events that members create in the Discord app. Sources: discord-api-docs
// resources/guild-scheduled-event (the object, field requirements by entity type, List and Get,
// Permissions Requirements), events/gateway-events (Guild Scheduled Event Create, Update, Delete:
// "The inner payload is a guild scheduled event object"), events/gateway (GUILD_SCHEDULED_EVENTS),
// resources/audit-log (GUILD_SCHEDULED_EVENT_CREATE 100, UPDATE 101, DELETE 102). The bot
// creating, editing or deleting events has no Route yet, so it's a Gap. Stage events aren't
// modelled.

/** Where an event happens: a voice channel, or a place outside Discord. */
export type EventPlace = { channel: APIChannel } | { location: string };

export interface EventInput {
  name: string;
  start: Date;
  place: EventPlace;
  description?: string;
}

const unknownEvent = () =>
  respond.error(404, 10070, "Unknown Guild Scheduled Event");

/**
 * Permissions Requirements: a VOICE event needs CREATE_EVENTS, VIEW_CHANNEL and CONNECT in its
 * channel; an EXTERNAL one CREATE_EVENTS in the guild. Editing or deleting someone else's event
 * needs MANAGE_EVENTS in place of CREATE_EVENTS.
 */
function requireEventPermissions(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  event: { channel_id: string | null; creator_id?: string | null },
  verb: string,
) {
  const channel = event.channel_id
    ? mock.state.requireChannel(event.channel_id)
    : undefined;
  const perms = computePermissions(mock.state, guild, user.id, channel);
  const own = !event.creator_id || event.creator_id === user.id;
  const manage = own
    ? Permission.CreateEvents | Permission.ManageEvents
    : Permission.ManageEvents;
  const voice = Permission.ViewChannel | Permission.Connect;
  if (!(perms & manage) || (channel && (perms & voice) !== voice))
    throw new Error(
      `discordjs-test-kit: ${user.username} can't ${verb} that event without ${own ? "Create Events" : "Manage Events"}${channel ? ", View Channel and Connect in its channel" : ""}`,
    );
}

function announce(
  mock: DiscordMock,
  t:
    | GatewayDispatchEvents.GuildScheduledEventCreate
    | GatewayDispatchEvents.GuildScheduledEventUpdate
    | GatewayDispatchEvents.GuildScheduledEventDelete,
  event: APIGuildScheduledEvent,
) {
  // Every bot in the guild with the intent hears it, whatever the event's channel (inferred, not
  // checked: the docs name no permission for receiving it).
  mock.gateway.dispatch(t, event, GatewayIntentBits.GuildScheduledEvents);
}

/** `user` creates a scheduled event in `guild`, as from the Discord app. */
export function createScheduledEvent(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  input: EventInput,
): APIGuildScheduledEvent {
  const channel = "channel" in input.place ? input.place.channel : undefined;
  if (channel && channel.type !== ChannelType.GuildVoice)
    throw new Error(
      "discordjs-test-kit: an event's channel must be a voice channel (stage events aren't modelled)",
    );
  if (input.name.length < 1 || input.name.length > 100)
    throw new Error("discordjs-test-kit: an event's name is 1-100 characters");
  requireEventPermissions(
    mock,
    guild,
    user,
    { channel_id: channel?.id ?? null },
    "create",
  );
  const event: APIGuildScheduledEvent = {
    id: snowflake(),
    guild_id: guild.id,
    channel_id: channel?.id ?? null,
    creator_id: user.id,
    creator: user,
    name: input.name,
    description: input.description ?? null,
    scheduled_start_time: input.start.toISOString(),
    // EXTERNAL requires an end time; the Discord app's default isn't documented, so the Mock
    // ends a place event an hour after it starts.
    scheduled_end_time: channel
      ? null
      : new Date(input.start.getTime() + 3_600_000).toISOString(),
    privacy_level: GuildScheduledEventPrivacyLevel.GuildOnly,
    status: GuildScheduledEventStatus.Scheduled,
    entity_type: channel
      ? GuildScheduledEventEntityType.Voice
      : GuildScheduledEventEntityType.External,
    entity_id: null,
    entity_metadata:
      "location" in input.place ? { location: input.place.location } : null,
    image: null,
    recurrence_rule: null,
  } as APIGuildScheduledEvent;
  mock.state.scheduledEvents.set(event.id, event);
  announce(mock, GatewayDispatchEvents.GuildScheduledEventCreate, event);
  recordAudit(mock, guild, {
    action_type: AuditLogEvent.GuildScheduledEventCreate,
    user_id: user.id,
    target_id: event.id,
    changes: [{ key: "name", new_value: event.name }],
  });
  return event;
}

/** `user` edits `event`'s name, description or start time. */
export function editScheduledEvent(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  event: APIGuildScheduledEvent,
  changes: { name?: string; description?: string; start?: Date },
) {
  requireEventPermissions(mock, guild, user, event, "edit");
  // Status transitions: a COMPLETED or CANCELED event "can no longer be updated".
  if (event.status !== GuildScheduledEventStatus.Scheduled)
    throw new Error("discordjs-test-kit: only a scheduled event can be edited");
  const before = { ...event };
  if (changes.name !== undefined) event.name = changes.name;
  if (changes.description !== undefined)
    event.description = changes.description;
  if (changes.start) {
    const shift =
      changes.start.getTime() - Date.parse(event.scheduled_start_time);
    event.scheduled_start_time = changes.start.toISOString();
    if (event.scheduled_end_time)
      event.scheduled_end_time = new Date(
        Date.parse(event.scheduled_end_time) + shift,
      ).toISOString();
  }
  announce(mock, GatewayDispatchEvents.GuildScheduledEventUpdate, event);
  recordAudit(mock, guild, {
    action_type: AuditLogEvent.GuildScheduledEventUpdate,
    user_id: user.id,
    target_id: event.id,
    changes: (["name", "description", "scheduled_start_time"] as const)
      .filter((key) => before[key] !== event[key])
      .map(
        (key) =>
          ({ key, old_value: before[key], new_value: event[key] }) as never,
      ),
  });
}

/** `user` deletes `event`. */
export function deleteScheduledEvent(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  event: APIGuildScheduledEvent,
) {
  requireEventPermissions(mock, guild, user, event, "delete");
  mock.state.scheduledEvents.delete(event.id);
  announce(mock, GatewayDispatchEvents.GuildScheduledEventDelete, event);
  recordAudit(mock, guild, {
    action_type: AuditLogEvent.GuildScheduledEventDelete,
    user_id: user.id,
    target_id: event.id,
    changes: [{ key: "name", old_value: event.name }],
  });
}

/** The guild's events, for GUILD_CREATE's guild_scheduled_events. */
export function scheduledEventsIn(mock: DiscordMock, guildId: string) {
  return [...mock.state.scheduledEvents.values()].filter(
    (event) => event.guild_id === guildId,
  );
}

export function registerScheduledEventRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state } = mock;
  // Get Permissions: VIEW_CHANNEL in a VOICE event's channel, none for EXTERNAL. The docs don't say
  // whether List leaves out the events the bot can't get or refuses (inferred: left out).
  const visible = (guild: GuildRecord, event: APIGuildScheduledEvent) =>
    !event.channel_id ||
    (computePermissions(
      state,
      guild,
      state.bot.id,
      state.requireChannel(event.channel_id),
    ) &
      Permission.ViewChannel) !==
      0n;
  // with_user_count: nobody marks themselves interested in the Model, so 0.
  const withCount = (event: APIGuildScheduledEvent, count: boolean) =>
    count ? { ...event, user_count: 0 } : event;

  rest.route(
    "GET",
    "/guilds/:guildId/scheduled-events",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return respond.error(404, 10004, "Unknown Guild");
      const count = req.query.get("with_user_count") === "true";
      return respond.json(
        scheduledEventsIn(mock, guild.id)
          .filter((event) => visible(guild, event))
          .map((event) => withCount(event, count)),
      );
    }),
  );

  rest.route(
    "GET",
    "/guilds/:guildId/scheduled-events/:eventId",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return respond.error(404, 10004, "Unknown Guild");
      const event = state.scheduledEvents.get(req.params.eventId!);
      if (!event || event.guild_id !== guild.id) return unknownEvent();
      if (!visible(guild, event)) return respond.missingAccess();
      return respond.json(
        withCount(event, req.query.get("with_user_count") === "true"),
      );
    }),
  );
}
