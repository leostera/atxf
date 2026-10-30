#!/usr/bin/env bun
import { parseTranscript, serializeTranscript } from "./jsonl.ts";
import { formats } from "./formats/index.ts";
import { reconcile } from "./reconcile.ts";
import { validateTranscript } from "./validate.ts";

const USAGE = `usage:
  atxf validate <file.atxf.jsonl>...
  atxf convert --from <agent|atxf> --to <agent|atxf> [--no-carry] <file>      writes to stdout
  atxf reconcile <copy.atxf.jsonl>...                                           writes to stdout

agents: ${Object.keys(formats).join(", ")}`;

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, (args: string[]) => Promise<number>> = { validate, convert, reconcile: reconcileCommand };
const run = command === undefined ? undefined : commands[command];
// Set the exit code rather than calling `process.exit`, which would cut off output still being written to a pipe.
process.exitCode = run === undefined ? usage() : await run(args);

async function validate(files: string[]): Promise<number> {
  if (files.length === 0) return usage();
  let failed = false;
  for (const file of files) {
    const result = validateTranscript(await Bun.file(file).text());
    for (const d of result.diagnostics) console.log(`${file}:${d.line}: ${d.severity}: ${d.message}`);
    console.log(`${result.ok ? "ok  " : "FAIL"} ${file}`);
    failed ||= !result.ok;
  }
  return failed ? 1 : 0;
}

async function convert(args: string[]): Promise<number> {
  const option = (name: string) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args.splice(at, 2)[1];
  };
  const from = option("--from");
  const to = option("--to");
  const carry = !args.includes("--no-carry");
  const [file] = args.filter((arg) => arg !== "--no-carry");
  const known = (name: string | undefined) => name === "atxf" || (name !== undefined && name in formats);
  if (!known(from) || !known(to) || file === undefined) return usage();
  const text = await Bun.file(file).text();
  const transcript = from === "atxf" ? parseTranscript(text) : formats[from!]!.toAtxf(text);
  process.stdout.write(to === "atxf" ? serializeTranscript(transcript) : formats[to!]!.fromAtxf(transcript, { carry }));
  return 0;
}

async function reconcileCommand(files: string[]): Promise<number> {
  if (files.length === 0) return usage();
  const copies = await Promise.all(files.map(async (file) => parseTranscript(await Bun.file(file).text())));
  const { transcript, renamed, problems } = reconcile(copies);
  for (const { copy, problems: found } of problems) for (const p of found) console.error(`${files[copy]}: record ${p.index + 1}: ${p.message}`);
  for (const r of renamed) console.error(`renamed ${r.id} -> ${r.as}`);
  process.stdout.write(serializeTranscript(transcript));
  return problems.length ? 1 : 0;
}

function usage(): number {
  console.error(USAGE);
  return 2;
}
