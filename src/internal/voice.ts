import {
  GatewayDispatchEvents,
  GatewayIntentBits,
  type APIVoiceState,
} from "discord-api-types/v10";
import type { DiscordMock } from "./mock.js";
import { computePermissions, Permission } from "./payloads.js";
import { respond, type RestHandler } from "./rest.js";
import type { GuildRecord } from "./state.js";

// Members' voice states. The bot itself never connects: voice connections (@discordjs/voice) are
// out of scope. Sources: discord-api-docs resources/voice (the voice state object, Get Current
// User Voice State, Get User Voice State), events/gateway-events#voice-state-update ("Sent when
// someone joins/leaves/moves voice channels"), events/gateway (GUILD_VOICE_STATES).

/** `userId`'s voice state in `guild`, if they're in a voice channel. */
export function voiceStateOf(
  mock: DiscordMock,
  guild: GuildRecord,
  userId: string,
) {
  return mock.state.voiceStates.get(guild.id)?.get(userId);
}

/**
 * Puts `userId` in voice channel `channelId`, or out of voice with null, and sends
 * VOICE_STATE_UPDATE with their member. Leaving sends the last state with a null channel_id.
 */
export function setVoiceState(
  mock: DiscordMock,
  guild: GuildRecord,
  userId: string,
  change: { channelId?: string | null; mute?: boolean; deaf?: boolean },
) {
  const { state } = mock;
  const member = guild.members.get(userId);
  if (!member)
    throw new Error(`discordjs-test-kit: ${userId} isn't in ${guild.name}`);
  const states =
    state.voiceStates.get(guild.id) ?? new Map<string, APIVoiceState>();
  state.voiceStates.set(guild.id, states);
  const voice: APIVoiceState = states.get(userId) ?? {
    guild_id: guild.id,
    channel_id: null,
    user_id: userId,
    session_id: crypto.randomUUID().replaceAll("-", ""),
    deaf: member.deaf,
    mute: member.mute,
    self_deaf: false,
    self_mute: false,
    self_video: false,
    suppress: false,
    request_to_speak_timestamp: null,
  };
  if (change.channelId !== undefined) voice.channel_id = change.channelId;
  if (change.mute !== undefined) voice.mute = member.mute = change.mute;
  if (change.deaf !== undefined) voice.deaf = member.deaf = change.deaf;
  if (voice.channel_id) states.set(userId, voice);
  else states.delete(userId);
  mock.gateway.dispatch(
    GatewayDispatchEvents.VoiceStateUpdate,
    { ...voice, member },
    GatewayIntentBits.GuildVoiceStates,
  );
}

export function registerVoiceRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state } = mock;
  // Get (Current) User Voice State. "If the specified user is connected to a voice channel, the
  // current user must have permission to connect to the channel." 10065 for someone not in voice
  // is the code table's "Unknown voice state" (pairing inferred, not checked).
  rest.route(
    "GET",
    "/guilds/:guildId/voice-states/:userId",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return respond.error(404, 10004, "Unknown Guild");
      const userId =
        req.params.userId === "@me" ? state.bot.id : req.params.userId!;
      const voice = voiceStateOf(mock, guild, userId);
      if (!voice) return respond.error(404, 10065, "Unknown Voice State");
      const channel = state.requireChannel(voice.channel_id!);
      const perms = computePermissions(state, guild, state.bot.id, channel);
      if (!(perms & Permission.ViewChannel)) return respond.missingAccess();
      if (!(perms & Permission.Connect)) return respond.missingPermissions();
      return respond.json(voice);
    }),
  );
}
