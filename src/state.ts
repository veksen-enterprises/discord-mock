import { EventEmitter } from "node:events";
import {
  ChannelType,
  type APIApplicationCommand,
  type ChannelFlags,
  type GuildMemberFlags,
  type UserFlags,
  type RoleFlags,
  type APIChannel,
  type APIGuildMember,
  type APIMessage,
  type APIRole,
  type APIUser,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord-api-types/v10";
import { snowflake } from "./snowflake.js";

export interface GuildRecord {
  id: string;
  name: string;
  ownerId: string;
  roles: Map<string, APIRole>;
  members: Map<string, APIGuildMember>;
  channelIds: string[];
}

/**
 * The fake Discord's in-memory truth. REST writes mutate it; the gateway
 * announces the mutations. Tests read it to assert what the bot did.
 */
export class DiscordState extends EventEmitter<{
  messageCreate: [APIMessage];
  messageUpdate: [APIMessage];
}> {
  readonly users = new Map<string, APIUser>();
  readonly guilds = new Map<string, GuildRecord>();
  readonly channels = new Map<string, APIChannel>();
  readonly messages = new Map<string, APIMessage[]>();
  /** Bytes behind each attachment url, keyed by attachment id. */
  readonly files = new Map<string, { data: Uint8Array; contentType: string }>();
  /** Base for attachment urls; set when the server listens. */
  cdnUrl = "";
  /** Keyed by guild id or "global", then by `${type}:${name}`: names are unique per type and scope. */
  readonly commands = new Map<string, Map<string, APIApplicationCommand>>();

  readonly applicationId: string;
  readonly bot: APIUser;

  constructor() {
    super();
    this.applicationId = snowflake();
    this.bot = this.createUser({
      username: "bot",
      bot: true,
      id: this.applicationId,
    });
  }

  createUser(input: { username: string; bot?: boolean; id?: string }): APIUser {
    const user: APIUser = {
      id: input.id ?? snowflake(),
      username: input.username,
      discriminator: "0",
      global_name: null,
      avatar: null,
      public_flags: 0 as UserFlags,
      ...(input.bot ? { bot: true } : {}),
    };
    this.users.set(user.id, user);
    return user;
  }

  createGuild(input: { name: string; ownerId?: string }): GuildRecord {
    const id = snowflake();
    const everyone: APIRole = {
      id,
      name: "@everyone",
      color: 0,
      colors: { primary_color: 0, secondary_color: null, tertiary_color: null },
      hoist: false,
      icon: null,
      unicode_emoji: null,
      position: 0,
      // VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY | USE_APPLICATION_COMMANDS
      permissions: String(
        (1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 31n),
      ),
      managed: false,
      mentionable: false,
      flags: 0 as RoleFlags,
    };
    const guild: GuildRecord = {
      id,
      name: input.name,
      // Never the bot by default: owners bypass every permission check, which would hide permission bugs.
      ownerId:
        input.ownerId ??
        this.createUser({ username: `${input.name}-owner` }).id,
      roles: new Map([[id, everyone]]),
      members: new Map(),
      channelIds: [],
    };
    this.guilds.set(id, guild);
    this.addMember(guild.id, guild.ownerId);
    this.addMember(guild.id, this.bot.id);
    return guild;
  }

  addMember(
    guildId: string,
    userId: string,
    input: { nick?: string } = {},
  ): APIGuildMember {
    const guild = this.requireGuild(guildId);
    const member: APIGuildMember = {
      user: this.requireUser(userId),
      roles: [],
      joined_at: new Date().toISOString(),
      nick: input.nick ?? null,
      avatar: null,
      banner: null,
      pending: false,
      premium_since: null,
      communication_disabled_until: null,
      deaf: false,
      mute: false,
      flags: 0 as GuildMemberFlags,
    };
    guild.members.set(userId, member);
    return member;
  }

  createRole(
    guildId: string,
    input: { name: string; permissions: bigint },
  ): APIRole {
    const guild = this.requireGuild(guildId);
    const role: APIRole = {
      ...guild.roles.get(guild.id)!,
      id: snowflake(),
      name: input.name,
      position: guild.roles.size,
      permissions: String(input.permissions),
    };
    guild.roles.set(role.id, role);
    return role;
  }

  assignRole(guildId: string, userId: string, roleId: string) {
    const member = this.requireGuild(guildId).members.get(userId);
    if (!member) throw new Error(`discord-mock: ${userId} isn't a member`);
    if (!member.roles.includes(roleId)) member.roles.push(roleId);
  }

  deleteChannel(id: string): APIChannel {
    const channel = this.requireChannel(id);
    this.channels.delete(id);
    this.messages.delete(id);
    if ("guild_id" in channel && channel.guild_id) {
      const guild = this.requireGuild(channel.guild_id);
      guild.channelIds = guild.channelIds.filter((c) => c !== id);
    }
    return channel;
  }

  createCategoryChannel(guildId: string, input: { name: string }): APIChannel {
    const guild = this.requireGuild(guildId);
    const channel = {
      id: snowflake(),
      type: ChannelType.GuildCategory,
      guild_id: guild.id,
      name: input.name,
      position: guild.channelIds.length,
      permission_overwrites: [],
      flags: 0 as ChannelFlags,
    } satisfies APIChannel;
    this.channels.set(channel.id, channel);
    guild.channelIds.push(channel.id);
    return channel;
  }

  createTextChannel(
    guildId: string,
    input: { name: string; parentId?: string },
  ): APIChannel {
    const guild = this.requireGuild(guildId);
    const channel = {
      id: snowflake(),
      type: ChannelType.GuildText,
      guild_id: guild.id,
      name: input.name,
      position: guild.channelIds.length,
      permission_overwrites: [],
      parent_id: input.parentId ?? null,
      nsfw: false,
      topic: null,
      last_message_id: null,
      rate_limit_per_user: 0,
      flags: 0 as ChannelFlags,
    } satisfies APIChannel;
    this.channels.set(channel.id, channel);
    this.messages.set(channel.id, []);
    guild.channelIds.push(channel.id);
    return channel;
  }

  /**
   * A forum (thread-only) channel. Its posts are threads; see `createThread`.
   * docs.discord.food/topics/threads#thread-only-channels
   */
  createForumChannel(guildId: string, input: { name: string }): APIChannel {
    const guild = this.requireGuild(guildId);
    const channel = {
      id: snowflake(),
      type: ChannelType.GuildForum,
      guild_id: guild.id,
      name: input.name,
      position: guild.channelIds.length,
      permission_overwrites: [],
      parent_id: null,
      nsfw: false,
      topic: null,
      last_message_id: null,
      rate_limit_per_user: 0,
      flags: 0 as ChannelFlags,
      available_tags: [],
      default_reaction_emoji: null,
      default_sort_order: null,
      default_forum_layout: 0,
    } as unknown as APIChannel;
    this.channels.set(channel.id, channel);
    guild.channelIds.push(channel.id);
    return channel;
  }

  /**
   * A public thread under `parentId`. In a forum, the starter message shares the thread's id
   * (docs.discord.food/topics/threads#thread-only-channels); `archived` files it under the
   * archived list instead of the active one.
   */
  createThread(input: {
    parentId: string;
    name: string;
    ownerId: string;
    archived?: boolean;
  }): APIChannel {
    const parent = this.requireChannel(input.parentId);
    if (!("guild_id" in parent) || !parent.guild_id)
      throw new Error("discord-mock: threads live in guild channels");
    const now = new Date().toISOString();
    const thread = {
      id: snowflake(),
      type: ChannelType.PublicThread,
      guild_id: parent.guild_id,
      parent_id: parent.id,
      owner_id: input.ownerId,
      name: input.name,
      last_message_id: null,
      rate_limit_per_user: 0,
      message_count: 0,
      member_count: 1,
      total_message_sent: 0,
      flags: 0 as ChannelFlags,
      thread_metadata: {
        archived: !!input.archived,
        auto_archive_duration: 4320,
        archive_timestamp: now,
        locked: false,
        create_timestamp: now,
      },
    } as unknown as APIChannel;
    this.channels.set(thread.id, thread);
    this.messages.set(thread.id, []);
    return thread;
  }

  /** The DM channel between the bot and `userId`, created on first use. */
  dmChannel(userId: string): APIChannel {
    const existing = [...this.channels.values()].find(
      (c) =>
        c.type === ChannelType.DM && c.recipients?.some((u) => u.id === userId),
    );
    if (existing) return existing;
    const channel = {
      id: snowflake(),
      type: ChannelType.DM,
      last_message_id: null,
      recipients: [this.requireUser(userId)],
      flags: 0 as ChannelFlags,
    } as unknown as APIChannel;
    this.channels.set(channel.id, channel);
    this.messages.set(channel.id, []);
    return channel;
  }

  /** The channel a thread's permissions come from: its parent. Any other channel is its own. */
  permissionChannel(channel: APIChannel): APIChannel {
    return "thread_metadata" in channel && channel.parent_id
      ? this.requireChannel(channel.parent_id)
      : channel;
  }

  addReaction(
    channelId: string,
    messageId: string,
    emoji: string,
    userId: string,
  ) {
    const message = this.requireMessage(channelId, messageId);
    const reactions = (message.reactions ??= []);
    let reaction = reactions.find((r) => r.emoji.name === emoji);
    if (!reaction) {
      reaction = {
        count: 0,
        count_details: { burst: 0, normal: 0 },
        me: false,
        me_burst: false,
        burst_colors: [],
        emoji: { id: null, name: emoji },
      };
      reactions.push(reaction);
    }
    const by = this.reactors.get(`${messageId}:${emoji}`) ?? new Set<string>();
    if (by.has(userId)) return false;
    by.add(userId);
    this.reactors.set(`${messageId}:${emoji}`, by);
    reaction.count++;
    reaction.count_details.normal++;
    if (userId === this.bot.id) reaction.me = true;
    return true;
  }

  removeReaction(
    channelId: string,
    messageId: string,
    emoji: string,
    userId: string,
  ) {
    const message = this.requireMessage(channelId, messageId);
    const by = this.reactors.get(`${messageId}:${emoji}`);
    if (!by?.delete(userId)) return false;
    const reaction = message.reactions!.find((r) => r.emoji.name === emoji)!;
    reaction.count--;
    reaction.count_details.normal--;
    if (userId === this.bot.id) reaction.me = false;
    if (!reaction.count)
      message.reactions = message.reactions!.filter((r) => r !== reaction);
    return true;
  }

  /** Who reacted with what, keyed by `${messageId}:${emoji}`. */
  readonly reactors = new Map<string, Set<string>>();

  createMessage(input: {
    channelId: string;
    authorId: string;
    content?: string;
    /** Files the author uploaded; served at `cdnUrl`. */
    files?: { name: string; data: Uint8Array; contentType: string }[];
    /** The message this one replies to. */
    replyTo?: string;
    /** Use this id, e.g. a forum post's starter message shares the thread's id. */
    id?: string;
    embeds?: APIMessage["embeds"];
    components?: APIMessage["components"];
    flags?: number;
    /** docs.discord.food/resources/message#message-interaction-metadata-structure */
    interaction?: {
      id: string;
      type: number;
      userId: string;
      guildId?: string;
      /** Component interactions only. */
      interactedMessageId?: string;
      /** Followups only. */
      originalResponseMessageId?: string;
    };
    webhookId?: string;
  }): APIMessage {
    const channel = this.requireChannel(input.channelId);
    // No guild_id: Discord sends it on gateway dispatches only, not in REST message objects.
    const id = input.id ?? snowflake();
    const attachments = (input.files ?? []).map((file) => {
      const attachmentId = snowflake();
      this.files.set(attachmentId, {
        data: file.data,
        contentType: file.contentType,
      });
      // Real urls point at cdn.discordapp.com and carry signed ex/is/hm params; inferred shape.
      const url = `${this.cdnUrl}/attachments/${channel.id}/${attachmentId}/${encodeURIComponent(file.name)}`;
      return {
        id: attachmentId,
        filename: file.name,
        size: file.data.byteLength,
        url,
        proxy_url: url,
        content_type: file.contentType,
      };
    });
    const message: APIMessage = {
      id,
      channel_id: channel.id,
      author: this.requireUser(input.authorId),
      content: input.content ?? "",
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      attachments,
      embeds: input.embeds ?? [],
      components: input.components ?? [],
      pinned: false,
      // 20 CHAT_INPUT_COMMAND for any interaction response, followups and component replies
      // included: inferred, not checked (the docs only describe 20 as the slash command reply).
      type: input.interaction ? 20 : input.replyTo ? 19 : 0,
      ...(input.replyTo
        ? {
            message_reference: {
              type: 0,
              message_id: input.replyTo,
              channel_id: channel.id,
              ...("guild_id" in channel && channel.guild_id
                ? { guild_id: channel.guild_id }
                : {}),
            },
          }
        : {}),
      flags: input.flags ?? 0,
      ...(input.webhookId ? { webhook_id: input.webhookId } : {}),
      ...(input.interaction
        ? {
            interaction_metadata: {
              id: input.interaction.id,
              type: input.interaction.type,
              user: this.requireUser(input.interaction.userId),
              authorizing_integration_owners: {
                0: input.interaction.guildId ?? "0",
              },
              ...(input.interaction.interactedMessageId
                ? {
                    interacted_message_id:
                      input.interaction.interactedMessageId,
                  }
                : {}),
              ...(input.interaction.originalResponseMessageId
                ? {
                    original_response_message_id:
                      input.interaction.originalResponseMessageId,
                  }
                : {}),
            } as APIMessage["interaction_metadata"],
          }
        : {}),
    };
    this.messages.get(channel.id)!.push(message);
    // docs.discord.food/topics/threads: message_count and total_message_sent count MESSAGE_CREATEs.
    if ("thread_metadata" in channel) {
      const counts = channel as {
        message_count?: number;
        total_message_sent?: number;
      };
      counts.message_count = (counts.message_count ?? 0) + 1;
      counts.total_message_sent = (counts.total_message_sent ?? 0) + 1;
    }
    (channel as { last_message_id?: string | null }).last_message_id =
      message.id;
    this.emit("messageCreate", message);
    return message;
  }

  updateMessage(
    channelId: string,
    messageId: string,
    patch: Partial<APIMessage>,
  ): APIMessage {
    const message = this.requireMessage(channelId, messageId);
    Object.assign(message, patch, {
      edited_timestamp: new Date().toISOString(),
    });
    this.emit("messageUpdate", message);
    return message;
  }

  setCommands(
    scope: string,
    bodies: RESTPostAPIApplicationCommandsJSONBody[],
  ): APIApplicationCommand[] {
    const existing = this.commands.get(scope);
    const next = new Map<string, APIApplicationCommand>();
    // docs.discord.food/interactions/application-commands: bulk overwrite replaces the scope;
    // a command whose name (and type) already exists keeps its id.
    for (const body of bodies) {
      const key = `${body.type ?? 1}:${body.name}`;
      const command = {
        id: existing?.get(key)?.id ?? snowflake(),
        application_id: this.applicationId,
        version: snowflake(),
        default_member_permissions: null,
        type: 1,
        description: "",
        ...(scope === "global" ? {} : { guild_id: scope }),
        ...body,
      } as APIApplicationCommand;
      next.set(key, command);
    }
    this.commands.set(scope, next);
    return [...next.values()];
  }

  findCommand(
    guildId: string | undefined,
    name: string,
  ): APIApplicationCommand | undefined {
    return (
      (guildId && this.commands.get(guildId)?.get(`1:${name}`)) ||
      this.commands.get("global")?.get(`1:${name}`)
    );
  }

  requireUser(id: string): APIUser {
    const user = this.users.get(id);
    if (!user) throw new Error(`discord-mock: unknown user ${id}`);
    return user;
  }
  requireGuild(id: string): GuildRecord {
    const guild = this.guilds.get(id);
    if (!guild) throw new Error(`discord-mock: unknown guild ${id}`);
    return guild;
  }
  requireChannel(id: string): APIChannel {
    const channel = this.channels.get(id);
    if (!channel) throw new Error(`discord-mock: unknown channel ${id}`);
    return channel;
  }
  requireMessage(channelId: string, id: string): APIMessage {
    const message = this.messages.get(channelId)?.find((m) => m.id === id);
    if (!message)
      throw new Error(`discord-mock: unknown message ${id} in ${channelId}`);
    return message;
  }
}
