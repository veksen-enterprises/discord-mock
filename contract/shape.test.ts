import { describe, expect, it } from "vitest";
import { diffShapes, shapeOf } from "./shape.js";

const diff = (discord: unknown, mock: unknown) =>
  diffShapes(shapeOf(discord), shapeOf(mock));

describe("shape diff", () => {
  it("ignores values that differ by nature: ids, timestamps, text", () => {
    expect(
      diff(
        {
          id: "1572343051337342976",
          at: "2026-11-17T20:00:00.000Z",
          content: "a",
        },
        {
          id: "1572343366832627752",
          at: "2026-01-01T00:00:00+00:00",
          content: "b",
        },
      ),
    ).toEqual([]);
  });

  it("reports keys on one side only, and kind mismatches", () => {
    expect(diff({ a: 1, b: "x" }, { b: 2, c: true })).toEqual([
      { kind: "missing-in-mock", path: "a", discord: "number" },
      { kind: "type", path: "b", discord: "string", mock: "number" },
      { kind: "extra-in-mock", path: "c", mock: "boolean" },
    ]);
  });

  it("treats null on either side as an unset optional field", () => {
    expect(diff({ topic: null }, { topic: "x" })).toEqual([]);
  });

  it("compares array elements by the union of their keys", () => {
    expect(diff([{ a: 1 }, { b: 2 }], [{ a: 1 }])).toEqual([
      { kind: "missing-in-mock", path: "[].b", discord: "number" },
    ]);
  });
});
