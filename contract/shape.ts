/**
 * Shape comparison: two responses agree when they have the same keys with the same kinds of
 * values. Ids, timestamps and text differ between the mock and Discord by nature, so values
 * are reduced to their kind.
 */
export type Shape =
  | string
  | { array: Shape | null }
  | { object: Record<string, Shape> };

const SNOWFLAKE = /^\d{17,20}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

export function shapeOf(value: unknown): Shape {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return { array: value.length ? value.map(shapeOf).reduce(merge) : null };
  }
  if (typeof value === "object") {
    return {
      object: Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          shapeOf(v),
        ]),
      ),
    };
  }
  if (typeof value === "string") {
    if (SNOWFLAKE.test(value)) return "snowflake";
    if (TIMESTAMP.test(value)) return "timestamp";
    return "string";
  }
  return typeof value;
}

/** Union of two shapes: arrays of mixed objects get every key any element had. */
function merge(a: Shape, b: Shape): Shape {
  if (typeof a === "object" && typeof b === "object") {
    if ("object" in a && "object" in b) {
      const out: Record<string, Shape> = { ...a.object };
      for (const [k, v] of Object.entries(b.object))
        out[k] = k in out ? merge(out[k]!, v) : v;
      return { object: out };
    }
    if ("array" in a && "array" in b) {
      if (!a.array) return b;
      if (!b.array) return a;
      return { array: merge(a.array, b.array) };
    }
  }
  if (a === b) return a;
  if (a === "null") return b;
  if (b === "null") return a;
  return `${a}|${b}`;
}

export type Difference =
  | { kind: "missing-in-mock"; path: string; discord: string }
  | { kind: "extra-in-mock"; path: string; mock: string }
  | { kind: "type"; path: string; discord: string; mock: string };

const label = (s: Shape) =>
  typeof s === "string" ? s : "array" in s ? "array" : "object";

export function diffShapes(
  discord: Shape,
  mock: Shape,
  path = "",
): Difference[] {
  if (typeof discord === "object" && typeof mock === "object") {
    if ("object" in discord && "object" in mock) {
      const keys = new Set([
        ...Object.keys(discord.object),
        ...Object.keys(mock.object),
      ]);
      return [...keys].sort().flatMap((k) => {
        const p = path ? `${path}.${k}` : k;
        if (!(k in mock.object))
          return [
            {
              kind: "missing-in-mock" as const,
              path: p,
              discord: label(discord.object[k]!),
            },
          ];
        if (!(k in discord.object))
          return [
            {
              kind: "extra-in-mock" as const,
              path: p,
              mock: label(mock.object[k]!),
            },
          ];
        return diffShapes(discord.object[k]!, mock.object[k]!, p);
      });
    }
    if ("array" in discord && "array" in mock) {
      // An empty array on either side says nothing about element shape.
      if (!discord.array || !mock.array) return [];
      return diffShapes(discord.array, mock.array, `${path}[]`);
    }
  }
  if (typeof discord === "string" && typeof mock === "string") {
    // null on one side is an optional field that happened to be unset: not a disagreement.
    if (discord === mock || discord === "null" || mock === "null") return [];
  }
  return [{ kind: "type", path, discord: label(discord), mock: label(mock) }];
}

export function describe(d: Difference): string {
  switch (d.kind) {
    case "missing-in-mock":
      return `${d.path}: missing in mock (Discord: ${d.discord})`;
    case "extra-in-mock":
      return `${d.path}: extra in mock (${d.mock}), Discord doesn't send it`;
    case "type":
      return `${d.path}: Discord ${d.discord}, mock ${d.mock}`;
  }
}
