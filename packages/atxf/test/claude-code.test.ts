import { readFileSync } from "node:fs";
import { describeConverterLaws } from "../src/laws.ts";
import { claudeCode } from "../src/formats/claude-code.ts";

const fixture = (name: string) => ({ name, text: readFileSync(new URL(`../../../fixtures/claude-code/${name}`, import.meta.url), "utf8") });

describeConverterLaws(claudeCode, { fixtures: [fixture("harbor-hello.jsonl")] });
