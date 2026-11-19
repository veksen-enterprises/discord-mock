/**
 * Lets a test skip time past the bot's collectors.
 *
 * discord.js runs a collector's `time` and `idle` on the `setTimeout` it took from `node:timers`
 * when it loaded (`src/structures/interfaces/Collector.js`), so faking the global `setTimeout`
 * never reaches them. Instead, when a bot starts, the kit finds the bot's copy of discord.js and
 * puts a setter for `_timeout` and `_idletimeout` on `Collector.prototype`. The constructor
 * assigns both before it starts a timer (`this._timeout = null`), so each new collector
 * registers itself, and each timer it then sets is noted with the time it was set. `skip` ends
 * every collector whose timer comes due within the skipped time, as the timer would:
 * `collector.stop('time')` or `collector.stop('idle')`.
 */
import { createRequire } from "node:module";

interface Collector {
  ended: boolean;
  stop(reason: string): void;
}
interface Timer {
  setAt: number;
  ms: number;
}
interface Clock {
  /** Whether a bot's discord.js was found and hooked. */
  hooked: boolean;
  skipped: number;
  /** The timers of each collector made since the kit hooked discord.js, by the reason they end it. */
  collectors: Map<Collector, Map<"time" | "idle", Timer>>;
}

// One clock per process: Vitest may evaluate this module again for each test file, while
// discord.js stays loaded.
const KEY = Symbol.for("discordjs-test-kit.clock");
const store = globalThis as typeof globalThis & { [KEY]?: Clock };
const clock: Clock = (store[KEY] ??= {
  hooked: false,
  skipped: 0,
  collectors: new Map(),
});
const require = createRequire(import.meta.url);

const now = () => performance.now() + clock.skipped;

/** The `Collector` class of the discord.js copy `client` comes from, if it's loaded through require. */
function collectorClassOf(client: object): { prototype: object } | undefined {
  for (const loaded of Object.values(require.cache)) {
    const exports = loaded?.exports as
      | { Client?: new () => object; Collector?: { prototype: object } }
      | undefined;
    if (
      exports?.Client &&
      exports.Collector &&
      client instanceof exports.Client
    )
      return exports.Collector;
  }
  return undefined;
}

const HOOKED = Symbol.for("discordjs-test-kit.clock.hooked");

/** Hooks the discord.js copy `client` comes from, once, so its collectors register themselves. */
export function hookCollectors(client: object): void {
  const Collector = collectorClassOf(client);
  if (!Collector) return;
  clock.hooked = true;
  const proto = Collector.prototype as Record<symbol, unknown>;
  if (proto[HOOKED]) return;
  proto[HOOKED] = true;
  for (const [field, reason] of [
    ["_timeout", "time"],
    ["_idletimeout", "idle"],
  ] as const) {
    Object.defineProperty(Collector.prototype, field, {
      configurable: true,
      set(this: Collector, first: unknown) {
        // The constructor's first assignment: from now on the field lives on the collector, and
        // every timer set into it is noted.
        const timers =
          clock.collectors.get(this) ??
          clock.collectors.set(this, new Map()).get(this)!;
        let value = first;
        Object.defineProperty(this, field, {
          configurable: true,
          enumerable: true,
          get: () => value,
          set: (timer: Record<string, unknown> | null) => {
            value = timer;
            // Node's Timeout keeps its delay in `_idleTimeout` (lib/internal/timers.js).
            const ms = timer?.["_idleTimeout"];
            if (typeof ms === "number")
              timers.set(reason, { setAt: now(), ms });
            else timers.delete(reason);
          },
        });
      },
    });
  }
}

/** Moves the bot's clock `ms` forward and ends, in order, every collector whose time came due. */
export function skip(ms: number): void {
  if (!clock.hooked)
    throw new Error(
      "discordjs-test-kit: skipTime found no discord.js collectors to time out: start a bot first, with `await discord.start(client)`",
    );
  clock.skipped += ms;
  // Ending one collector can start another (a bot's `end` handler), so look again after each.
  for (;;) {
    let next: { collector: Collector; reason: string; due: number } | undefined;
    for (const [collector, timers] of clock.collectors) {
      if (collector.ended) {
        clock.collectors.delete(collector);
        continue;
      }
      for (const [reason, timer] of timers) {
        const due = timer.setAt + timer.ms;
        if (due <= now() && (!next || due < next.due))
          next = { collector, reason, due };
      }
    }
    if (!next) return;
    next.collector.stop(next.reason);
  }
}
