import {
  GatewayDispatchEvents,
  GatewayIntentBits,
  MessageType,
  PollLayoutType,
  type APIMessage,
  type APIUser,
} from "discord-api-types/v10";
import type { DiscordMock } from "./mock.js";
import { respond, type RestHandler } from "./rest.js";

// Polls. Sources: discord-api-docs resources/poll (the poll object and create request: answers
// numbered from 1, duration in hours defaulting to 24, "Apps are not allowed to vote", End Poll
// "cannot end polls from other users", Get Answer Voters), resources/message (poll on Create
// Message; POLL_RESULT messages "sent after a poll has ended and the results have been finalized",
// pointing at the poll, with a poll_result embed), events/gateway (GUILD_MESSAGE_POLLS,
// DIRECT_MESSAGE_POLLS), events/gateway-events (Message Poll Vote Add/Remove fields), and the code
// table (520001 Poll expired, 520003 Cannot edit a poll message, 520006 Cannot expire a non-poll
// message). Polls don't end on their own as time passes; the bot ends them with End Poll.

type Poll = NonNullable<APIMessage["poll"]>;

interface PollRequest {
  question: { text: string };
  answers: {
    poll_media: { text?: string; emoji?: { id?: string; name?: string } };
  }[];
  duration?: number;
  allow_multiselect?: boolean;
  layout_type?: number;
}

/** The poll object a create request becomes: answer ids from 1, `expiry` from `duration` hours. */
export function pollFrom(request: unknown): Poll | undefined {
  if (!request) return undefined;
  const req = request as PollRequest;
  return {
    question: { text: req.question.text },
    answers: req.answers.map((answer, i) => ({
      answer_id: i + 1,
      poll_media: answer.poll_media,
    })),
    expiry: new Date(
      Date.now() + (req.duration ?? 24) * 3_600_000,
    ).toISOString(),
    allow_multiselect: req.allow_multiselect ?? false,
    layout_type: req.layout_type ?? PollLayoutType.Default,
    results: { is_finalized: false, answer_counts: [] },
  } as Poll;
}

const ended = (poll: Poll) =>
  poll.results?.is_finalized || Date.parse(poll.expiry!) <= Date.now();

/** Recounts `message`'s poll from the votes. `me_voted` is the bot's, and apps can't vote. */
function recount(mock: DiscordMock, message: APIMessage) {
  const votes = mock.state.pollVotes.get(message.id) ?? new Map();
  const counts = new Map<number, number>();
  for (const picks of votes.values())
    for (const id of picks) counts.set(id, (counts.get(id) ?? 0) + 1);
  message.poll!.results = {
    is_finalized: message.poll!.results?.is_finalized ?? false,
    answer_counts: [...counts]
      .sort(([a], [b]) => a - b)
      .map(([id, count]) => ({ id, count, me_voted: false })),
  };
}

function announceVote(
  mock: DiscordMock,
  t:
    | GatewayDispatchEvents.MessagePollVoteAdd
    | GatewayDispatchEvents.MessagePollVoteRemove,
  user: APIUser,
  message: APIMessage,
  answerId: number,
) {
  const channel = mock.state.requireChannel(message.channel_id);
  const guildId = "guild_id" in channel ? channel.guild_id : undefined;
  mock.gateway.dispatch(
    t,
    {
      user_id: user.id,
      channel_id: channel.id,
      message_id: message.id,
      ...(guildId ? { guild_id: guildId } : {}),
      answer_id: answerId,
    },
    guildId
      ? GatewayIntentBits.GuildMessagePolls
      : GatewayIntentBits.DirectMessagePolls,
  );
}

/**
 * `user` votes for the answers labelled `labels` on `message`'s poll, as in the Discord app: one
 * answer unless allow_multiselect, not after it ends, and not again before removing their vote
 * (the app's behaviour, inferred). One MESSAGE_POLL_VOTE_ADD per answer.
 */
export function vote(
  mock: DiscordMock,
  user: APIUser,
  message: APIMessage,
  labels: string[],
) {
  const poll = message.poll;
  if (!poll) throw new Error("discordjs-test-kit: that message has no poll");
  if (ended(poll)) throw new Error("discordjs-test-kit: that poll has ended");
  if (!labels.length || (labels.length > 1 && !poll.allow_multiselect))
    throw new Error(
      `discordjs-test-kit: that poll takes ${poll.allow_multiselect ? "one or more answers" : "one answer"}`,
    );
  const ids = labels.map((label) => {
    const answer = poll.answers.find((a) => a.poll_media.text === label);
    if (!answer)
      throw new Error(
        `discordjs-test-kit: the poll has no answer "${label}"; it has ${poll.answers.map((a) => a.poll_media.text).join(", ")}`,
      );
    return answer.answer_id;
  });
  const votes = mock.state.pollVotes.get(message.id) ?? new Map();
  mock.state.pollVotes.set(message.id, votes);
  if (votes.has(user.id))
    throw new Error(
      `discordjs-test-kit: ${user.username} already voted; remove the vote first`,
    );
  votes.set(user.id, ids);
  recount(mock, message);
  for (const id of ids)
    announceVote(
      mock,
      GatewayDispatchEvents.MessagePollVoteAdd,
      user,
      message,
      id,
    );
}

/** `user` removes their vote: one MESSAGE_POLL_VOTE_REMOVE per answer they had picked. */
export function removeVote(
  mock: DiscordMock,
  user: APIUser,
  message: APIMessage,
) {
  const poll = message.poll;
  if (!poll) throw new Error("discordjs-test-kit: that message has no poll");
  if (ended(poll)) throw new Error("discordjs-test-kit: that poll has ended");
  const ids = mock.state.pollVotes.get(message.id)?.get(user.id);
  if (!ids)
    throw new Error(`discordjs-test-kit: ${user.username} hasn't voted`);
  mock.state.pollVotes.get(message.id)!.delete(user.id);
  recount(mock, message);
  for (const id of ids)
    announceVote(
      mock,
      GatewayDispatchEvents.MessagePollVoteRemove,
      user,
      message,
      id,
    );
}

export function registerPollRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state } = mock;
  const find = (channelId: string, messageId: string) =>
    state.messages.get(channelId)?.find((m) => m.id === messageId);

  // End Poll: the bot's own poll only (what Discord answers for someone else's isn't documented, so
  // it's a Gap); 520006 for a message without one; 520001 once ended (pairing inferred). Ending
  // finalizes the results, fires MESSAGE_UPDATE and posts the POLL_RESULT message, whose
  // victor_* fields are left out on a tie (inferred).
  rest.route(
    "POST",
    "/channels/:channelId/polls/:messageId/expire",
    authed((req) => {
      const channel = state.channels.get(req.params.channelId!);
      if (!channel) return respond.unknownChannel();
      const denied = mock.checkBotPerms(channel, 0n);
      if (denied) return denied;
      const message = find(channel.id, req.params.messageId!);
      if (!message) return respond.error(404, 10008, "Unknown Message");
      const poll = message.poll;
      if (!poll)
        return respond.error(400, 520006, "Cannot expire a non-poll message");
      if (message.author.id !== state.bot.id)
        return rest.gap("ending another user's poll");
      if (ended(poll)) return respond.error(400, 520001, "Poll expired");
      poll.expiry = new Date().toISOString();
      recount(mock, message);
      poll.results!.is_finalized = true;
      mock.gateway.dispatchMessage("MESSAGE_UPDATE", message);
      const counts = poll.results!.answer_counts;
      const total = counts.reduce((n, c) => n + c.count, 0);
      const top = Math.max(0, ...counts.map((c) => c.count));
      const victors = counts.filter((c) => c.count === top && top > 0);
      const victor =
        victors.length === 1
          ? poll.answers.find((a) => a.answer_id === victors[0]!.id)
          : undefined;
      const result = state.createMessage({
        channelId: channel.id,
        authorId: message.author.id,
        embeds: [
          {
            type: "poll_result" as never,
            fields: [
              { name: "poll_question_text", value: poll.question.text ?? "" },
              { name: "victor_answer_votes", value: String(top) },
              { name: "total_votes", value: String(total) },
              ...(victor
                ? [
                    {
                      name: "victor_answer_id",
                      value: String(victor.answer_id),
                    },
                    {
                      name: "victor_answer_text",
                      value: victor.poll_media.text ?? "",
                    },
                  ]
                : []),
            ],
          },
        ],
      });
      Object.assign(result, {
        type: MessageType.PollResult,
        mentions: [message.author],
        message_reference: {
          type: 0,
          message_id: message.id,
          channel_id: channel.id,
          ...("guild_id" in channel && channel.guild_id
            ? { guild_id: channel.guild_id }
            : {}),
        },
      });
      mock.gateway.dispatchMessage("MESSAGE_CREATE", result);
      return respond.json(message);
    }),
  );

  // Get Answer Voters: `after` and `limit` (1-100, 25 by default), users in id order (inferred).
  rest.route(
    "GET",
    "/channels/:channelId/polls/:messageId/answers/:answerId",
    authed((req) => {
      const channel = state.channels.get(req.params.channelId!);
      if (!channel) return respond.unknownChannel();
      // The docs name no permission; seeing the channel is assumed (inferred).
      const denied = mock.checkBotPerms(channel, 0n);
      if (denied) return denied;
      const message = find(channel.id, req.params.messageId!);
      if (!message) return respond.error(404, 10008, "Unknown Message");
      if (!message.poll) return rest.gap("voters of a message without a poll");
      const answerId = Number(req.params.answerId);
      const after = req.query.get("after");
      const limit = Math.min(Number(req.query.get("limit") ?? 25), 100);
      const users = [...(state.pollVotes.get(message.id) ?? new Map())]
        .filter(([, ids]) => (ids as number[]).includes(answerId))
        .map(([userId]) => state.requireUser(userId as string))
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
        .filter((u) => !after || BigInt(u.id) > BigInt(after))
        .slice(0, limit);
      return respond.json({ users });
    }),
  );
}
