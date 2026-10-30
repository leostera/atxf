import type { AtxfRecord, EntryRecord, Transcript, TranscriptHeader } from "./types.ts";

/** Splits JSONL text into parsed objects, skipping blank lines. Throws with the line number on bad JSON. */
export function parseJsonl(text: string): unknown[] {
  const values: unknown[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    try {
      values.push(JSON.parse(line));
    } catch (cause) {
      throw new Error(`line ${index + 1}: invalid JSON: ${(cause as Error).message}`);
    }
  });
  return values;
}

export function toJsonl(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join("\n") + (values.length > 0 ? "\n" : "");
}

/** Parses an ATXF transcript. Structural validation is `validateTranscript`'s job; this only checks the header. */
export function parseTranscript(text: string): Transcript {
  const [header, ...records] = parseJsonl(text) as AtxfRecord[];
  if (!header || header.type !== "transcript") throw new Error("the first record of an ATXF transcript must be `transcript`");
  return { header: header as TranscriptHeader, records: records as EntryRecord[] };
}

export function serializeTranscript(transcript: Transcript): string {
  return toJsonl([transcript.header, ...transcript.records]);
}
