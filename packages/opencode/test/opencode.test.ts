import { readFileSync } from "node:fs";
import { embeddedToolResults, summariesAsUser } from "@atxf/core";
import { describeConverterLaws } from "@atxf/core/laws";
import { arbitraryTranscript, noisyJsonDocument } from "@atxf/core/testing";
import { opencode } from "../src/index.ts";

const fixture = (name: string) => ({ name, text: readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8") });

describeConverterLaws(opencode, {
  fixtures: [fixture("export-hand-built.json")],
  nativeFiles: arbitraryTranscript({ integrity: false }).chain((t) => noisyJsonDocument(opencode.fromAtxf(t, { carry: false }), "messages")),
  view: (view) => embeddedToolResults(summariesAsUser(view)),
});
