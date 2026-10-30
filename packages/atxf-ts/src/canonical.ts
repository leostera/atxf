import { createHash } from "node:crypto";

/**
 * RFC 8785 (JCS) canonical JSON: object keys sorted by UTF-16 code units, no whitespace, ECMAScript number and
 * string serialization, which is what `JSON.stringify` produces once keys are sorted. `undefined` fields are dropped,
 * as JSON has no such value. Non-finite numbers are rejected, as JCS requires.
 */
export function canonicalJson(value: unknown): string {
  // Written out rather than `JSON.stringify` of a key-sorted copy: objects list integer-like keys such as "10" first,
  // whatever order they were inserted in, which is not JCS order.
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`canonical JSON cannot encode ${value}`);
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
