import type { DecodeContext } from "./codec.ts";
import { indexTree } from "./tree.ts";
import { isTreeRecord, type EntryRecord, type Native, type TreeRecord } from "./types.ts";

/** Shared bookkeeping for format decoders: ids, references and the tree built so far. */

export type J = Record<string, any>;

export function isObject(value: unknown): value is J {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** `value` when it is an RFC 3339 timestamp, otherwise `fallback`. */
export function isoTime(value: unknown, fallback: string): string {
  if (typeof value === "string" && RFC3339.test(value) && !Number.isNaN(Date.parse(value))) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime()) && date.getUTCFullYear() >= 1970 && date.getUTCFullYear() < 10000) {
      return date.toISOString();
    }
  }
  return fallback;
}

export const EPOCH = "1970-01-01T00:00:00.000Z";

/**
 * Tracks the records a decoder has produced, so references can be resolved and checked. Native ids map to the
 * ATXF tree record they resolve to: a tree record maps to itself; an annotation, or a unit written by `encode`
 * without a single counterpart, maps to the record its parent resolves to.
 */
export class TreeBuilder {
  readonly records: EntryRecord[] = [];
  private readonly resolved = new Map<string, string | null>();
  private readonly parents = new Map<string, string | null>();
  private readonly types = new Map<string, string>();
  private readonly toolCalls = new Map<string, string>();
  /** The last tree record, in file order: the parent for formats without explicit parent links. */
  last: string | null = null;

  constructor(readonly context: DecodeContext) {
    for (const record of context.base?.records ?? []) this.observe(record);
    // A continuation picks up where the carried transcript is: its active leaf.
    if (context.base) this.last = indexTree(context.base).activeLeaf;
  }

  private observe(record: EntryRecord) {
    if (isTreeRecord(record)) {
      this.parents.set(record.id, record.parentId);
      this.types.set(record.id, record.type);
      this.last = record.id;
    }
    if (record.type === "message" && record.role === "assistant") {
      for (const block of record.content) if (block.type === "tool_call") this.toolCalls.set(block.id, record.id);
    }
  }

  /** Map a native id to the ATXF tree record it resolves to. */
  alias(nativeId: unknown, atxfId: string | null) {
    if (typeof nativeId === "string") this.resolved.set(nativeId, atxfId);
  }

  /** The ATXF tree record a native reference points to, or `null` when unknown. */
  resolve(nativeId: unknown): string | null {
    if (typeof nativeId !== "string") return null;
    return this.resolved.get(nativeId) ?? null;
  }

  /** Whether `nativeId` has been seen, even if it resolves to no record. */
  knows(nativeId: unknown): boolean {
    return typeof nativeId === "string" && this.resolved.has(nativeId);
  }

  isNode(id: string | null | undefined): id is string {
    return typeof id === "string" && this.parents.has(id);
  }

  typeOf(id: string): string | undefined {
    return this.types.get(id);
  }

  isAncestor(ancestor: string, of: string | null): boolean {
    const seen = new Set<string>();
    for (let cursor = of; cursor !== null && cursor !== undefined && !seen.has(cursor); cursor = this.parents.get(cursor) ?? null) {
      if (cursor === ancestor) return true;
      seen.add(cursor);
    }
    return false;
  }

  /** The assistant message that issued tool call `id`, if any. */
  toolCallOwner(id: string): string | undefined {
    return this.toolCalls.get(id);
  }

  hasToolCall(id: string): boolean {
    return this.toolCalls.has(id);
  }

  push<R extends EntryRecord>(record: R, native?: Native): R {
    const full = (native ? { ...record, native } : record) as R;
    this.records.push(full);
    this.observe(full);
    return full;
  }
}

/** Keeps the keys of `value` whose values are not `undefined`. */
export function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function isTree(record: EntryRecord): record is TreeRecord {
  return isTreeRecord(record);
}
