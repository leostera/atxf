import { createHash } from "node:crypto";

/**
 * RFC 8785 (JCS) canonical JSON: object keys sorted by UTF-16 code units, no whitespace, ECMAScript number and
 * string serialization, which is what `JSON.stringify` produces once keys are sorted. `undefined` fields are dropped,
 * as JSON has no such value. Non-finite numbers are rejected, as JCS requires.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`canonical JSON cannot encode ${value}`);
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
