#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseTranscript, serializeTranscript } from "./jsonl.ts";
import { formats } from "./formats/index.ts";
import { reconcile } from "./reconcile.ts";
import { linearize } from "./linearize.ts";
import { validateTranscript } from "./validate.ts";
import { addFidelity, emptyFidelity, formatFidelity, isLossless } from "./fidelity.ts";
import { readdir, realpath, stat } from "node:fs/promises";
import type { Transcript } from "./types.ts";
import { addIntegrity, verifyIntegrity } from "./integrity.ts";
import { join } from "node:path";

const USAGE = `usage:
  atxf validate <file.atxf.jsonl>...
  atxf convert --from <agent|atxf> --to <agent|atxf> [--no-carry [--tree]] <file>   writes to stdout
  atxf fidelity --from <agent> [--json] <file|dir>...                            what survives without native
  atxf reconcile <copy.atxf.jsonl>...                                           writes to stdout
  atxf linearize [--from <agent|atxf>] [--to <agent|atxf>] <copy>...           every branch on one path, to stdout
      several copies of a session are reconciled first; --to an agent writes its session file
  atxf stream --from <agent> [--no-integrity] [--lines <first>:<last>] [--resume <state.json>] [--state <state.json>] <file>
      pushes the file's lines (1-based, inclusive) one at a time; writes each record, then the header, to stdout

agents: ${Object.keys(formats).join(", ")}`;

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, (args: string[]) => Promise<number>> = { validate, convert, reconcile: reconcileCommand, linearize: linearizeCommand, fidelity: fidelityCommand, stream: streamCommand };
const run = command === undefined ? undefined : commands[command];
// Set the exit code rather than calling `process.exit`, which would cut off output still being written to a pipe.
process.exitCode = run === undefined ? usage() : await run(args).catch((error: unknown) => {
  // As the Rust CLI does: the message, not a stack trace.
  console.error(`atxf: ${error instanceof Error ? error.message : String(error)}`);
  return 1;
});

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

async function streamCommand(args: string[]): Promise<number> {
  const option = (name: string) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args.splice(at, 2)[1];
  };
  const from = option("--from");
  const range = option("--lines");
  const resume = option("--resume");
  const save = option("--state");
  const integrity = !args.includes("--no-integrity");
  const [file] = args.filter((arg) => arg !== "--no-integrity");
  const stream = from === undefined ? undefined : formats[from]?.stream?.bind(formats[from]);
  const bounds = range?.match(/^(\d+):(\d+)$/);
  if (stream === undefined || file === undefined || (range !== undefined && !bounds)) return usage();
  const lines = (await readFile(file, "utf8")).split("\n");
  if (lines.at(-1) === "") lines.pop();
  const [first, last] = bounds ? [Math.max(1, Number(bounds[1])), Number(bounds[2])] : [1, lines.length];
  let reading;
  try {
    reading = stream(resume === undefined ? { integrity } : { resume: JSON.parse(await readFile(resume, "utf8")) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const out: string[] = [];
  for (const line of lines.slice(first - 1, last)) for (const record of reading.push(line)) out.push(JSON.stringify(record));
  out.push(JSON.stringify(reading.header ?? null));
  process.stdout.write(`${out.join("\n")}\n`);
  if (save !== undefined) await writeFile(save, `${JSON.stringify(reading.state())}\n`);
  return 0;
}

/**
 * Files given together link by path too: a `parent.uri` naming another of the files links to that file's session,
 * whatever the file is called (Pi records its parent's path).
 */
async function linkByPath(files: string[], transcripts: Transcript[]): Promise<Transcript[]> {
  const real = await Promise.all(files.map((file) => realpath(file).catch(() => file)));
  return Promise.all(
    transcripts.map(async (transcript) => {
      const uri = transcript.header.parent?.uri;
      if (uri === undefined) return transcript;
      const at = real.indexOf(await realpath(uri).catch(() => uri));
      const id = at < 0 ? undefined : transcripts[at]!.header.id;
      if (id === undefined || id === transcript.header.parent!.transcriptId) return transcript;
      const linked = { ...transcript, header: { ...transcript.header, parent: { ...transcript.header.parent!, transcriptId: id } } };
      // The header is hashed, so a file whose hashes verify is hashed again; one that does not keeps its problems.
      if (!transcript.header.integrity || verifyIntegrity(transcript).length > 0) return linked;
      return addIntegrity(linked);
    }),
  );
}

async function reconcileCommand(files: string[]): Promise<number> {
  if (files.length === 0) return usage();
  const copies = await linkByPath(files, await Promise.all(files.map(async (file) => parseTranscript(await readFile(file, "utf8")))));
  const { transcript, renamed, problems } = reconcile(copies);
  for (const { copy, problems: found } of problems) for (const p of found) console.error(`${files[copy]}: record ${p.index + 1}: ${p.message}`);
  for (const r of renamed) console.error(`renamed ${r.id} -> ${r.as}`);
  process.stdout.write(serializeTranscript(transcript));
  return problems.length ? 1 : 0;
}

async function linearizeCommand(args: string[]): Promise<number> {
  const option = (name: string) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args.splice(at, 2)[1];
  };
  const from = option("--from") ?? "atxf";
  const to = option("--to") ?? "atxf";
  const known = (name: string) => name === "atxf" || name in formats;
  if (!known(from) || !known(to) || args.length === 0) return usage();
  const read = (text: string) => (from === "atxf" ? parseTranscript(text) : formats[from]!.toAtxf(text));
  const copies = await linkByPath(args, await Promise.all(args.map(async (file) => read(await readFile(file, "utf8")))));
  let source = copies[0]!;
  if (copies.length > 1) {
    const result = reconcile(copies);
    for (const { copy, problems } of result.problems) for (const p of problems) console.error(`${args[copy]}: record ${p.index + 1}: ${p.message}`);
    if (result.problems.length) return 1;
    source = result.transcript;
  }
  const { transcript, branches } = linearize(source);
  console.error(`linearized ${branches} branch(es) into one`);
  process.stdout.write(to === "atxf" ? serializeTranscript(transcript) : formats[to]!.fromAtxf(transcript, { carry: false, tree: true }));
  return 0;
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
