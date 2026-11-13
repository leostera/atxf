import { IdAllocator, type Converter, type FromAtxfOptions, type StreamOptions, type StreamState, type TranscriptStream } from "./convert.ts";
import { canonicalJson, sha256 } from "./canonical.ts";
import { addIntegrity, TranscriptHasher, type HasherState } from "./integrity.ts";
import { indexTree } from "./tree.ts";
import { isPureNative, nativeUnits, type Framing, type Unit } from "./native.ts";
import type { EntryRecord, Transcript, TranscriptHeader } from "./types.ts";

/**
 * Builds a lossless converter from a format's pieces (SPEC §11.1).
 *
 * - **Native in, native out.** `decode` puts every unit of a source file into exactly one record's `native`. A
 *   transcript that still holds only this format's native records is written back from them, byte for byte.
 * - **Anything else out.** `encode` writes the format's own records for the transcript's active context, so the
 *   agent can continue it. Each written record is marked with the ATXF id it stands for, and the whole transcript
 *   rides along in a carrier the agent ignores.
 * - **Carried transcript in.** Reading such a file returns the carried transcript unchanged. Records without a
 *   marker were appended by the agent afterwards; they are decoded and attached through the markers.
 */
export interface FormatSpec {
  agent: string;
  format: string;
  framing: Framing;
  /**
   * Native units to ATXF. Units in `context.known` were written by `encode` and are already in the carried
   * transcript: skip them, but resolve references to them through their ATXF ids. Every other unit MUST end up in
   * exactly one returned record's `native`, in order.
   */
  decode(units: Unit[], context: DecodeContext): { header: TranscriptHeader; records: EntryRecord[] };
  /**
   * The format's records for the transcript's active context, each with the ATXF record id it stands for.
   * `options.sessionId` is the native session the records will be loaded as (see `FromAtxfOptions`).
   */
  encode(transcript: Transcript, options: { sessionId?: string }): Encoded[];
  /**
   * Every record of the transcript, in file order, for formats that can hold a tree (`carry: false, tree: true`).
   * A record read from this format is written as the entry it was read from, restored with what it keeps in
   * `ext.<agent>.patch` (SPEC §11.2).
   */
  encodeTree?(transcript: Transcript): Encoded[];
  carrier: Carrier;
  /**
   * Reads units one at a time, holding no records, for line-framed formats whose records never change once
   * written. With it, the converter can `stream`. `decode` should read through the same reader, so the two agree.
   */
  reader?(context: DecodeContext): FormatReader;
  /**
   * The version of the reader's state (`FormatReader.state`), for a stream that is saved and resumed. It names the
   * format and changes whenever reading does, so a state saved by another version is refused, not misread.
   */
  streamState?: string;
}

/** A format's decoder, one unit at a time. */
export interface FormatReader {
  /** Starts the transcript from the file's first unit, which the header may take (`took`). */
  start(first: Unit | undefined): { header: TranscriptHeader; took: boolean };
  /** The record for the unit at `index` in the file, or `undefined` for a unit in `context.known`. */
  next(unit: Unit, index: number): EntryRecord | undefined;
  /** What the reader knows after the units it has read, as JSON; for formats with `streamState`. */
  state?(): unknown;
  /** Picks up from `state`, for a transcript whose header is `header`. Throws when `state` is not one. */
  restore?(state: unknown, header: TranscriptHeader): void;
}

export interface Encoded {
  value: unknown;
  /** The exact line, without its newline, for a value that cannot be printed (a line that was not JSON). */
  raw?: string;
  /** The ATXF record this native record stands for, or `null` for one with no single counterpart. */
  source: string | null;
}

export interface Carrier {
  mark(value: unknown, source: string | null): unknown;
  /** The mark's ATXF id, `null` for a mark without one, `undefined` for an unmarked record. */
  markOf(value: unknown): string | null | undefined;
  /** Add the carried transcript to the encoded (and marked) records. */
  attach(values: unknown[], transcript: Transcript): unknown[];
  /** Find the carried transcript and return the units without it. */
  detach(units: Unit[]): { transcript: Transcript; units: Unit[] } | undefined;
}

export interface DecodeContext {
  /** Unit index → ATXF id of a unit written by `encode` (`null` when it stands for no single record). */
  known: ReadonlyMap<number, string | null>;
  /** The carried transcript, when continuing one. */
  base?: Transcript;
  /** Allocates record ids, already holding the carried transcript's ids. */
  ids: IdAllocator;
}

export interface ConvertOptions {
  /** Hash records read from native files (SPEC §17). Default true. */
  integrity?: boolean;
}

export function defineConverter(spec: FormatSpec, defaults: ConvertOptions = {}): Converter {
  const toAtxf = (text: string, options: ConvertOptions = {}): Transcript => {
    const integrity = options.integrity ?? defaults.integrity ?? true;
    const units = spec.framing.parse(text);
    const carried = spec.carrier.detach(units);
    if (!carried) {
      const decoded = spec.decode(units, { known: new Map(), ids: new IdAllocator() });
      const header = { ...decoded.header, fidelity: { ...decoded.header.fidelity, nativeDigest: nativeDigest(text) } };
      const transcript = { header, records: decoded.records };
      return integrity ? addIntegrity(transcript) : transcript;
    }
    const base = carried.transcript;
    const known = new Map<number, string | null>();
    carried.units.forEach((unit, index) => {
      const mark = spec.carrier.markOf(unit.value);
      if (mark !== undefined) known.set(index, mark);
    });
    if (known.size === carried.units.length) return base;
    // The last record the encoder wrote stands for where the transcript is now: whatever the agent appended after
    // it continues from the active leaf, which may lie past the last context message (a trailing edit or event).
    const last = Math.max(...known.keys());
    if (Number.isFinite(last)) known.set(last, indexTree(base).activeLeaf);
    const ids = new IdAllocator(base.records.map((record) => record.id));
    const decoded = spec.decode(carried.units, { known, base, ids });
    const transcript = { header: base.header, records: [...base.records, ...decoded.records] };
    return base.header.integrity ? addIntegrity(transcript) : transcript;
  };

  const fromAtxf = (transcript: Transcript, options: FromAtxfOptions = {}): string => {
    const carry = options.carry ?? true;
    // Native records hold the ids of the session they were read from, so they stand for the transcript only when
    // the file is loaded as that same session.
    const sameSession = options.sessionId === undefined || options.sessionId === transcript.header.source.sessionId;
    if (carry && sameSession && isPureNative(transcript, spec.agent)) {
      // Native records alone stand for the transcript only if reading them back gives it: a reconciled transcript
      // (SPEC §18) holds only native records too, but its branches may not fit one file of a linear format. Reading
      // is deterministic, so printing the very file the transcript was read from is enough, and checking that costs
      // one digest. A transcript without the digest is read back and compared instead.
      const text = spec.framing.print(nativeUnits(transcript, spec.framing.canonical));
      const digest = transcript.header.fidelity?.nativeDigest;
      if (digest !== undefined ? digest === nativeDigest(text) : sameRecords(toAtxf(text, { integrity: false }), transcript)) return text;
    }
    if (!carry && options.tree && spec.encodeTree) {
      const units = spec.encodeTree(transcript).map(({ value, raw }) => ({ value, raw: raw === undefined ? spec.framing.canonical(value) : `${raw}\n` }));
      return spec.framing.print(units);
    }
    const encoded = spec.encode(transcript, { sessionId: options.sessionId });
    const values = carry
      ? spec.carrier.attach(
          encoded.map(({ value, source }) => spec.carrier.mark(value, source)),
          transcript,
        )
      : encoded.map(({ value }) => value);
    return spec.framing.print(values.map((value) => ({ value, raw: spec.framing.canonical(value) })));
  };

  const reader = spec.reader;
  const stream =
    reader &&
    ((options: StreamOptions = {}): TranscriptStream => {
      const resume = options.resume === undefined ? undefined : parseStreamState(options.resume, spec.streamState);
      const integrity = resume?.integrity ?? options.integrity ?? defaults.integrity ?? true;
      const read = reader({ known: new Map(), ids: new IdAllocator() });
      let header: TranscriptHeader | undefined = resume?.header ?? undefined;
      let hasher: TranscriptHasher | undefined;
      let index = resume?.lines ?? 0;
      if (resume && header !== undefined) {
        read.restore!(resume.reader, header);
        if (integrity) hasher = TranscriptHasher.resume(header, resume.hasher!);
      }
      return {
        get header() {
          return hasher?.header ?? header;
        },
        state() {
          if (!spec.streamState || !read.state) throw new RangeError(`${spec.agent} streams cannot be saved`);
          return {
            stream: spec.streamState,
            integrity,
            lines: index,
            header: header ?? null,
            reader: header === undefined ? null : read.state(),
            hasher: hasher?.state() ?? null,
          };
        },
        push(line) {
          // Every line converts: a stream never refuses one, so a reader of a live file never stops. Blank lines
          // hold no record. A line carrying a transcript is read as the entry it is, the transcript kept with it.
          if (line.includes("\n")) return line.split("\n").flatMap((part) => this.push(part));
          if (line.trim() === "") return [];
          const unit = spec.framing.parse(`${line}\n`)[0]!;
          if (header === undefined) {
            const started = read.start(unit);
            header = started.header;
            if (integrity) hasher = new TranscriptHasher(header);
            if (started.took) {
              index += 1;
              return [];
            }
          }
          const record = read.next(unit, index);
          index += 1;
          if (record === undefined) return [];
          return [hasher ? hasher.push(record) : record];
        },
      };
    });

  return { agent: spec.agent, format: spec.format, toAtxf, fromAtxf, ...(stream ? { stream } : {}), ...(spec.encodeTree ? { tree: true } : {}) };
}

/** A saved stream, checked: refused when it is from another reader version or is not a stream state at all. */
function parseStreamState(value: StreamState, version: string | undefined) {
  const state = value as unknown as Record<string, unknown>;
  if (version === undefined) throw new RangeError("this converter's streams cannot be resumed");
  if (typeof state !== "object" || state === null || state.stream !== version) {
    throw new RangeError(`a stream state from another reader (${String(state?.stream)}; this one reads ${version})`);
  }
  const header = state.header === null ? undefined : (state.header as TranscriptHeader);
  const ok =
    typeof state.integrity === "boolean" &&
    Number.isInteger(state.lines) &&
    (state.lines as number) >= 0 &&
    (header === undefined ? state.lines === 0 && state.reader === null : typeof header === "object" && state.reader !== null) &&
    (state.integrity && header !== undefined ? isHasherState(state.hasher) : state.hasher === null);
  if (!ok) throw new RangeError("not a stream state");
  return { integrity: state.integrity as boolean, lines: state.lines as number, header, reader: state.reader, hasher: state.hasher as HasherState | null };
}

function isHasherState(value: unknown): value is HasherState {
  const h = value as HasherState;
  const ids = (list: unknown) => Array.isArray(list) && list.every((id) => typeof id === "string");
  return (
    typeof h === "object" &&
    h !== null &&
    Array.isArray(h.hashes) &&
    h.hashes.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string") &&
    ids(h.unreferenced) &&
    ids(h.forward) &&
    typeof h.chain === "string" &&
    Number.isInteger(h.count)
  );
}

/** The digest of a native file, recorded in `fidelity.nativeDigest` of the transcript read from it. */
export function nativeDigest(text: string): string {
  return `sha256:${sha256(text)}`;
}

/** Whether two transcripts hold the same header and records, ignoring hashes. Compares one record at a time. */
function sameRecords(a: Transcript, b: Transcript): boolean {
  if (a.records.length !== b.records.length) return false;
  // A streamed transcript has no digest of its file (see `TranscriptStream`); the digest is not content.
  const header = ({ hash: _h, integrity: _i, fidelity, ...rest }: TranscriptHeader) =>
    canonicalJson({ ...rest, fidelity: fidelity && { ...fidelity, nativeDigest: undefined } });
  if (header(a.header) !== header(b.header)) return false;
  const record = ({ hash: _, ...rest }: EntryRecord) => canonicalJson(rest);
  return a.records.every((r, i) => record(r) === record(b.records[i]!));
}

/** The carried transcript as one JSON value: the header and records, in order. */
export function carriedValue(transcript: Transcript): { header: TranscriptHeader; records: EntryRecord[] } {
  return { header: transcript.header, records: transcript.records };
}

/** Resolves references in a continuation: native ids of encoded records map to the ATXF ids they stand for. */
export class Aliases {
  private readonly map = new Map<string, string | null>();
  set(nativeId: string, atxfId: string | null) {
    this.map.set(nativeId, atxfId);
  }
  has(nativeId: string) {
    return this.map.has(nativeId);
  }
  get(nativeId: string): string | null | undefined {
    return this.map.get(nativeId);
  }
}
