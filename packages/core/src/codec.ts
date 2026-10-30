import { IdAllocator, type Converter } from "./convert.ts";
import { addIntegrity } from "./integrity.ts";
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
  /** The format's records for the transcript's active context, each with the ATXF record id it stands for. */
  encode(transcript: Transcript): Encoded[];
  carrier: Carrier;
}

export interface Encoded {
  value: unknown;
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
      const transcript = { header: decoded.header, records: decoded.records };
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

  const fromAtxf = (transcript: Transcript, options: { carry?: boolean } = {}): string => {
    const carry = options.carry ?? true;
    if (carry && isPureNative(transcript, spec.agent)) return spec.framing.print(nativeUnits(transcript, spec.framing.canonical));
    const encoded = spec.encode(transcript);
    const values = carry
      ? spec.carrier.attach(
          encoded.map(({ value, source }) => spec.carrier.mark(value, source)),
          transcript,
        )
      : encoded.map(({ value }) => value);
    return spec.framing.print(values.map((value) => ({ value, raw: spec.framing.canonical(value) })));
  };

  return { agent: spec.agent, format: spec.format, toAtxf, fromAtxf };
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
