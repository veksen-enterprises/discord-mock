import {
  OverwriteType,
  type APIChannel,
  type APIGuildMember,
} from "discord-api-types/v10";
import type { DiscordState, GuildRecord } from "./state.js";

export const Permission = {
  ManageChannels: 1n << 4n,
  Administrator: 1n << 3n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
  ManageRoles: 1n << 28n,
} as const;

const ALL = (1n << 53n) - 1n;

/** Discord's permission algorithm: base from roles, then @everyone/role/member overwrites. */
export function computePermissions(
  state: DiscordState,
  guild: GuildRecord,
  userId: string,
  channel?: APIChannel,
): bigint {
  if (guild.ownerId === userId) return ALL;
  const member = guild.members.get(userId);
  if (!member) return 0n;
  let base = BigInt(guild.roles.get(guild.id)!.permissions);
  for (const roleId of member.roles)
    base |= BigInt(guild.roles.get(roleId)?.permissions ?? "0");
  if (base & Permission.Administrator) return ALL;
  if (!channel || !("permission_overwrites" in channel)) return base;

  const overwrites = channel.permission_overwrites ?? [];
  const apply = (ow: { allow: string; deny: string } | undefined) => {
    if (!ow) return;
    base &= ~BigInt(ow.deny);
    base |= BigInt(ow.allow);
  };
  apply(overwrites.find((o) => o.id === guild.id));
  let allow = 0n;
  let deny = 0n;
  for (const ow of overwrites) {
    if (ow.type === OverwriteType.Role && member.roles.includes(ow.id)) {
      allow |= BigInt(ow.allow);
      deny |= BigInt(ow.deny);
    }
  }
  apply({ allow: String(allow), deny: String(deny) });
  apply(
    overwrites.find((o) => o.type === OverwriteType.Member && o.id === userId),
  );
  return base;
}

export function guildCreatePayload(state: DiscordState, guild: GuildRecord) {
  return {
    id: guild.id,
    name: guild.name,
    icon: null,
    splash: null,
    discovery_splash: null,
    owner_id: guild.ownerId,
    afk_channel_id: null,
    afk_timeout: 300,
    verification_level: 0,
    default_message_notifications: 0,
    explicit_content_filter: 0,
    roles: [...guild.roles.values()],
    emojis: [],
    stickers: [],
    features: [],
    mfa_level: 0,
    application_id: null,
    system_channel_id: null,
    system_channel_flags: 0,
    rules_channel_id: null,
    vanity_url_code: null,
    description: null,
    banner: null,
    premium_tier: 0,
    preferred_locale: "en-US",
    public_updates_channel_id: null,
    nsfw_level: 0,
    premium_progress_bar_enabled: false,
    safety_alerts_channel_id: null,
    joined_at: new Date().toISOString(),
    large: false,
    unavailable: false,
    member_count: guild.members.size,
    members: [...guild.members.values()],
    channels: guild.channelIds.map((id) => state.channels.get(id)!),
    threads: [],
    presences: [],
    voice_states: [],
    stage_instances: [],
    guild_scheduled_events: [],
    soundboard_sounds: [],
  };
}

export function interactionMember(
  state: DiscordState,
  guild: GuildRecord,
  member: APIGuildMember,
  channel: APIChannel,
) {
  return {
    ...member,
    permissions: String(
      computePermissions(state, guild, member.user.id, channel),
    ),
  };
}
