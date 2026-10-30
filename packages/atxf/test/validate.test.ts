import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { validateTranscript } from "../src/validate.ts";

const header = {
  type: "transcript",
  atxf: "0.1",
  id: "t",
  time: "2026-10-29T12:00:00Z",
  source: { agent: "test" },
};
const t = "2026-10-29T12:00:01Z";
const user = { type: "message", id: "u1", parentId: null, time: t, role: "user", content: "hi" };
const call = {
  type: "message",
  id: "a1",
  parentId: "u1",
  time: t,
  role: "assistant",
  content: [{ type: "tool_call", id: "call-1", name: "bash", arguments: { cmd: "ls" } }],
};

const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n");
const errors = (...records: unknown[]) =>
  validateTranscript(jsonl(...records))
    .diagnostics.filter((d) => d.severity === "error")
    .map((d) => d.message);

describe("examples", () => {
  for (const file of readdirSync(new URL("../../../examples", import.meta.url))) {
    test(file, async () => {
      const result = validateTranscript(await Bun.file(new URL(`../../../examples/${file}`, import.meta.url)).text());
      expect(result.diagnostics).toEqual([]);
    });
  }
});

describe("schema rejects", () => {
  const cases: [string, unknown[]][] = [
    ["unknown record type", [header, { ...user, type: "note" }]],
    ["missing parentId on a tree record", [header, { ...user, parentId: undefined }]],
    ["unknown property", [header, { ...user, mood: "happy" }]],
    ["assistant string content", [header, user, { ...call, content: "hello" }]],
    ["tool result without toolCallId", [header, user, call, { type: "message", id: "r1", parentId: "a1", time: t, role: "tool", content: "x" }]],
    ["tool_call with both arguments and input", [header, user, { ...call, content: [{ type: "tool_call", id: "c", name: "x", arguments: {}, input: "y" }] }]],
    ["reasoning with nothing in it", [header, user, { ...call, content: [{ type: "reasoning" }] }]],
    ["summary compaction without firstKeptId", [header, user, { type: "compaction", id: "k", parentId: "u1", time: t, strategy: "summary", summary: "s" }]],
    ["replace compaction without replacement", [header, user, { type: "compaction", id: "k", parentId: "u1", time: t, strategy: "replace" }]],
    ["turn start with outcome", [header, { type: "turn", id: "x", parentId: null, time: t, phase: "start", turnId: "1", outcome: "succeeded" }]],
    ["turn end without outcome", [header, { type: "turn", id: "x", parentId: null, time: t, phase: "end", turnId: "1" }]],
    ["empty settings", [header, { type: "settings", id: "s", parentId: null, time: t }]],
    ["empty metadata", [header, { type: "metadata", id: "m", time: t }]],
    ["wrong format version", [{ ...header, atxf: "9" }]],
    ["leaf with parentId", [header, user, { type: "leaf", id: "l", parentId: "u1", time: t, targetId: "u1" }]],
  ];
  for (const [name, records] of cases) {
    test(name, () => expect(errors(...records)[0]).toStartWith("schema:"));
  }
});

describe("cross-record invariants", () => {
  test("header must be first", () => {
    expect(errors(user, header)).toContain("first record must be `transcript`");
  });
  test("parentId must point backwards", () => {
    expect(errors(header, { ...user, parentId: "later" })[0]).toContain("parentId `later`");
  });
  test("ids are unique", () => {
    expect(errors(header, user, { ...user, parentId: "u1" })).toContain("duplicate id `u1`");
  });
  test("firstKeptId must be an ancestor", () => {
    const sibling = { ...user, id: "u2" };
    const compaction = { type: "compaction", id: "k", parentId: "u1", time: t, strategy: "summary", summary: "s", firstKeptId: "u2" };
    expect(errors(header, user, sibling, compaction)).toContain("firstKeptId `u2` must be an ancestor of the compaction");
  });
  test("tool result must be on its call's branch", () => {
    const otherBranch = { ...user, id: "u2" };
    const result = { type: "message", id: "r", parentId: "u2", time: t, role: "tool", toolCallId: "call-1", content: "x" };
    expect(errors(header, user, call, otherBranch, result)).toContain("tool result `call-1` is not on the same branch as its call");
  });
  test("restoreCheckpointId must reference a checkpoint", () => {
    const leaf = { type: "leaf", id: "l", time: t, targetId: "u1", restoreCheckpointId: "u1" };
    expect(errors(header, user, leaf)).toContain("restoreCheckpointId must reference a `checkpoint`");
  });
  test("unknown tool call ids are warnings, not errors", () => {
    const result = { type: "message", id: "r", parentId: "u1", time: t, role: "tool", toolCallId: "imported", content: "x" };
    const { ok, diagnostics } = validateTranscript(jsonl(header, user, result));
    expect(ok).toBe(true);
    expect(diagnostics.map((d) => d.severity)).toEqual(["warning"]);
  });
});
