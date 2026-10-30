import { readFileSync } from "node:fs";
import { embeddedToolResults, summariesAsUser } from "../src/index.ts";
import { describeConverterLaws } from "../src/laws.ts";
import { geminiCli } from "../src/formats/gemini-cli.ts";

const fixture = (name: string) => ({ name, text: readFileSync(new URL(`../../../fixtures/gemini-cli/${name}`, import.meta.url), "utf8") });

describeConverterLaws(geminiCli, {
  fixtures: [fixture("session-hand-built.jsonl")],
  view: (view) => embeddedToolResults(summariesAsUser(view)),
});
