import {
  ChannelFlags,
  ChannelType,
  GatewayDispatchEvents,
  GatewayIntentBits,
  MessageFlags,
  type APIChannel,
  type APIThreadChannel,
  type RESTPostAPIChannelMessagesThreadsJSONBody,
  type RESTPostAPIChannelThreadsJSONBody,
} from "discord-api-types/v10";
import { messageLimitError, threadNameError } from "./limits.js";
import type { DiscordMock } from "./mock.js";
import { computePermissions, Permission } from "./payloads.js";
import { respond, type RestHandler, type RestRequest } from "./rest.js";

// Thread Routes. Sources: discord-api-docs resources/channel (Start Thread from Message, Start
// Thread without Message, Modify Channel thread params, Add/Remove/Get Thread Member, List Thread
// Members), topics/threads, topics/permissions, and docs.discord.food/resources/channel. Which JSON
// code each refusal carries, and its HTTP status, isn't documented per route: the pairings below
// come from Discord's code table and are inferred, not checked.

const archivedThread = () =>
  respond.error(
    400,
    50083,
    "Tried to perform an operation on an archived thread",
  );
const wrongChannelType = () =>
  respond.error(400, 50024, "Cannot execute action on this channel type");

/**
 * `applied_tags` problems for a post in `forum`: "limited to 5" (Modify Channel, thread), ids among
 * the forum's available_tags (inferred), and a `moderated` tag needs MANAGE_THREADS ("can only be
 * added to or removed from threads by a member with the MANAGE_THREADS permission"). The 50035 code
 * is inferred, not checked.
 */
function tagsError(
  forum: APIChannel,
  tags: unknown,
  before: string[],
  canManage: boolean,
) {
  if (!Array.isArray(tags) || tags.length > 5) return respond.invalidFormBody();
  const available =
    "available_tags" in forum ? (forum.available_tags ?? []) : [];
  if (tags.some((id) => !available.some((t) => t.id === id)))
    return respond.invalidFormBody();
  const changed = [
    ...tags.filter((id) => !before.includes(id)),
    ...before.filter((id) => !tags.includes(id)),
  ];
  if (
    !canManage &&
    changed.some((id) => available.find((t) => t.id === id)?.moderated)
  )
    return respond.missingPermissions();
  return undefined;
}

export function registerThreadRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state, gateway } = mock;
  const bot = state.bot.id;

  const botPerms = (channel: APIChannel) =>
    "guild_id" in channel && channel.guild_id
      ? computePermissions(
          state,
          state.requireGuild(channel.guild_id),
          bot,
          channel,
        )
      : 0n;
  /** 50001 without VIEW_CHANNEL, 50013 without any of `anyOf`. */
  const refuse = (channel: APIChannel, anyOf: bigint) => {
    const perms = botPerms(channel);
    if (!(perms & Permission.ViewChannel)) return respond.missingAccess();
    if (anyOf && !(perms & anyOf)) return respond.missingPermissions();
    return undefined;
  };
  const threadOf = (req: RestRequest) => {
    const channel = state.channels.get(req.params.channelId!);
    return channel && "thread_metadata" in channel
      ? (channel as APIThreadChannel)
      : undefined;
  };

  // docs: "The id of the created thread will be the same as the id of the source message".
  // A GUILD_TEXT parent makes a PUBLIC_THREAD, a GUILD_ANNOUNCEMENT one an ANNOUNCEMENT_THREAD.
  // Fires THREAD_CREATE and MESSAGE_UPDATE. The permission isn't named on the route; CREATE_PUBLIC_THREADS
  // "Allows for creating public and announcement threads" (topics/permissions), so it's inferred.
  // discord.js checks the HAS_THREAD flag before asking again (Message.startThread), so the flag is set.
  rest.route(
    "POST",
    "/channels/:channelId/messages/:messageId/threads",
    authed((req) => {
      const parent = state.channels.get(req.params.channelId!);
      if (!parent) return respond.unknownChannel();
      const message = state.messages
        .get(parent.id)
        ?.find((m) => m.id === req.params.messageId);
      if (!message) return respond.error(404, 10008, "Unknown Message");
      const type =
        parent.type === ChannelType.GuildText
          ? ChannelType.PublicThread
          : parent.type === ChannelType.GuildAnnouncement
            ? ChannelType.AnnouncementThread
            : undefined;
      if (type === undefined) return wrongChannelType();
      const body = req.body as
        | RESTPostAPIChannelMessagesThreadsJSONBody
        | undefined;
      const denied = refuse(parent, Permission.CreatePublicThreads);
      if (denied) return denied;
      const name = body?.name ?? "";
      const badName = threadNameError(name);
      if (badName) return badName;
      if (state.channels.has(message.id))
        return respond.error(
          400,
          160004,
          "A thread has already been created for this message",
        );
      const thread = state.createThread({
        id: message.id,
        type,
        parentId: parent.id,
        name,
        ownerId: bot,
        autoArchiveDuration: body?.auto_archive_duration,
        rateLimitPerUser: body?.rate_limit_per_user ?? undefined,
      });
      announceCreate(thread);
      // Not an edit: edited_timestamp stays as it was.
      Object.assign(message, {
        flags: (message.flags ?? 0) | MessageFlags.HasThread,
        thread,
      });
      state.emit("messageUpdate", message);
      // Discord's MESSAGE_UPDATE here leaves `thread` out, though the message has it over REST
      // (contract run 8).
      const { thread: _, ...dispatched } = message;
      gateway.dispatchMessage("MESSAGE_UPDATE", dispatched as typeof message);
      return respond.json(withBotMember(thread), 201);
    }),
  );

  // docs: `type` "currently defaults to PRIVATE_THREAD"; private threads "can only be created in
  // GUILD_TEXT channels"; food: "Requires the CREATE_PUBLIC_THREADS or CREATE_PRIVATE_THREADS
  // permission, depending on the type of thread being created".
  rest.route(
    "POST",
    "/channels/:channelId/threads",
    authed((req) => {
      const parent = state.channels.get(req.params.channelId!);
      if (!parent) return respond.unknownChannel();
      if (parent.type === ChannelType.GuildForum)
        return startForumPost(req, parent);
      const body = req.body as RESTPostAPIChannelThreadsJSONBody | undefined;
      const type = body?.type ?? ChannelType.PrivateThread;
      const allowed =
        parent.type === ChannelType.GuildText
          ? [ChannelType.PublicThread, ChannelType.PrivateThread]
          : parent.type === ChannelType.GuildAnnouncement
            ? [ChannelType.AnnouncementThread]
            : [];
      if (!allowed.includes(type)) return wrongChannelType();
      const denied = refuse(
        parent,
        type === ChannelType.PrivateThread
          ? Permission.CreatePrivateThreads
          : Permission.CreatePublicThreads,
      );
      if (denied) return denied;
      const name = body?.name ?? "";
      const badName = threadNameError(name);
      if (badName) return badName;
      const thread = state.createThread({
        type,
        parentId: parent.id,
        name,
        ownerId: bot,
        autoArchiveDuration: body?.auto_archive_duration,
        rateLimitPerUser: body?.rate_limit_per_user ?? undefined,
        invitable:
          type === ChannelType.PrivateThread
            ? (body?.invitable ?? true)
            : undefined,
      });
      announceCreate(thread);
      return respond.json(withBotMember(thread), 201);
    }),
  );

  // docs (Modify Channel, thread): name/archived/auto_archive_duration need MANAGE_THREADS or being
  // the creator; locked and rate_limit_per_user need MANAGE_THREADS; "Requires the thread to have
  // archived set to false or be set to false in the request"; a locked thread only unarchives with
  // MANAGE_THREADS (topics/threads). Fires THREAD_UPDATE.
  rest.route(
    "PATCH",
    "/channels/:channelId",
    authed((req) => {
      const channel = state.channels.get(req.params.channelId!);
      if (!channel) return respond.unknownChannel();
      const thread = threadOf(req);
      if (!thread) return rest.gap(`PATCH a channel of type ${channel.type}`);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const known = [
        "name",
        "archived",
        "auto_archive_duration",
        "locked",
        "applied_tags",
      ];
      const other = Object.keys(body).find((key) => !known.includes(key));
      if (other) return rest.gap(`PATCH thread ${other}`);
      const meta = thread.thread_metadata!;
      if (meta.archived && body.archived !== false) return archivedThread();
      // "When setting archived to false, when locked is also false, only the SEND_MESSAGES
      // permission is required" (the docs name SEND_MESSAGES here, not SEND_MESSAGES_IN_THREADS).
      const onlyUnarchive =
        Object.keys(body).length === 1 &&
        body.archived === false &&
        !meta.locked;
      const needsManage =
        "locked" in body ||
        (meta.locked && body.archived === false) ||
        (!onlyUnarchive && thread.owner_id !== bot);
      const denied = refuse(
        thread,
        needsManage
          ? Permission.ManageThreads
          : onlyUnarchive
            ? Permission.SendMessages
            : 0n,
      );
      if (denied) return denied;
      const badName = threadNameError(body.name);
      if (badName) return badName;
      if ("applied_tags" in body) {
        const forum = state.requireChannel(thread.parent_id!);
        if (forum.type !== ChannelType.GuildForum) return wrongChannelType();
        const badTags = tagsError(
          forum,
          body.applied_tags,
          thread.applied_tags ?? [],
          (botPerms(thread) & Permission.ManageThreads) !== 0n,
        );
        if (badTags) return badTags;
        thread.applied_tags = body.applied_tags as string[];
      }
      if (typeof body.name === "string") thread.name = body.name;
      if (typeof body.archived === "boolean") {
        meta.archived = body.archived;
        meta.archive_timestamp = new Date().toISOString();
      }
      if (typeof body.locked === "boolean") meta.locked = body.locked;
      if (typeof body.auto_archive_duration === "number")
        meta.auto_archive_duration = body.auto_archive_duration as never;
      gateway.dispatch(
        GatewayDispatchEvents.ThreadUpdate,
        thread,
        GatewayIntentBits.Guilds,
      );
      return respond.json(thread);
    }),
  );

  // Add Thread Member: 204 "if the member is successfully added or was already a member"; needs "the
  // ability to send messages in the thread" and an unarchived thread. @me joins.
  rest.route(
    "PUT",
    "/channels/:channelId/thread-members/:userId",
    authed((req) => {
      const thread = threadOf(req);
      if (!thread) return respond.unknownChannel();
      const userId = req.params.userId === "@me" ? bot : req.params.userId!;
      if (thread.thread_metadata!.archived) return archivedThread();
      const denied = refuse(
        thread,
        userId === bot ? 0n : Permission.SendMessagesInThreads,
      );
      if (denied) return denied;
      const guild = state.requireGuild(thread.guild_id!);
      if (!guild.members.has(userId))
        return respond.error(404, 10007, "Unknown Member");
      if (state.addThreadMember(thread.id, userId))
        announceMembers(mock, thread, { added: userId });
      return respond.noContent();
    }),
  );

  // Remove Thread Member: needs "MANAGE_THREADS ... or the creator of the thread if it is a
  // PRIVATE_THREAD"; leaving (@me) needs nothing. Both need an unarchived thread.
  rest.route(
    "DELETE",
    "/channels/:channelId/thread-members/:userId",
    authed((req) => {
      const thread = threadOf(req);
      if (!thread) return respond.unknownChannel();
      const userId = req.params.userId === "@me" ? bot : req.params.userId!;
      if (thread.thread_metadata!.archived) return archivedThread();
      const allowed =
        userId === bot ||
        !!(botPerms(thread) & Permission.ManageThreads) ||
        (thread.type === ChannelType.PrivateThread && thread.owner_id === bot);
      if (!allowed) return respond.missingPermissions();
      if (state.removeThreadMember(thread.id, userId))
        announceMembers(mock, thread, { removed: userId });
      return respond.noContent();
    }),
  );

  // Get Thread Member: "returns a 404 response otherwise". The code is inferred.
  rest.route(
    "GET",
    "/channels/:channelId/thread-members/:userId",
    authed((req) => {
      const thread = threadOf(req);
      if (!thread) return respond.unknownChannel();
      if (req.query.get("with_member") === "true")
        return rest.gap("thread member with_member");
      const member = state.threadMember(thread.id, req.params.userId!);
      return member
        ? respond.json(member)
        : respond.error(404, 10007, "Unknown Member");
    }),
  );

  rest.route(
    "GET",
    "/channels/:channelId/thread-members",
    authed((req) => {
      const thread = threadOf(req);
      if (!thread) return respond.unknownChannel();
      if (req.query.get("with_member") === "true")
        return rest.gap("thread members with_member");
      return respond.json(state.threadMembers(thread.id));
    }),
  );

  // gateway-events#thread-create: "When a thread is created, includes an additional newly_created
  // boolean field". GUILDS intent.
  // Discord's response carries the bot's thread member as `member` (contract run 8).
  // Start Thread in Forum or Media Channel: "The current user must have the SEND_MESSAGES
  // permission (CREATE_PUBLIC_THREADS is ignored)"; a PUBLIC_THREAD whose first message is
  // `message`, answered with the thread and that message nested. REQUIRE_TAG wants a tag: 40067
  // (pairing inferred). Files on the starter message are a Gap. Fires THREAD_CREATE and the
  // message's MESSAGE_CREATE. 201 like the other thread starts (inferred).
  function startForumPost(req: RestRequest, forum: APIChannel) {
    const denied = refuse(forum, Permission.SendMessages);
    if (denied) return denied;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (req.files?.length) return rest.gap("files on the bot's forum post");
    const badName = threadNameError(body.name ?? "");
    if (badName) return badName;
    const message = (body.message ?? {}) as Record<string, unknown>;
    if (
      message.content == null &&
      message.embeds == null &&
      message.components == null &&
      message.sticker_ids == null
    )
      return respond.error(400, 50006, "Cannot send an empty message");
    if (message.sticker_ids != null)
      return rest.gap("stickers on the bot's forum post");
    const overLimit = messageLimitError(message);
    if (overLimit) return overLimit;
    const tags = (body.applied_tags ?? []) as string[];
    const badTags = tagsError(
      forum,
      tags,
      [],
      (botPerms(forum) & Permission.ManageThreads) !== 0n,
    );
    if (badTags) return badTags;
    if (((forum.flags ?? 0) & ChannelFlags.RequireTag) !== 0 && !tags.length)
      return respond.error(
        400,
        40067,
        "A tag is required to create a forum post in this channel",
      );
    const thread = state.createThread({
      parentId: forum.id,
      name: body.name as string,
      ownerId: bot,
      autoArchiveDuration: body.auto_archive_duration as number | undefined,
      appliedTags: tags,
    });
    announceCreate(thread);
    const starter = state.createMessage({
      id: thread.id,
      channelId: thread.id,
      authorId: bot,
      content: message.content as string | undefined,
      embeds: message.embeds as never,
      components: message.components as never,
      flags: message.flags as number | undefined,
    });
    gateway.dispatchMessage("MESSAGE_CREATE", starter);
    return respond.json({ ...withBotMember(thread), message: starter }, 201);
  }

  const withBotMember = (thread: APIChannel) => ({
    ...thread,
    member: state.threadMember(thread.id, bot),
  });

  // The creator also gets THREAD_MEMBER_UPDATE for its own membership: real Discord sent it in
  // contract run 7 (gateway-events#thread-member-update: "the thread member object for the current
  // user").
  function announceCreate(thread: APIChannel) {
    gateway.dispatch(
      GatewayDispatchEvents.ThreadCreate,
      { ...thread, newly_created: true },
      GatewayIntentBits.Guilds,
    );
    gateway.dispatch(
      GatewayDispatchEvents.ThreadMemberUpdate,
      {
        ...state.threadMember(thread.id, bot),
        guild_id: (thread as APIThreadChannel).guild_id,
      },
      GatewayIntentBits.Guilds,
    );
  }
}

// gateway-events#thread-members-update: "If the current user does not have the GUILD_MEMBERS
// Gateway Intent, then this event will only be sent if the current user was added to or removed
// from the thread." member_count is capped at 50.
export function announceMembers(
  mock: DiscordMock,
  thread: APIThreadChannel,
  change: { added?: string; removed?: string },
) {
  const { state, gateway } = mock;
  const bot = state.bot.id;
  const userId = change.added ?? change.removed!;
  const guild = state.requireGuild(thread.guild_id!);
  const member = guild.members.get(userId);
  gateway.dispatch(
    GatewayDispatchEvents.ThreadMembersUpdate,
    {
      id: thread.id,
      guild_id: thread.guild_id,
      member_count: Math.min(50, state.threadMembers(thread.id).length),
      ...(change.added
        ? {
            added_members: [
              {
                ...state.threadMember(thread.id, userId),
                member,
                presence: null,
              },
            ],
          }
        : { removed_member_ids: [userId] }),
    },
    userId === bot ? GatewayIntentBits.Guilds : GatewayIntentBits.GuildMembers,
  );
}

// Discord's docs don't say it, but the Discord app adds a member to a private thread when a message
// there mentions them (inferred from the app, not checked). Without it, a bot that opens a private
// thread and greets the user by mention would fail a test it passes on Discord.
export function addMentionedToPrivateThread(
  mock: DiscordMock,
  thread: APIChannel,
  mentionedIds: string[],
) {
  if (thread.type !== ChannelType.PrivateThread) return;
  const guild = mock.state.requireGuild((thread as APIThreadChannel).guild_id!);
  for (const userId of mentionedIds)
    if (
      guild.members.has(userId) &&
      mock.state.addThreadMember(thread.id, userId)
    )
      announceMembers(mock, thread as APIThreadChannel, { added: userId });
}
