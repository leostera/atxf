import {
  REFERENCE_FIELDS,
  addIntegrity,
  canonicalJson,
  sha256,
  verifyIntegrity,
  type EntryRecord,
  type Hash,
  type IntegrityProblem,
  type Transcript,
  type TranscriptHeader,
} from "@atxf/core";

/**
 * Reconciling copies of one session (SPEC.md, Reconciliation; specs/reconcile.ts).
 *
 * Copies of a session diverge when it is continued in two places. Reconciling them is a union of their records,
 * keyed by a Merkle hash of each record: its content and the keys of the records it references, as in SPEC §17 but
 * without ids. Two records are the same record exactly when their keys are equal, so the union keeps every record of every copy
 * once, and divergent suffixes become sibling branches of the tree. The result does not depend on the order of the
 * copies or on how they are grouped, and reconciling a result again changes nothing.
 *
 * Ids only name records. Formats that number records by position (Codex, Gemini CLI) give two different records
 * the same id when two copies append at once. Of the records sharing an id, the one with the smallest hash keeps it
 * and the others are renamed `id~<hash prefix>`, with every reference to them rewritten.
 *
 * Records are written in a deterministic order: references first, then by time, then by hash. The active leaf is
 * then the one the last tree or leaf record in that order sets (SPEC §4), so copies with the same records always
 * show the same place: usually the latest step of either copy, and a rewind when the rewind is the latest event.
 */

export interface ReconcileOptions {
  /**
   * Hash the result and seal it. Default: when any copy declares integrity. The seal commits to the reconciled
   * records; the copies' own seals are dropped, since each commits to one copy's records and order.
   */
  integrity?: boolean;
}

export interface Renamed {
  id: string;
  /** The id the record has in the result. */
  as: string;
  /** The record's reconciliation key. */
  key: Hash;
}

export interface ReconcileResult {
  transcript: Transcript;
  /** Records that share an id with a different record, and the id each now has. */
  renamed: Renamed[];
  /** Hashes that did not verify, by copy index. The records are reconciled by content regardless. */
  problems: { copy: number; problems: IntegrityProblem[] }[];
}

interface Keyed {
  key: Hash;
  record: EntryRecord;
  /** Reference field → the referenced record's key. `native.of` is under `of`. */
  refs: Map<string, Hash | null>;
  time: number;
}

/** Reconcile copies of one session into one transcript that keeps every record of every copy. */
export function reconcile(copies: readonly Transcript[], options: ReconcileOptions = {}): ReconcileResult {
  if (copies.length === 0) throw new Error("reconcile needs at least one copy");
  const sessionId = copies[0]!.header.id;
  for (const copy of copies) {
    if (copy.header.id !== sessionId) throw new Error(`copies of different sessions: \`${sessionId}\` and \`${copy.header.id}\``);
  }

  const problems = copies.flatMap((copy, index) => {
    const found = copy.header.integrity ? verifyIntegrity(copy) : [];
    return found.length ? [{ copy: index, problems: found }] : [];
  });

  const byKey = new Map<Hash, Keyed>();
  for (const copy of copies) {
    for (const keyed of keyCopy(copy)) {
      // The same record may have different ids in different copies: an earlier reconciliation renamed it, or the
      // ids are positions. Keep the smallest, so the choice does not depend on the order of the copies; a record's
      // own id sorts before its renamed form `id~...`.
      const kept = byKey.get(keyed.key);
      if (kept === undefined || keyed.record.id < kept.record.id) byKey.set(keyed.key, keyed);
    }
  }

  const ordered = topologicalOrder([...byKey.values()]);
  const { ids, renamed } = assignIds(ordered);
  const records = ordered.map((keyed) => rewrite(keyed, ids));

  const transcript: Transcript = { header: pickHeader(copies), records };
  const integrity = options.integrity ?? copies.some((copy) => copy.header.integrity !== undefined);
  if (!integrity) return { transcript, renamed, problems };

  const keys = ordered.map((keyed) => keyed.key).sort();
  const last = ordered.at(-1)?.record.time ?? transcript.header.time;
  const seal = { id: `seal~${sha256(keys.join("\n")).slice(0, 12)}`, time: last };
  return { transcript: addIntegrity(transcript, { seal }), renamed, problems };
}

const DOMAIN = "atxf/0.1/reconcile\n";

/**
 * The reconciliation key of every record of a copy, except seals: a digest of the record's content without its id,
 * its hash or the ids it references, and of the keys of the records it references. It is the Merkle hash of SPEC
 * §17 with ids left out, so renaming a record changes neither its key nor any other record's, and copies whose ids
 * are positions (shifted by a line one copy lacks) still agree on their shared records.
 */
function keyCopy(copy: Transcript): Keyed[] {
  const keyOf = new Map<string, Hash>();
  const out: Keyed[] = [];
  copy.records.forEach((record, index) => {
    if (keyOf.has(record.id)) throw new Error(`a copy of \`${copy.header.id}\` has two records with id \`${record.id}\``);
    if (record.type === "seal") return;
    const unhashed = withoutHash(record);
    const content = { ...unhashed, id: "" } as unknown as Record<string, unknown>;
    const refs = new Map<string, Hash | null>();
    const resolve = (field: string, id: string) => {
      const key = keyOf.get(id);
      if (key === undefined) throw new Error(`a copy of \`${copy.header.id}\`, record ${index + 1}: ${field} \`${id}\` has no earlier record`);
      return key;
    };
    for (const field of REFERENCE_FIELDS) {
      const id = content[field];
      if (id === null) refs.set(field, null);
      else if (typeof id === "string") {
        refs.set(field, resolve(field, id));
        content[field] = "";
      }
    }
    const of = unhashed.native?.of;
    if (of !== undefined) {
      refs.set("of", resolve("native.of", of));
      content.native = { ...unhashed.native, of: "" };
    }
    const key: Hash = `sha256:${sha256(DOMAIN + canonicalJson({ content, refs: Object.fromEntries(refs) }))}`;
    keyOf.set(record.id, key);
    out.push({ key, record: unhashed, refs, time: timeOf(record.time) });
  });
  return out;
}

/** The reconciliation keys of a transcript's records. Two copies are in sync when their sets of keys are equal. */
export function reconciliationKeys(transcript: Transcript): Set<Hash> {
  return new Set(keyCopy(transcript).map((keyed) => keyed.key));
}

/** Whether two copies hold the same records, whatever their ids, order, hashes or seals. */
export function inSync(a: Transcript, b: Transcript): boolean {
  const [ka, kb] = [reconciliationKeys(a), reconciliationKeys(b)];
  return ka.size === kb.size && [...ka].every((key) => kb.has(key));
}

/**
 * References first; among the records whose references are all written, the earliest, then the smallest key.
 * Depends only on the set of records.
 */
function topologicalOrder(records: Keyed[]): Keyed[] {
  const waiting = new Map<Hash, number>();
  const dependents = new Map<Hash, Keyed[]>();
  for (const keyed of records) {
    const deps = new Set([...keyed.refs.values()].filter((ref): ref is Hash => ref !== null));
    waiting.set(keyed.key, deps.size);
    for (const dep of deps) {
      const list = dependents.get(dep) ?? [];
      list.push(keyed);
      dependents.set(dep, list);
    }
  }
  const before = (a: Keyed, b: Keyed) => a.time < b.time || (a.time === b.time && a.key < b.key);
  const ready = new MinHeap<Keyed>(before);
  for (const keyed of records) if (waiting.get(keyed.key) === 0) ready.push(keyed);
  const out: Keyed[] = [];
  for (let next = ready.pop(); next !== undefined; next = ready.pop()) {
    out.push(next);
    for (const dependent of dependents.get(next.key) ?? []) {
      const left = waiting.get(dependent.key)! - 1;
      waiting.set(dependent.key, left);
      if (left === 0) ready.push(dependent);
    }
  }
  // Every reference resolves within its own copy, so there is no cycle and nothing is left waiting.
  return out;
}

/** The smallest key keeps a shared id; the others get `id~<key prefix>`, long enough to be unique. */
function assignIds(records: Keyed[]): { ids: Map<Hash, string>; renamed: Renamed[] } {
  const byId = new Map<string, Hash[]>();
  for (const { key, record } of records) byId.set(record.id, [...(byId.get(record.id) ?? []), key]);
  const taken = new Set(byId.keys());
  const ids = new Map<Hash, string>();
  const renamed: Renamed[] = [];
  for (const [id, keys] of [...byId].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    keys.sort();
    ids.set(keys[0]!, id);
    for (const key of keys.slice(1)) {
      const hex = key.slice("sha256:".length);
      let length = 8;
      while (taken.has(`${id}~${hex.slice(0, length)}`)) length += 4;
      const as = `${id}~${hex.slice(0, length)}`;
      taken.add(as);
      ids.set(key, as);
      renamed.push({ id, as, key });
    }
  }
  return { ids, renamed };
}

/** The record with its id and references in the result's ids. */
function rewrite(keyed: Keyed, ids: Map<Hash, string>): EntryRecord {
  const record = { ...keyed.record, id: ids.get(keyed.key)! } as unknown as Record<string, unknown>;
  for (const [field, ref] of keyed.refs) {
    const id = ref === null ? null : ids.get(ref)!;
    if (field === "of") record.native = { ...(record.native as object), of: id };
    else record[field] = id;
  }
  return record as unknown as EntryRecord;
}

/** Copies may disagree on header fields; the result takes the same one whatever the order of the copies. */
function pickHeader(copies: readonly Transcript[]): TranscriptHeader {
  const headers = copies.map((copy) => {
    const { hash: _hash, integrity: _integrity, ...rest } = copy.header;
    return rest as TranscriptHeader;
  });
  return headers.map((header) => ({ header, text: canonicalJson(header) })).sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))[0]!.header;
}

function withoutHash(record: EntryRecord): EntryRecord {
  const { hash: _, ...rest } = record;
  return rest as EntryRecord;
}

/** Milliseconds since the epoch; a time that does not parse sorts first. */
function timeOf(time: string): number {
  const ms = Date.parse(time);
  return Number.isNaN(ms) ? -Infinity : ms;
}

class MinHeap<T> {
  private readonly items: T[] = [];
  constructor(private readonly before: (a: T, b: T) => boolean) {}

  push(item: T): void {
    const items = this.items;
    items.push(item);
    for (let i = items.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (!this.before(items[i]!, items[parent]!)) break;
      [items[i], items[parent]] = [items[parent]!, items[i]!];
      i = parent;
    }
  }

  pop(): T | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length === 0 || last === undefined) return top;
    items[0] = last;
    for (let i = 0; ; ) {
      const left = 2 * i + 1;
      const right = left + 1;
      let min = i;
      if (left < items.length && this.before(items[left]!, items[min]!)) min = left;
      if (right < items.length && this.before(items[right]!, items[min]!)) min = right;
      if (min === i) break;
      [items[i], items[min]] = [items[min]!, items[i]!];
      i = min;
    }
    return top;
  }
}
