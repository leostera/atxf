import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { conversationView, embeddedToolResults, serializeTranscript, summariesAsUser, validateTranscript, type Converter, type PortableMessage } from "@atxf/core";
import { arbitraryTranscript, normalize } from "@atxf/core/testing";
import { converters } from "./converters.ts";

/**
 * Continuation: an agent opens a file written for another agent's transcript and keeps going. Reading the file
 * back gives the carried transcript plus the new records, attached at the active leaf.
 */
const TIME = "2026-10-30T09:00:00.000Z";
const TEXT = "Continue from here.";

/** Append one user prompt the way each agent writes it. */
const append: Record<string, (file: string) => string> = {
  pi(file) {
    const last = file.trimEnd().split("\n").at(-1)!;
    const parentId = JSON.parse(last).id ?? null;
    return file + JSON.stringify({ type: "message", id: "cont0001", parentId, timestamp: TIME, message: { role: "user", content: TEXT, timestamp: Date.parse(TIME) } }) + "\n";
  },
  "claude-code"(file) {
    const entries = file.trimEnd().split("\n").map((line) => JSON.parse(line));
    const parentUuid = entries.findLast((entry) => typeof entry.uuid === "string")?.uuid ?? null;
    return file + JSON.stringify({ parentUuid, isSidechain: false, type: "user", message: { role: "user", content: TEXT }, uuid: "c0ffee00-0000-4000-8000-000000000001", timestamp: TIME, sessionId: "s" }) + "\n";
  },
  codex(file) {
    return file + JSON.stringify({ timestamp: TIME, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: TEXT }] } }) + "\n";
  },
  "gemini-cli"(file) {
    return file + JSON.stringify({ id: "cont0001", timestamp: TIME, type: "user", content: TEXT }) + "\n";
  },
  opencode(file) {
    const doc = JSON.parse(file);
    doc.messages.push({ id: "msg_cont0001", type: "user", text: TEXT, files: [], agents: [], skills: [], time: { created: Date.parse(TIME) } });
    return JSON.stringify(doc, null, 2) + "\n";
  },
};

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
          const continued = converter.toAtxf(append[converter.agent]!(converter.fromAtxf(t)));
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
