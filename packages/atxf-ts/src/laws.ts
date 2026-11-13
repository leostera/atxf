import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Converter } from "./convert.ts";
import { conversationView, type PortableMessage } from "./equivalence.ts";
import { addIntegrity } from "./integrity.ts";
import { addFidelity, emptyFidelity, formatFidelity, isLossless } from "./fidelity.ts";
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
 * 6. **Without native,** for a converter that writes whole trees (SPEC §11.2): a native file read, stripped of
 *    `native` and written as a whole tree equals the original entry by entry, as JSON; read again, it gives the
 *    same transcript. Any transcript written as a whole tree reads back as itself.
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

      // Saved after any line and resumed in a new stream, as JSON, a stream goes on as if it had never stopped.
      const resumedAt = (text: string, cut: number, integrity?: boolean) => {
        const lines = text.split("\n").filter((line) => line !== "");
        const first = stream({ integrity });
        const before = lines.slice(0, cut).flatMap((line) => first.push(line));
        const resumed = stream({ resume: JSON.parse(JSON.stringify(first.state())) });
        const after = lines.slice(cut).flatMap((line) => resumed.push(line));
        return { header: resumed.header ?? first.header, records: [...before, ...after] };
      };
      if (converter.stream!().state !== undefined && (() => { try { converter.stream!().state(); return true; } catch { return false; } })()) {
        for (const fixture of fixtures) {
          test(`streaming: fixture ${fixture.name} resumes from its state after every line`, () => {
            const whole = streamed(fixture.text);
            const count = fixture.text.split("\n").filter((line) => line !== "").length;
            for (let cut = 0; cut <= count; cut++) expect(resumedAt(fixture.text, cut)).toEqual(whole);
          });
        }

        test("streaming: a stream saved after any line and resumed returns the same records and hashes", () => {
          fc.assert(
            fc.property(appended, fc.nat(), fc.boolean(), (text, at, integrity) => {
              const count = text.split("\n").filter((line) => line !== "").length;
              expect(resumedAt(text, at % (count + 1), integrity)).toEqual(streamed(text, integrity));
            }),
            { numRuns: runs },
          );
        });
      }

      test("streaming: a streamed transcript writes back the file it was read from", () => {
        fc.assert(fc.property(appended, (text) => converter.fromAtxf(streamed(text)) === text), { numRuns: runs });
      });
    }

    if (converter.tree) {
      for (const fixture of options.fixtures ?? []) {
        test(`without native: fixture ${fixture.name} writes back every entry, and reads back the same`, () => {
          const report = addFidelity(emptyFidelity(), converter, fixture.text);
          expect(isLossless(report) ? "lossless" : formatFidelity(converter.agent, report)).toBe("lossless");
        });
      }

      test("without native: a native file, stripped and written as a whole tree, writes back every entry", () => {
        fc.assert(
          fc.property(nativeFiles, (text) => {
            const report = addFidelity(emptyFidelity(), converter, text);
            expect(isLossless(report) ? "lossless" : formatFidelity(converter.agent, report)).toBe("lossless");
          }),
          { numRuns: runs },
        );
      });

      test("without native: any transcript written as a whole tree reads back as itself", () => {
        fc.assert(
          fc.property(arbitraryTranscript({ integrity: false }), (t) => {
            const back = converter.toAtxf(converter.fromAtxf(t, { carry: false, tree: true }), { integrity: false });
            expect(withoutNative(back)).toEqual(withoutNative(t));
          }),
          { numRuns: runs },
        );
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

/** A transcript as it is without native: no native records, nor what the header says of them. */
function withoutFidelity<H extends { fidelity?: unknown }>({ fidelity: _, ...header }: H): Omit<H, "fidelity"> {
  return header;
}

function withoutNative(t: Transcript): Transcript {
  const { native: _, ...header } = t.header;
  const { nativeDigest: __, native: ____, ...fidelity } = header.fidelity ?? {};
  return normalize({
    header: Object.keys(fidelity).length === 0 ? withoutFidelity(header) : { ...header, fidelity },
    records: t.records.map(({ native: ___, ...record }) => record as typeof record),
  });
}

export type { Transcript };
