import { readFileSync } from "node:fs";
import { embeddedToolResults, summariesAsUser } from "../src/index.ts";
import { describeConverterLaws } from "../src/laws.ts";
import { arbitraryTranscript, noisyJsonDocument } from "../src/testing.ts";
import { opencode } from "../src/formats/opencode.ts";

const fixture = (name: string) => ({ name, text: readFileSync(new URL(`../../../fixtures/opencode/${name}`, import.meta.url), "utf8") });

describeConverterLaws(opencode, {
  fixtures: [fixture("export-hand-built.json")],
  nativeFiles: arbitraryTranscript({ integrity: false }).chain((t) => noisyJsonDocument(opencode.fromAtxf(t, { carry: false }), "messages")),
  view: (view) => embeddedToolResults(summariesAsUser(view)),
});
