import {
  GatewayDispatchEvents,
  GatewayIntentBits,
  type PresenceUpdateStatus,
  type ActivityType,
  type APIUser,
  type GatewayPresenceUpdate,
} from "discord-api-types/v10";
import type { DiscordMock } from "./mock.js";

// Member presences. Sources: docs.discord.food/resources/presence (the presence object: user,
// guild_id, status, activities, client_status) and gateway/gateway-events#presence-update ("you
// must specify the GUILD_PRESENCES intent", "never received for the user's own presence", "the
// user object ... can be very partial", only `id` guaranteed, so only `id` is sent). Everyone
// starts offline. Which platform a status comes from isn't modelled: client_status puts it on
// desktop (inferred).

export type PresenceStatus = "online" | "idle" | "dnd" | "offline";

export interface PresenceInput {
  status: PresenceStatus;
  activity?: { name: string; type: ActivityType };
}

/**
 * `user` changes status or activity: PRESENCE_UPDATE in every guild they share with the bot.
 * The activity's created_at is when it was set (resources/presence#activity-object).
 */
export function setPresence(
  mock: DiscordMock,
  user: APIUser,
  input: PresenceInput,
) {
  const offline = input.status === "offline";
  const presence = {
    user: { id: user.id },
    status: input.status as PresenceUpdateStatus,
    activities:
      input.activity && !offline
        ? [{ ...input.activity, created_at: Date.now() }]
        : [],
    client_status: offline ? {} : { desktop: input.status },
  } as Omit<GatewayPresenceUpdate, "guild_id">;
  mock.state.presences.set(user.id, presence);
  for (const guild of mock.state.guilds.values())
    if (guild.members.has(user.id))
      mock.gateway.dispatch(
        GatewayDispatchEvents.PresenceUpdate,
        { ...presence, guild_id: guild.id },
        GatewayIntentBits.GuildPresences,
      );
}
