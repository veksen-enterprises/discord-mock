import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { GatewayDispatchEvents, GatewayIntentBits, GatewayOpcodes, type APIMessage } from "discord-api-types/v10";
import type { DiscordState } from "./state.js";
import { snowflake } from "./snowflake.js";
import { guildCreatePayload } from "./payloads.js";

const PRIVILEGED = GatewayIntentBits.GuildMembers | GatewayIntentBits.GuildPresences | GatewayIntentBits.MessageContent;

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
}

export class Gateway {
  private wss = new WebSocketServer({ noServer: true });
  private sessions = new Map<string, Session>();
  url = "";

  constructor(
    private state: DiscordState,
    private options: GatewayOptions,
  ) {
    this.wss.on("connection", (socket, req) => this.onConnection(socket, req));
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
  }

  private onConnection(socket: WebSocket, req: IncomingMessage) {
    const params = new URL(req.url!, "http://localhost").searchParams;
    // Fail loudly rather than speak a protocol we don't: zlib-stream kicks in when zlib-sync is installed.
    if (params.get("compress") || params.get("encoding") === "etf") {
      socket.close(4000, `discord-mock: unsupported ${params.get("compress") ? "compress" : "encoding"} (${req.url})`);
      return;
    }
    const send = (payload: unknown) => socket.send(JSON.stringify(payload));
    send({ op: GatewayOpcodes.Hello, d: { heartbeat_interval: 41_250 }, s: null, t: null });

    let session: Session | undefined;
    socket.on("message", (raw) => {
      const { op, d } = JSON.parse(raw.toString());
      switch (op) {
        case GatewayOpcodes.Heartbeat:
          send({ op: GatewayOpcodes.HeartbeatAck });
          return;
        case GatewayOpcodes.Identify: {
          if (d.token !== this.options.token && d.token !== `Bot ${this.options.token}`) {
            socket.close(4004, "Authentication failed.");
            return;
          }
          const disallowed = d.intents & PRIVILEGED & ~this.options.privilegedIntents;
          if (disallowed) {
            socket.close(4014, "Disallowed intent(s).");
            return;
          }
          session = { id: snowflake(), intents: d.intents, seq: 0, socket, missed: [] };
          this.sessions.set(session.id, session);
          const guilds = [...this.state.guilds.values()];
          this.send(session, GatewayDispatchEvents.Ready, {
            v: 10,
            user: this.state.bot,
            guilds: guilds.map((g) => ({ id: g.id, unavailable: true })),
            session_id: session.id,
            resume_gateway_url: this.url,
            shard: [0, 1],
            application: { id: this.state.applicationId, flags: 0 },
          });
          for (const guild of guilds) this.send(session, GatewayDispatchEvents.GuildCreate, guildCreatePayload(this.state, guild));
          return;
        }
        case GatewayOpcodes.Resume: {
          const existing = this.sessions.get(d.session_id);
          if (!existing) {
            send({ op: GatewayOpcodes.InvalidSession, d: false });
            return;
          }
          session = existing;
          session.socket = socket;
          for (const payload of session.missed.splice(0)) socket.send(JSON.stringify(payload));
          this.send(session, GatewayDispatchEvents.Resumed, null);
          return;
        }
      }
    });
    socket.on("close", () => {
      if (session?.socket === socket) session.socket = null;
    });
  }

  private send(session: Session, t: string, d: unknown) {
    const payload = { op: GatewayOpcodes.Dispatch, t, s: ++session.seq, d };
    if (session.socket) session.socket.send(JSON.stringify(payload));
    else session.missed.push(payload);
  }

  /** Dispatch to every session whose intents allow it. */
  dispatch(t: string, d: unknown, requiredIntent?: number) {
    for (const session of this.sessions.values()) {
      if (requiredIntent && !(session.intents & requiredIntent)) continue;
      this.send(session, t, d);
    }
  }

  /**
   * MESSAGE_CREATE with Discord's intent rules: guild messages need GUILD_MESSAGES, DMs need
   * DIRECT_MESSAGES, and without MESSAGE_CONTENT the content fields arrive empty unless the
   * bot wrote the message, is mentioned, or it's a DM.
   */
  dispatchMessage(t: "MESSAGE_CREATE" | "MESSAGE_UPDATE", message: APIMessage & { guild_id?: string }) {
    const inGuild = !!message.guild_id;
    const required = inGuild ? GatewayIntentBits.GuildMessages : GatewayIntentBits.DirectMessages;
    for (const session of this.sessions.values()) {
      if (!(session.intents & required)) continue;
      const exempt =
        !inGuild ||
        message.author.id === this.state.bot.id ||
        message.mentions.some((u) => u.id === this.state.bot.id) ||
        session.intents & GatewayIntentBits.MessageContent;
      const member = inGuild ? this.state.guilds.get(message.guild_id!)?.members.get(message.author.id) : undefined;
      const d = {
        ...message,
        ...(member ? { member: { ...member, user: undefined } } : {}),
        ...(exempt ? {} : { content: "", embeds: [], attachments: [], components: [] }),
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

  close() {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }
}
