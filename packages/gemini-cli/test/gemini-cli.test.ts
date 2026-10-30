import { readFileSync } from "node:fs";
import { embeddedToolResults, summariesAsUser } from "@atxf/core";
import { describeConverterLaws } from "@atxf/core/laws";
import { geminiCli } from "../src/index.ts";

const fixture = (name: string) => ({ name, text: readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8") });

describeConverterLaws(geminiCli, {
  fixtures: [fixture("session-hand-built.jsonl")],
  view: (view) => embeddedToolResults(summariesAsUser(view)),
});
