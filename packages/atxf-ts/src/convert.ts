import type { AtxfRecord, EntryRecord, Transcript, TranscriptHeader } from "./types.ts";

/**
 * A converter between one agent's native session format and ATXF.
 *
 * Both directions are lossless (SPEC §11): `fromAtxf(toAtxf(x))` reproduces `x` byte for byte, and
 * `toAtxf(fromAtxf(t))` returns `t` for any transcript, because a file written for another agent's transcript
 * carries that transcript along. See `defineConverter`.
 */
export interface Converter {
  /** The agent name used in `source.agent` and `native.source`, e.g. `pi`. */
  agent: string;
  /** The native format identifier, e.g. `pi/session-jsonl`. */
  format: string;
  /** Parses native session text into a transcript. Records are hashed (SPEC §17) unless `integrity` is false. */
  toAtxf(text: string, options?: { integrity?: boolean }): Transcript;
  /**
   * Writes a transcript as native session text. With `carry: false`, writes only the agent's own records for the
   * active context, without marks or the carried transcript: a clean file that no longer round-trips.
   */
  fromAtxf(transcript: Transcript, options?: FromAtxfOptions): string;
  /**
   * Reads a native file one line at a time, as the agent appends to it. Present for line-framed formats whose
   * records never change once written.
   */
  stream?(options?: { integrity?: boolean }): TranscriptStream;
  /** Whether `fromAtxf` can write the whole tree (`carry: false, tree: true`), keeping what native held (SPEC §11.2). */
  readonly tree?: boolean;
}

/**
 * A native file read as the agent writes it. Each record is final when it is returned: pushing a file's lines one
 * by one returns the records `toAtxf` returns for the whole file, in order, and `header` is `toAtxf`'s header
 * without `fidelity.nativeDigest`, which only a finished file has. Records are hashed against that header, so a
 * stream's hashes are its own and stay the same however long the file grows. A stream keeps the ids and hashes it
 * needs to resolve later references, never the records, so it reads a file of any length.
 */
export interface TranscriptStream {
  /** The header, once the first line has been read. */
  readonly header: TranscriptHeader | undefined;
  /**
   * Reads the next line, without its newline, and returns the records it adds: none for a line the header took or
   * a blank one. Never throws for what a line holds: a line that is not JSON, or has no ATXF form, becomes a custom
   * record that writes it back (SPEC §11.2), and text holding several lines is read a line at a time. A line
   * carrying a transcript, as `fromAtxf` writes it, is read as the entry it is, not as the transcript: only
   * `toAtxf` reads the carried transcript, with the rest of its file.
   */
  push(line: string): EntryRecord[];
}

export interface FromAtxfOptions {
  /** Write marks and the carried transcript, so the file reads back as the same transcript. Default true. */
  carry?: boolean;
  /**
   * With `carry: false`, write every record, branches and compacted history included, rather than the active
   * context alone, for formats that can hold a tree. Default false. A converter that keeps what native records hold
   * beyond ATXF's fields in `ext` (SPEC §11.2) writes a file equal to the original as JSON, entry by entry.
   */
  tree?: boolean;
  /**
   * The id of the native session the file will be loaded as, when that is not the transcript's own session, e.g.
   * when an agent replaces one of its sessions with a shared transcript. Formats whose ids must be unique across
   * sessions derive their ids from it. Default: the transcript's `source.sessionId`, else its id.
   */
  sessionId?: string;
}

/** A copy of the transcript without native passthrough, as if it came from another agent. */
export function stripNative(transcript: Transcript): Transcript {
  const strip = <T extends AtxfRecord>(record: T): T => {
    if (!("native" in record) || record.native === undefined) return record;
    const { native: _, ...rest } = record;
    return rest as T;
  };
  const header = strip(transcript.header);
  return {
    header: { ...header, fidelity: { ...header.fidelity, native: "none" } },
    records: transcript.records.map((record) => strip(record) as EntryRecord),
  };
}

/** True when this record carries native records from `agent`. */
export function hasNative(record: AtxfRecord, agent: string): boolean {
  return record.native !== undefined && record.native.source === agent && record.native.records.length > 0;
}

/** Milliseconds since the epoch as an RFC 3339 timestamp. */
export function isoFromMillis(ms: number): string {
  return new Date(ms).toISOString();
}

export function millisFromIso(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Builds ids that never collide within one transcript. */
export class IdAllocator {
  private used = new Set<string>();
  constructor(existing: Iterable<string> = []) {
    for (const id of existing) this.used.add(id);
  }
  /** `preferred` when free, otherwise `preferred-2`, `preferred-3`, … */
  take(preferred: string): string {
    let id = preferred;
    for (let n = 2; this.used.has(id); n++) id = `${preferred}-${n}`;
    this.used.add(id);
    return id;
  }
}
