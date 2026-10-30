import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { canonicalJson } from "../src/canonical.ts";
import {
  addIntegrity,
  hashHeader,
  proveInclusion,
  TranscriptHasher,
  verifyInclusion,
  verifyIntegrity,
} from "../src/integrity.ts";
import { parseTranscript, serializeTranscript } from "../src/jsonl.ts";
import type { EntryRecord, Transcript } from "../src/types.ts";
import { validateTranscript } from "../src/validate.ts";

const examplesDir = new URL("../../../examples/", import.meta.url);
const examples = readdirSync(examplesDir).filter((file) => file.endsWith(".atxf.jsonl"));
const load = (file: string) => parseTranscript(readFileSync(new URL(file, examplesDir), "utf8"));
const branching = () => load("branching.atxf.jsonl");
const sealed = (transcript: Transcript) => addIntegrity(transcript, { seal: { id: "test-seal", time: "2026-10-29T14:00:00Z" } });
const clone = <T>(value: T): T => structuredClone(value);
const indexOf = (transcript: Transcript, id: string) => transcript.records.findIndex((record) => record.id === id);

describe("canonical JSON", () => {
  test("sorts keys recursively and drops undefined, so key order does not change a hash", () => {
    expect(canonicalJson({ b: 1, a: [1.0, "é", { d: undefined, c: null }] })).toBe('{"a":[1,"é",{"c":null}],"b":1}');
  });
});

describe("hashing", () => {
  test.each(examples)("%s validates after adding integrity and a seal", (file) => {
    const result = validateTranscript(serializeTranscript(sealed(load(file))));
    expect(result.diagnostics).toEqual([]);
  });

  test("is deterministic and independent of key order", () => {
    const shuffled = branching();
    shuffled.records = shuffled.records.map(
      (record) => Object.fromEntries(Object.entries(record).reverse()) as unknown as EntryRecord,
    );
    expect(sealed(shuffled)).toEqual(sealed(branching()));
  });

  test("hashing while appending gives the same hashes as hashing the finished file", () => {
    const transcript = branching();
    const hasher = new TranscriptHasher(transcript.header);
    const streamed = transcript.records.map((record) => hasher.push(record).hash);
    expect<(string | undefined)[]>(streamed).toEqual(addIntegrity(transcript).records.map((record) => record.hash));
  });

  test("copies that share a prefix share its hashes; the divergent suffixes differ", () => {
    const base = branching();
    const prefix = base.records.slice(0, indexOf(base, "a4"));
    const left = { header: base.header, records: [...prefix, { ...base.records[indexOf(base, "a4")]! }] };
    const right = {
      header: base.header,
      records: [...prefix, { type: "message", id: "b4", parentId: "a3", time: "2026-10-29T13:00:11Z", role: "user", content: "Looks good." } as EntryRecord],
    };
    const [l, r] = [addIntegrity(left).records, addIntegrity(right).records];
    expect(l.slice(0, prefix.length)).toEqual(r.slice(0, prefix.length));
    expect(l.at(-1)!.hash).not.toBe(r.at(-1)!.hash);
  });

  test("the header hash covers the header, and every record commits to it", () => {
    const transcript = sealed(branching());
    const renamed = clone(transcript);
    renamed.header.title = "renamed";
    expect(hashHeader(renamed.header)).not.toBe(transcript.header.hash);
    expect(verifyIntegrity(renamed).map((p) => p.index)).toContain(-1);
  });
});

describe("tamper detection", () => {
  test("editing a record's content invalidates it and every record that depends on it", () => {
    const transcript = sealed(branching());
    const edited = clone(transcript);
    const a3 = edited.records[indexOf(edited, "a3")] as { content: { text: string }[] };
    a3.content[0]!.text = "Approach B.";
    const flagged = new Set(verifyIntegrity(edited).map((p) => edited.records[p.index]?.id));
    for (const id of ["a3", "a4", "a5", "l1", "a6", "n1", "test-seal"]) expect(flagged).toContain(id);
    expect(flagged).not.toContain("a2");
  });

  test("re-parenting a record is detected even though its content digest is unchanged", () => {
    const edited = sealed(branching());
    (edited.records[indexOf(edited, "a7")] as { parentId: string }).parentId = "a2";
    expect(verifyIntegrity(edited).some((p) => edited.records[p.index]!.id === "a7")).toBe(true);
  });

  test("a seal detects a deleted branch tip, which no remaining record references", () => {
    const transcript = branching();
    const truncated = sealed(transcript);
    // a11 is the newest message on the main branch and nothing references it, so its hash appears nowhere else.
    truncated.records = truncated.records.filter((record) => record.id !== "a11");
    const problems = verifyIntegrity(truncated);
    expect(problems.map((p) => truncated.records[p.index]!.type)).toEqual(["seal", "seal", "seal"]);
  });

  test("a seal detects reordered annotations, which decide the active leaf and label", () => {
    const transcript = branching();
    transcript.records.push({ type: "label", id: "l2", time: "2026-10-29T13:07:00Z", targetId: "a3", label: "final" });
    const ordered = sealed(transcript);
    const swapped = clone(ordered);
    const [i, j] = [indexOf(swapped, "n1"), indexOf(swapped, "l2")];
    [swapped.records[i], swapped.records[j]] = [swapped.records[j]!, swapped.records[i]!];
    const problems = verifyIntegrity(swapped);
    expect(problems).toEqual([{ index: indexOf(swapped, "test-seal"), message: "seal chain does not match the records before it" }]);
  });

  test("records without a hash are rejected once the header declares integrity", () => {
    const transcript = addIntegrity(branching());
    delete transcript.records[0]!.hash;
    expect(verifyIntegrity(transcript)[0]).toEqual({ index: 0, message: "missing hash; the header declares `integrity`" });
  });

  test("a seal without integrity in the header is an error", () => {
    const transcript = sealed(branching());
    delete transcript.header.integrity;
    delete transcript.header.hash;
    const result = validateTranscript(serializeTranscript(transcript));
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.message.includes("seal requires `integrity`"))).toBe(true);
  });
});

describe("inclusion proofs", () => {
  test("every record has a proof that ends at one of the seal's heads", () => {
    const transcript = sealed(branching());
    const seal = transcript.records.at(-1) as { heads: string[] };
    for (const record of transcript.records.slice(0, -1)) {
      const proof = proveInclusion(transcript, record.id);
      expect(verifyInclusion(proof)).toBe(true);
      expect(seal.heads).toContain(proof.head);
    }
  });

  test("a proof fails for altered content or a broken path", () => {
    const transcript = sealed(branching());
    const proof = proveInclusion(transcript, "a2");
    expect(proof.steps.length).toBeGreaterThan(1);
    expect(verifyInclusion({ ...proof, record: { ...proof.record, content: "Fix it." } as EntryRecord })).toBe(false);
    expect(verifyInclusion({ ...proof, steps: [proof.steps[0]!, ...proof.steps.slice(2)] })).toBe(false);
  });
});
