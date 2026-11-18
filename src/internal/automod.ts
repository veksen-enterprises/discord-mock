import {
  AuditLogEvent,
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  GatewayDispatchEvents,
  GatewayIntentBits,
  MessageType,
  type APIAutoModerationAction,
  type APIAutoModerationRule,
  type APIChannel,
  type APIUser,
} from "discord-api-types/v10";
import { reasonOf, recordAudit } from "./audit.js";
import type { DiscordMock } from "./mock.js";
import { computePermissions, Permission } from "./payloads.js";
import { respond, type RestHandler } from "./rest.js";
import { snowflake } from "./snowflake.js";
import type { GuildRecord } from "./state.js";

// AutoMod: the bot's rules, and what they do to members' messages. Sources: discord-api-docs
// resources/auto-moderation (the rule and action objects, trigger metadata limits, keyword
// matching strategies, "MANAGE_GUILD permission to access all Auto Moderation resources", TIMEOUT
// needs MODERATE_MEMBERS, max rules per trigger type, the five Routes), events/gateway-events
// (rule create/update/delete carry the rule; Action Execution fields; "only sent to bot users which
// have the MANAGE_GUILD permission"; content and matched_content need MESSAGE_CONTENT),
// events/gateway (AUTO_MODERATION_CONFIGURATION, AUTO_MODERATION_EXECUTION), resources/audit-log
// (140-145), docs.discord.food/resources/auto-moderation (the alert message: type
// AUTO_MODERATION_ACTION, an `auto_moderation_message` embed whose description is the content and
// whose fields are rule_name, channel_id, keyword and keyword_matched_content).
//
// Modelled: KEYWORD and MENTION_SPAM rules on messages members send, with BLOCK_MESSAGE,
// SEND_ALERT_MESSAGE and TIMEOUT. SPAM, KEYWORD_PRESET and MEMBER_PROFILE rules, the
// MEMBER_UPDATE event, BLOCK_MEMBER_INTERACTION and members editing messages are Gaps or not
// modelled. Nobody is exempt beyond the rule's exempt roles and channels; whether Discord exempts
// admins is undocumented (inferred, not checked).

type Rule = APIAutoModerationRule;

// resources/auto-moderation#trigger-types, "Max per Guild".
const MAX_PER_GUILD: Partial<Record<AutoModerationRuleTriggerType, number>> = {
  [AutoModerationRuleTriggerType.Keyword]: 6,
  [AutoModerationRuleTriggerType.MentionSpam]: 1,
};

const rulesIn = (mock: DiscordMock, guildId: string) =>
  [...mock.state.autoModRules.values()].filter((r) => r.guild_id === guildId);

/** Whether the bot hears AutoMod events in `guild`: it needs MANAGE_GUILD. */
const botHears = (mock: DiscordMock, guild: GuildRecord) =>
  (computePermissions(mock.state, guild, mock.state.bot.id) &
    Permission.ManageGuild) !==
  0n;

function announceRule(
  mock: DiscordMock,
  guild: GuildRecord,
  t:
    | GatewayDispatchEvents.AutoModerationRuleCreate
    | GatewayDispatchEvents.AutoModerationRuleUpdate
    | GatewayDispatchEvents.AutoModerationRuleDelete,
  rule: Rule,
) {
  if (botHears(mock, guild))
    mock.gateway.dispatch(
      t,
      rule,
      GatewayIntentBits.AutoModerationConfiguration,
    );
}

/** keyword matching strategies: `*` at either end widens the match; without one, a whole word. */
function keywordPattern(keyword: string) {
  const prefix = keyword.startsWith("*");
  const suffix = keyword.endsWith("*") && keyword.length > 1;
  const word = keyword
    .replace(/^\*|\*$/g, "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // "surrounded by whitespace": the start and end of the content count as whitespace (inferred).
  const before = prefix ? "" : "(?<=^|\\s)";
  const after = suffix ? "" : "(?=\\s|$)";
  // Prefix and suffix match the rest of the word, so matched content is the whole word (inferred).
  return new RegExp(
    `${before}${prefix ? "\\S*" : ""}${word}${suffix ? "\\S*" : ""}${after}`,
    "i",
  );
}

/** The keyword and content a KEYWORD rule matches in `content`, if any. */
function keywordMatch(rule: Rule, content: string) {
  const meta = rule.trigger_metadata;
  const allowed = (text: string) =>
    (meta.allow_list ?? []).some((a) => keywordPattern(a).test(text));
  for (const keyword of meta.keyword_filter ?? []) {
    const found = keywordPattern(keyword).exec(content)?.[0];
    if (found && !allowed(found)) return { keyword, matched: found };
  }
  // Rust regex flavour, run as a JavaScript RegExp: most patterns agree (inferred, not checked).
  for (const pattern of meta.regex_patterns ?? []) {
    const found = new RegExp(pattern).exec(content)?.[0];
    if (found !== undefined && !allowed(found))
      return { keyword: pattern, matched: found };
  }
  return undefined;
}

/** MENTION_SPAM: more unique user and role mentions than mention_total_limit. */
function mentionMatch(rule: Rule, content: string) {
  const mentions = new Set(content.match(/<@[!&]?\d+>/g) ?? []);
  const limit = rule.trigger_metadata.mention_total_limit ?? Infinity;
  return mentions.size > limit ? { keyword: null, matched: null } : undefined;
}

/**
 * Runs the guild's enabled MESSAGE_SEND rules on what `user` is sending in `channel`. Returns the
 * custom message of a BLOCK_MESSAGE action if one blocked it; `post` creates the message when no
 * rule blocks it, so alerts and execution events can name it.
 */
export function moderateMessage(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  channel: APIChannel,
  content: string,
  post: () => { id: string },
): { blocked: string | null } | undefined {
  const member = guild.members.get(user.id);
  const parentId = "parent_id" in channel ? channel.parent_id : null;
  const hits = rulesIn(mock, guild.id).flatMap((rule) => {
    if (
      !rule.enabled ||
      rule.event_type !== AutoModerationRuleEventType.MessageSend
    )
      return [];
    if (
      rule.exempt_channels.includes(channel.id) ||
      (parentId && rule.exempt_channels.includes(parentId)) ||
      rule.exempt_roles.some((id) => member?.roles.includes(id))
    )
      return [];
    const match =
      rule.trigger_type === AutoModerationRuleTriggerType.Keyword
        ? keywordMatch(rule, content)
        : mentionMatch(rule, content);
    return match ? [{ rule, ...match }] : [];
  });
  if (!hits.length) {
    post();
    return undefined;
  }
  const block = hits
    .flatMap(({ rule }) => rule.actions)
    .find((a) => a.type === AutoModerationActionType.BlockMessage);
  const messageId = block ? undefined : post().id;
  for (const hit of hits)
    for (const action of hit.rule.actions)
      execute(mock, guild, user, channel, content, hit, action, messageId);
  return block
    ? { blocked: block.metadata?.custom_message ?? null }
    : undefined;
}

function execute(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  channel: APIChannel,
  content: string,
  hit: { rule: Rule; keyword: string | null; matched: string | null },
  action: APIAutoModerationAction,
  messageId: string | undefined,
) {
  const { state } = mock;
  const { rule } = hit;
  const options = {
    auto_moderation_rule_name: rule.name,
    auto_moderation_rule_trigger_type: String(rule.trigger_type),
    channel_id: channel.id,
  };
  let alertId: string | undefined;
  if (action.type === AutoModerationActionType.BlockMessage)
    recordAudit(mock, guild, {
      action_type: AuditLogEvent.AutoModerationBlockMessage,
      user_id: state.bot.id,
      target_id: user.id,
      options: options as never,
    });
  if (action.type === AutoModerationActionType.SendAlertMessage) {
    const alert = state.createMessage({
      channelId: action.metadata!.channel_id!,
      authorId: user.id,
      content: "",
      embeds: [
        {
          type: "auto_moderation_message" as never,
          description: content,
          fields: [
            { name: "rule_name", value: rule.name },
            { name: "channel_id", value: channel.id },
            ...(hit.keyword
              ? [
                  { name: "keyword", value: hit.keyword },
                  { name: "keyword_matched_content", value: hit.matched! },
                ]
              : []),
          ],
        },
      ],
    });
    alert.type = MessageType.AutoModerationAction;
    alertId = alert.id;
    mock.gateway.dispatchMessage("MESSAGE_CREATE", alert);
    recordAudit(mock, guild, {
      action_type: AuditLogEvent.AutoModerationFlagToChannel,
      user_id: state.bot.id,
      target_id: user.id,
      options: options as never,
    });
  }
  if (action.type === AutoModerationActionType.Timeout) {
    const member = guild.members.get(user.id)!;
    const seconds = action.metadata!.duration_seconds!;
    member.communication_disabled_until = new Date(
      Date.now() + seconds * 1000,
    ).toISOString();
    mock.gateway.dispatch(
      GatewayDispatchEvents.GuildMemberUpdate,
      { ...member, guild_id: guild.id },
      GatewayIntentBits.GuildMembers,
    );
    recordAudit(mock, guild, {
      action_type: AuditLogEvent.AutoModerationUserCommunicationDisabled,
      user_id: state.bot.id,
      target_id: user.id,
      options: options as never,
    });
  }
  if (!botHears(mock, guild)) return;
  mock.gateway.dispatchFor(
    GatewayDispatchEvents.AutoModerationActionExecution,
    guild.id,
    GatewayIntentBits.AutoModerationExecution,
    (intents) => {
      const withContent = (intents & GatewayIntentBits.MessageContent) !== 0;
      return {
        guild_id: guild.id,
        action,
        rule_id: rule.id,
        rule_trigger_type: rule.trigger_type,
        user_id: user.id,
        channel_id: channel.id,
        ...(messageId ? { message_id: messageId } : {}),
        ...(alertId ? { alert_system_message_id: alertId } : {}),
        content: withContent ? content : "",
        matched_keyword: hit.keyword,
        matched_content: withContent ? hit.matched : "",
      };
    },
  );
}

/** A rule body's problem: a Gap for what isn't modelled, 50035 for what Discord refuses. */
function invalid(
  mock: DiscordMock,
  guild: GuildRecord,
  body: Partial<Rule> & Record<string, unknown>,
  triggerType: AutoModerationRuleTriggerType,
) {
  const { rest } = mock;
  if (
    triggerType !== AutoModerationRuleTriggerType.Keyword &&
    triggerType !== AutoModerationRuleTriggerType.MentionSpam
  )
    return rest.gap(`an AutoMod rule with trigger_type ${triggerType}`);
  if (
    body.event_type !== undefined &&
    body.event_type !== AutoModerationRuleEventType.MessageSend
  )
    return rest.gap(`an AutoMod rule with event_type ${body.event_type}`);
  if (body.name !== undefined && (typeof body.name !== "string" || !body.name))
    return respond.invalidFormBody();
  const meta = body.trigger_metadata ?? {};
  // Trigger Metadata Field Limits.
  const over = (list: string[] | undefined, length: number, chars: number) =>
    !!list && (list.length > length || list.some((s) => s.length > chars));
  if (
    over(meta.keyword_filter, 1000, 60) ||
    over(meta.regex_patterns, 10, 260) ||
    over(meta.allow_list, 100, 60) ||
    (body.exempt_roles?.length ?? 0) > 20 ||
    (body.exempt_channels?.length ?? 0) > 50
  )
    return respond.invalidFormBody();
  for (const pattern of meta.regex_patterns ?? []) {
    try {
      new RegExp(pattern);
    } catch {
      // What Discord answers an invalid Rust regex with is undocumented.
      return rest.gap("an AutoMod regex JavaScript can't compile");
    }
  }
  for (const action of body.actions ?? []) {
    if (action.type === AutoModerationActionType.BlockMemberInteraction)
      return rest.gap("the BLOCK_MEMBER_INTERACTION AutoMod action");
    if (
      action.type === AutoModerationActionType.BlockMessage &&
      (action.metadata?.custom_message?.length ?? 0) > 150
    )
      return respond.invalidFormBody();
    if (action.type === AutoModerationActionType.SendAlertMessage) {
      const target = mock.state.channels.get(action.metadata?.channel_id ?? "");
      if (!target || !("guild_id" in target) || target.guild_id !== guild.id)
        return respond.invalidFormBody();
    }
    if (action.type === AutoModerationActionType.Timeout) {
      const seconds = action.metadata?.duration_seconds ?? 0;
      if (seconds < 1 || seconds > 2419200) return respond.invalidFormBody();
      if (
        !(
          computePermissions(mock.state, guild, mock.state.bot.id) &
          Permission.ModerateMembers
        )
      )
        return respond.missingPermissions();
    }
  }
  return undefined;
}

export function registerAutoModRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state } = mock;
  const base = "/guilds/:guildId/auto-moderation/rules";
  /** The guild, or the refusal: every AutoMod Route needs MANAGE_GUILD. */
  const guarded = (guildId: string) => {
    const guild = state.guilds.get(guildId);
    if (!guild) return { refused: respond.error(404, 10004, "Unknown Guild") };
    if (!botHears(mock, guild))
      return { refused: respond.missingPermissions() };
    return { guild };
  };
  // No documented error code names an unknown rule, so asking for one is a Gap.
  const ruleIn = (guild: GuildRecord, id: string) => {
    const rule = state.autoModRules.get(id);
    return rule?.guild_id === guild.id ? rule : undefined;
  };

  rest.route(
    "GET",
    base,
    authed((req) => {
      const { refused, guild } = guarded(req.params.guildId!);
      return refused ?? respond.json(rulesIn(mock, guild.id));
    }),
  );

  rest.route(
    "GET",
    `${base}/:ruleId`,
    authed((req) => {
      const { refused, guild } = guarded(req.params.guildId!);
      if (refused) return refused;
      const rule = ruleIn(guild, req.params.ruleId!);
      return rule ? respond.json(rule) : rest.gap("an unknown AutoMod rule");
    }),
  );

  rest.route(
    "POST",
    base,
    authed((req) => {
      const { refused, guild } = guarded(req.params.guildId!);
      if (refused) return refused;
      const body = (req.body ?? {}) as Partial<Rule> & Record<string, unknown>;
      if (
        typeof body.name !== "string" ||
        body.event_type === undefined ||
        body.trigger_type === undefined ||
        !Array.isArray(body.actions)
      )
        return respond.invalidFormBody();
      const problem = invalid(mock, guild, body, body.trigger_type);
      if (problem) return problem;
      const max = MAX_PER_GUILD[body.trigger_type]!;
      if (
        rulesIn(mock, guild.id).filter(
          (r) => r.trigger_type === body.trigger_type,
        ).length >= max
      )
        // The docs give the limit but no error code.
        return rest.gap(`more than ${max} AutoMod rules of one trigger type`);
      const rule: Rule = {
        id: snowflake(),
        guild_id: guild.id,
        name: body.name,
        creator_id: state.bot.id,
        event_type: body.event_type,
        trigger_type: body.trigger_type,
        trigger_metadata: body.trigger_metadata ?? {},
        actions: body.actions,
        enabled: body.enabled ?? false,
        exempt_roles: body.exempt_roles ?? [],
        exempt_channels: body.exempt_channels ?? [],
      };
      state.autoModRules.set(rule.id, rule);
      announceRule(
        mock,
        guild,
        GatewayDispatchEvents.AutoModerationRuleCreate,
        rule,
      );
      recordAudit(mock, guild, {
        action_type: AuditLogEvent.AutoModerationRuleCreate,
        user_id: state.bot.id,
        target_id: rule.id,
        reason: reasonOf(req),
      });
      return respond.json(rule);
    }),
  );

  rest.route(
    "PATCH",
    `${base}/:ruleId`,
    authed((req) => {
      const { refused, guild } = guarded(req.params.guildId!);
      if (refused) return refused;
      const rule = ruleIn(guild, req.params.ruleId!);
      if (!rule) return rest.gap("an unknown AutoMod rule");
      const body = (req.body ?? {}) as Partial<Rule> & Record<string, unknown>;
      const problem = invalid(mock, guild, body, rule.trigger_type);
      if (problem) return problem;
      const editable = [
        "name",
        "event_type",
        "trigger_metadata",
        "actions",
        "enabled",
        "exempt_roles",
        "exempt_channels",
      ] as const;
      for (const key of editable)
        if (body[key] !== undefined) Object.assign(rule, { [key]: body[key] });
      announceRule(
        mock,
        guild,
        GatewayDispatchEvents.AutoModerationRuleUpdate,
        rule,
      );
      recordAudit(mock, guild, {
        action_type: AuditLogEvent.AutoModerationRuleUpdate,
        user_id: state.bot.id,
        target_id: rule.id,
        reason: reasonOf(req),
      });
      return respond.json(rule);
    }),
  );

  rest.route(
    "DELETE",
    `${base}/:ruleId`,
    authed((req) => {
      const { refused, guild } = guarded(req.params.guildId!);
      if (refused) return refused;
      const rule = ruleIn(guild, req.params.ruleId!);
      if (!rule) return rest.gap("an unknown AutoMod rule");
      state.autoModRules.delete(rule.id);
      announceRule(
        mock,
        guild,
        GatewayDispatchEvents.AutoModerationRuleDelete,
        rule,
      );
      recordAudit(mock, guild, {
        action_type: AuditLogEvent.AutoModerationRuleDelete,
        user_id: state.bot.id,
        target_id: rule.id,
        reason: reasonOf(req),
      });
      return respond.noContent();
    }),
  );
}
