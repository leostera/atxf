import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentText } from "../src/equivalence.ts";
import { formats } from "../src/formats/index.ts";
import { reconciliationKeys } from "../src/reconcile.ts";
import { missing, pull, push, readShared } from "../src/sync.ts";
import type { Transcript } from "../src/types.ts";
import { validateTranscript } from "../src/validate.ts";
import { serializeTranscript } from "../src/jsonl.ts";
import { appendPrompt } from "./converters.ts";

const example = readFileSync(new URL("../../../examples/minimal.atxf.jsonl", import.meta.url), "utf8");
const sharedPath = () => join(mkdtempSync(join(tmpdir(), "atxf-sync-")), "session.atxf.jsonl");
const texts = (t: Transcript) => t.records.flatMap((r) => (r.type === "message" && r.role === "user" ? [contentText(r.content)] : []));

/** One agent's copy: its native file, which it appends to natively, read and written through its converter. */
class Copy {
  constructor(
    readonly agent: keyof typeof formats,
    public file: string,
  ) {}
  static from(agent: keyof typeof formats, transcript: Transcript) {
    return new Copy(agent, formats[agent].fromAtxf(transcript));
  }
  get transcript() {
    return formats[this.agent].toAtxf(this.file);
  }
  say(text: string, time: string) {
    this.file = appendPrompt(this.agent, this.file, { text, time, tag: `${this.agent}-${time}` });
  }
  async push(path: string) {
    return push(path, this.transcript);
  }
  async pull(path: string) {
    const result = await pull(path, this.transcript);
    if (result) this.file = formats[this.agent].fromAtxf(result.transcript);
    return result?.added ?? 0;
  }
}

describe("a shared session across agents", () => {
  const agents = Object.keys(formats) as (keyof typeof formats)[];

  for (const a of agents) {
    for (const b of agents) {
      test(`${a} and ${b} take turns and both end with every turn`, async () => {
        const path = sharedPath();
        const first = Copy.from(a, formats[a].toAtxf(formats[a].fromAtxf((await import("../src/jsonl.ts")).parseTranscript(example))));
        await first.push(path);
        // The second agent joins by importing the shared session.
        const second = Copy.from(b, (await readShared(path))!);

        first.say("from the first agent", "2026-10-30T10:00:01Z");
        await first.push(path);
        expect(await second.pull(path)).toBe(1);
        second.say("from the second agent", "2026-10-30T10:00:02Z");
        await second.push(path);
        expect(await first.pull(path)).toBe(1);

        const shared = (await readShared(path))!;
        for (const copy of [first, second]) {
          expect(missing(shared, copy.transcript)).toBe(0);
          expect(missing(copy.transcript, shared)).toBe(0);
          expect(texts(copy.transcript)).toContain("from the first agent");
          expect(texts(copy.transcript)).toContain("from the second agent");
        }
        expect(reconciliationKeys(shared).size).toBe(shared.records.filter((r) => r.type !== "seal").length);
        expect(validateTranscript(serializeTranscript(shared)).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
        // Nothing left to exchange: pushing and pulling again change nothing.
        expect((await first.push(path)).added).toBe(0);
        expect(await second.pull(path)).toBe(0);
      });
    }
  }

  test("concurrent pushes both land", async () => {
    const path = sharedPath();
    const base = Copy.from("pi", (await import("../src/jsonl.ts")).parseTranscript(example));
    await base.push(path);
    const shared = (await readShared(path))!;
    const pi = Copy.from("pi", shared);
    const opencode = Copy.from("opencode", shared);
    pi.say("pi turn", "2026-10-30T10:00:01Z");
    opencode.say("opencode turn", "2026-10-30T10:00:01Z");
    await Promise.all([pi.push(path), opencode.push(path)]);
    const texts_ = texts((await readShared(path))!);
    expect(texts_).toContain("pi turn");
    expect(texts_).toContain("opencode turn");
  });
});
