// End to end with a real Pi: `bun packages/pi-atxf/test/e2e.ts`. Needs `pi` on PATH.
//
// Pi runs in RPC mode against a scripted OpenAI-compatible model, with its own agent and session directories. It
// starts a session and joins a shared file; another agent (simulated through the OpenCode converter) adds a turn;
// Pi pulls it on its own, sends it to the model as context on its next request, and pushes its reply back.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { serializeTranscript, validateTranscript } from "@leostera/atxf";
import { opencode } from "@leostera/atxf/opencode";
import { push, readShared } from "@leostera/atxf/sync";
import { contentText } from "@leostera/atxf";

const root = mkdtempSync(join(tmpdir(), "pi-atxf-e2e-"));
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
const project = join(root, "project");
const sharedPath = join(root, "shared", "session.atxf.jsonl");
for (const dir of [agentDir, sessionDir, project]) mkdirSync(dir, { recursive: true });

const requests: { role: string; content: unknown }[][] = [];
const model = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { messages: { role: string; content: unknown }[] };
    requests.push(body.messages);
    const last = [...body.messages].reverse().find((m) => m.role === "user");
    const text = `pi reply ${requests.length} to: ${JSON.stringify(last?.content).slice(0, 80)}`;
    const chunk = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "mock-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return new Response(chunk({ role: "assistant", content: text }) + chunk({}, "stop") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  },
});
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${model.port}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "mock-1" }] } } }),
);

const extension = new URL("../src/index.ts", import.meta.url).pathname;
const child = spawn(
  "pi",
  ["--mode", "rpc", "--offline", "-ne", "-e", extension, "--no-mcp", "-ns", "-np", "-nc", "--no-themes", "--model", "mock/mock-1", "--session-dir", sessionDir],
  { cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, XDG_STATE_HOME: join(root, "state") }, stdio: ["pipe", "pipe", "pipe"] },
);
child.stderr.on("data", (d) => process.env.E2E_VERBOSE && process.stderr.write(d));
const events: Record<string, unknown>[] = [];
const waiters: { match: (e: Record<string, unknown>) => boolean; resolve: (e: Record<string, unknown>) => void }[] = [];
createInterface({ input: child.stdout }).on("line", (line) => {
  const event = JSON.parse(line) as Record<string, unknown>;
  events.push(event);
  if (process.env.E2E_VERBOSE) console.error("<", line.slice(0, 200));
  for (const waiter of waiters.splice(0)) (waiter.match(event) ? waiter.resolve(event) : waiters.push(waiter));
});
const next = (match: (e: Record<string, unknown>) => boolean, ms = 20_000) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    waiters.push({ match, resolve });
    setTimeout(() => reject(new Error(`timed out; last events: ${JSON.stringify(events.slice(-5))}`)), ms);
  });
let id = 0;
const send = (command: Record<string, unknown>) => {
  const request = { id: `r${++id}`, ...command };
  child.stdin.write(`${JSON.stringify(request)}\n`);
  return next((e) => e.type === "response" && e.id === request.id);
};
const prompt = async (message: string) => {
  const settled = next((e) => e.type === "agent_settled");
  const response = await send({ type: "prompt", message });
  if ((response.data as { disposition?: string })?.disposition === "started") await settled;
  return response;
};
const until = async (check: () => Promise<boolean> | boolean, what: string, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
};
const sharedTexts = async () => ((await readShared(sharedPath))?.records ?? []).flatMap((r) => (r.type === "message" ? [contentText(r.content as never)] : []));
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) process.exitCode = 1;
};

try {
  await prompt("hello from pi");
  await prompt(`/atxf join ${sharedPath}`);
  await until(async () => (await sharedTexts()).some((t) => t.includes("hello from pi")), "the shared session");
  check(true, "joining shares the Pi session");

  // Another agent takes a turn: it opens the shared session in its own format, adds a prompt and pushes.
  const other = JSON.parse(opencode.fromAtxf((await readShared(sharedPath))!));
  other.messages.push({ id: "msg_other", type: "user", text: "hello from opencode", files: [], agents: [], skills: [], time: { created: Date.now() } });
  await push(sharedPath, opencode.toAtxf(`${JSON.stringify(other, null, 2)}\n`));

  await until(() => {
    const files = new Bun.Glob("**/*.jsonl").scanSync(sessionDir);
    return [...files].some((f) => readFileSync(join(sessionDir, f), "utf8").includes("hello from opencode"));
  }, "Pi to pull the other agent's turn");
  check(true, "Pi pulls the other agent's turn on its own");

  await prompt("and back to pi");
  const context = JSON.stringify(requests.at(-1));
  check(context.includes("hello from opencode"), "the other agent's turn is in Pi's model context");
  await until(async () => (await sharedTexts()).some((t) => t.includes("and back to pi")), "Pi to push its turn");
  const texts = await sharedTexts();
  check(texts.some((t) => t.startsWith(`pi reply ${requests.length}`)), "Pi's reply reaches the shared session");
  const shared = (await readShared(sharedPath))!;
  check(validateTranscript(serializeTranscript(shared)).ok, "the shared session is valid");
  check(new Set(texts).size === texts.length, "no turn appears twice");
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  child.kill();
  model.stop(true);
}
