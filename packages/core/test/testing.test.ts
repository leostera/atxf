import { expect, test } from "bun:test";
import fc from "fast-check";
import { serializeTranscript } from "../src/jsonl.ts";
import { arbitraryTranscript } from "../src/testing.ts";
import { validateTranscript } from "../src/validate.ts";

test("generated transcripts are valid, so failures in converter laws are converter bugs", () => {
  fc.assert(
    fc.property(arbitraryTranscript(), (t) => {
      expect(validateTranscript(serializeTranscript(t)).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    }),
    { numRuns: 500 },
  );
});
