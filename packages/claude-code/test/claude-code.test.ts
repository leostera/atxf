import { readFileSync } from "node:fs";
import { describeConverterLaws } from "@atxf/core/laws";
import { claudeCode } from "../src/index.ts";

const fixture = (name: string) => ({ name, text: readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8") });

describeConverterLaws(claudeCode, { fixtures: [fixture("harbor-hello.jsonl")] });
