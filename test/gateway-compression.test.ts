/**
 * zlib-stream transport compression (docs.discord.food/topics/gateway#transport-compression), which
 * discord.js asks for whenever zlib-sync is installed, as many production bots have it. discord.js
 * compresses only through zlib-sync, a native module the kit doesn't depend on, so this test reads
 * the Gateway as zlib-sync does: one inflate context for the connection, a message per
 * Z_SYNC_FLUSH suffix. Checked through a stock Client in the Discord Tickets trial, which installs it.
 */
import { once } from "node:events";
import { createInflate } from "node:zlib";
import { GatewayOpcodes } from "discord-api-types/v10";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createDiscordMock, type DiscordMock } from "../src/internal/mock.js";

let mock: DiscordMock;
afterEach(async () => {
  await mock.close();
});

/** Connects with compress=zlib-stream and hands back each packet, inflated, as JSON. */
async function connectCompressed(url: string) {
  const socket = new WebSocket(
    `${url}?v=10&encoding=json&compress=zlib-stream`,
  );
  const inflate = createInflate();
  const packets: { op: number; t?: string; d: any }[] = [];
  let text = "";
  inflate.on("data", (chunk: Buffer) => (text += chunk.toString()));
  socket.on("message", (data: Buffer) => {
    inflate.write(data);
    // Every packet ends in the sync flush suffix, so each flush yields one whole JSON message.
    inflate.flush(() => {
      if (text) packets.push(JSON.parse(text));
      text = "";
    });
  });
  await once(socket, "open");
  return { socket, packets };
}

async function until<T>(get: () => T | undefined): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = get();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

it("compresses HELLO and READY on one zlib stream, each ending in the sync flush suffix", async () => {
  // Arrange
  mock = await createDiscordMock();
  mock.createGuild("Support");
  const { socket, packets } = await connectCompressed(mock.gateway.url);
  const raw: Buffer[] = [];
  socket.on("message", (data: Buffer) => raw.push(data));
  await until(() => packets.find((p) => p.op === GatewayOpcodes.Hello));

  // Act
  socket.send(
    JSON.stringify({
      op: GatewayOpcodes.Identify,
      d: { token: mock.token, intents: 1, properties: {} },
    }),
  );
  const ready = await until(() => packets.find((p) => p.t === "READY"));

  // Assert
  expect(ready.d.user.id).toBe(mock.state.bot.id);
  expect(
    raw.every((b) => b.subarray(-4).equals(Buffer.from([0, 0, 0xff, 0xff]))),
  ).toBe(true);
  socket.close();
});

it("records zstd-stream as unmodelled rather than answering in plain text", async () => {
  // Arrange
  mock = await createDiscordMock();
  const socket = new WebSocket(
    `${mock.gateway.url}?v=10&encoding=json&compress=zstd-stream`,
  );

  // Act
  const [code] = await once(socket, "close");

  // Assert
  expect(code).toBe(4000);
  expect(mock.rest.unhandled).toEqual([
    "gateway /gateway?v=10&encoding=json&compress=zstd-stream",
  ]);
  mock.rest.unhandled.length = 0;
});
