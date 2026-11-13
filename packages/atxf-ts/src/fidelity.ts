import { stripNative, type Converter } from "./convert.ts";
import { diff, jsonEqual, type PatchOperation } from "./patch.ts";
import type { Transcript } from "./types.ts";

/**
 * How much of a native session survives ATXF without `native` (SPEC §11.2): the session is read, its native records
 * are stripped, and it is written back as a whole tree. Every native entry is then compared, as JSON with the order
 * of keys ignored, with the one written back under the same key.
 *
 * - `missing`: paths of values the original has and the written-back entry lacks or holds differently. A path is
 *   a JSON Pointer with array indices as `[]`, under the entry's type: `message:/message/durationMs`.
 * - `added`: paths the written-back entry has and the original does not.
 * - `ext`: paths the converter keeps in the record's `ext.<agent>.patch`, not in typed fields: what ATXF only holds
 *   for this agent. Not a loss, but not portable either.
 * - `stable`: reading the written-back file gives the transcript it was written from (without native, hashes and
 *   `fidelity.nativeDigest`).
 *
 * Lossless without native means `missing`, `added` and `missingEntries` are empty, and `stable` holds.
 */
export interface FidelityReport {
  files: number;
  /**
   * Files that carry an ATXF transcript (written by `fromAtxf`), which read as that transcript (SPEC §11.1, law 3)
   * rather than as their own entries. Not compared.
   */
  carried: number;
  entries: number;
  /** Entries written back equal to the original. */
  equal: number;
  /** Native entries with no entry under the same key in the file written back, by type. */
  missingEntries: Record<string, number>;
  /** Entries written back that are not in the original, by type. */
  addedEntries: Record<string, number>;
  missing: Record<string, number>;
  added: Record<string, number>;
  ext: Record<string, number>;
  /** Files whose transcript did not survive ATXF → native → ATXF. */
  unstable: number;
  /** Files the converter could not read or write, with the error. */
  errors: Record<string, number>;
}

export function emptyFidelity(): FidelityReport {
  return { files: 0, carried: 0, entries: 0, equal: 0, missingEntries: {}, addedEntries: {}, missing: {}, added: {}, ext: {}, unstable: 0, errors: {} };
}

export interface FidelityOptions {
  /** The key an entry is matched by: its id, by default, and `session` for the header line. */
  key?: (entry: unknown) => string;
}

const defaultKey = (entry: unknown): string => {
  const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
  if (e.type === "session") return "session";
  return typeof e.id === "string" ? e.id : JSON.stringify(entry);
};

/** Adds one JSON Lines session file's fidelity to `into`. */
export function addFidelity(into: FidelityReport, converter: Converter, text: string, options: FidelityOptions = {}): FidelityReport {
  const key = options.key ?? defaultKey;
  into.files += 1;
  if (carriesTranscript(text)) {
    into.carried += 1;
    return into;
  }
  let transcript: Transcript;
  let written: string;
  try {
    transcript = stripNative(converter.toAtxf(text, { integrity: false }));
    written = converter.fromAtxf(transcript, { carry: false, tree: true });
  } catch (error) {
    count(into.errors, error instanceof Error ? error.message.slice(0, 120) : String(error));
    return into;
  }
  const original = keyed(lines(text), key);
  const back = new Map<string, unknown>();
  for (const [k, entry] of keyed(lines(written), key)) back.set(k, entry);
  into.entries += original.length;
  const seen = new Set<string>();
  for (const [k, entry] of original) {
    seen.add(k);
    const type = typeOf(entry);
    if (!back.has(k)) {
      count(into.missingEntries, type);
      continue;
    }
    const other = back.get(k);
    if (jsonEqual(entry, other)) {
      into.equal += 1;
      continue;
    }
    for (const op of diff(entry, other)) count(op.op === "remove" ? into.added : into.missing, `${type}:${pattern(op.path)}`);
  }
  for (const [k, entry] of back) if (!seen.has(k)) count(into.addedEntries, typeOf(entry));
  for (const record of [transcript.header, ...transcript.records]) {
    const patch = (record as { ext?: Record<string, { patch?: PatchOperation[] }> }).ext?.[converter.agent]?.patch ?? [];
    for (const op of patch) count(into.ext, `${record.type}:${op.op} ${pattern(op.path)}`);
  }
  try {
    if (!sameTranscript(stripNative(converter.toAtxf(written, { integrity: false })), transcript)) into.unstable += 1;
  } catch {
    into.unstable += 1;
  }
  return into;
}

/** Sums reports, as from several processes. */
export function mergeFidelity(a: FidelityReport, b: FidelityReport): FidelityReport {
  const sum = (x: Record<string, number>, y: Record<string, number>) => {
    const out = { ...x };
    for (const [k, n] of Object.entries(y)) out[k] = (out[k] ?? 0) + n;
    return out;
  };
  return {
    files: a.files + b.files,
    carried: a.carried + b.carried,
    entries: a.entries + b.entries,
    equal: a.equal + b.equal,
    missingEntries: sum(a.missingEntries, b.missingEntries),
    addedEntries: sum(a.addedEntries, b.addedEntries),
    missing: sum(a.missing, b.missing),
    added: sum(a.added, b.added),
    ext: sum(a.ext, b.ext),
    unstable: a.unstable + b.unstable,
    errors: sum(a.errors, b.errors),
  };
}

/** Whether the report finds nothing lost. */
export function isLossless(report: FidelityReport): boolean {
  const none = (x: Record<string, number>) => Object.keys(x).length === 0;
  return none(report.missingEntries) && none(report.addedEntries) && none(report.missing) && none(report.added) && none(report.errors) && report.unstable === 0;
}

/** The report as text: totals, then each table, largest first. */
export function formatFidelity(agent: string, report: FidelityReport): string {
  const out = [
    `${agent}: ${report.files} file(s) (${report.carried} carrying a transcript, not compared), ${report.entries} entries, ${report.equal} written back equal, ${report.unstable} unstable through ATXF`,
  ];
  const table = (title: string, rows: Record<string, number>) => {
    const entries = Object.entries(rows).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    out.push(`${title}: ${entries.length === 0 ? "none" : ""}`);
    for (const [k, n] of entries) out.push(`  ${String(n).padStart(7)}  ${k}`);
  };
  table("errors", report.errors);
  table("entries missing", report.missingEntries);
  table("entries added", report.addedEntries);
  table("values missing", report.missing);
  table("values added", report.added);
  table("kept in ext only", report.ext);
  return out.join("\n");
}

/** Whether a line of the file carries a transcript in an `atxf` key, as `fromAtxf` writes it. */
function carriesTranscript(text: string): boolean {
  return text.split("\n").some((line) => {
    if (!line.includes('"atxf"')) return false;
    try {
      const value = JSON.parse(line);
      return typeof value?.atxf?.transcript === "object" && value.atxf.transcript !== null;
    } catch {
      return false;
    }
  });
}

/** Each non-blank line's value; a line that is not JSON is compared as its text. */
function lines(text: string): unknown[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: "<not json>", line };
      }
    });
}

/** Entries under their keys; an entry whose key an earlier one has is told apart by how many came before. */
function keyed(entries: unknown[], key: (entry: unknown) => string): [string, unknown][] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const k = key(entry);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return [n === 0 ? k : `${k}#${n}`, entry];
  });
}

function typeOf(entry: unknown): string {
  const type = (entry as { type?: unknown } | null)?.type;
  return typeof type === "string" ? type : "?";
}

/** A JSON Pointer with array indices as `[]`. */
function pattern(path: string): string {
  return path.replace(/\/\d+(?=\/|$)/g, "/[]") || "/";
}

function count(into: Record<string, number>, key: string) {
  into[key] = (into[key] ?? 0) + 1;
}

/** The same transcript, ignoring hashes and the digest of the native file. */
function sameTranscript(a: Transcript, b: Transcript): boolean {
  const header = (t: Transcript) => {
    const { hash: _h, integrity: _i, fidelity, ...rest } = t.header;
    const { nativeDigest: _d, ...f } = fidelity ?? {};
    return { ...rest, fidelity: f };
  };
  const records = (t: Transcript) => t.records.map(({ hash: _, ...rest }) => rest);
  return jsonEqual(header(a), header(b)) && jsonEqual(records(a), records(b));
}
