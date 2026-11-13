#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseTranscript, serializeTranscript } from "./jsonl.ts";
import { formats } from "./formats/index.ts";
import { reconcile } from "./reconcile.ts";
import { validateTranscript } from "./validate.ts";
import { addFidelity, emptyFidelity, formatFidelity, isLossless } from "./fidelity.ts";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const USAGE = `usage:
  atxf validate <file.atxf.jsonl>...
  atxf convert --from <agent|atxf> --to <agent|atxf> [--no-carry [--tree]] <file>   writes to stdout
  atxf fidelity --from <agent> [--json] <file|dir>...                            what survives without native
  atxf reconcile <copy.atxf.jsonl>...                                           writes to stdout

agents: ${Object.keys(formats).join(", ")}`;

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, (args: string[]) => Promise<number>> = { validate, convert, reconcile: reconcileCommand, fidelity: fidelityCommand };
const run = command === undefined ? undefined : commands[command];
// Set the exit code rather than calling `process.exit`, which would cut off output still being written to a pipe.
process.exitCode = run === undefined ? usage() : await run(args);

async function validate(files: string[]): Promise<number> {
  if (files.length === 0) return usage();
  let failed = false;
  for (const file of files) {
    const result = validateTranscript(await readFile(file, "utf8"));
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
  const tree = args.includes("--tree");
  const [file] = args.filter((arg) => arg !== "--no-carry" && arg !== "--tree");
  const known = (name: string | undefined) => name === "atxf" || (name !== undefined && name in formats);
  if (!known(from) || !known(to) || file === undefined) return usage();
  const text = await readFile(file, "utf8");
  const transcript = from === "atxf" ? parseTranscript(text) : formats[from!]!.toAtxf(text);
  process.stdout.write(to === "atxf" ? serializeTranscript(transcript) : formats[to!]!.fromAtxf(transcript, { carry, tree }));
  return 0;
}

async function reconcileCommand(files: string[]): Promise<number> {
  if (files.length === 0) return usage();
  const copies = await Promise.all(files.map(async (file) => parseTranscript(await readFile(file, "utf8"))));
  const { transcript, renamed, problems } = reconcile(copies);
  for (const { copy, problems: found } of problems) for (const p of found) console.error(`${files[copy]}: record ${p.index + 1}: ${p.message}`);
  for (const r of renamed) console.error(`renamed ${r.id} -> ${r.as}`);
  process.stdout.write(serializeTranscript(transcript));
  return problems.length ? 1 : 0;
}

async function fidelityCommand(args: string[]): Promise<number> {
  const at = args.indexOf("--from");
  const from = at === -1 ? undefined : args.splice(at, 2)[1];
  const json = args.includes("--json");
  const paths = args.filter((arg) => arg !== "--json");
  if (from === undefined || !(from in formats) || paths.length === 0) return usage();
  const files: string[] = [];
  const collect = async (path: string) => {
    if ((await stat(path)).isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await collect(join(path, entry));
    } else if (path.endsWith(".jsonl") || paths.includes(path)) files.push(path);
  };
  for (const path of paths) await collect(path);
  const report = emptyFidelity();
  for (const file of files) addFidelity(report, formats[from]!, await readFile(file, "utf8"));
  process.stdout.write(json ? `${JSON.stringify(report, null, 1)}\n` : `${formatFidelity(from, report)}\n`);
  return isLossless(report) ? 0 : 1;
}

function usage(): number {
  console.error(USAGE);
  return 2;
}
