---
status: accepted
---

# Bots Connect to Real Local Servers, Not Intercepted Requests

Decided 2026-11-17 in the spike.

**The problem.** A discord.js bot talks to Discord over two channels: REST over
HTTP and the Gateway over WebSocket. A test has to stand in for both without
changing the bot's code paths.

**The decision.** The Mock runs a real HTTP server and a real WebSocket server
on `127.0.0.1`. The bot is pointed at it with one client option,
`rest: { api: mock.apiUrl }`. The Gateway needs no option: `@discordjs/ws` asks
`GET /gateway/bot` for its URL, through the same REST client, and connects to
whatever comes back (`WebSocketManager.fetchGatewayInformation`). Checked on
discord.js 14.28.

## Considered Options

**msw.** Rejected: it can't see either channel. In Node, `@discordjs/rest`
calls `undici.request` directly and `@discordjs/ws` uses the `ws` package, since
`shouldUseGlobalFetchAndWebSocket()` is false outside Deno and Bun. msw
intercepts `http`/`ClientRequest` and the global `fetch`/`WebSocket`. Its API
ideas (per-test overrides, `once`, failing on unhandled requests) are kept; see
ADR 0002.

**undici `MockAgent` plus a patched `WebSocket`.** Rejected: two global patches
that leak between tests, and the Gateway still needs a protocol implementation,
so nothing is saved over a real server.

**Mocking discord.js classes.** Rejected: it skips the code the tests exist to
cover (parsing, caching, REST queueing, retries, resume). It's what the
consumers do today.

## Consequences

- A bot must accept client options. sin-bot and the d2armory bot each need a
  small change for that.
- Tests run in parallel: each mock has its own port and nothing is global.
- Everything a bot sends is a real HTTP request, so the Request log sees
  exactly what Discord would.
- discord.js asks for `zlib-stream` compression when `zlib-sync` is installed.
  The Mock doesn't speak it yet and closes the socket with a reason.
