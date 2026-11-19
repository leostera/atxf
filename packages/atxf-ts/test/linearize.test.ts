import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { indexTree, isTreeRecord, leaves, linearize, serializeTranscript, validateTranscript, verifyIntegrity, type EntryRecord, type Transcript } from "../src/index.ts";
import { arbitraryTranscript } from "../src/testing.ts";

const RUNS = Number(process.env.ATXF_RUNS ?? 200);
const property = (name: string, check: (source: Transcript) => void) =>
  test(name, () => fc.assert(fc.property(arbitraryTranscript({ maxRecords: 24 }), check), { numRuns: RUNS }));

/** A record as linearizing keeps it: without its parent, hash and native. */
function content(record: EntryRecord): unknown {
  const { hash: _, native: __, ...rest } = record as EntryRecord & { parentId?: unknown };
  if ("parentId" in rest) delete rest.parentId;
  return rest;
}

describe("linearize", () => {
  property("the result is a valid transcript, sealed when the source declares integrity", (source) => {
    const { transcript } = linearize(source);
    expect(validateTranscript(serializeTranscript(transcript)).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(verifyIntegrity(transcript)).toEqual([]);
  });

  property("it is one path, holding every tree record of the source once, unchanged but for its parent", (source) => {
    const { transcript } = linearize(source);
    const tree = transcript.records.filter(isTreeRecord);
    tree.forEach((record, index) => expect(record.parentId).toBe(index === 0 ? null : tree[index - 1]!.id));
    const before = new Map(source.records.filter(isTreeRecord).map((record) => [record.id, content(record)]));
    expect(tree.map((record) => record.id).sort()).toEqual([...before.keys()].sort());
    for (const record of tree) expect(content(record)).toEqual(before.get(record.id));
    if (tree.length) expect(leaves(indexTree(transcript))).toEqual([tree.at(-1)!.id]);
  });

  property("every record comes after the records it continued", (source) => {
    const at = new Map(linearize(source).transcript.records.map((record, index) => [record.id, index]));
    for (const record of source.records.filter(isTreeRecord)) {
      if (record.parentId !== null && at.has(record.parentId)) expect(at.get(record.parentId)!).toBeLessThan(at.get(record.id)!);
    }
  });

  property("annotations are kept, but where the leaf was and the source's seal are not", (source) => {
    const kept = (t: Transcript, drop: boolean) => t.records.filter((r) => !isTreeRecord(r) && !(drop && (r.type === "leaf" || r.type === "seal"))).map(content);
    expect(kept(linearize(source).transcript, false)).toEqual(kept(source, true));
  });

  property("it forks the source, and is the same however often it is made", (source) => {
    const { transcript, branches } = linearize(source);
    expect(transcript.header.parent).toEqual({ transcriptId: source.header.id, relation: "fork" });
    expect(transcript.header.fidelity?.topology).toBe("linearized");
    expect(transcript.header.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(branches).toBe(leaves(indexTree(source)).length);
    expect(serializeTranscript(linearize(source).transcript)).toBe(serializeTranscript(transcript));
  });

  property("a linear source keeps its order", (source) => {
    const tree = source.records.filter(isTreeRecord);
    const chained = tree.map((record, index) => ({ ...record, parentId: index === 0 ? null : tree[index - 1]!.id }) as EntryRecord);
    const linear = linearize({ header: source.header, records: chained }).transcript.records.filter(isTreeRecord);
    expect(linear.map((record) => record.id)).toEqual(tree.map((record) => record.id));
  });

  test("turns of two branches interleave by time; another answer to the same prompt comes right after it", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
    const message = (id: string, parentId: string | null, role: "user" | "assistant", s: number) =>
      (role === "user" ? { type: "message", id, parentId, time: at(s), role, content: id } : { type: "message", id, parentId, time: at(s), role, content: [{ type: "text", text: id }] }) as EntryRecord;
    const source: Transcript = {
      header: { type: "transcript", atxf: "0.1", id: "s", time: at(0), source: { agent: "test" } },
      records: [
        message("q", null, "user", 0),
        message("a1", "q", "assistant", 1),
        message("a2", "q", "assistant", 9), // a retry: another answer to q
        message("x", "a1", "user", 2), // branch one
        message("y", "a1", "user", 3), // branch two, later
        message("x2", "x", "assistant", 4),
        message("y2", "y", "assistant", 5),
        message("x3", "x2", "user", 6),
      ],
    };
    const ids = linearize(source).transcript.records.map((record) => record.id);
    // q's answers first (a2 answers q too, so it follows a1's turn), then branch one and two turn by turn, by time.
    expect(ids).toEqual(["q", "a1", "a2", "x", "x2", "y", "y2", "x3"]);
  });
});
