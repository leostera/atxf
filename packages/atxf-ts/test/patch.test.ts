import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { applyPatch, diff, jsonEqual } from "../src/patch.ts";

const json = fc.jsonValue({ maxDepth: 4 }).map((value) => JSON.parse(JSON.stringify(value)) as unknown);

/** The same value with every object's keys in reverse order. */
const reordered = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reordered);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reordered(v)]));
  return value;
};

describe("JSON Patch between JSON values", () => {
  test("applying diff(to, from) to from gives to", () => {
    fc.assert(fc.property(json, json, (to, from) => jsonEqual(applyPatch(from, diff(to, from)), to)));
  });
  test("equal values, in any key order, have an empty patch", () => {
    fc.assert(fc.property(json, (value) => diff(reordered(value), value).length === 0));
  });
  test("the patch does not depend on the order of keys", () => {
    fc.assert(fc.property(json, json, (to, from) => jsonEqual(diff(reordered(to), reordered(from)), diff(to, from))));
  });
  test("objects are patched field by field, arrays of one length element by element", () => {
    expect(diff({ a: 1, b: [1, { c: 2 }], d: null }, { a: 1, b: [1, { c: 3 }], e: true })).toEqual([
      { op: "replace", path: "/b/1/c", value: 2 },
      { op: "add", path: "/d", value: null },
      { op: "remove", path: "/e" },
    ]);
    expect(diff({ "a/b": [1, 2] }, { "a/b": [1] })).toEqual([{ op: "replace", path: "/a~1b", value: [1, 2] }]);
  });
  test("keys named like Object.prototype members are ordinary keys", () => {
    expect(diff({ constructor: 1 }, {})).toEqual([{ op: "add", path: "/constructor", value: 1 }]);
    expect(applyPatch({}, [{ op: "add", path: "/toString", value: 2 }])).toEqual({ toString: 2 });
  });
});
