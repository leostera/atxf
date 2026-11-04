// Times the same pipeline as packages/atxf-rs/examples/bench.rs, on the built TypeScript package.
// usage: bun bench/bench.mjs <pi session.jsonl>...   or   node bench/bench.mjs <pi session.jsonl>...
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { buildContext, parseTranscript, serializeTranscript, validateTranscript, verifyIntegrity } from "@leostera/atxf";
import { reconcile } from "@leostera/atxf/reconcile";
import { opencode } from "@leostera/atxf/opencode";
import { pi } from "@leostera/atxf/pi";

const runtime = typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.versions.node}`;

/** Median milliseconds of `work`, after one warm-up run, over at least 3 runs and about a second. */
function time(work) {
  work();
  const runs = [];
  const start = performance.now();
  while (runs.length < 3 || (performance.now() - start < 1000 && runs.length < 50)) {
    const t0 = performance.now();
    work();
    runs.push(performance.now() - t0);
  }
  runs.sort((a, b) => a - b);
  return runs[Math.floor(runs.length / 2)];
}

for (const path of process.argv.slice(2)) {
  const text = readFileSync(path, "utf8");
  const transcript = pi.toAtxf(text);
  const atxf = serializeTranscript(transcript);
  const native = opencode.fromAtxf(transcript);
  const prefix = { header: transcript.header, records: transcript.records.slice(0, Math.floor(transcript.records.length * 0.9)) };
  const records = transcript.records.length;
  const stages = {
    "read pi": () => pi.toAtxf(text),
    serialize: () => serializeTranscript(transcript),
    parse: () => parseTranscript(atxf),
    validate: () => validateTranscript(atxf),
    "verify integrity": () => verifyIntegrity(transcript),
    "build context": () => buildContext(transcript),
    "write opencode": () => opencode.fromAtxf(transcript),
    "read opencode": () => opencode.toAtxf(native),
    reconcile: () => reconcile([transcript, prefix]),
  };
  for (const [stage, work] of Object.entries(stages)) {
    const ms = time(work);
    console.log(JSON.stringify({ impl: `ts (${runtime})`, file: basename(path), bytes: text.length, records, stage, ms: Number(ms.toFixed(3)) }));
  }
}
