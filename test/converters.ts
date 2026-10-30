import type { Converter } from "@atxf/core";
import { arbitraryTranscript, noisyJsonDocument, noisyJsonl } from "@atxf/core/testing";
import { claudeCode } from "@atxf/claude-code";
import { codex } from "@atxf/codex";
import { geminiCli } from "@atxf/gemini-cli";
import { opencode } from "@atxf/opencode";
import { pi } from "@atxf/pi";
import type fc from "fast-check";

/** Every converter, with an arbitrary for its native files. */
export const converters: { converter: Converter; nativeFiles: fc.Arbitrary<string> }[] = [pi, claudeCode, codex, geminiCli].map((converter) => ({
  converter,
  nativeFiles: arbitraryTranscript({ integrity: false }).chain((t) => noisyJsonl(converter.fromAtxf(t, { carry: false }))),
}));
converters.push({
  converter: opencode,
  nativeFiles: arbitraryTranscript({ integrity: false }).chain((t) => noisyJsonDocument(opencode.fromAtxf(t, { carry: false }), "messages")),
});
