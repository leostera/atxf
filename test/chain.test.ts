import { describe, expect, test } from "bun:test";
import { opendirSync, statSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { conversationView, embeddedToolResults, summariesAsUser, type PortableMessage } from "@atxf/core";
import { normalize, arbitraryTranscript } from "@atxf/core/testing";
import { converters } from "./converters.ts";

/**
 * Cross-format laws: a file in any format, converted to any other format and back, comes back byte for byte.
 *
 *   format A → ATXF → format B → ATXF → format A
 */
const runs = Number(process.env.ATXF_RUNS ?? 40);

describe("format A → ATXF → format B → ATXF → format A is lossless", () => {
  for (const a of converters) {
    for (const b of converters) {
      test(`${a.converter.agent} → ${b.converter.agent} → ${a.converter.agent}`, () => {
        fc.assert(
          fc.property(a.nativeFiles, (text) => {
            const there = b.converter.fromAtxf(a.converter.toAtxf(text));
            const back = a.converter.fromAtxf(b.converter.toAtxf(there));
            expect(back).toBe(text);
          }),
          { numRuns: runs },
        );
      });
    }
  }
});

describe("longer chains are lossless too", () => {
  test("A → B → C → D → E → A for every rotation of the five formats", () => {
    const order = converters.map((c) => c.converter);
    for (let start = 0; start < order.length; start++) {
      const ring = [...order.slice(start), ...order.slice(0, start)];
      const first = converters.find((c) => c.converter === ring[0])!;
      fc.assert(
        fc.property(first.nativeFiles, (text) => {
          let file = text;
          let transcript = ring[0]!.toAtxf(file);
          for (const next of ring.slice(1)) {
            file = next.fromAtxf(transcript);
            transcript = next.toAtxf(file);
          }
          expect(ring[0]!.fromAtxf(transcript)).toBe(text);
        }),
        { numRuns: Math.ceil(runs / 2) },
      );
    }
  });

  test("any transcript survives a trip through every format", () => {
    fc.assert(
      fc.property(arbitraryTranscript(), (t) => {
        let transcript = t;
        for (const { converter } of converters) transcript = converter.toAtxf(converter.fromAtxf(transcript));
        expect(normalize(transcript)).toEqual(normalize(t));
      }),
      { numRuns: runs },
    );
  });
});

const views: Record<string, (view: PortableMessage[]) => PortableMessage[]> = {
  codex: summariesAsUser,
  opencode: (view) => embeddedToolResults(summariesAsUser(view)),
  "gemini-cli": (view) => embeddedToolResults(summariesAsUser(view)),
};

/**
 * Real Pi sessions, when `ATXF_PI_SESSIONS` names a directory of them (e.g. ~/.pi/agent/sessions). The directory is
 * walked lazily and each session is checked by test/pi-session.ts in a process of its own, `ATXF_PI_JOBS` at a time
 * (default 1): only those sessions are in memory at once, so memory depends on the largest session, never on how
 * many there are. Converting one takes about 40 times its size. `ATXF_PI_MAX_MB` skips larger sessions, and
 * `ATXF_PI_LIMIT` stops early.
 */
const piSessions = process.env.ATXF_PI_SESSIONS;
describe.skipIf(!piSessions)("real Pi sessions round-trip through every format, and keep their conversation without carry", () => {
  test("every session", async () => {
    const limit = Number(process.env.ATXF_PI_LIMIT ?? Infinity);
    const jobs = Math.max(1, Number(process.env.ATXF_PI_JOBS ?? 1));
    const maxBytes = Number(process.env.ATXF_PI_MAX_MB ?? Infinity) * 1024 * 1024;
    let skipped = 0;
    const script = join(import.meta.dir, "pi-session.ts");
    const files = sessionFiles(piSessions!);
    const failures: string[] = [];
    let checked = 0;
    const worker = async () => {
      for (let next = files.next(); !next.done && checked < limit; next = files.next()) {
        if (statSync(next.value).size > maxBytes) {
          skipped += 1;
          continue;
        }
        checked += 1;
        const child = Bun.spawn(["bun", "--smol", script, next.value], { stdout: "ignore", stderr: "pipe" });
        if ((await child.exited) !== 0) failures.push((await new Response(child.stderr).text()).trim() || `${next.value}: exited ${child.exitCode}`);
      }
    };
    await Promise.all(Array.from({ length: jobs }, worker));
    console.log(`checked ${checked} Pi sessions${skipped ? `; skipped ${skipped} over ${maxBytes / 1024 / 1024} MB` : ""}`);
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  }, 24 * 3_600_000);
});

/** The `.jsonl` files under `dir`, one at a time. */
function* sessionFiles(dir: string): Generator<string> {
  const handle = opendirSync(dir);
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) yield* sessionFiles(path);
      else if (entry.name.endsWith(".jsonl")) yield path;
    }
  } finally {
    handle.closeSync();
  }
}
