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

  addMember(guildId: string, userId: string): APIGuildMember {
    const guild = this.requireGuild(guildId);
    const member: APIGuildMember = {
      user: this.requireUser(userId),
      roles: [],
      joined_at: new Date().toISOString(),
      nick: null,
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

  createTextChannel(guildId: string, input: { name: string }): APIChannel {
    const guild = this.requireGuild(guildId);
    const channel = {
      id: snowflake(),
      type: ChannelType.GuildText,
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
    } satisfies APIChannel;
    this.channels.set(channel.id, channel);
    this.messages.set(channel.id, []);
    guild.channelIds.push(channel.id);
    return channel;
  }

  createMessage(input: {
    channelId: string;
    authorId: string;
    content?: string;
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
    const message: APIMessage = {
      id: snowflake(),
      channel_id: channel.id,
      author: this.requireUser(input.authorId),
      content: input.content ?? "",
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      attachments: [],
      embeds: input.embeds ?? [],
      components: input.components ?? [],
      pinned: false,
      // 20 CHAT_INPUT_COMMAND for any interaction response, followups and component replies
      // included: inferred, not checked (the docs only describe 20 as the slash command reply).
      type: input.interaction ? 20 : 0,
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
