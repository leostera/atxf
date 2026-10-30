#!/usr/bin/env bun
import { validateTranscript } from "./validate.ts";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: atxf-validate <file.atxf.jsonl>...");
  process.exit(2);
}

let failed = false;
for (const file of files) {
  const result = validateTranscript(await Bun.file(file).text());
  for (const d of result.diagnostics) {
    console.log(`${file}:${d.line}: ${d.severity}: ${d.message}`);
  }
  console.log(`${result.ok ? "ok  " : "FAIL"} ${file}`);
  failed ||= !result.ok;
}
process.exit(failed ? 1 : 0);
