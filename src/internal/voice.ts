import {
  ChannelType,
  GatewayDispatchEvents,
  GatewayIntentBits,
  type APIVoiceState,
} from "discord-api-types/v10";
import type { DiscordMock } from "./mock.js";
import { computePermissions, Permission } from "./payloads.js";
import { respond, type RestHandler } from "./rest.js";
import type { GuildRecord } from "./state.js";

// Voice states, the members' and the bot's. Sources: discord-api-docs resources/voice (the voice
// state object, Get Current User Voice State, Get User Voice State),
// events/gateway-events#voice-state-update ("Sent when someone joins/leaves/moves voice
// channels"), events/gateway (GUILD_VOICE_STATES), topics/voice-connections (the bot's op 4).

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
  change: {
    channelId?: string | null;
    mute?: boolean;
    deaf?: boolean;
    selfMute?: boolean;
    selfDeaf?: boolean;
  },
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
  if (change.selfMute !== undefined) voice.self_mute = change.selfMute;
  if (change.selfDeaf !== undefined) voice.self_deaf = change.selfDeaf;
  if (voice.channel_id) states.set(userId, voice);
  else states.delete(userId);
  mock.gateway.dispatch(
    GatewayDispatchEvents.VoiceStateUpdate,
    { ...voice, member },
    GatewayIntentBits.GuildVoiceStates,
  );
}

/**
 * The bot's op 4 (topics/voice-connections#retrieving-voice-server-information): with a
 * channel_id, VOICE_STATE_UPDATE (the bot's, with its session_id, under GUILD_VOICE_STATES, so
 * @discordjs/voice needs that intent) then VOICE_SERVER_UPDATE with a new token and the fake
 * voice server's endpoint, to the session that asked; with null, the bot leaves and its voice
 * connection closes with 4014. "When the voice channel is full, you will not receive the Voice State
 * Update or Voice Server Update events", unless the bot has Move Members. Joining without View
 * Channel and Connect, or anything but a voice or stage channel of a guild the bot is in, is a Gap.
 */
export async function botVoiceStateUpdate(
  mock: DiscordMock,
  d: {
    guild_id: string;
    channel_id: string | null;
    self_mute?: boolean;
    self_deaf?: boolean;
  },
  reply: (t: string, d: unknown) => void,
) {
  const { state } = mock;
  const guild = state.guilds.get(d.guild_id);
  if (!guild || !state.botIn(guild.id))
    return void mock.rest.gap(`voice in a guild the bot isn't in`);
  const bot = state.bot.id;
  if (d.channel_id === null) {
    mock.voiceServer.end(guild.id);
    if (voiceStateOf(mock, guild, bot))
      setVoiceState(mock, guild, bot, { channelId: null });
    return;
  }
  const channel = state.channels.get(d.channel_id);
  if (
    !channel ||
    !("guild_id" in channel) ||
    channel.guild_id !== guild.id ||
    (channel.type !== ChannelType.GuildVoice &&
      channel.type !== ChannelType.GuildStageVoice)
  )
    return void mock.rest.gap(`voice in ${d.channel_id}, not a voice channel`);
  const perms = computePermissions(state, guild, bot, channel);
  const needed = Permission.ViewChannel | Permission.Connect;
  if ((perms & needed) !== needed)
    return void mock.rest.gap("joining voice without View Channel and Connect");
  const limit = "user_limit" in channel ? (channel.user_limit ?? 0) : 0;
  const inside = [...(state.voiceStates.get(guild.id)?.values() ?? [])].filter(
    (v) => v.channel_id === channel.id && v.user_id !== bot,
  ).length;
  if (limit > 0 && inside >= limit && !(perms & Permission.MoveMembers)) return;
  const endpoint = await mock.voiceServer.endpoint();
  setVoiceState(mock, guild, bot, {
    channelId: channel.id,
    selfMute: d.self_mute ?? false,
    selfDeaf: d.self_deaf ?? false,
  });
  const voice = voiceStateOf(mock, guild, bot)!;
  const session = mock.voiceServer.open(
    guild.id,
    channel.id,
    bot,
    voice.session_id,
  );
  reply(GatewayDispatchEvents.VoiceServerUpdate, {
    token: session.token,
    guild_id: guild.id,
    endpoint,
  });
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
