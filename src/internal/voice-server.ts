import { createDecipheriv, randomBytes, randomInt } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { EventEmitter, once } from "node:events";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import {
  VoiceOpcodes,
  type VoiceSendPayload,
} from "discord-api-types/voice/v8";
import { WebSocketServer, type WebSocket } from "ws";
import { selfSignedCertificate, trustCertificate } from "./certificate.js";

// The voice server a bot's voice connection (@discordjs/voice) talks to. Source: Discord's docs,
// topics/voice-connections: Hello (op 8, with `v`), Identify (op 0) answered by Ready (op 2: ssrc,
// ip, port, modes), Heartbeat (op 3, `seq_ack` since v8) answered by Heartbeat ACK (op 6), IP
// Discovery over UDP (a 74-byte request of type 1, answered with type 2, the address and port),
// Select Protocol (op 1) answered by Session Description (op 4: mode, 32-byte secret_key,
// dave_protocol_version), Speaking (op 5), RTP packets of 0x80 0x78, a sequence, a timestamp and
// the SSRC, and "aead_aes256_gcm_rtpsize" with a 32-bit nonce appended to the payload. Close codes
// from topics/opcodes-and-status-codes#voice.
//
// Not modelled, so a test can't lean on them: DAVE (the end-to-end encryption MLS group). The bot
// must offer DAVE in Identify, as Discord only supports E2EE calls since March 2026 (4017
// otherwise, inferred, not checked); the call then runs at dave_protocol_version 0, transport
// encryption only, which the docs allow ("any non-discontinued protocol version equal to or less
// than your supported protocol version"). Resume (op 7) and other opcodes the bot sends are Gaps.
// Other users' audio and Speaking aren't sent, and xchacha20 packets aren't decrypted: in that mode
// every packet counts as sound.

const MODES = ["aead_aes256_gcm_rtpsize", "aead_xchacha20_poly1305_rtpsize"];
const SILENCE = Buffer.from([0xf8, 0xff, 0xfe]);

/** One voice session: what VOICE_SERVER_UPDATE handed the bot, and what it did with it. */
export interface VoiceSession {
  guildId: string;
  channelId: string;
  userId: string;
  sessionId: string;
  token: string;
  ssrc: number;
  socket?: WebSocket;
  mode?: string;
  secretKey?: Buffer;
  /** RTP packets that carried sound, not silence. */
  soundPackets: number;
}

export class VoiceServer extends EventEmitter<{ sound: [VoiceSession] }> {
  private https?: Server;
  private wss?: WebSocketServer;
  private udp?: Socket;
  private untrust?: () => void;
  private starting?: Promise<string>;
  /** Sessions by guild id: a bot has one voice connection per guild. */
  readonly sessions = new Map<string, VoiceSession>();
  /** The last close that refused the bot, by guild id, as "code reason". */
  readonly refusals = new Map<string, string>();
  constructor(private recordGap: (what: string) => void) {
    super();
  }

  /** Starts the TLS WebSocket and UDP servers once; resolves with the endpoint, `host:port`. */
  endpoint(): Promise<string> {
    this.starting ??= this.start();
    return this.starting;
  }

  private async start() {
    const { cert, key } = selfSignedCertificate();
    this.untrust = trustCertificate(cert);
    this.https = createServer({ cert, key });
    this.wss = new WebSocketServer({ server: this.https });
    this.wss.on("connection", (socket) => this.onConnection(socket));
    this.udp = createSocket("udp4");
    this.udp.on("message", (packet, from) => this.onPacket(packet, from));
    this.https.listen(0, "127.0.0.1");
    this.udp.bind(0, "127.0.0.1");
    await Promise.all([
      once(this.https, "listening"),
      once(this.udp, "listening"),
    ]);
    return `127.0.0.1:${(this.https.address() as AddressInfo).port}`;
  }

  /**
   * A new session for the bot in `channelId`, replacing any it had in the guild: Discord changes the
   * token on every VOICE_SERVER_UPDATE (topics/voice-connections). The old socket is left for the
   * bot to close, as @discordjs/voice does when it reconnects (inferred, not checked).
   */
  open(
    guildId: string,
    channelId: string,
    userId: string,
    sessionId: string,
  ): VoiceSession {
    const session: VoiceSession = {
      guildId,
      channelId,
      userId,
      sessionId,
      token: randomBytes(8).toString("hex"),
      ssrc: randomInt(1, 2 ** 31),
      soundPackets: 0,
    };
    this.sessions.set(guildId, session);
    return session;
  }

  /** Ends the bot's session in `guildId`: 4014 "Disconnected", which @discordjs/voice doesn't retry. */
  end(guildId: string) {
    this.sessions.get(guildId)?.socket?.close(4014, "Disconnected");
    this.sessions.delete(guildId);
  }

  private onConnection(socket: WebSocket) {
    let seq = 0;
    let session: VoiceSession | undefined;
    const send = (op: number, d: unknown, numbered = true) =>
      socket.send(JSON.stringify(numbered ? { op, d, seq: ++seq } : { op, d }));
    const refuse = (
      guildId: string | undefined,
      code: number,
      reason: string,
    ) => {
      if (guildId) this.refusals.set(guildId, `${code} ${reason}`);
      socket.close(code, reason);
    };
    send(VoiceOpcodes.Hello, { heartbeat_interval: 13_750, v: 8 }, false);
    socket.on("message", (raw, binary) => {
      // Binary messages are DAVE's, which isn't modelled.
      if (binary) return this.recordGap("voice DAVE binary message");
      let payload: VoiceSendPayload;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        return socket.close(4002, "Failed to decode payload");
      }
      const { op, d } = payload;
      if (op === VoiceOpcodes.Heartbeat)
        return send(VoiceOpcodes.HeartbeatAck, { t: d?.t ?? d }, false);
      if (op === VoiceOpcodes.Identify) {
        if (session) return socket.close(4005, "Already authenticated");
        const found = this.sessions.get(d?.server_id);
        if (
          !found ||
          found.userId !== d.user_id ||
          found.sessionId !== d.session_id ||
          found.token !== d.token
        )
          return refuse(d?.server_id, 4004, "Authentication failed");
        if (!d.max_dave_protocol_version)
          return refuse(d?.server_id, 4017, "E2EE/DAVE protocol required");
        session = found;
        this.refusals.delete(found.guildId);
        session.socket?.close(4014, "Disconnected");
        session.socket = socket;
        const { port } = this.udp!.address();
        return send(VoiceOpcodes.Ready, {
          ssrc: session.ssrc,
          ip: "127.0.0.1",
          port,
          modes: MODES,
        });
      }
      if (!session) return socket.close(4003, "Not authenticated");
      switch (op) {
        case VoiceOpcodes.SelectProtocol:
          if (session.mode)
            return refuse(session.guildId, 4006, "Session no longer valid");
          if (d?.protocol !== "udp")
            return refuse(session.guildId, 4012, "Unknown protocol");
          if (!MODES.includes(d.data?.mode))
            return refuse(session.guildId, 4016, "Unknown encryption mode");
          session.mode = d.data.mode;
          session.secretKey = randomBytes(32);
          return send(VoiceOpcodes.SessionDescription, {
            mode: session.mode,
            secret_key: [...session.secretKey],
            dave_protocol_version: 0,
          });
        case VoiceOpcodes.Speaking:
          return;
        default:
          return this.recordGap(`voice op ${op}`);
      }
    });
    socket.on("close", () => {
      if (session?.socket === socket) session.socket = undefined;
    });
  }

  private onPacket(packet: Buffer, from: RemoteInfo) {
    if (packet.length === 74 && packet.readUInt16BE(0) === 1) {
      // IP Discovery: the response carries the address and port the request came from.
      const reply = Buffer.alloc(74);
      reply.writeUInt16BE(2, 0);
      reply.writeUInt16BE(70, 2);
      reply.writeUInt32BE(packet.readUInt32BE(4), 4);
      reply.write(from.address, 8, "utf8");
      reply.writeUInt16BE(from.port, 72);
      this.udp!.send(reply, from.port, from.address);
      return;
    }
    if (packet.length < 12 || packet[0]! >> 6 !== 2) return; // keep-alives aren't RTP
    const ssrc = packet.readUInt32BE(8);
    const session = [...this.sessions.values()].find(
      (s) => s.ssrc === ssrc && s.secretKey,
    );
    if (!session) return;
    const opus = decrypt(session, packet);
    if (opus?.equals(SILENCE)) return;
    session.soundPackets++;
    this.emit("sound", session);
  }

  close() {
    for (const guildId of [...this.sessions.keys()]) this.end(guildId);
    this.wss?.close();
    this.https?.closeAllConnections();
    this.https?.close();
    this.udp?.close();
    this.untrust?.();
  }
}

/**
 * The Opus payload of an aead_aes256_gcm_rtpsize packet: the RTP header (with any CSRCs and the
 * extension preamble) is the additional data, the 4-byte nonce trails the 16-byte tag, and the
 * extension body is encrypted with the payload (RFC 3711's rtpsize rule). Undefined in another mode.
 */
function decrypt(session: VoiceSession, packet: Buffer): Buffer | undefined {
  if (session.mode !== "aead_aes256_gcm_rtpsize") return undefined;
  const csrcs = packet[0]! & 0x0f;
  const extension = (packet[0]! & 0x10) !== 0;
  const headerLength = 12 + 4 * csrcs + (extension ? 4 : 0);
  const nonce = Buffer.alloc(12);
  packet.copy(nonce, 0, packet.length - 4);
  const decipher = createDecipheriv("aes-256-gcm", session.secretKey!, nonce);
  decipher.setAAD(packet.subarray(0, headerLength));
  decipher.setAuthTag(packet.subarray(packet.length - 20, packet.length - 4));
  try {
    const plain = Buffer.concat([
      decipher.update(packet.subarray(headerLength, packet.length - 20)),
      decipher.final(),
    ]);
    const extensionWords = extension
      ? packet.readUInt16BE(headerLength - 2)
      : 0;
    return plain.subarray(extensionWords * 4);
  } catch {
    return undefined;
  }
}
