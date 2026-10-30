import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { indexTree, serializeTranscript, validateTranscript, verifyIntegrity, addIntegrity, type EntryRecord, type Transcript } from "../src/index.ts";
import { arbitraryTranscript } from "../src/testing.ts";
import { inSync, reconcile, reconciliationKeys } from "../src/reconcile.ts";

/** The laws of specs/reconcile.ts, over arbitrary transcripts. */
const RUNS = Number(process.env.ATXF_RUNS ?? 100);
const text = (t: Transcript) => serializeTranscript(t);
const merge = (...copies: Transcript[]) => reconcile(copies).transcript;

function strip(record: EntryRecord): EntryRecord {
  const { hash: _, ...rest } = record;
  return rest as EntryRecord;
}

/**
 * A copy of `base` that was continued elsewhere: its first `cut` records, then the rest changed by `tag` (as another
 * Mac's agent would write different records, under the same positional ids), or nothing more when `tag` is null.
 */
function diverge(base: Transcript, cut: number, tag: string | null, sealed: boolean): Transcript {
  const records = base.records.filter((record) => record.type !== "seal").map(strip);
  const suffix = tag === null ? [] : records.slice(cut).map((record) => ({ ...record, ext: { ...record.ext, "x-copy": tag } }) as EntryRecord);
  const { hash: _h, integrity: _i, ...header } = base.header;
  const copy: Transcript = { header, records: [...records.slice(0, cut), ...suffix] };
  return sealed ? addIntegrity(copy, { seal: { id: `seal-${tag}`, time: base.header.time } }) : copy;
}

const copies = (count: { min: number; max: number }) =>
  arbitraryTranscript({ maxRecords: 16 }).chain((base) =>
    fc
      .array(fc.record({ cut: fc.nat(base.records.length), tag: fc.option(fc.constantFrom("a", "b", "c")), sealed: fc.boolean() }), { minLength: count.min, maxLength: count.max })
      .map((specs) => specs.map(({ cut, tag, sealed }) => diverge(base, cut, tag, sealed))),
  );

const property = (name: string, arb: fc.Arbitrary<Transcript[]>, check: (copies: Transcript[]) => void) =>
  test(name, () => fc.assert(fc.property(arb, check), { numRuns: RUNS }));

describe("reconcile", () => {
  property("the result is a valid transcript", copies({ min: 1, max: 3 }), (cs) => {
    const result = reconcile(cs);
    const validation = validateTranscript(text(result.transcript));
    expect(validation.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(verifyIntegrity(result.transcript)).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  property("no record is lost, and none is duplicated", copies({ min: 1, max: 3 }), (cs) => {
    const result = reconciliationKeys(merge(...cs));
    const union = new Set(cs.flatMap((c) => [...reconciliationKeys(c)]));
    for (const key of union) expect(result.has(key)).toBe(true);
    expect(result.size).toBe(union.size);
  });

  property("the order of the copies does not matter", copies({ min: 2, max: 3 }), (cs) => {
    expect(text(merge(...[...cs].reverse()))).toBe(text(merge(...cs)));
    expect(text(merge(...cs.slice(1), cs[0]!))).toBe(text(merge(...cs)));
  });

  property("neither does how they are grouped", copies({ min: 3, max: 3 }), ([a, b, c]) => {
    const all = text(merge(a!, b!, c!));
    expect(text(merge(merge(a!, b!), c!))).toBe(all);
    expect(text(merge(a!, merge(b!, c!)))).toBe(all);
  });

  property("reconciling again changes nothing", copies({ min: 1, max: 3 }), (cs) => {
    const once = merge(...cs);
    expect(text(merge(once))).toBe(text(once));
    expect(text(merge(once, ...cs))).toBe(text(once));
  });

  property("records sharing an id keep distinct ids, and references follow them", copies({ min: 2, max: 3 }), (cs) => {
    const { transcript, renamed } = reconcile(cs);
    const ids = transcript.records.map((record) => record.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { as } of renamed) expect(ids).toContain(as);
  });

  property("a copy is in sync with the result exactly when it holds every record", copies({ min: 1, max: 3 }), (cs) => {
    const result = merge(...cs);
    for (const c of cs) expect(inSync(c, result)).toBe(reconciliationKeys(c).size === reconciliationKeys(result).size);
    expect(inSync(result, merge(result))).toBe(true);
  });

  test("divergent continuations become sibling branches, and the latest one is active", () => {
    const header = { type: "transcript", atxf: "0.1", id: "s", time: "2026-10-30T09:00:00Z", source: { agent: "codex" } } as const;
    const user = (id: string, parentId: string | null, time: string, content: string) => ({ type: "message", role: "user", id, parentId, time, content }) as EntryRecord;
    const shared = [user("0", null, "2026-10-30T09:00:00Z", "hello"), user("1", "0", "2026-10-30T09:01:00Z", "fix the bug")];
    const studio: Transcript = { header, records: [...shared, user("2", "1", "2026-10-30T09:02:00Z", "on the Studio")] };
    const laptop: Transcript = { header, records: [...shared, user("2", "1", "2026-10-30T09:03:00Z", "on the Laptop"), user("3", "2", "2026-10-30T09:04:00Z", "and more")] };

    const { transcript, renamed } = reconcile([laptop, studio]);
    expect(transcript.records.map((r) => r.id)).toEqual(["0", "1", "2", renamed[0]!.as, "3"]);
    expect(renamed).toHaveLength(1);
    const index = indexTree(transcript);
    expect(index.children.get("1")).toHaveLength(2);
    // The Laptop's records came later, so its tip is the active leaf.
    expect((index.nodes.get(index.activeLeaf!) as { content: string }).content).toBe("and more");
    expect((index.nodes.get(index.nodes.get("3")!.parentId!) as { content: string }).content).toBe("on the Laptop");
  });

  test("a rewind that is the latest event moves every copy back", () => {
    const header = { type: "transcript", atxf: "0.1", id: "s", time: "2026-10-30T09:00:00Z", source: { agent: "pi" } } as const;
    const a = { type: "message", role: "user", id: "a", parentId: null, time: "2026-10-30T09:00:00Z", content: "one" } as EntryRecord;
    const b = { type: "message", role: "user", id: "b", parentId: "a", time: "2026-10-30T09:01:00Z", content: "two" } as EntryRecord;
    const c = { type: "message", role: "user", id: "c", parentId: "b", time: "2026-10-30T09:02:00Z", content: "three" } as EntryRecord;
    const rewind = { type: "leaf", id: "l", time: "2026-10-30T09:03:00Z", targetId: "a", reason: "rewind" } as EntryRecord;
    const result = merge({ header, records: [a, b, c] }, { header, records: [a, b, rewind] });
    expect(indexTree(result).activeLeaf).toBe("a");
    expect(result.records).toHaveLength(4);
  });

  test("copies of different sessions are refused", () => {
    const one = { header: { type: "transcript", atxf: "0.1", id: "one", time: "2026-10-30T09:00:00Z", source: { agent: "pi" } }, records: [] } as Transcript;
    expect(() => reconcile([one, { ...one, header: { ...one.header, id: "two" } }])).toThrow("different sessions");
  });
});
