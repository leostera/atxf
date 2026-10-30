#!/usr/bin/env bun
import { parseTranscript, serializeTranscript } from "@atxf/core";
import { reconcile } from "./index.ts";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: atxf-reconcile <copy.atxf.jsonl>... > reconciled.atxf.jsonl");
  process.exit(2);
}

const copies = await Promise.all(files.map(async (file) => parseTranscript(await Bun.file(file).text())));
const { transcript, renamed, problems } = reconcile(copies);
for (const { copy, problems: found } of problems) for (const p of found) console.error(`${files[copy]}: record ${p.index + 1}: ${p.message}`);
for (const r of renamed) console.error(`renamed ${r.id} -> ${r.as}`);
process.stdout.write(serializeTranscript(transcript));
process.exit(problems.length ? 1 : 0);
