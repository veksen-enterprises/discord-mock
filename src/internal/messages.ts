import {
  GatewayDispatchEvents,
  GatewayIntentBits,
  type APIChannel,
  type APIMessage,
} from "discord-api-types/v10";
import type { DiscordMock } from "./mock.js";
import { Permission } from "./payloads.js";
import { respond, type RestHandler, type RestRequest } from "./rest.js";

// Pin Routes. Sources: discord-api-docs resources/message (Get Channel
// Pins, Pin Message, Unpin Message), topics/opcodes-and-status-codes for the
// JSON codes, and docs.discord.food/resources/message. HTTP statuses the docs don't give are
// inferred, not checked.

const MAX_PINS = 250; // 30003 "Maximum number of pins reached for the channel (250)"

/**
 * Registered before the Model's message Routes: `GET /messages/pins` would otherwise match
 * `GET /messages/:messageId`, as Discord's router never does.
 */
export function registerMessageRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state, gateway } = mock;
  /** When each pinned message was pinned, by message id. */
  const pinnedAt = new Map<string, string>();

  const guildIdOf = (channel: APIChannel) =>
    "guild_id" in channel && channel.guild_id ? channel.guild_id : undefined;
  /** The channel and message a route names, or the refusal Discord gives. */
  const target = (req: RestRequest, needed: bigint) => {
    const channel = state.channels.get(req.params.channelId!);
    if (!channel) return { refused: respond.unknownChannel() };
    const denied = mock.checkBotPerms(channel, needed);
    if (denied) return { refused: denied };
    const message = mock
      .messagesIn(channel)
      .find((m) => m.id === req.params.messageId);
    if (!message) return { refused: respond.unknownMessage() };
    return { channel, message };
  };
  const pinsIn = (channel: APIChannel) =>
    mock
      .messagesIn(channel)
      .filter((m) => m.pinned)
      .sort((a, b) => pinnedAt.get(b.id)!.localeCompare(pinnedAt.get(a.id)!));
  const withoutReactions = (m: APIMessage) => ({ ...m, reactions: undefined });

  /** CHANNEL_PINS_UPDATE (gateway-events#channel-pins-update): GUILDS in guilds, DIRECT_MESSAGES in DMs. */
  const announcePins = (channel: APIChannel) => {
    const guildId = guildIdOf(channel);
    const latest = pinsIn(channel)[0];
    gateway.dispatch(
      GatewayDispatchEvents.ChannelPinsUpdate,
      {
        ...(guildId ? { guild_id: guildId } : {}),
        channel_id: channel.id,
        last_pin_timestamp: latest ? pinnedAt.get(latest.id)! : null,
      },
      guildId ? GatewayIntentBits.Guilds : GatewayIntentBits.DirectMessages,
    );
  };

  // Get Channel Pins: VIEW_CHANNEL; without READ_MESSAGE_HISTORY "no pins will be returned".
  // Newest pin first; `before` is a pinned_at timestamp.
  rest.route(
    "GET",
    "/channels/:channelId/messages/pins",
    authed((req) => {
      const channel = state.channels.get(req.params.channelId!);
      if (!channel) return respond.unknownChannel();
      const denied = mock.checkBotPerms(channel, 0n);
      if (denied) return denied;
      if (mock.checkBotPerms(channel, Permission.ReadMessageHistory))
        return respond.json({ items: [], has_more: false });
      const before = req.query.get("before");
      const limit = Math.min(50, Number(req.query.get("limit") ?? 50));
      const pins = pinsIn(channel).filter(
        (m) => !before || pinnedAt.get(m.id)! < new Date(before).toISOString(),
      );
      return respond.json({
        items: pins.slice(0, limit).map((m) => ({
          pinned_at: pinnedAt.get(m.id)!,
          message: withoutReactions(m),
        })),
        has_more: pins.length > limit,
      });
    }),
  );

  // List Pinned Messages (deprecated; discord.js's fetchPinned still calls it): up to 50 messages.
  rest.route(
    "GET",
    "/channels/:channelId/pins",
    authed((req) => {
      const channel = state.channels.get(req.params.channelId!);
      if (!channel) return respond.unknownChannel();
      const denied = mock.checkBotPerms(channel, Permission.ReadMessageHistory);
      if (denied) return denied;
      return respond.json(pinsIn(channel).slice(0, 50).map(withoutReactions));
    }),
  );

  // Pin and Unpin Message need PIN_MESSAGES, split from MANAGE_MESSAGES on 2026-02-23
  // (discord-api-docs change-log). 204, fires CHANNEL_PINS_UPDATE. Pinning a pinned message,
  // or unpinning one that isn't, is answered 204 without an event (inferred, not checked).
  rest.route(
    "PUT",
    "/channels/:channelId/messages/pins/:messageId",
    authed((req) => {
      const { refused, channel, message } = target(req, Permission.PinMessages);
      if (refused) return refused;
      if (message.pinned) return respond.noContent();
      if (pinsIn(channel).length >= MAX_PINS)
        return respond.error(
          400,
          30003,
          "Maximum number of pins reached for the channel (250)",
        );
      message.pinned = true;
      pinnedAt.set(message.id, new Date().toISOString());
      announcePins(channel);
      return respond.noContent();
    }),
  );

  rest.route(
    "DELETE",
    "/channels/:channelId/messages/pins/:messageId",
    authed((req) => {
      const { refused, channel, message } = target(req, Permission.PinMessages);
      if (refused) return refused;
      if (!message.pinned) return respond.noContent();
      message.pinned = false;
      pinnedAt.delete(message.id);
      announcePins(channel);
      return respond.noContent();
    }),
  );
}
