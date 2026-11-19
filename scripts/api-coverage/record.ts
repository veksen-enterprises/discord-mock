// Vitest setup file for `npm run coverage:api`. It records every request a built-in route answered
// and every Dispatch the Gateway sent, while the normal suite runs. A route counts only when a test
// called it through a stock Client, so a registered but untested route doesn't count.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { threadId } from "node:worker_threads";
import { Gateway } from "../../src/internal/gateway.js";
import { RestRouter, type RestHandler } from "../../src/internal/rest.js";

const dir = process.env.API_COVERAGE_DIR;
if (dir) {
  const file = join(dir, `${process.pid}-${threadId}.log`);
  const seen = new Set<string>();
  const record = (line: string) => {
    if (seen.has(line)) return;
    seen.add(line);
    appendFileSync(file, line + "\n");
  };

  const route = RestRouter.prototype.route;
  RestRouter.prototype.route = function (
    method,
    pattern,
    handler: RestHandler,
  ) {
    route.call(this, method, pattern, async (req) => {
      const gaps = this.unhandled.length;
      const result = await handler(req);
      // A handler that answers with a Gap hasn't modelled the call.
      if (result && this.unhandled.length === gaps)
        record(`rest ${req.method} ${req.path}`);
      return result;
    });
  };

  // `send` is private in TypeScript; it's the one place a Dispatch leaves for a session.
  const proto = Gateway.prototype as unknown as {
    send: (session: unknown, t: string, d: unknown) => void;
  };
  const send = proto.send;
  proto.send = function (session, t, d) {
    record(`gateway ${t}`);
    send.call(this, session, t, d);
  };
}
