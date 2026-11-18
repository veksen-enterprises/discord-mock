import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  GatewayDispatchEvents,
  GatewayIntentBits,
  GatewayOpcodes,
  MessageFlags,
  type APIMessage,
} from "discord-api-types/v10";
import { WebSocketServer, type WebSocket } from "ws";
import { guildCreatePayload } from "./payloads.js";
import type { DiscordState, GuildRecord } from "./state.js";

const PRIVILEGED =
  GatewayIntentBits.GuildMembers |
  GatewayIntentBits.GuildPresences |
  GatewayIntentBits.MessageContent;

interface Session {
  id: string;
  intents: number;
  seq: number;
  socket: WebSocket | null;
  /** Dispatches emitted while the socket was down, replayed on RESUME like Discord does. */
  missed: unknown[];
}

export interface GatewayOptions {
  token: string;
  /** Privileged intents "enabled in the developer portal". Identify asking for others closes with 4014. */
  privilegedIntents: number;
  /** Records something the bot asked for that the Mock doesn't model, so the test fails on it. */
  recordGap: (what: string) => void;
  /** Called on every Dispatch, so the Mock can tell when the bot has something to react to. */
  onDispatch?: () => void;
  /** Op 4 from the bot; `reply` dispatches to the session that sent it alone. */
  onVoiceStateUpdate?: (d: any, reply: (t: string, d: unknown) => void) => void;
}

export class Gateway {
  private wss = new WebSocketServer({ noServer: true });
  private sessions = new Map<string, Session>();
  /** Sockets that connected while the Gateway is down, each waiting for its HELLO. */
  private held: (() => void)[] = [];
  private down = false;
  url = "";

  constructor(
    private state: DiscordState,
    private options: GatewayOptions,
  ) {
    this.wss.on("connection", (socket, req) => this.onConnection(socket, req));
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    this.wss.handleUpgrade(req, socket, head, (ws) =>
      this.wss.emit("connection", ws, req),
    );
  }

  private onConnection(socket: WebSocket, req: IncomingMessage) {
    const params = new URL(req.url!, "http://localhost").searchParams;
    // zlib-stream kicks in when zlib-sync is installed. No close code says "unsupported": @discordjs/ws
    // resumes on 4000 (WebSocketShard.onClose), so the bot reconnects in a loop. The Gap is what fails the test.
    if (params.get("compress") || params.get("encoding") === "etf") {
      this.options.recordGap(`gateway ${req.url}`);
      socket.close(
        4000,
        `discordjs-test-kit: unsupported ${params.get("compress") ? "compress" : "encoding"} (${req.url})`,
      );
      return;
    }
    const send = (payload: unknown) => socket.send(JSON.stringify(payload));
    const hello = () => {
      if (socket.readyState !== socket.OPEN) return;
      send({
        op: GatewayOpcodes.Hello,
        d: { heartbeat_interval: 41_250 },
        s: null,
        t: null,
      });
    };
    // A bot reconnecting during an outage waits on HELLO; @discordjs/ws gives it 60s (helloTimeout).
    if (this.down) this.held.push(hello);
    else hello();

    let session: Session | undefined;
    socket.on("message", (raw) => {
      let payload: { op: number; d: any };
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        // docs.discord.food/gateway/opcodes-and-close-codes: 4002 "You sent an invalid payload".
        socket.close(4002, "Error while decoding payload.");
        return;
      }
      const { op, d } = payload;
      switch (op) {
        case GatewayOpcodes.Heartbeat:
          // docs.discord.food/gateway/gateway-events#heartbeat-ack: d is null.
          send({ op: GatewayOpcodes.HeartbeatAck, d: null });
          return;
        case GatewayOpcodes.Identify: {
          if (
            d.token !== this.options.token &&
            d.token !== `Bot ${this.options.token}`
          ) {
            socket.close(4004, "Authentication failed.");
            return;
          }
          const disallowed =
            d.intents & PRIVILEGED & ~this.options.privilegedIntents;
          if (disallowed) {
            socket.close(4014, "Disallowed intent(s).");
            return;
          }
          session = {
            id: randomBytes(16).toString("hex"),
            intents: d.intents,
            seq: 0,
            socket,
            missed: [],
          };
          this.sessions.set(session.id, session);
          const guilds = [...this.state.guilds.values()].filter((g) =>
            this.state.botIn(g.id),
          );
          this.send(session, GatewayDispatchEvents.Ready, {
            v: 10,
            // READY's user is the full bot user: flags and account fields, no public_flags.
            user: {
              ...this.state.bot,
              public_flags: undefined,
              flags: 0,
              verified: true,
              mfa_enabled: false,
              email: null,
            },
            guilds: guilds.map((g) => ({ id: g.id, unavailable: true })),
            session_id: session.id,
            resume_gateway_url: this.url,
            shard: [0, 1],
            application: { id: this.state.applicationId, flags: 0 },
          });
          // gateway-events#guild-create, scenario 1: "Guilds that are unavailable due to an outage
          // will send a Guild Delete event."
          for (const guild of guilds)
            if (this.state.outages.has(guild.id))
              this.send(session, GatewayDispatchEvents.GuildDelete, {
                id: guild.id,
                unavailable: true,
              });
            else
              this.send(
                session,
                GatewayDispatchEvents.GuildCreate,
                guildCreatePayload(this.state, guild, session.intents),
              );
          return;
        }
        case GatewayOpcodes.Resume: {
          // docs.discord.food/gateway/gateway-events#resume carries the token like identify does.
          if (d.token !== this.options.token) {
            socket.close(4004, "Authentication failed.");
            return;
          }
          const existing = this.sessions.get(d.session_id);
          if (!existing) {
            send({ op: GatewayOpcodes.InvalidSession, d: false });
            return;
          }
          session = existing;
          session.socket = socket;
          for (const payload of session.missed.splice(0))
            socket.send(JSON.stringify(payload));
          this.send(session, GatewayDispatchEvents.Resumed, null);
          return;
        }
        case GatewayOpcodes.RequestGuildMembers:
          if (session) this.requestGuildMembers(session, d);
          return;
        // docs.discord.food/topics/gateway-events, Update Presence: no reply to the sender is
        // documented, and discord.js's ClientPresence.set doesn't wait for one. Nothing in the Model
        // shows a presence, so it is accepted and dropped. The 5 per 20s limit isn't modelled.
        // Inferred, not checked against Discord.
        case GatewayOpcodes.PresenceUpdate:
          return;
        // topics/voice-connections#retrieving-voice-server-information: the bot joins, moves or
        // leaves voice; Discord answers with VOICE_STATE_UPDATE and VOICE_SERVER_UPDATE.
        case GatewayOpcodes.VoiceStateUpdate:
          if (session && this.options.onVoiceStateUpdate) {
            const to = session;
            this.options.onVoiceStateUpdate(d, (t, data) =>
              this.send(to, t, data),
            );
          } else this.options.recordGap(`gateway op ${op}`);
          return;
        default:
          this.options.recordGap(`gateway op ${op}`);
      }
    });
    socket.on("close", () => {
      if (session?.socket === socket) session.socket = null;
    });
  }

  /**
   * Op 8, answered with GUILD_MEMBERS_CHUNK, up to 1000 members each. Discord's docs
   * (events/gateway-events#request-guild-members): one guild_id per request; the whole list
   * (query "") needs GUILD_MEMBERS; a `query` is a username prefix capped at 100 members;
   * `user_ids` is capped at 100 and unknown ids come back in `not_found`; presences need
   * GUILD_PRESENCES, else they're off. What Discord does when a rule is broken is unchecked: a Gap.
   */
  private requestGuildMembers(
    session: Session,
    d: {
      guild_id: string | string[];
      query?: string;
      limit?: number;
      presences?: boolean;
      user_ids?: string | string[];
      nonce?: string;
    },
  ) {
    if (Array.isArray(d.guild_id) && d.guild_id.length !== 1)
      return this.options.recordGap("gateway op 8 with several guild_ids");
    const guildId = Array.isArray(d.guild_id) ? d.guild_id[0]! : d.guild_id;
    const guild = this.state.guilds.get(guildId);
    if (!guild)
      return this.options.recordGap(
        `gateway op 8 for unknown guild ${guildId}`,
      );
    if (d.presences && session.intents & GatewayIntentBits.GuildPresences)
      return this.options.recordGap("gateway op 8 with presences");
    const all = [...guild.members.values()];
    let members: typeof all;
    let notFound: string[] | undefined;
    if (d.user_ids !== undefined) {
      const ids = [d.user_ids].flat().slice(0, 100);
      members = all.filter((m) => ids.includes(m.user.id));
      notFound = ids.filter((id) => !guild.members.has(id));
    } else if (d.query === "") {
      if (!(session.intents & GatewayIntentBits.GuildMembers))
        return this.options.recordGap(
          "gateway op 8 for every member without GUILD_MEMBERS",
        );
      members = d.limit ? all.slice(0, d.limit) : all;
    } else if (d.query !== undefined) {
      // A case-sensitive prefix match: inferred, not checked against Discord.
      members = all
        .filter((m) => m.user.username.startsWith(d.query!))
        .slice(0, Math.min(d.limit || 100, 100));
    } else {
      return this.options.recordGap("gateway op 8 without query or user_ids");
    }
    const chunkCount = Math.max(1, Math.ceil(members.length / 1000));
    for (let index = 0; index < chunkCount; index++)
      this.send(session, GatewayDispatchEvents.GuildMembersChunk, {
        guild_id: guild.id,
        members: members.slice(index * 1000, (index + 1) * 1000),
        chunk_index: index,
        chunk_count: chunkCount,
        ...(notFound?.length && index === 0 ? { not_found: notFound } : {}),
        ...(d.nonce !== undefined ? { nonce: d.nonce } : {}),
      });
  }

  private send(session: Session, t: string, d: unknown) {
    const payload = { op: GatewayOpcodes.Dispatch, t, s: ++session.seq, d };
    this.options.onDispatch?.();
    if (session.socket) session.socket.send(JSON.stringify(payload));
    else session.missed.push(payload);
  }

  /** GUILD_CREATE for a guild created after the bot connected (docs: scenario 3, "joins a new guild"). */
  announceGuild(guild: GuildRecord) {
    for (const session of this.sessions.values())
      this.send(
        session,
        GatewayDispatchEvents.GuildCreate,
        guildCreatePayload(this.state, guild, session.intents),
      );
  }

  /** Whether the bot hears `guildId`'s events: it's in the guild, and the guild isn't in an outage. */
  private hears(guildId: string) {
    return this.state.botIn(guildId) && !this.state.outages.has(guildId);
  }

  /**
   * An outage takes `guild` away: GUILD_DELETE with `unavailable: true`, then nothing from it until
   * `endOutage`, which sends GUILD_CREATE (gateway-events#guild-delete, #guild-create scenario 2).
   */
  startOutage(guild: GuildRecord) {
    this.dispatch(
      GatewayDispatchEvents.GuildDelete,
      { id: guild.id, unavailable: true },
      GatewayIntentBits.Guilds,
    );
    this.state.outages.add(guild.id);
  }

  endOutage(guild: GuildRecord) {
    this.state.outages.delete(guild.id);
    if (this.state.botIn(guild.id)) this.announceGuild(guild);
  }

  /** Dispatch to every session whose intents allow it. Nothing from a guild the bot isn't in. */
  dispatch(t: string, d: unknown, requiredIntent?: number) {
    const guildId = (d as { guild_id?: string } | undefined)?.guild_id;
    if (guildId && !this.hears(guildId)) return;
    for (const session of this.sessions.values()) {
      if (requiredIntent && !(session.intents & requiredIntent)) continue;
      this.send(session, t, d);
    }
  }

  /** Like `dispatch`, with the payload built per session from its intents. */
  dispatchFor(
    t: string,
    guildId: string,
    requiredIntent: number,
    build: (intents: number) => unknown,
  ) {
    if (!this.hears(guildId)) return;
    for (const session of this.sessions.values())
      if (session.intents & requiredIntent)
        this.send(session, t, build(session.intents));
  }

  /**
   * MESSAGE_CREATE/UPDATE with Discord's intent rules (docs.discord.food/gateway/using-gateway#message-content-intent):
   * guild messages need GUILD_MESSAGES, DMs need DIRECT_MESSAGES, and without MESSAGE_CONTENT the
   * content, embeds, attachments, components and poll arrive empty unless the bot wrote the
   * message, is mentioned, or it's a DM. Extra fields per gateway-events#message-object-extra-fields.
   */
  dispatchMessage(t: "MESSAGE_CREATE" | "MESSAGE_UPDATE", message: APIMessage) {
    // An ephemeral message lives only in the invoking user's client, so no bot's Gateway session
    // hears it, whichever route created or edited it. Inferred, not checked against Discord.
    if ((message.flags ?? 0) & MessageFlags.Ephemeral) return;
    const channel = this.state.requireChannel(message.channel_id);
    const guildId = "guild_id" in channel ? channel.guild_id : undefined;
    const inGuild = !!guildId;
    if (inGuild && !this.hears(guildId)) return;
    const required = inGuild
      ? GatewayIntentBits.GuildMessages
      : GatewayIntentBits.DirectMessages;
    for (const session of this.sessions.values()) {
      if (!(session.intents & required)) continue;
      const exempt =
        !inGuild ||
        message.author.id === this.state.bot.id ||
        message.mentions.some((u) => u.id === this.state.bot.id) ||
        session.intents & GatewayIntentBits.MessageContent;
      const member = inGuild
        ? this.state.guilds.get(guildId!)?.members.get(message.author.id)
        : undefined;
      const guild = guildId ? this.state.guilds.get(guildId) : undefined;
      const d = {
        ...message,
        ...(guildId ? { guild_id: guildId } : {}),
        channel_type: channel.type,
        ...(member ? { member: { ...member, user: undefined } } : {}),
        // In guilds each mentioned user carries its member, without `user`.
        mentions: message.mentions.map((u) => {
          const m = guild?.members.get(u.id);
          return m ? { ...u, member: { ...m, user: undefined } } : u;
        }),
        ...(exempt
          ? {}
          : {
              content: "",
              embeds: [],
              attachments: [],
              components: [],
              poll: undefined,
            }),
      };
      this.send(session, t, d);
    }
  }

  /** Simulate Discord dropping the connection; discord.js should resume. */
  dropConnections() {
    for (const session of this.sessions.values()) {
      session.socket?.terminate();
      session.socket = null;
    }
  }

  /**
   * Discord goes away for long enough that every session expires: docs.discord.food/gateway/using-gateway#resuming
   * says a session whose replay buffer overfills is invalidated. Dispatches until `comeBack` reach no one.
   */
  goDown() {
    this.down = true;
    for (const session of this.sessions.values()) session.socket?.terminate();
    this.sessions.clear();
  }

  /**
   * Discord is back. A held bot gets HELLO, tries to RESUME, gets Invalid Session (d: false) because
   * its session is gone, and identifies again; @discordjs/ws handles op 9 that way (WebSocketShard.onMessage).
   */
  comeBack() {
    this.down = false;
    for (const hello of this.held.splice(0)) hello();
  }

  close() {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }
}
