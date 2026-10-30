import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { conversationView, embeddedToolResults, serializeTranscript, summariesAsUser, validateTranscript, type Converter, type PortableMessage } from "../src/index.ts";
import { arbitraryTranscript, normalize } from "../src/testing.ts";
import { appendPrompt, converters } from "./converters.ts";

/**
 * Continuation: an agent opens a file written for another agent's transcript and keeps going. Reading the file
 * back gives the carried transcript plus the new records, attached at the active leaf.
 */
const TIME = "2026-10-30T09:00:00.000Z";
const TEXT = "Continue from here.";

const views: Record<string, (view: PortableMessage[]) => PortableMessage[]> = {
  codex: summariesAsUser,
  opencode: (view) => embeddedToolResults(summariesAsUser(view)),
  "gemini-cli": (view) => embeddedToolResults(summariesAsUser(view)),
};

const prompt = (view: PortableMessage[]) => ({ role: "user", text: TEXT }) satisfies PortableMessage;

describe("continuation", () => {
  for (const { converter } of converters as { converter: Converter }[]) {
    test(`${converter.agent}: records appended by the agent join the carried transcript at its active leaf`, () => {
      const view = views[converter.agent] ?? ((v: PortableMessage[]) => v);
      fc.assert(
        fc.property(arbitraryTranscript(), (t) => {
          const continued = converter.toAtxf(appendPrompt(converter.agent, converter.fromAtxf(t), { text: TEXT, time: TIME, tag: "cont0001" }));
          // The carried records come back unchanged (rehashed only when the transcript declares integrity).
          expect(normalize(continued.records.slice(0, t.records.length)).map(({ hash: _, ...r }: any) => r)).toEqual(
            normalize(t.records).map(({ hash: _, ...r }: any) => r),
          );
          expect(continued.records.length).toBe(t.records.length + 1);
          expect(validateTranscript(serializeTranscript(continued)).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
          // The conversation is the old one plus the new prompt.
          expect(view(conversationView(continued))).toEqual(view([...conversationView(t), prompt(conversationView(t))]));
        }),
        { numRuns: 60, seed: process.env.SEED ? Number(process.env.SEED) : undefined, path: process.env.FCPATH, endOnFailure: true },
      );
    });
  }
});
