import {
  ChannelType,
  GatewayDispatchEvents,
  GatewayIntentBits,
  MessageFlags,
  type APIChannel,
  type APIThreadChannel,
} from "discord-api-types/v10";
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
      const denied = refuse(parent, Permission.CreatePublicThreads);
      if (denied) return denied;
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
        name: req.body?.name,
        ownerId: bot,
        autoArchiveDuration: req.body?.auto_archive_duration,
      });
      announceCreate(thread);
      // Not an edit: edited_timestamp stays as it was.
      Object.assign(message, {
        flags: (message.flags ?? 0) | MessageFlags.HasThread,
        thread,
      });
      state.emit("messageUpdate", message);
      gateway.dispatchMessage("MESSAGE_UPDATE", message);
      return respond.json(thread, 201);
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
        return rest.gap("forum post created by the bot");
      const type = (req.body?.type ?? ChannelType.PrivateThread) as ChannelType;
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
      const thread = state.createThread({
        type,
        parentId: parent.id,
        name: req.body?.name,
        ownerId: bot,
        autoArchiveDuration: req.body?.auto_archive_duration,
        invitable:
          type === ChannelType.PrivateThread
            ? (req.body?.invitable ?? true)
            : undefined,
      });
      announceCreate(thread);
      return respond.json(thread, 201);
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
      const known = ["name", "archived", "auto_archive_duration", "locked"];
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
  function announceCreate(thread: APIChannel) {
    gateway.dispatch(
      GatewayDispatchEvents.ThreadCreate,
      { ...thread, newly_created: true },
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
