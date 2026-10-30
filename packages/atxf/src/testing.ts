import fc from "fast-check";
import { addIntegrity } from "./integrity.ts";
import { indexTree, pathTo } from "./tree.ts";
import type {
  AssistantBlock,
  EntryRecord,
  MessageBody,
  ModelRef,
  Replay,
  ToolDefinition,
  Transcript,
  TranscriptHeader,
  TreeRecord,
  Usage,
  UserContent,
} from "./types.ts";

/**
 * Property-testing kit: arbitrary valid ATXF transcripts, and noise for native files. Converter tests use them to
 * check that every conversion is lossless.
 */

/** JSON that survives `JSON.stringify` and `JSON.parse` unchanged (no `-0`, no `undefined`). */
export const arbitraryJson: fc.Arbitrary<unknown> = fc.json({ maxDepth: 2 }).map((text) => JSON.parse(text));
const arbitraryJsonObject = fc.dictionary(fc.string({ maxLength: 8 }), arbitraryJson, { maxKeys: 3 });

const text = fc.oneof(
  { weight: 3, arbitrary: fc.string({ maxLength: 40 }) },
  { weight: 1, arbitrary: fc.string({ unit: "grapheme", maxLength: 20 }) },
  { weight: 1, arbitrary: fc.constantFrom("", " ", "\n", "line one\nline two", '{"looks":"like json"}', "émoji 🎉 ok") },
);
const name = fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/);
const count = fc.nat({ max: 100_000 });

const modelRef: fc.Arbitrary<ModelRef> = fc.record(
  { provider: fc.constantFrom("anthropic", "openai", "google", "local"), id: name, api: fc.constantFrom("messages", "responses", "chat") },
  { requiredKeys: ["provider", "id"] },
);
const usage: fc.Arbitrary<Usage> = fc.record(
  {
    input: count,
    output: count,
    cacheRead: count,
    cacheWrite: count,
    reasoning: count,
    total: count,
    cost: fc.record({ total: fc.double({ min: 0, max: 10, noNaN: true, noDefaultInfinity: true }).map((n) => Math.round(n * 1e6) / 1e6) }),
  },
  { requiredKeys: ["input", "output"] },
);
const replay: fc.Arbitrary<Replay[]> = fc.array(
  fc.record({ provider: fc.constantFrom("anthropic", "openai", "google"), kind: fc.constantFrom("signature", "encrypted_content"), data: arbitraryJson }, { requiredKeys: ["provider", "data"] }),
  { minLength: 1, maxLength: 2 },
);
const userContent: fc.Arbitrary<UserContent> = fc.oneof(
  text,
  fc.array(
    fc.oneof(
      { weight: 4, arbitrary: fc.record({ type: fc.constant("text" as const), text }) },
      { weight: 1, arbitrary: fc.record({ type: fc.constant("image" as const), mediaType: fc.constantFrom("image/png", "image/jpeg"), data: fc.base64String({ maxLength: 16 }) }) },
      { weight: 1, arbitrary: fc.record({ type: fc.constant("resource" as const), uri: fc.webUrl(), text }, { requiredKeys: ["type", "uri"] }) },
    ),
    { minLength: 1, maxLength: 3 },
  ),
);
const toolDefinition: fc.Arbitrary<ToolDefinition> = fc.record(
  { name, description: text, parameters: fc.constant({ type: "object", properties: {} }) },
  { requiredKeys: ["name"] },
);
const instructions = fc.array(fc.record({ name, text: fc.option(text, { nil: null }) }), { maxLength: 3 });
const time = (index: number) => new Date(Date.UTC(2026, 9, 29, 12) + index * 1000).toISOString();

/** A recipe for one record. Picks are resolved against the records generated so far, so any recipe is valid. */
type Op =
  | { kind: "user"; branch: number | null; content: UserContent; origin: "human" | "extension" | null }
  | { kind: "assistant"; branch: number | null; text: string | null; reasoning: string | null; calls: { name: string; args: Record<string, unknown> }[]; model: ModelRef | null; usage: Usage | null; stop: "end" | "tool_use" | "error" | null; replay: Replay[] | null }
  | { kind: "tool"; pick: number; content: UserContent; isError: boolean }
  | { kind: "context"; branch: number | null; mode: "replace" | "patch"; instructions: { name: string; text: string | null }[]; tools: ToolDefinition[]; removed: string[] }
  | { kind: "settings"; branch: number | null; model: ModelRef | null; effort: string | null; cwd: string | null }
  | { kind: "compaction"; strategy: "summary" | "replace"; summary: string; keep: number | null; replacement: string[] }
  | { kind: "edit"; pick: number; replacement: string | null }
  | { kind: "branch_summary"; branch: number; from: number; summary: string }
  | { kind: "event"; event: "turn" | "tool_status" | "usage" | "checkpoint" | "agent_link" | "custom"; payload: unknown; pick: number }
  | { kind: "leaf"; pick: number | null }
  | { kind: "label"; pick: number; label: string | null }
  | { kind: "metadata"; title: string };

const branch = fc.option(fc.nat(), { nil: null, freq: 4 });
const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ kind: fc.constant("user" as const), branch, content: userContent, origin: fc.constantFrom("human" as const, "extension" as const, null) }) },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("assistant" as const),
      branch,
      text: fc.option(text),
      reasoning: fc.option(text, { freq: 3 }),
      calls: fc.array(fc.record({ name, args: arbitraryJsonObject }), { maxLength: 2 }),
      model: fc.option(modelRef),
      usage: fc.option(usage),
      stop: fc.constantFrom("end" as const, "tool_use" as const, "error" as const, null),
      replay: fc.option(replay, { freq: 3 }),
    }),
  },
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("tool" as const), pick: fc.nat(), content: userContent, isError: fc.boolean() }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("context" as const),
      branch,
      mode: fc.constantFrom("replace" as const, "patch" as const),
      instructions,
      tools: fc.array(toolDefinition, { maxLength: 2 }),
      removed: fc.array(name, { maxLength: 1 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("settings" as const), branch, model: fc.option(modelRef), effort: fc.option(fc.constantFrom("low", "high")), cwd: fc.option(fc.constant("/work")) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("compaction" as const), strategy: fc.constantFrom("summary" as const, "replace" as const), summary: text, keep: fc.option(fc.nat()), replacement: fc.array(text, { minLength: 1, maxLength: 2 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("edit" as const), pick: fc.nat(), replacement: fc.option(text) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("branch_summary" as const), branch: fc.nat(), from: fc.nat(), summary: text }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("event" as const),
      event: fc.constantFrom("turn" as const, "tool_status" as const, "usage" as const, "checkpoint" as const, "agent_link" as const, "custom" as const),
      payload: arbitraryJson,
      pick: fc.nat(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("leaf" as const), pick: fc.option(fc.nat()) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("label" as const), pick: fc.nat(), label: fc.option(name) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("metadata" as const), title: text }) },
);

export interface ArbitraryTranscriptOptions {
  maxRecords?: number;
  /** Probability-like weight for adding integrity (hashes and a seal). Default: sometimes. */
  integrity?: boolean | "sometimes";
}

/** Arbitrary transcripts that pass `validateTranscript`: trees with branches, tools, compactions, edits and events. */
export function arbitraryTranscript(options: ArbitraryTranscriptOptions = {}): fc.Arbitrary<Transcript> {
  const integrity = options.integrity ?? "sometimes";
  return fc
    .record({
      ops: fc.array(op, { maxLength: options.maxRecords ?? 24 }),
      title: fc.option(text, { nil: undefined }),
      idPrefix: fc.constantFrom("", "e-", "msg_", "0f"),
      passthrough: fc.array(fc.option(arbitraryJsonObject, { freq: 4 }), { maxLength: 4 }),
      sealed: integrity === "sometimes" ? fc.boolean() : fc.constant(integrity),
    })
    .map(({ ops, title, idPrefix, passthrough, sealed }) => {
      const header: TranscriptHeader = {
        type: "transcript",
        atxf: "0.1",
        id: `${idPrefix}transcript`,
        time: time(0),
        source: { agent: "generated" },
        ...(title !== undefined ? { title } : {}),
      };
      const transcript: Transcript = { header, records: build(ops, idPrefix, passthrough) };
      return sealed ? addIntegrity(transcript, { seal: { id: `${idPrefix}seal`, time: time(ops.length + 1) } }) : transcript;
    });
}

function build(ops: Op[], prefix: string, passthrough: (Record<string, unknown> | null)[]): EntryRecord[] {
  const records: EntryRecord[] = [];
  const nodes: TreeRecord[] = [];
  const messages: TreeRecord[] = [];
  const calls: { id: string; owner: string; answered: boolean }[] = [];
  let leaf: string | null = null;
  let callCount = 0;

  const ancestorsOf = (id: string | null) => {
    const transcript = { header: {} as TranscriptHeader, records };
    return new Set(pathTo(indexTree(transcript), id).map((node) => node.id));
  };
  const pick = (n: number) => nodes[n % nodes.length]!;
  const parentFor = (b: number | null): string | null => (b === null || nodes.length === 0 ? leaf : b % (nodes.length + 1) === nodes.length ? null : pick(b).id);

  ops.forEach((op, index) => {
    const id = `${prefix}r${index}`;
    const at = time(index + 1);
    const extra = passthrough[index % Math.max(passthrough.length, 1)];
    const withExtras = <R extends EntryRecord>(record: R): R =>
      (extra && index % 3 === 0 ? { ...record, ext: { "x-generated": extra } } : extra && index % 3 === 1 ? { ...record, native: { source: "generated", records: [extra] } } : record) as R;
    const addNode = (record: TreeRecord) => {
      const full = withExtras(record);
      records.push(full);
      nodes.push(full);
      if (full.type === "message") messages.push(full);
      leaf = full.id;
    };
    const addAnnotation = (record: EntryRecord) => records.push(withExtras(record));

    switch (op.kind) {
      case "user":
        addNode({ type: "message", id, parentId: parentFor(op.branch), time: at, role: "user", content: op.content, ...(op.origin ? { origin: { kind: op.origin } } : {}) } as TreeRecord);
        break;
      case "assistant": {
        const content: AssistantBlock[] = [];
        if (op.reasoning !== null) content.push({ type: "reasoning", text: op.reasoning, ...(op.replay ? { replay: op.replay } : {}) });
        if (op.text !== null) content.push({ type: "text", text: op.text });
        for (const call of op.calls) {
          const callId = `call-${++callCount}`;
          content.push({ type: "tool_call", id: callId, name: call.name, arguments: call.args });
          calls.push({ id: callId, owner: id, answered: false });
        }
        const body: MessageBody = {
          role: "assistant",
          content,
          ...(op.model ? { model: op.model } : {}),
          ...(op.usage ? { usage: op.usage } : {}),
          ...(op.stop ? { stop: op.stop } : {}),
        };
        addNode({ type: "message", id, parentId: parentFor(op.branch), time: at, ...body } as TreeRecord);
        break;
      }
      case "tool": {
        const open = calls.filter((call) => !call.answered);
        if (open.length === 0) break;
        const call = open[op.pick % open.length]!;
        call.answered = true;
        const parentId = leaf !== null && ancestorsOf(leaf).has(call.owner) ? leaf : call.owner;
        addNode({ type: "message", id, parentId, time: at, role: "tool", toolCallId: call.id, content: op.content, ...(op.isError ? { isError: true } : {}) } as TreeRecord);
        break;
      }
      case "context":
        addNode({
          type: "context",
          id,
          parentId: parentFor(op.branch),
          time: at,
          mode: op.mode,
          ...(op.instructions.length ? { instructions: op.instructions } : {}),
          ...(op.tools.length ? { toolsAdded: op.tools } : {}),
          ...(op.mode === "patch" && op.removed.length ? { toolsRemoved: op.removed } : {}),
        });
        break;
      case "settings":
        addNode({
          type: "settings",
          id,
          parentId: parentFor(op.branch),
          time: at,
          ...(op.model ? { model: op.model } : {}),
          ...(op.effort ? { reasoningEffort: op.effort } : {}),
          ...(op.cwd || (!op.model && !op.effort) ? { cwd: op.cwd ?? "/work" } : {}),
        });
        break;
      case "compaction": {
        if (op.strategy === "replace") {
          addNode({ type: "compaction", id, parentId: leaf, time: at, strategy: "replace", replacement: op.replacement.map((content) => ({ role: "user", content })) });
          break;
        }
        const ancestors = [...ancestorsOf(leaf)];
        const firstKeptId = op.keep === null || ancestors.length === 0 ? null : ancestors[op.keep % ancestors.length]!;
        addNode({ type: "compaction", id, parentId: leaf, time: at, strategy: "summary", summary: op.summary, firstKeptId });
        break;
      }
      case "edit": {
        if (messages.length === 0) break;
        const target = messages[op.pick % messages.length]! as TreeRecord & { role: string };
        const replacement = op.replacement === null ? null : target.role === "assistant" ? [{ type: "text" as const, text: op.replacement }] : op.replacement;
        addNode({ type: "context_edit", id, parentId: leaf, time: at, targetId: target.id, replacement });
        break;
      }
      case "branch_summary":
        if (nodes.length === 0) break;
        addNode({ type: "branch_summary", id, parentId: pick(op.branch).id, time: at, fromId: pick(op.from).id, summary: op.summary });
        break;
      case "event": {
        const parentId = leaf;
        const callId = calls.length ? calls[op.pick % calls.length]!.id : undefined;
        if (op.event === "turn") addNode({ type: "turn", id, parentId, time: at, phase: op.pick % 2 ? "end" : "start", turnId: `turn-${op.pick % 5}`, ...(op.pick % 2 ? { outcome: "succeeded" as const } : {}) });
        if (op.event === "tool_status" && callId) addNode({ type: "tool_status", id, parentId, time: at, toolCallId: callId, status: "completed" });
        if (op.event === "usage") addNode({ type: "usage", id, parentId, time: at, kind: "cache_warm", usage: { input: op.pick, output: 0 } });
        if (op.event === "checkpoint") addNode({ type: "checkpoint", id, parentId, time: at, snapshot: `snap-${op.pick}` });
        if (op.event === "agent_link") addNode({ type: "agent_link", id, parentId, time: at, relation: "spawn", transcriptId: `child-${op.pick}` });
        if (op.event === "custom") addNode({ type: "custom", id, parentId, time: at, namespace: "generated", name: "state", data: op.payload });
        break;
      }
      case "leaf": {
        const targetId = op.pick === null || nodes.length === 0 ? null : pick(op.pick).id;
        addAnnotation({ type: "leaf", id, time: at, targetId, reason: "navigate" });
        leaf = targetId;
        break;
      }
      case "label":
        if (nodes.length === 0) break;
        addAnnotation({ type: "label", id, time: at, targetId: pick(op.pick).id, label: op.label });
        break;
      case "metadata":
        addAnnotation({ type: "metadata", id, time: at, title: op.title });
        break;
    }
  });
  return records;
}

/** A JSON round trip, which drops `undefined` fields: the form a transcript has once written and read back. */
export function normalize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Noise for a JSON Lines file, to check that native round-trips are byte exact for any input: unknown record types,
 * unknown fields, non-canonical spacing, blank lines, CRLF line endings, a line that is not JSON, and a missing
 * final newline.
 */
export function noisyJsonl(text: string): fc.Arbitrary<string> {
  const lines = text.split("\n").filter((line) => line !== "");
  return fc
    .record({
      unknownLines: fc.array(fc.tuple(fc.nat(), arbitraryJsonObject), { maxLength: 2 }),
      extraFields: fc.array(fc.tuple(fc.nat(), fc.string({ maxLength: 6 }), arbitraryJson), { maxLength: 2 }),
      spaced: fc.array(fc.nat(), { maxLength: 2 }),
      blank: fc.array(fc.nat(), { maxLength: 2 }),
      crlf: fc.boolean(),
      broken: fc.option(fc.nat(), { freq: 4 }),
      finalNewline: fc.boolean(),
    })
    .map(({ unknownLines, extraFields, spaced, blank, crlf, broken, finalNewline }) => {
      const out = lines.slice();
      for (const [at, field, value] of extraFields) {
        if (out.length < 2) break;
        const index = 1 + (at % (out.length - 1));
        const record = JSON.parse(out[index]!);
        if (record && typeof record === "object" && !Array.isArray(record) && !(field in record)) {
          record[field] = value;
          out[index] = JSON.stringify(record);
        }
      }
      for (const at of spaced) if (out.length) out[at % out.length] = JSON.stringify(JSON.parse(out[at % out.length]!), null, 0).replace(/,"/g, ', "');
      for (const [at, value] of unknownLines) out.splice(1 + (at % out.length), 0, JSON.stringify({ type: "x-unknown", ...value }));
      if (broken !== null) out.splice(1 + (broken % out.length), 0, "{not json");
      for (const at of blank) out.splice(1 + (at % out.length), 0, "");
      const eol = crlf ? "\r\n" : "\n";
      return out.join(eol) + (finalNewline ? eol : "");
    });
}


/**
 * Noise for a JSON document of records (`{..., [items]: [...]}`): unknown record types and fields, another
 * indentation, a missing final newline, or text that is not JSON at all.
 */
export function noisyJsonDocument(text: string, items: string): fc.Arbitrary<string> {
  return fc
    .record({
      unknownItems: fc.array(fc.tuple(fc.nat(), arbitraryJsonObject), { maxLength: 2 }),
      extraFields: fc.array(fc.tuple(fc.nat(), fc.string({ maxLength: 6 }), arbitraryJson), { maxLength: 2 }),
      indent: fc.constantFrom<number | string>(2, 2, 2, 0, 4, "\t"),
      finalNewline: fc.boolean(),
      broken: fc.boolean().map((b) => b && Math.random() < 0.1),
    })
    .map(({ unknownItems, extraFields, indent, finalNewline, broken }) => {
      if (broken) return text.slice(0, Math.max(1, Math.floor(text.length / 2)));
      const doc = JSON.parse(text);
      const list: unknown[] = doc[items];
      for (const [at, field, value] of extraFields) {
        const item = list[at % Math.max(list.length, 1)] as Record<string, unknown> | undefined;
        if (item && typeof item === "object" && !(field in item)) item[field] = value;
      }
      for (const [at, value] of unknownItems) list.splice(at % (list.length + 1), 0, { type: "x-unknown", ...value });
      return JSON.stringify(doc, null, indent) + (finalNewline ? "\n" : "");
    });
}
