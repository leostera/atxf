// Two Pis continue one session apart; a third continues the merge and remembers what both did.
//
// Needs `pi` on PATH, and is skipped without it. Each Pi runs once per prompt (`pi -p`) in its own session
// directory, against a scripted OpenAI-compatible model that records every request, so what a Pi remembers is what
// it sends the model. Pi A starts the session and the file is copied to Pi B, as when a session moves to a second
// machine. Each is then told a different codeword. Both copies are read into ATXF, reconciled into one transcript
// (SPEC §18), merged so the active branch summarizes the other, and written back as one Pi session file, which Pi C
// continues.
//
// `ATXF_E2E_MODEL=provider/model` runs the three Pis against a real model, with your Pi agent directory and
// extensions for its credentials, and checks that Pi C's answer names both codewords. `ATXF_E2E_KEEP=1` keeps the
// session files.
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { activePath, buildContext, indexTree, leaves, serializeTranscript, validateTranscript, type Transcript } from "../src/index.ts";
import { pi } from "../src/formats/pi.ts";
import { mergeBranches, reconcile } from "../src/reconcile.ts";

const realModel = process.env.ATXF_E2E_MODEL;
const havePi = Bun.which("pi") !== null;
const root = mkdtempSync(join(tmpdir(), "atxf-pi-merge-"));
if (!process.env.ATXF_E2E_KEEP) afterAll(() => rmSync(root, { recursive: true, force: true }));

type Message = { role: string; content: unknown };
const requests: Message[][] = [];
const model = havePi && !realModel ? scriptedModel() : undefined;
afterAll(() => model?.stop(true));

/** An OpenAI-compatible model that records each request and answers it with a line of text. */
function scriptedModel() {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: Message[] };
      requests.push(body.messages);
      const chunk = (delta: unknown, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "mock-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const text = `Noted (reply ${requests.length}).`;
      return new Response(chunk({ role: "assistant", content: text }) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
}

const agentDir = (() => {
  if (realModel) return process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME!, ".pi", "agent");
  const dir = join(root, "agent");
  mkdirSync(dir, { recursive: true });
  if (model) {
    const provider = { baseUrl: `http://127.0.0.1:${model.port}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "mock-1" }] };
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { mock: provider } }));
  }
  return dir;
})();

/** Runs one Pi turn in `dir`, continuing `session` when given, and returns its answer and its session file. */
async function piTurn(dir: string, message: string, session?: string): Promise<{ answer: string; file: string }> {
  mkdirSync(dir, { recursive: true });
  const where = session ? ["--session", session] : ["--session-dir", dir];
  // A real model may come from an extension (a custom provider), so only the scripted one runs without them.
  const isolated = realModel ? [] : ["--offline", "-ne"];
  const flags = ["-p", ...isolated, "--no-mcp", "-ns", "-np", "-nc", "--no-themes", "--model", realModel ?? "mock/mock-1"];
  // Asynchronously: the scripted model answers from this process.
  const run = Bun.spawn(["pi", ...flags, ...where, message], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
  const [stdout, stderr, status] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  if (status !== 0) throw new Error(`pi exited with ${status}: ${stderr}`);
  const file = session ?? join(dir, readdirSync(dir).find((name) => name.endsWith(".jsonl"))!);
  return { answer: stdout.trim(), file };
}

const CODEWORDS = ["MARMALADE", "TANGERINE"];
const textOf = (messages: Message[]) => JSON.stringify(messages);

describe.skipIf(!havePi)("two Pis, merged in ATXF, continued by a third", () => {
  let merged: Transcript;
  let reconciled: Transcript;
  let answer: string;
  let continued: string;

  test("the copies diverge, reconcile into two branches and merge into one", async () => {
    const a = await piTurn(join(root, "a"), "We are naming a release. I will tell you codewords; remember each one. Reply with one short line.");
    const b = join(root, "b", basename(a.file));
    mkdirSync(join(root, "b"), { recursive: true });
    copyFileSync(a.file, b);
    await piTurn(join(root, "a"), `Codeword one is ${CODEWORDS[0]}. Reply with one short line.`, a.file);
    await piTurn(join(root, "b"), `Codeword two is ${CODEWORDS[1]}. Reply with one short line.`, b);

    const copies = [pi.toAtxf(readFileSync(a.file, "utf8")), pi.toAtxf(readFileSync(b, "utf8"))];
    reconciled = reconcile(copies).transcript;
    const index = indexTree(reconciled);
    expect(leaves(index)).toHaveLength(2);
    // Without merging, the active branch holds only one copy's codeword.
    const unmerged = JSON.stringify(buildContext(reconciled).messages);
    expect(CODEWORDS.filter((word) => unmerged.includes(word))).toHaveLength(1);

    const result = mergeBranches(reconciled);
    merged = result.transcript;
    expect(result.merged).toHaveLength(1);
    expect(validateTranscript(serializeTranscript(merged)).ok).toBe(true);
    const context = JSON.stringify(buildContext(merged).messages);
    for (const word of CODEWORDS) expect(context).toContain(word);
    // Merging again adds nothing.
    expect(mergeBranches(merged).merged).toHaveLength(0);
  }, 600_000);

  test("a third Pi continues the merged session and remembers both codewords", async () => {
    const c = join(root, "c", "merged.jsonl");
    mkdirSync(join(root, "c"), { recursive: true });
    writeFileSync(c, pi.fromAtxf(merged, { carry: false, tree: true }));
    const before = requests.length;
    ({ answer } = await piTurn(join(root, "c"), "What are the two codewords? Answer with just the two words.", c));
    continued = readFileSync(c, "utf8");

    if (model) {
      expect(requests.length).toBe(before + 1);
      const sent = textOf(requests.at(-1)!);
      for (const word of CODEWORDS) expect(sent).toContain(word);
    } else {
      for (const word of CODEWORDS) expect(answer.toUpperCase()).toContain(word);
    }
  }, 600_000);

  test("the continued file still holds both branches, and the new turn follows the merge", () => {
    const after = pi.toAtxf(continued);
    const path = activePath(after);
    expect(path.some((record) => record.type === "branch_summary")).toBe(true);
    expect(leaves(indexTree(after))).toHaveLength(2);
    // Every record of the reconciled copies is still there.
    expect(after.records.length).toBeGreaterThan(reconciled.records.length);
  }, 60_000);
});
