import type { AtxfRecord, EntryRecord, Transcript } from "./types.ts";

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
  fromAtxf(transcript: Transcript, options?: { carry?: boolean }): string;
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
