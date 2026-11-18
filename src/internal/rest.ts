import type { IncomingMessage, ServerResponse } from "node:http";

export interface RestRequest {
  method: string;
  /** Route path without the /api/vN prefix, e.g. /channels/123/messages. */
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  /** Parsed JSON body, or payload_json for multipart. */
  body: any;
  files: UploadedFile[];
}

export interface RestResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Raw bytes instead of a JSON body, e.g. an attachment on the CDN. */
  file?: { data: Uint8Array; contentType: string };
  /** Kill the connection instead of answering: "fin" closes it cleanly, "rst" resets it (ECONNRESET). */
  dropConnection?: "fin" | "rst";
}

export type RestHandler = (
  req: RestRequest,
) => RestResponse | undefined | Promise<RestResponse | undefined>;

interface Route {
  method: string;
  pattern: string;
  regex: RegExp;
  keys: string[];
  handler: RestHandler;
  once: boolean;
}

function compile(pattern: string) {
  const keys: string[] = [];
  const source = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:(\w+)/g, (_, key: string) => {
      keys.push(key);
      return "([^/]+)";
    });
  return { regex: new RegExp(`^${source}/?$`), keys };
}

/** Response builders for overrides and built-in routes. */
export const respond = {
  json: (body: unknown, status = 200): RestResponse => ({ status, body }),
  noContent: (): RestResponse => ({ status: 204 }),
  /** Discord's error envelope: { message, code }. See docs.discord.food/topics/errors. */
  error: (status: number, code: number, message: string): RestResponse => ({
    status,
    body: { message, code },
  }),
  // Codes from Discord's JSON error code table (discord-api-docs, topics/opcodes-and-status-codes;
  // docs.discord.food/topics/errors loads its table client-side). The message strings and the
  // HTTP statuses of 10062/40060/10015 are inferred, not checked: the contract test can't trigger them.
  missingPermissions: () => respond.error(403, 50013, "Missing Permissions"),
  missingAccess: () => respond.error(403, 50001, "Missing Access"),
  unknownChannel: () => respond.error(404, 10003, "Unknown Channel"),
  unknownMessage: () => respond.error(404, 10008, "Unknown Message"),
  unknownWebhook: () => respond.error(404, 10015, "Unknown Webhook"),
  unknownInteraction: () => respond.error(404, 10062, "Unknown interaction"),
  alreadyAcknowledged: () =>
    respond.error(400, 40060, "Interaction has already been acknowledged."),
  unauthorized: () => respond.error(401, 0, "401: Unauthorized"),
  /** 50035; Discord also sends a per-field `errors` tree, which the Mock leaves out. */
  invalidFormBody: () => respond.error(400, 50035, "Invalid Form Body"),
  /** 429 with the headers @discordjs/rest reads (Retry-After, X-RateLimit-Global/-Scope). */
  rateLimited: (opts: {
    retryAfter: number;
    global?: boolean;
    scope?: "user" | "global" | "shared";
  }): RestResponse => ({
    status: 429,
    headers: {
      "retry-after": String(opts.retryAfter),
      "x-ratelimit-scope": opts.scope ?? (opts.global ? "global" : "user"),
      ...(opts.global ? { "x-ratelimit-global": "true" } : {}),
    },
    body: {
      // docs.discord.food/topics/rate-limits: the shared-resource example says "The resource is being rate limited."
      message:
        opts.scope === "shared"
          ? "The resource is being rate limited."
          : "You are being rate limited.",
      retry_after: opts.retryAfter,
      global: !!opts.global,
    },
  }),
  serverError: (status = 500): RestResponse => ({
    status,
    body: { message: "500: Internal Server Error", code: 0 },
  }),
  /** undici reports "other side closed"; @discordjs/rest does NOT retry it. */
  connectionClosed: (): RestResponse => ({ status: 0, dropConnection: "fin" }),
  /** TCP RST, surfacing as ECONNRESET; @discordjs/rest retries it like a 5xx. */
  connectionReset: (): RestResponse => ({ status: 0, dropConnection: "rst" }),
};

export class RestRouter {
  private builtins: Route[] = [];
  private overrides: Route[] = [];
  /** Every request the bot made, in order. */
  readonly log: {
    method: string;
    path: string;
    status: number;
    body: unknown;
  }[] = [];
  /** Gaps: requests the Mock can't answer truthfully. A non-empty list fails `assertNoUnhandledRequests()`. */
  readonly unhandled: string[] = [];

  /** Record a Gap and answer 404 with code 0, which no real Discord error uses. */
  gap(what: string): RestResponse {
    this.unhandled.push(what);
    return respond.error(404, 0, `discordjs-test-kit: no handler for ${what}`);
  }

  route(method: string, pattern: string, handler: RestHandler) {
    this.builtins.push({
      method,
      pattern,
      handler,
      once: false,
      ...compile(pattern),
    });
  }

  /**
   * msw-style override, checked before the stateful routes. Return undefined to fall through.
   * Returns a function that removes it.
   */
  use(
    method: string,
    pattern: string,
    handler: RestHandler,
    opts: { once?: boolean } = {},
  ): () => void {
    const route: Route = {
      method,
      pattern,
      handler,
      once: !!opts.once,
      ...compile(pattern),
    };
    this.overrides.unshift(route);
    return () => {
      const index = this.overrides.indexOf(route);
      if (index !== -1) this.overrides.splice(index, 1);
    };
  }

  resetOverrides() {
    this.overrides = [];
  }

  async handle(req: IncomingMessage, res: ServerResponse, prefix: RegExp) {
    const url = new URL(req.url!, "http://localhost");
    const path = decodeURIComponent(url.pathname.replace(prefix, ""));
    const method = req.method!;
    // Not Array.fromAsync: consumers typecheck this source with their own `lib`, often < ES2024.
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const { body, files } = await parseBody(raw, req.headers["content-type"]);

    const entry = { method, path, status: 0, body };
    this.log.push(entry);
    let result: RestResponse | undefined;
    for (const list of [this.overrides, this.builtins]) {
      for (const route of [...list]) {
        if (route.method !== method) continue;
        const match = route.regex.exec(path);
        if (!match) continue;
        const params = Object.fromEntries(
          route.keys.map((k, i) => [k, match[i + 1]!]),
        );
        result = await route.handler({
          method,
          path,
          params,
          query: url.searchParams,
          headers: req.headers,
          body,
          files,
        });
        if (result === undefined) continue;
        if (route.once) list.splice(list.indexOf(route), 1);
        break;
      }
      if (result) break;
    }

    result ??= this.gap(`${method} ${path}`);
    entry.status = result.status;

    if (result.dropConnection === "rst")
      return void req.socket.resetAndDestroy();
    if (result.dropConnection === "fin") return void req.socket.destroy();
    const headers: Record<string, string> = { ...result.headers };
    if (result.file) {
      res.writeHead(result.status, {
        ...headers,
        "content-type": result.file.contentType,
      });
      return void res.end(result.file.data);
    }
    if (result.body !== undefined) headers["content-type"] = "application/json";
    res.writeHead(result.status, headers);
    res.end(
      result.body === undefined ? undefined : JSON.stringify(result.body),
    );
  }
}

// FormData's own entry type, not the global File: consumers typecheck this source, and under
// @types/node the global File (node:buffer) and undici's File don't match.
type UploadedFile = Exclude<ReturnType<FormData["get"]>, string | null>;

async function parseBody(
  raw: Buffer,
  contentType: string | undefined,
): Promise<{ body: any; files: UploadedFile[] }> {
  if (!raw.length) return { body: undefined, files: [] };
  if (contentType?.startsWith("multipart/form-data")) {
    const form = await new Response(new Uint8Array(raw), {
      headers: { "content-type": contentType },
    }).formData();
    const files = [...form.values()].filter(
      (v): v is UploadedFile => typeof v !== "string",
    );
    const json = form.get("payload_json");
    return { body: typeof json === "string" ? JSON.parse(json) : {}, files };
  }
  return { body: JSON.parse(raw.toString("utf8")), files: [] };
}
