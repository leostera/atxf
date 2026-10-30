import { canonicalJson, sha256 } from "./canonical.ts";
import type { EntryRecord, SealRecord, Transcript, TranscriptHeader } from "./types.ts";

/**
 * Record hashes (SPEC.md, Integrity).
 *
 * Every record's hash commits to its own content, to the header, and to the hash of every record it references.
 * Because references always point to earlier records, a writer can hash each record as it appends it, and a
 * record's hash transitively covers everything it depends on, like a Git commit.
 */

export type Hash = `sha256:${string}`;

/** Fields whose value is the id of an earlier tree record. Their targets' hashes go into the referencing hash. */
export const REFERENCE_FIELDS = ["parentId", "targetId", "fromId", "firstKeptId", "restoreCheckpointId"] as const;

export const INTEGRITY = { alg: "sha256", canon: "jcs" } as const;

const DOMAIN = {
  transcript: "atxf/0.1/transcript\n",
  content: "atxf/0.1/content\n",
  record: "atxf/0.1/record\n",
  chain: "atxf/0.1/chain\n",
} as const;

function digest(domain: string, text: string): Hash {
  return `sha256:${sha256(domain + text)}`;
}

function withoutHash<T extends { hash?: string }>(record: T): Omit<T, "hash"> {
  const { hash: _, ...rest } = record;
  return rest;
}

export function hashHeader(header: TranscriptHeader): Hash {
  return digest(DOMAIN.transcript, canonicalJson(withoutHash(header)));
}

/** Digest of a record's own fields. A proof carries this instead of the full record. */
export function contentDigest(record: EntryRecord): Hash {
  return digest(DOMAIN.content, canonicalJson(withoutHash(record)));
}

/** The reference fields present on a record, each mapped to the referenced record's id (or `null`). */
export function referencesOf(record: EntryRecord): Partial<Record<(typeof REFERENCE_FIELDS)[number], string | null>> {
  const refs: Partial<Record<(typeof REFERENCE_FIELDS)[number], string | null>> = {};
  for (const field of REFERENCE_FIELDS) {
    const value = (record as unknown as Record<string, unknown>)[field];
    if (typeof value === "string" || value === null) refs[field] = value;
  }
  return refs;
}

/** One step of a hash: what a verifier needs to recompute a record's hash without its content. */
export interface HashInput {
  transcript: Hash;
  content: Hash;
  /** Reference field → hash of the referenced record, or `null` for a null reference. */
  refs: Partial<Record<(typeof REFERENCE_FIELDS)[number], Hash | null>>;
}

export function hashFromInput(input: HashInput): Hash {
  return digest(DOMAIN.record, canonicalJson(input));
}

/** `resolve` maps a referenced id to that record's hash; it must know every earlier record. */
export function hashInput(record: EntryRecord, transcript: Hash, resolve: (id: string) => Hash | undefined): HashInput {
  const refs: HashInput["refs"] = {};
  for (const [field, id] of Object.entries(referencesOf(record))) {
    if (id === null) {
      refs[field as keyof HashInput["refs"]] = null;
      continue;
    }
    const target = resolve(id);
    if (target === undefined) throw new Error(`record \`${record.id}\`: ${field} \`${id}\` has no earlier hashed record`);
    refs[field as keyof HashInput["refs"]] = target;
  }
  return { transcript, content: contentDigest(record), refs };
}

export function hashRecord(record: EntryRecord, transcript: Hash, resolve: (id: string) => Hash | undefined): Hash {
  return hashFromInput(hashInput(record, transcript, resolve));
}

export function chainStep(previous: Hash, recordHash: Hash): Hash {
  return digest(DOMAIN.chain, `${previous}\n${recordHash}`);
}

/**
 * Incremental hasher for a transcript being written or read in file order. `push` returns the record with its
 * hash; `seal` returns the commitment to every record pushed so far.
 */
export class TranscriptHasher {
  readonly header: TranscriptHeader;
  readonly transcriptHash: Hash;
  private readonly hashes = new Map<string, Hash>();
  private readonly referenced = new Set<string>();
  private readonly dagIds: string[] = [];
  private chain: Hash;
  private count = 0;

  constructor(header: TranscriptHeader) {
    this.header = { ...header, integrity: INTEGRITY };
    this.transcriptHash = hashHeader(this.header);
    this.header.hash = this.transcriptHash;
    this.chain = this.transcriptHash;
  }

  hashOf(id: string): Hash | undefined {
    return this.hashes.get(id);
  }

  /** Hash the next record in file order. A seal is checked against the records before it. */
  push<R extends EntryRecord>(record: R): R & { hash: Hash } {
    const hash = hashRecord(record, this.transcriptHash, (id) => this.hashes.get(id));
    if (record.type !== "seal") {
      for (const id of Object.values(referencesOf(record))) if (id !== null && id !== undefined) this.referenced.add(id);
      this.dagIds.push(record.id);
    }
    this.hashes.set(record.id, hash);
    this.chain = chainStep(this.chain, hash);
    this.count += 1;
    return { ...record, hash };
  }

  /** The commitment a `seal` record appended now would carry. */
  commitment(): Pick<SealRecord, "count" | "chain" | "heads"> {
    const heads = this.dagIds
      .filter((id) => !this.referenced.has(id))
      .map((id) => this.hashes.get(id)!)
      .sort();
    return { count: this.count, chain: this.chain, heads };
  }

  seal(id: string, time: string): SealRecord & { hash: Hash } {
    return this.push({ type: "seal", id, time, ...this.commitment() });
  }
}

/** Return a copy of the transcript with `integrity` declared and every record hashed. Existing hashes are replaced. */
export function addIntegrity(transcript: Transcript, options: { seal?: { id: string; time: string } } = {}): Transcript {
  const hasher = new TranscriptHasher(withoutHash(transcript.header));
  const records: EntryRecord[] = [];
  for (const record of transcript.records) {
    const unhashed = withoutHash(record) as EntryRecord;
    // Seals depend on what precedes them, so they are recomputed rather than rehashed.
    records.push(unhashed.type === "seal" ? hasher.seal(unhashed.id, unhashed.time) : hasher.push(unhashed));
  }
  if (options.seal) records.push(hasher.seal(options.seal.id, options.seal.time));
  return { header: hasher.header, records };
}

export interface IntegrityProblem {
  /** Index into `transcript.records`, or -1 for the header. */
  index: number;
  message: string;
}

/** Check every hash and seal of a transcript whose header declares `integrity`. */
export function verifyIntegrity(transcript: Transcript): IntegrityProblem[] {
  const problems: IntegrityProblem[] = [];
  const { header } = transcript;
  if (!header.integrity) {
    transcript.records.forEach((record, index) => {
      if (record.type === "seal") problems.push({ index, message: "seal requires `integrity` in the header" });
    });
    return problems;
  }
  const hasher = new TranscriptHasher(withoutHash(header));
  if (header.hash !== hasher.transcriptHash) problems.push({ index: -1, message: "header hash does not match its content" });

  transcript.records.forEach((record, index) => {
    if (record.type === "seal") {
      const expected = hasher.commitment();
      if (record.count !== expected.count) problems.push({ index, message: `seal count is ${record.count}, expected ${expected.count}` });
      if (record.chain !== expected.chain) problems.push({ index, message: "seal chain does not match the records before it" });
      if (JSON.stringify(record.heads) !== JSON.stringify(expected.heads)) {
        problems.push({ index, message: "seal heads do not match the records before it" });
      }
    }
    let computed: Hash;
    try {
      computed = hasher.push(withoutHash(record) as EntryRecord).hash;
    } catch (error) {
      problems.push({ index, message: (error as Error).message });
      return;
    }
    if (record.hash === undefined) problems.push({ index, message: "missing hash; the header declares `integrity`" });
    else if (record.hash !== computed) problems.push({ index, message: "hash does not match the record's content and references" });
  });
  return problems;
}

/**
 * A proof that `record` is covered by `head`, a hash listed in a seal. `steps[0]` is the record's own hash input;
 * each later step is the hash input of a record that references the one before it, ending at the head. A verifier
 * needs only these digests, not the other records' content.
 */
export interface InclusionProof {
  record: EntryRecord;
  steps: HashInput[];
  head: Hash;
}

export function verifyInclusion(proof: InclusionProof): boolean {
  const [first, ...rest] = proof.steps;
  if (!first || first.content !== contentDigest(proof.record)) return false;
  let current = hashFromInput(first);
  for (const step of rest) {
    if (step.transcript !== first.transcript || !Object.values(step.refs).includes(current)) return false;
    current = hashFromInput(step);
  }
  return current === proof.head;
}

/** Build an inclusion proof for record `id`, walking forward through referencing records until a head. */
export function proveInclusion(transcript: Transcript, id: string): InclusionProof {
  const hasher = new TranscriptHasher(withoutHash(transcript.header));
  const inputs = new Map<string, HashInput>();
  const referencedBy = new Map<string, string>();
  const byId = new Map<string, EntryRecord>();
  for (const record of transcript.records) {
    const unhashed = withoutHash(record) as EntryRecord;
    inputs.set(record.id, hashInput(unhashed, hasher.transcriptHash, (ref) => hasher.hashOf(ref)));
    if (record.type === "seal") hasher.seal(record.id, record.time);
    else hasher.push(unhashed);
    byId.set(record.id, unhashed);
    if (record.type === "seal") continue;
    for (const ref of Object.values(referencesOf(unhashed))) {
      // The first referencing record is enough; any path to a head proves inclusion.
      if (ref && !referencedBy.has(ref)) referencedBy.set(ref, record.id);
    }
  }
  const record = byId.get(id);
  if (!record || record.type === "seal") throw new Error(`no hashable record \`${id}\``);
  const steps: HashInput[] = [];
  let cursor: string | undefined = id;
  while (cursor !== undefined) {
    steps.push(inputs.get(cursor)!);
    cursor = referencedBy.get(cursor);
  }
  return { record, steps, head: hashFromInput(steps.at(-1)!) };
}
