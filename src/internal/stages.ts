import {
  AuditLogEvent,
  ChannelType,
  GatewayDispatchEvents,
  GatewayIntentBits,
  StageInstancePrivacyLevel,
  type APIChannel,
  type APIStageInstance,
  type APIUser,
} from "discord-api-types/v10";
import { reasonOf, recordAudit } from "./audit.js";
import type { DiscordMock } from "./mock.js";
import { computePermissions, Permission } from "./payloads.js";
import { respond, type RestHandler } from "./rest.js";
import { snowflake } from "./snowflake.js";

// Stages. Sources: Discord's docs, resources/stage-instance (the object; a topic of 1-120
// characters; "Requires the user to be a moderator of the Stage channel": MANAGE_CHANNELS,
// MUTE_MEMBERS and MOVE_MEMBERS), events/gateway-events (STAGE_INSTANCE_CREATE and DELETE, under
// GUILDS), resources/guild (GUILD_CREATE's stage_instances), the code table (10067 Unknown Stage
// Instance) and resources/audit-log (83, 84 and 85); docs.discord.food/resources/stage-instance for
// the bot's own Create, Modify and Delete. Stages don't close on their own when nobody speaks.

const moderator =
  Permission.ManageChannels | Permission.MuteMembers | Permission.MoveMembers;

function guildOf(mock: DiscordMock, channel: APIChannel) {
  if (channel.type !== ChannelType.GuildStageVoice)
    throw new Error(
      `discordjs-test-kit: #${channel.name} isn't a stage channel`,
    );
  return mock.state.requireGuild(channel.guild_id!);
}

function requireModerator(
  mock: DiscordMock,
  user: APIUser,
  channel: APIChannel,
) {
  const guild = guildOf(mock, channel);
  if (
    (computePermissions(mock.state, guild, user.id, channel) & moderator) !==
    moderator
  )
    throw new Error(
      `discordjs-test-kit: ${user.username} isn't a moderator of #${channel.name}: it takes Manage Channels, Mute Members and Move Members`,
    );
  return guild;
}

/** `user` makes stage channel `channel` live with `topic`: STAGE_INSTANCE_CREATE. */
export function startStage(
  mock: DiscordMock,
  user: APIUser,
  channel: APIChannel,
  topic: string,
  reason?: string,
): APIStageInstance {
  const guild = requireModerator(mock, user, channel);
  if (mock.state.stageInstances.has(channel.id))
    throw new Error(`discordjs-test-kit: #${channel.name} is already live`);
  if (topic.length < 1 || topic.length > 120)
    throw new Error(
      `discordjs-test-kit: a stage topic is 1-120 characters, not ${topic.length}`,
    );
  // The docs type guild_scheduled_event_id as ?snowflake (null); discord-api-types as optional.
  const stage = {
    id: snowflake(),
    guild_id: guild.id,
    channel_id: channel.id,
    topic,
    privacy_level: StageInstancePrivacyLevel.GuildOnly,
    discoverable_disabled: false,
    guild_scheduled_event_id: null,
  } as unknown as APIStageInstance;
  mock.state.stageInstances.set(channel.id, stage);
  mock.gateway.dispatch(
    GatewayDispatchEvents.StageInstanceCreate,
    stage,
    GatewayIntentBits.Guilds,
  );
  recordAudit(mock, guild, {
    action_type: AuditLogEvent.StageInstanceCreate,
    user_id: user.id,
    target_id: stage.id,
    changes: [{ key: "topic", new_value: topic }],
    options: { channel_id: channel.id },
    reason,
  });
  return stage;
}

/** `user` ends the live stage in `channel`: STAGE_INSTANCE_DELETE. */
export function endStage(
  mock: DiscordMock,
  user: APIUser,
  channel: APIChannel,
  reason?: string,
) {
  const guild = requireModerator(mock, user, channel);
  const stage = mock.state.stageInstances.get(channel.id);
  if (!stage)
    throw new Error(`discordjs-test-kit: #${channel.name} isn't live`);
  mock.state.stageInstances.delete(channel.id);
  mock.gateway.dispatch(
    GatewayDispatchEvents.StageInstanceDelete,
    stage,
    GatewayIntentBits.Guilds,
  );
  recordAudit(mock, guild, {
    action_type: AuditLogEvent.StageInstanceDelete,
    user_id: user.id,
    target_id: stage.id,
    changes: [{ key: "topic", old_value: stage.topic }],
    options: { channel_id: channel.id },
    reason,
  });
}

export function registerStageRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state } = mock;
  // Get Stage Instance: 10067 when the channel isn't live. Seeing the channel is assumed (inferred).
  rest.route(
    "GET",
    "/stage-instances/:channelId",
    authed((req) => {
      const channel = state.channels.get(req.params.channelId!);
      if (!channel) return respond.unknownChannel();
      const denied = mock.checkBotPerms(channel, 0n);
      if (denied) return denied;
      const stage = state.stageInstances.get(channel.id);
      return stage
        ? respond.json(stage)
        : respond.error(404, 10067, "Unknown Stage Instance");
    }),
  );

  const unknownStage = () =>
    respond.error(404, 10067, "Unknown Stage Instance");
  const isModerator = (channel: APIChannel) =>
    (computePermissions(state, guildOf(mock, channel), state.bot.id, channel) &
      moderator) ===
    moderator;
  const topicOk = (topic: unknown) =>
    typeof topic === "string" && topic.length >= 1 && topic.length <= 120;

  // Create Stage Instance: a moderator of the stage channel, topic 1-120 characters,
  // privacy_level GUILD_ONLY (the only level the docs' privacy table has). Linking a scheduled
  // event and send_start_notification are a Gap, as is a channel that's already live (its error
  // isn't documented). A non-stage channel or bad topic answering 50035 is inferred.
  rest.route(
    "POST",
    "/stage-instances",
    authed((req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.guild_scheduled_event_id != null)
        return rest.gap("a stage instance for a scheduled event");
      if (body.send_start_notification)
        return rest.gap("a stage start notification");
      const channel = state.channels.get(body.channel_id as string);
      if (!channel) return respond.unknownChannel();
      if (
        channel.type !== ChannelType.GuildStageVoice ||
        !topicOk(body.topic) ||
        (body.privacy_level ?? StageInstancePrivacyLevel.GuildOnly) !==
          StageInstancePrivacyLevel.GuildOnly
      )
        return respond.invalidFormBody();
      if (!isModerator(channel)) return respond.missingPermissions();
      if (state.stageInstances.has(channel.id))
        return rest.gap("a second stage instance in one channel");
      return respond.json(
        startStage(
          mock,
          state.bot,
          channel,
          body.topic as string,
          reasonOf(req),
        ),
      );
    }),
  );

  // Modify Stage Instance: topic and privacy_level, STAGE_INSTANCE_UPDATE (GUILDS).
  rest.route(
    "PATCH",
    "/stage-instances/:channelId",
    authed((req) => {
      const channel = state.channels.get(req.params.channelId!);
      if (!channel) return respond.unknownChannel();
      const stage = state.stageInstances.get(channel.id);
      if (!stage) return unknownStage();
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (
        ("topic" in body && !topicOk(body.topic)) ||
        ("privacy_level" in body &&
          body.privacy_level !== StageInstancePrivacyLevel.GuildOnly)
      )
        return respond.invalidFormBody();
      if (!isModerator(channel)) return respond.missingPermissions();
      const before = stage.topic;
      if ("topic" in body) stage.topic = body.topic as string;
      mock.gateway.dispatch(
        GatewayDispatchEvents.StageInstanceUpdate,
        stage,
        GatewayIntentBits.Guilds,
      );
      recordAudit(mock, state.requireGuild(stage.guild_id), {
        action_type: AuditLogEvent.StageInstanceUpdate,
        user_id: state.bot.id,
        target_id: stage.id,
        changes: [{ key: "topic", old_value: before, new_value: stage.topic }],
        options: { channel_id: channel.id },
        reason: reasonOf(req),
      });
      return respond.json(stage);
    }),
  );

  // Delete Stage Instance: 204.
  rest.route(
    "DELETE",
    "/stage-instances/:channelId",
    authed((req) => {
      const channel = state.channels.get(req.params.channelId!);
      if (!channel) return respond.unknownChannel();
      if (!state.stageInstances.has(channel.id)) return unknownStage();
      if (!isModerator(channel)) return respond.missingPermissions();
      endStage(mock, state.bot, channel, reasonOf(req));
      return respond.noContent();
    }),
  );
}
