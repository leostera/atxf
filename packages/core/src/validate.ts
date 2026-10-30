import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { verifyIntegrity } from "./integrity.ts";
import { TREE_TYPES, type EntryRecord, type TranscriptHeader } from "./types.ts";
import schema from "../../../schema/v0.1/atxf.schema.json" with { type: "json" };

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  /** 1-based line number in the JSONL input; 0 for whole-file problems. */
  line: number;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
}

type JsonRecord = { type: string; id: string; [key: string]: unknown };

const ajv = new Ajv2020({ allErrors: false, strict: false });
addFormats(ajv);
const validateRecord = ajv.compile(schema);


/**
 * Validates one ATXF transcript (JSONL text): each line against the JSON Schema, then the
 * cross-record invariants from SPEC.md that a per-line schema cannot express.
 */
export function validateTranscript(text: string): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  const error = (line: number, message: string) => diagnostics.push({ severity: "error", line, message });
  const warn = (line: number, message: string) => diagnostics.push({ severity: "warning", line, message });

  const records = parseLines(text, error);
  if (records.length === 0) {
    error(0, "transcript is empty");
    return finish(diagnostics);
  }

  for (const { line, record } of records) {
    if (!validateRecord(record)) {
      const detail = (validateRecord.errors ?? [])
        .map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`)
        .join("; ");
      error(line, `schema: ${detail}`);
    }
  }
  if (diagnostics.length > 0) return finish(diagnostics);

  checkReferences(records, error, warn);
  if (diagnostics.some((d) => d.severity === "error")) return finish(diagnostics);
  checkIntegrity(records, error, warn);
  return finish(diagnostics);
}

/** Hashes and seals (SPEC.md, Integrity). Runs only on a structurally valid transcript. */
function checkIntegrity(
  records: { line: number; record: JsonRecord }[],
  error: (line: number, message: string) => void,
  warn: (line: number, message: string) => void,
) {
  const [header, ...rest] = records;
  if (!(header!.record as { integrity?: unknown }).integrity) {
    for (const { line, record } of rest) {
      if (record.hash !== undefined) warn(line, "record has a `hash` but the header does not declare `integrity`; it is not checked");
    }
  }
  const problems = verifyIntegrity({
    header: header!.record as unknown as TranscriptHeader,
    records: rest.map(({ record }) => record as unknown as EntryRecord),
  });
  for (const { index, message } of problems) error(index === -1 ? header!.line : rest[index]!.line, `integrity: ${message}`);
}

function parseLines(text: string, error: (line: number, message: string) => void) {
  const records: { line: number; record: JsonRecord }[] = [];
  text.split("\n").forEach((raw, index) => {
    if (raw.trim() === "") return;
    try {
      records.push({ line: index + 1, record: JSON.parse(raw) });
    } catch (cause) {
      error(index + 1, `invalid JSON: ${(cause as Error).message}`);
    }
  });
  return records;
}

function checkReferences(
  records: { line: number; record: JsonRecord }[],
  error: (line: number, message: string) => void,
  warn: (line: number, message: string) => void,
) {
  const [header, ...rest] = records;
  if (header!.record.type !== "transcript") error(header!.line, "first record must be `transcript`");

  // Tree nodes seen so far, mapped to their parent, so every reference must point backwards.
  const parents = new Map<string, string | null>();
  const nodes = new Map<string, JsonRecord>();
  const ids = new Set<string>();
  const toolCallOwner = new Map<string, string>();

  const ancestors = (id: string | null): Set<string> => {
    const seen = new Set<string>();
    for (let cursor = id; cursor !== null && cursor !== undefined; cursor = parents.get(cursor) ?? null) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
    }
    return seen;
  };
  const requireNode = (line: number, field: string, id: unknown) => {
    if (typeof id === "string" && !nodes.has(id)) error(line, `${field} \`${id}\` does not reference an earlier tree record`);
  };

  for (const { line, record } of rest) {
    if (record.type === "transcript") {
      error(line, "`transcript` header must appear exactly once, on the first line");
      continue;
    }
    if (ids.has(record.id)) error(line, `duplicate id \`${record.id}\``);
    ids.add(record.id);

    if (TREE_TYPES.has(record.type)) {
      const parentId = record.parentId as string | null;
      requireNode(line, "parentId", parentId);
      parents.set(record.id, parentId);
      nodes.set(record.id, record);
    }

    switch (record.type) {
      case "message":
        checkMessage(line, record, ancestors, toolCallOwner, error, warn);
        break;
      case "compaction":
        if (record.strategy === "summary" && typeof record.firstKeptId === "string") {
          requireNode(line, "firstKeptId", record.firstKeptId);
          if (!ancestors(record.parentId as string | null).has(record.firstKeptId)) {
            error(line, `firstKeptId \`${record.firstKeptId}\` must be an ancestor of the compaction`);
          }
        }
        break;
      case "context_edit":
        requireNode(line, "targetId", record.targetId);
        if (nodes.get(record.targetId as string)?.type !== "message") {
          error(line, "context_edit targetId must reference a `message`");
        }
        break;
      case "branch_summary":
        requireNode(line, "fromId", record.fromId);
        break;
      case "tool_status":
        if (!toolCallOwner.has(record.toolCallId as string)) {
          warn(line, `tool_status references unknown toolCallId \`${record.toolCallId}\``);
        }
        break;
      case "leaf":
        requireNode(line, "targetId", record.targetId);
        requireNode(line, "restoreCheckpointId", record.restoreCheckpointId);
        if (record.restoreCheckpointId && nodes.get(record.restoreCheckpointId as string)?.type !== "checkpoint") {
          error(line, "restoreCheckpointId must reference a `checkpoint`");
        }
        break;
      case "label":
        requireNode(line, "targetId", record.targetId);
        break;
      case "seal":
        break;
    }
  }
}

function checkMessage(
  line: number,
  record: JsonRecord,
  ancestors: (id: string | null) => Set<string>,
  toolCallOwner: Map<string, string>,
  error: (line: number, message: string) => void,
  warn: (line: number, message: string) => void,
) {
  if (record.role === "assistant") {
    for (const block of record.content as { type: string; id?: string }[]) {
      if (block.type !== "tool_call") continue;
      if (toolCallOwner.has(block.id!)) error(line, `duplicate tool_call id \`${block.id}\``);
      toolCallOwner.set(block.id!, record.id);
    }
  }
  if (record.role === "tool") {
    const owner = toolCallOwner.get(record.toolCallId as string);
    if (owner === undefined) {
      warn(line, `tool result references unknown toolCallId \`${record.toolCallId}\``);
    } else if (!ancestors(record.parentId as string | null).has(owner)) {
      error(line, `tool result \`${record.toolCallId}\` is not on the same branch as its call`);
    }
  }
}

function finish(diagnostics: Diagnostic[]): ValidationResult {
  return { ok: !diagnostics.some((d) => d.severity === "error"), diagnostics };
}
