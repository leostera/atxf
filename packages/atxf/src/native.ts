import type { Native, Transcript } from "./types.ts";

/**
 * One record of a source file: its parsed value and its exact text. Units are what native passthrough carries
 * (SPEC §11): every unit of a source file ends up in exactly one ATXF record's `native`, so writing the units back
 * in order reproduces the file byte for byte.
 */
export interface Unit {
  /** The parsed record, or `null` when the text is not valid JSON. */
  value: unknown;
  /** The exact source text, including the line terminator and any blank lines that follow. */
  raw: string;
}

/** How a format lays its records out in a file. */
export interface Framing {
  parse(text: string): Unit[];
  print(units: readonly Unit[]): string;
  /** The text this framing writes for a fresh record. A unit whose raw text differs keeps it in `native.raw`. */
  canonical(value: unknown): string;
}

/** The text `JSON.stringify` gives a JSONL record. A unit whose raw text differs keeps it in `native.raw`. */
export function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * JSON Lines. Blank lines and a missing final newline are kept in the raw text of the record before them; blank
 * lines before the first record are kept in its raw text too. A line that is not JSON becomes a unit with value
 * `null`, so even a damaged file round-trips.
 */
export const jsonl: Framing = {
  parse(text) {
    const units: Unit[] = [];
    let leading = "";
    for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      if (line.trim() === "") {
        if (units.length === 0) leading += line;
        else units[units.length - 1]!.raw += line;
        continue;
      }
      let value: unknown = null;
      try {
        value = JSON.parse(line);
      } catch {
        // Kept as raw text only.
      }
      units.push({ value, raw: leading + line });
      leading = "";
    }
    if (leading !== "") {
      // A file of only blank lines: keep them on an empty unit so they survive.
      units.push({ value: null, raw: leading });
    }
    return units;
  },
  print(units) {
    return units.map((unit) => unit.raw).join("");
  },
  canonical: jsonlLine,
};

/** A unit for a value written fresh, in the canonical layout. */
export function freshUnit(value: unknown): Unit {
  return { value, raw: jsonlLine(value) };
}

/** `native` for a group of units. `raw` is present only when some unit's text is not its canonical line. */
export function nativeOf(units: readonly Unit[], source: string, format?: string, canonical = jsonlLine): Native {
  const records = units.map((unit) => unit.value);
  const exact = units.some((unit) => unit.raw !== canonical(unit.value));
  return {
    source,
    ...(format ? { format } : {}),
    records,
    ...(exact ? { raw: units.map((unit) => unit.raw) } : {}),
  };
}

/** `native` for a record derived from the same units as the earlier record `of`. */
export function nativeOfShared(of: string, source: string, format?: string): Native {
  return { source, ...(format ? { format } : {}), records: [], of };
}

/** The units a `native` carries, rebuilding canonical text where it has no `raw`. */
export function unitsOfNative(native: Native, canonical = jsonlLine): Unit[] {
  return native.records.map((value, index) => ({ value, raw: native.raw?.[index] ?? canonical(value) }));
}

/**
 * True when the transcript came entirely from `agent` and still carries all of its native records, so the
 * source file can be reproduced from passthrough alone.
 */
export function isPureNative(transcript: Transcript, agent: string): boolean {
  const { header, records } = transcript;
  if (header.source.agent !== agent || header.fidelity?.native !== "all") return false;
  if (header.native !== undefined && header.native.source !== agent) return false;
  return records.every((record) => record.native?.source === agent);
}

/** The source units of a pure transcript, in file order: the header's first, then each record's. */
export function nativeUnits(transcript: Transcript, canonical = jsonlLine): Unit[] {
  const units: Unit[] = [];
  if (transcript.header.native) units.push(...unitsOfNative(transcript.header.native, canonical));
  for (const record of transcript.records) units.push(...unitsOfNative(record.native!, canonical));
  return units;
}

/**
 * A JSON document holding the records in one array, e.g. `{"info": {...}, "messages": [...]}`. The first unit is the
 * document without the array; each array element is a unit. A document in the canonical layout (`JSON.stringify`
 * with `indent`, the array key last, then `eol`) keeps no raw text; any other layout keeps the whole text on the
 * first unit. Text that is not such a document becomes a single unit with value `null`.
 */
export function jsonDocument(options: { items: string; indent: number | string; eol: string }): Framing {
  const build = (units: readonly Unit[]) => {
    const head = units[0]?.value;
    if (head === null || typeof head !== "object" || Array.isArray(head)) return undefined;
    return `${JSON.stringify({ ...head, [options.items]: units.slice(1).map((unit) => unit.value) }, null, options.indent)}${options.eol}`;
  };
  return {
    parse(text) {
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch {
        return [{ value: null, raw: text }];
      }
      if (doc === null || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray((doc as Record<string, unknown>)[options.items])) {
        return [{ value: doc ?? null, raw: text }];
      }
      const { [options.items]: items, ...head } = doc as Record<string, unknown>;
      const units: Unit[] = [{ value: head, raw: "" }, ...(items as unknown[]).map((value) => ({ value, raw: "" }))];
      if (build(units) !== text) units[0]!.raw = text;
      return units;
    },
    print(units) {
      if (units.length === 0) return "";
      if (units[0]!.raw !== "") return units[0]!.raw;
      return build(units) ?? "";
    },
    canonical: () => "",
  };
}
