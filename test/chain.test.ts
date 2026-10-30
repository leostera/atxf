import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

/** Real Pi sessions, when `ATXF_PI_SESSIONS` names a directory of them (e.g. ~/.pi/agent/sessions). */
const piSessions = process.env.ATXF_PI_SESSIONS;
describe.skipIf(!piSessions)("real Pi sessions round-trip through every format, and keep their conversation without carry", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".jsonl")) files.push(path);
    }
  };
  if (piSessions) walk(piSessions);
  const limit = Number(process.env.ATXF_PI_LIMIT ?? files.length);
  test(`${Math.min(limit, files.length)} sessions`, () => {
    const pi = converters[0]!.converter;
    for (const file of files.slice(0, limit)) {
      const text = readFileSync(file, "utf8");
      const transcript = pi.toAtxf(text);
      for (const { converter } of converters) {
        const back = pi.fromAtxf(converter.toAtxf(converter.fromAtxf(transcript)));
        if (back !== text) throw new Error(`${file} did not survive ${converter.agent}`);
        const view = views[converter.agent] ?? ((v: PortableMessage[]) => v);
        const clean = view(conversationView(converter.toAtxf(converter.fromAtxf(transcript, { carry: false }))));
        expect(clean).toEqual(view(conversationView(transcript)));
      }
    }
  }, 600_000);
});
