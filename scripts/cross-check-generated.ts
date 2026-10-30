// Generated transcripts through both implementations: the TypeScript one in-process, the Rust one through its CLI.
// Every output must match byte for byte, so the property tests of the TypeScript package cover the Rust crate too.
//
// usage: bun scripts/cross-check-generated.ts [runs]      (default 200)
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { parseTranscript, serializeTranscript } from "../packages/atxf-ts/src/jsonl.ts";
import { formats } from "../packages/atxf-ts/src/formats/index.ts";
import { reconcile } from "../packages/atxf-ts/src/reconcile.ts";
import { arbitraryTranscript, noisyJsonDocument, noisyJsonl } from "../packages/atxf-ts/src/testing.ts";
import { validateTranscript } from "../packages/atxf-ts/src/validate.ts";

const runs = Number(process.argv[2] ?? 200);
const root = join(import.meta.dir, "..");
const rust = join(root, "packages/atxf-rs/target/release/atxf");
const build = Bun.spawnSync(["cargo", "build", "--quiet", "--release", "--manifest-path", join(root, "packages/atxf-rs/Cargo.toml")], { stderr: "inherit" });
if (build.exitCode !== 0) process.exit(1);

const work = mkdtempSync(join(tmpdir(), "atxf-xcheck-"));
let checks = 0;
const failures: string[] = [];

function rs(args: string[], input: string, name = "input"): { out: string; code: number } {
  const file = join(work, name);
  writeFileSync(file, input);
  const result = Bun.spawnSync([rust, ...args, file]);
  return { out: result.stdout.toString(), code: result.exitCode };
}

function same(label: string, expected: string, actual: string, input: string) {
  checks++;
  if (expected === actual) return true;
  const file = join(tmpdir(), `atxf-xcheck-failure-${failures.length}.txt`);
  writeFileSync(file, `${label}\n--- input\n${input}\n--- typescript\n${expected}\n--- rust\n${actual}\n`);
  failures.push(`${label}: see ${file}`);
  return false;
}

const agents = Object.keys(formats) as (keyof typeof formats)[];

fc.assert(
  fc.property(arbitraryTranscript(), fc.boolean(), (transcript, carry) => {
    const text = serializeTranscript(transcript);
    // The generator's transcripts must read the same.
    same("atxf→atxf", serializeTranscript(parseTranscript(text)), rs(["convert", "--from", "atxf", "--to", "atxf"], text).out, text);
    const result = validateTranscript(text);
    const validated = rs(["validate"], text);
    same("validate exit code", String(result.ok ? 0 : 1), String(validated.code), text);
    for (const agent of agents) {
      const flags = carry ? [] : ["--no-carry"];
      const native = formats[agent].fromAtxf(transcript, { carry });
      if (!same(`atxf→${agent} ${flags}`, native, rs(["convert", "--from", "atxf", "--to", agent, ...flags], text).out, text)) continue;
      same(`${agent}→atxf`, serializeTranscript(formats[agent].toAtxf(native)), rs(["convert", "--from", agent, "--to", "atxf"], native).out, native);
    }
    return true;
  }),
  { numRuns: runs },
);

// Native files with noise: blank lines, unknown records, odd whitespace.
for (const agent of agents) {
  const noisy = arbitraryTranscript({ integrity: false }).chain((t) => {
    const native = formats[agent].fromAtxf(t, { carry: false });
    return agent === "opencode" ? noisyJsonDocument(native, "messages") : noisyJsonl(native);
  });
  fc.assert(
    fc.property(noisy, (native) => {
      const decoded = formats[agent].toAtxf(native);
      same(`noisy ${agent}→atxf`, serializeTranscript(decoded), rs(["convert", "--from", agent, "--to", "atxf"], native).out, native);
      same(`noisy ${agent}→${agent}`, formats[agent].fromAtxf(decoded), rs(["convert", "--from", agent, "--to", agent], native).out, native);
      return true;
    }),
    { numRuns: Math.ceil(runs / 2) },
  );
}

// Reconciling generated copies that share a prefix and diverge.
fc.assert(
  fc.property(arbitraryTranscript(), fc.nat(), fc.nat(), (transcript, cutA, cutB) => {
    const records = transcript.records;
    const a = { header: transcript.header, records: records.slice(0, records.length ? 1 + (cutA % records.length) : 0) };
    const b = { header: transcript.header, records: records.slice(0, records.length ? 1 + (cutB % records.length) : 0) };
    let expected: string;
    try {
      expected = serializeTranscript(reconcile([a, b]).transcript);
    } catch {
      return true;
    }
    const fileA = join(work, "a.atxf.jsonl");
    writeFileSync(fileA, serializeTranscript(a));
    const actual = rs(["reconcile", fileA], serializeTranscript(b), "b.atxf.jsonl").out;
    same("reconcile", expected, actual, `${serializeTranscript(a)}\n---\n${serializeTranscript(b)}`);
    return true;
  }),
  { numRuns: runs },
);

rmSync(work, { recursive: true, force: true });
for (const failure of failures.slice(0, 20)) console.log(`DIFF ${failure}`);
console.log(`${checks} checks, ${failures.length} differences`);
process.exitCode = failures.length ? 1 : 0;
