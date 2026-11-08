import { describe, expect, test } from "bun:test";
import { pi } from "../src/formats/pi.ts";

const session = JSON.stringify({ type: "session", version: 3, id: "s-1", timestamp: "2026-11-08T10:00:00.000Z", cwd: "/w" });
const user = (id: string, parentId: string | null, text: string) =>
  JSON.stringify({ type: "message", id, parentId, timestamp: "2026-11-08T10:00:01.000Z", message: { role: "user", content: text, timestamp: 1 } });

describe("pi.stream", () => {
  test("the session line starts the header and adds no record", () => {
    const reading = pi.stream!();
    expect(reading.header).toBeUndefined();
    expect(reading.push(session)).toEqual([]);
    expect(reading.header).toMatchObject({ type: "transcript", id: "s-1", integrity: { alg: "sha256" } });
    expect(reading.header!.fidelity?.nativeDigest).toBeUndefined();
  });

  test("each later line is one record, whose hash is the same however long the file grows", () => {
    const reading = pi.stream!();
    reading.push(session);
    const [first] = reading.push(user("a", null, "hello"));
    const [second] = reading.push(user("b", "a", "again"));
    expect(first).toMatchObject({ type: "message", id: "a", parentId: null, role: "user" });
    expect(second).toMatchObject({ id: "b", parentId: "a" });

    const again = pi.stream!();
    again.push(session);
    expect(again.push(user("a", null, "hello"))[0]!.hash).toBe(first!.hash!);
  });

  test("a file without a session line gets the default header, and its first line is a record", () => {
    const reading = pi.stream!({ integrity: false });
    expect(reading.push(user("a", null, "hi"))).toHaveLength(1);
    expect(reading.header).toMatchObject({ id: "pi-session" });
  });

  test("blank lines, embedded newlines and lines carrying a transcript are refused", () => {
    const reading = pi.stream!();
    expect(() => reading.push("")).toThrow(RangeError);
    expect(() => reading.push("  ")).toThrow(RangeError);
    expect(() => reading.push(`${session}\n${session}`)).toThrow(RangeError);
    const carrying = JSON.stringify({ ...JSON.parse(session), atxf: { id: null, transcript: { header: {}, records: [] } } });
    expect(() => reading.push(carrying)).toThrow(RangeError);
  });

  test("a line that is not JSON is kept verbatim as a record", () => {
    const reading = pi.stream!();
    reading.push(session);
    const [record] = reading.push("not json");
    expect(record!.native).toMatchObject({ source: "pi", records: [null], raw: ["not json\n"] });
  });
});
