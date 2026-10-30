import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { indexTree, pathTo, serializeTranscript, validateTranscript, type Converter, type Transcript, type TreeRecord } from "@atxf/core";
import { arbitraryTranscript } from "@atxf/core/testing";
import { inSync, reconcile, reconciliationKeys } from "@atxf/reconcile";
import { appendPrompt, converters } from "./converters.ts";

/**
 * Reconciliation through real formats (specs/reconcile.ts): a session copied to two Macs, continued on each, then
 * reconciled. Each copy's new prompt becomes a branch; nothing either copy holds is lost.
 */
const RUNS = Number(process.env.ATXF_RUNS ?? 40);
const STUDIO = { text: "On the Studio", time: "2026-10-30T09:00:00.000Z", tag: "studio01" };
const LAPTOP = { text: "On the Laptop", time: "2026-10-30T09:05:00.000Z", tag: "laptop01" };

const all = converters.map(({ converter }) => converter as Converter);

function userWith(t: Transcript, text: string): TreeRecord | undefined {
  return indexTree(t).nodes.values().find((r) => r.type === "message" && r.role === "user" && (r.content === text || (Array.isArray(r.content) && r.content.some((b) => b.type === "text" && b.text === text))));
}

function checkReconciled(copies: Transcript[], base: Transcript) {
  const { transcript } = reconcile(copies);
  expect(validateTranscript(serializeTranscript(transcript)).diagnostics.filter((d) => d.severity === "error")).toEqual([]);

  const keys = reconciliationKeys(transcript);
  for (const copy of copies) for (const key of reconciliationKeys(copy)) expect(keys.has(key)).toBe(true);
  for (const key of reconciliationKeys(base)) expect(keys.has(key)).toBe(true);

  // Both prompts are there, as siblings below where the copies diverged; the later one is where the session is.
  const studio = userWith(transcript, STUDIO.text);
  const laptop = userWith(transcript, LAPTOP.text);
  expect(studio).toBeDefined();
  expect(laptop).toBeDefined();
  expect(studio!.parentId).toBe(laptop!.parentId);
  const index = indexTree(transcript);
  expect(pathTo(index, index.activeLeaf).map((r) => r.id)).toContain(laptop!.id);
  return transcript;
}

describe("reconcile", () => {
  for (const converter of all) {
    test(`${converter.agent}: two Macs continue a session; the reconciled copy keeps both and writes back`, () => {
      fc.assert(
        fc.property(arbitraryTranscript({ integrity: false }), (t) => {
          const file = converter.fromAtxf(t, { carry: false });
          const base = converter.toAtxf(file);
          const studio = converter.toAtxf(appendPrompt(converter.agent, file, STUDIO));
          const laptop = converter.toAtxf(appendPrompt(converter.agent, file, LAPTOP));
          const reconciled = checkReconciled([studio, laptop], base);
          // Written back for the same agent and read again, it is the same session.
          expect(inSync(converter.toAtxf(converter.fromAtxf(reconciled)), reconciled)).toBe(true);
        }),
        { numRuns: RUNS },
      );
    });
  }

  for (const a of all) {
    for (const b of all) {
      test(`continued in ${a.agent} on one Mac and in ${b.agent} on the other`, () => {
        fc.assert(
          fc.property(arbitraryTranscript(), (t) => {
            const studio = a.toAtxf(appendPrompt(a.agent, a.fromAtxf(t), STUDIO));
            const laptop = b.toAtxf(appendPrompt(b.agent, b.fromAtxf(t), LAPTOP));
            const reconciled = checkReconciled([studio, laptop], t);
            expect(reconciliationKeys(reconciled).size).toBe(reconciliationKeys(t).size + 2);
            // Either agent can pick up the reconciled session, carrying it whole.
            for (const c of [a, b]) expect(inSync(c.toAtxf(c.fromAtxf(reconciled)), reconciled)).toBe(true);
          }),
          { numRuns: Math.ceil(RUNS / 4) },
        );
      });
    }
  }
});
