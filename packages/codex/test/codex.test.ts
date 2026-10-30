import { readFileSync } from "node:fs";
import { summariesAsUser } from "@atxf/core";
import { describeConverterLaws } from "@atxf/core/laws";
import { codex } from "../src/index.ts";

const fixture = (name: string) => ({ name, text: readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8") });

describeConverterLaws(codex, { fixtures: [fixture("rollout-hand-built.jsonl")], view: summariesAsUser });
