import { sha256 } from "./canonical.ts";
import { REFERENCE_FIELDS, addIntegrity } from "./integrity.ts";
import { isTreeRecord, type EntryRecord, type Transcript, type TranscriptHeader, type TreeRecord } from "./types.ts";

/**
 * Linearizing a transcript (SPEC.md, Linearization): every branch on one path, so an agent continuing it sees what
 * every branch did, word for word.
 *
 * Reconciling copies of a session keeps each copy's turns as a sibling branch (SPEC §18), and an agent continuing
 * it sees only the branch its leaf is on. Linearizing writes every tree record once, one after the other, turn by
 * turn: a turn starts at a root, at a user message, or at a branch, and runs down its only child until the next one.
 * Turns follow their parent turn, earliest first, except that a branch starting mid-turn (another answer to the same
 * prompt) comes right after the turn it branched from. Each record's parent becomes the record before it.
 *
 * The result is a new transcript, forked from the source: its records keep their ids and content, but not their
 * parents, so they are not the source's records, and the native ones they were read from no longer describe them.
 */

export interface LinearizeResult {
  transcript: Transcript;
  /** How many branch tips the source had: 1 for a source that was already linear. */
  branches: number;
}

const DOMAIN = "atxf/0.1/linearize\n";

export function linearize(source: Transcript): LinearizeResult {
  const tree = source.records.filter(isTreeRecord);
  const position = new Map(tree.map((record, index) => [record.id, index]));
  const children = new Map<string | null, TreeRecord[]>();
  for (const record of tree) {
    // A parent the transcript does not hold (a dangling reference) makes the record a root, as SPEC §4 reads it.
    const parent = record.parentId !== null && position.has(record.parentId) ? record.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), record]);
  }
  const branches = tree.filter((record) => !children.has(record.id)).length;

  const turns = linearTurns(children, position);
  const ordered: TreeRecord[] = [];
  for (const turn of turns) ordered.push(...turn);

  let previous: string | null = null;
  const records: EntryRecord[] = ordered.map((record) => {
    const { hash: _, native: __, ...rest } = record;
    const linear = { ...rest, parentId: previous } as TreeRecord;
    previous = record.id;
    return linear;
  });
  // Where the leaf was and the seal over the source's records describe the source, not the linear transcript.
  for (const record of source.records) {
    if (isTreeRecord(record) || record.type === "leaf" || record.type === "seal") continue;
    const { hash: _, native: __, ...rest } = record;
    records.push(rest as EntryRecord);
  }

  const header = linearHeader(source.header, ordered);
  const transcript: Transcript = { header, records };
  return { transcript: source.header.integrity ? addIntegrity(transcript) : transcript, branches };
}

/**
 * The turns of a tree in the order they are written. A record also waits for the records it references (an edit's
 * target, a summary's branch): its turn is cut there, and the rest waits. This never deadlocks, since the source's
 * file order puts every parent and reference first, so the earliest record not yet written is always ready.
 */
function linearTurns(children: Map<string | null, TreeRecord[]>, position: Map<string, number>): TreeRecord[][] {
  const written = new Set<string>();
  const referencesWritten = (record: TreeRecord) =>
    REFERENCES.every((field) => {
      const id = (record as unknown as Record<string, unknown>)[field];
      return typeof id !== "string" || !position.has(id) || written.has(id);
    });
  // A piece is a turn, or the rest of one, from `head` down its only child until the next turn starts.
  const continues = (head: TreeRecord) => (position.has(head.parentId ?? "") && !startsTurn(head) ? 0 : 1);
  // Another answer to the same prompt (a branch mid-turn) first, then the earliest piece, then file order.
  const compare = (a: TreeRecord, b: TreeRecord) => continues(a) - continues(b) || cmp(timeOf(a.time), timeOf(b.time)) || position.get(a.id)! - position.get(b.id)!;

  let pending: TreeRecord[] = [...(children.get(null) ?? [])];
  const out: TreeRecord[][] = [];
  while (pending.length > 0) {
    const ready = pending.filter(referencesWritten).sort(compare);
    // A source whose references point forward (not valid) still linearizes: its earliest piece goes first.
    const head = ready[0] ?? [...pending].sort((a, b) => position.get(a.id)! - position.get(b.id)!)[0]!;
    pending = pending.filter((record) => record !== head);
    const turn: TreeRecord[] = [];
    for (let record: TreeRecord | undefined = head; record !== undefined; ) {
      turn.push(record);
      written.add(record.id);
      const next: TreeRecord[] = children.get(record.id) ?? [];
      record = undefined;
      if (next.length === 1 && !startsTurn(next[0]!) && referencesWritten(next[0]!)) record = next[0];
      else pending.push(...next);
    }
    out.push(turn);
  }
  return out;
}

/** The fields that name another record, beside `parentId` (SPEC §17.1). */
const REFERENCES = REFERENCE_FIELDS.filter((field) => field !== "parentId");

/** A user message starts a turn; so does any record after a branch, which `linearTurns` checks itself. */
const startsTurn = (record: TreeRecord) => record.type === "message" && record.role === "user";

/** As reconciling orders records: a time that does not parse comes first. */
function timeOf(time: string): number {
  const millis = Date.parse(time);
  return Number.isNaN(millis) ? -Infinity : millis;
}

const cmp = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The linear transcript's header: a new id, forked from the source, with no native session of its own yet. Fields
 * keep their place, and new ones go last, so the Rust port writes the same bytes.
 */
function linearHeader(source: TranscriptHeader, ordered: readonly TreeRecord[]): TranscriptHeader {
  const header = { ...source } as TranscriptHeader & Record<string, unknown>;
  delete header.hash;
  delete header.native;
  header.id = uuidFrom(sha256(`${DOMAIN}${source.id}\n${ordered.map((record) => record.id).join("\n")}`));
  const agent = { ...source.source };
  delete agent.sessionId;
  header.source = agent;
  header.parent = { transcriptId: source.id, relation: "fork" };
  const fidelity = { ...source.fidelity };
  delete fidelity.nativeDigest;
  delete fidelity.native;
  fidelity.topology = "linearized";
  header.fidelity = fidelity;
  return header;
}

/** A UUID (version 8, RFC 9562) made of the first bytes of a hex digest, so the id is deterministic. */
function uuidFrom(hex: string): string {
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
