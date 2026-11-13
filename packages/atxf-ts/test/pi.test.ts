import { readFileSync } from "node:fs";
import { describeConverterLaws } from "../src/laws.ts";
import { pi } from "../src/formats/pi.ts";

const fixture = (name: string) => ({ name, text: readFileSync(new URL(`../../../fixtures/pi/${name}`, import.meta.url), "utf8") });

describeConverterLaws(pi, { fixtures: [fixture("session-every-field.jsonl")] });
