import { readFileSync } from "node:fs";
import { summariesAsUser } from "../src/index.ts";
import { describeConverterLaws } from "../src/laws.ts";
import { codex } from "../src/formats/codex.ts";

const fixture = (name: string) => ({ name, text: readFileSync(new URL(`../../../fixtures/codex/${name}`, import.meta.url), "utf8") });

describeConverterLaws(codex, { fixtures: [fixture("rollout-hand-built.jsonl")], view: summariesAsUser });
