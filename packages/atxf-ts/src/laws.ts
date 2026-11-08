import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Converter } from "./convert.ts";
import { conversationView, type PortableMessage } from "./equivalence.ts";
import { addIntegrity } from "./integrity.ts";
import { serializeTranscript } from "./jsonl.ts";
import { arbitraryTranscript, noisyJsonl, normalize } from "./testing.ts";
import type { Transcript } from "./types.ts";
import { validateTranscript } from "./validate.ts";

export interface LawOptions {
  /** Native files that must round-trip byte for byte, e.g. real sessions. */
  fixtures?: { name: string; text: string }[];
  /** Generated cases per property. Default 100. */
  runs?: number;
  /** Arbitrary native files. Default: generated transcripts written without carry, plus JSONL noise. */
  nativeFiles?: fc.Arbitrary<string>;
  /** Maps a conversation view to what the format can express, for the faithful-view law. */
  view?: (messages: PortableMessage[]) => PortableMessage[];
}

/**
 * The laws every converter must satisfy (SPEC §11.1):
 *
 * 1. **Native round trip:** `fromAtxf(toAtxf(x)) === x` for native files, byte for byte, noise included.
 * 2. **Valid output:** what `toAtxf` returns passes `validateTranscript`.
 * 3. **Carry:** `toAtxf(fromAtxf(t))` equals `t` for any transcript, whatever its source.
 * 4. **Faithful view:** written without the carried transcript, the file still holds the same conversation.
 * 5. **Streaming,** for a converter that can `stream`: pushing a file's lines one at a time returns `toAtxf`'s
 *    records, and its header without `fidelity.nativeDigest`; the streamed transcript writes back the same file.
 */
export function describeConverterLaws(converter: Converter, options: LawOptions = {}) {
  const runs = options.runs ?? Number(process.env.ATXF_RUNS ?? 100);
  const view = options.view ?? ((messages: PortableMessage[]) => messages);
  const nativeFiles =
    options.nativeFiles ?? arbitraryTranscript({ integrity: false }).chain((t) => noisyJsonl(converter.fromAtxf(t, { carry: false })));

  describe(`${converter.agent} laws`, () => {
    for (const fixture of options.fixtures ?? []) {
      test(`fixture ${fixture.name} round-trips byte for byte and decodes to a valid transcript`, () => {
        const transcript = converter.toAtxf(fixture.text);
        expect(converter.fromAtxf(transcript)).toBe(fixture.text);
        expect(validateTranscript(serializeTranscript(transcript)).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      });
    }

    test("native round trip: fromAtxf(toAtxf(x)) === x for any native file", () => {
      fc.assert(fc.property(nativeFiles, (text) => converter.fromAtxf(converter.toAtxf(text)) === text), { numRuns: runs });
    });

    test("valid output: toAtxf returns a valid transcript for any native file", () => {
      fc.assert(
        fc.property(nativeFiles, (text) => {
          const errors = validateTranscript(serializeTranscript(converter.toAtxf(text))).diagnostics.filter((d) => d.severity === "error");
          expect(errors).toEqual([]);
        }),
        { numRuns: runs },
      );
    });

    test("carry: toAtxf(fromAtxf(t)) equals t for any transcript", () => {
      fc.assert(
        fc.property(arbitraryTranscript(), (t) => {
          expect(normalize(converter.toAtxf(converter.fromAtxf(t)))).toEqual(normalize(t));
        }),
        { numRuns: runs },
      );
    });

    const stream = converter.stream?.bind(converter);
    if (stream) {
      const streamed = (text: string, integrity?: boolean) => {
        const reading = stream({ integrity });
        const records = text.split("\n").filter((line) => line !== "").flatMap((line) => reading.push(line));
        return { header: reading.header!, records };
      };
      const withoutDigest = (t: Transcript, integrity?: boolean): Transcript => {
        const { nativeDigest: _, ...fidelity } = t.header.fidelity ?? {};
        const header = { ...t.header, fidelity };
        return integrity === false ? { header, records: t.records } : addIntegrity({ header, records: t.records });
      };
      // Streams read records as an agent appends them: whole lines, each ending in a newline, none blank.
      const appended = nativeFiles.map((text) => text.split("\n").filter((line) => line.trim() !== "").map((line) => `${line}\n`).join(""));
      const fixtures = (options.fixtures ?? []).filter(({ text }) => text.endsWith("\n") && !text.split("\n").slice(0, -1).some((line) => line.trim() === ""));

      for (const fixture of fixtures) {
        test(`streaming: fixture ${fixture.name} streams to the records toAtxf reads`, () => {
          expect(streamed(fixture.text)).toEqual(withoutDigest(converter.toAtxf(fixture.text, { integrity: false })));
        });
      }

      test("streaming: pushing lines one at a time returns toAtxf's records, hashed against the streamed header", () => {
        fc.assert(
          fc.property(appended, (text) => {
            expect(streamed(text, false)).toEqual(withoutDigest(converter.toAtxf(text, { integrity: false }), false));
            expect(streamed(text)).toEqual(withoutDigest(converter.toAtxf(text, { integrity: false })));
          }),
          { numRuns: runs },
        );
      });

      test("streaming: a streamed transcript writes back the file it was read from", () => {
        fc.assert(fc.property(appended, (text) => converter.fromAtxf(streamed(text)) === text), { numRuns: runs });
      });
    }

    test("faithful view: without carry, the file still holds the same conversation", () => {
      fc.assert(
        fc.property(arbitraryTranscript({ integrity: false }), (t) => {
          const written = converter.toAtxf(converter.fromAtxf(t, { carry: false }));
          expect(view(conversationView(written))).toEqual(view(conversationView(t)));
        }),
        { numRuns: runs },
      );
    });
  });
}

export type { Transcript };
