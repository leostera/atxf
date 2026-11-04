import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { embeddedToolResults, summariesAsUser, type Transcript } from "../src/index.ts";
import { describeConverterLaws } from "../src/laws.ts";
import { arbitraryTranscript, noisyJsonDocument } from "../src/testing.ts";
import { opencode } from "../src/formats/opencode.ts";

const fixture = (name: string) => ({ name, text: readFileSync(new URL(`../../../fixtures/opencode/${name}`, import.meta.url), "utf8") });

describeConverterLaws(opencode, {
  fixtures: [fixture("export-hand-built.json"), fixture("export-2.0.20.json")],
  nativeFiles: arbitraryTranscript({ integrity: false }).chain((t) => noisyJsonDocument(opencode.fromAtxf(t, { carry: false }), "messages")),
  view: (view) => embeddedToolResults(summariesAsUser(view)),
});

// OpenCode message ids are unique across all of its sessions, so ids written for one session must never be written
// for another, while writing the same transcript for the same session again must give the same ids.
describe("message ids", () => {
  const transcript = (id: string): Transcript => ({
    header: { type: "transcript", atxf: "0.1", id, time: "2026-01-01T00:00:00.000Z", source: { agent: "pi", format: "pi/session-jsonl", sessionId: id } },
    records: [
      { type: "settings", id: "r1", parentId: null, time: "2026-01-01T00:00:01.000Z", model: { provider: "anthropic", id: "claude" } },
      { type: "message", id: "r2", parentId: "r1", time: "2026-01-01T00:00:02.000Z", role: "user", content: "hello" },
      { type: "message", id: "r3", parentId: "r2", time: "2026-01-01T00:00:03.000Z", role: "assistant", content: [{ type: "text", text: "hi" }] },
    ],
  });
  const exported = (text: string) => JSON.parse(text) as { info: { id: string }; messages: { id: string; type: string }[] };
  const messageIds = (text: string) => exported(text).messages.map((message) => message.id);
  const disjoint = (a: string[], b: string[]) => expect(a.filter((id) => b.includes(id))).toEqual([]);

  test("two transcripts with the same record ids and a model switch get disjoint ids", () => {
    const a = opencode.fromAtxf(transcript("ses_a"));
    const b = opencode.fromAtxf(transcript("ses_b"));
    expect(exported(a).messages.some((message) => message.type === "model-switched")).toBe(true);
    disjoint(messageIds(a), messageIds(b));
  });

  test("one transcript written for two sessions gets disjoint ids", () => {
    const t = transcript("shared");
    const a = opencode.fromAtxf(t, { sessionId: "ses_a" });
    const b = opencode.fromAtxf(t, { sessionId: "ses_b" });
    expect([exported(a).info.id, exported(b).info.id]).toEqual(["ses_a", "ses_b"]);
    disjoint(messageIds(a), messageIds(b));
  });

  test("writing a transcript for the same session again gives the same ids", () => {
    const t = transcript("shared");
    expect(messageIds(opencode.fromAtxf(t, { sessionId: "ses_a" }))).toEqual(messageIds(opencode.fromAtxf(t, { sessionId: "ses_a" })));
  });

  test("reading a file written for another session gives back the transcript and its record ids", () => {
    const t = transcript("shared");
    const back = opencode.toAtxf(opencode.fromAtxf(t, { sessionId: "ses_a" }));
    expect(back).toEqual(t);
    expect(back.records.map((record) => record.id)).toEqual(["r1", "r2", "r3"]);
  });

  test("an OpenCode session written for another session does not reuse its message ids", () => {
    const text = fixture("export-2.0.20.json").text;
    const native = opencode.toAtxf(text);
    const own = messageIds(text);
    const other = opencode.fromAtxf(native, { sessionId: "ses_other" });
    expect(exported(other).info.id).toBe("ses_other");
    disjoint(messageIds(other), own);
    expect(opencode.toAtxf(other)).toEqual(native);
    // Written for its own session, it is still the original file, byte for byte.
    expect(opencode.fromAtxf(native, { sessionId: exported(text).info.id })).toBe(text);
  });
});
