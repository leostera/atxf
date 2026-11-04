// One session across two real agents: `bun test/e2e/pi-opencode.ts`. Needs `pi`, `opencode` and `tmux` on PATH.
//
// Pi runs in RPC mode with the pi-atxf extension; OpenCode runs its TUI in tmux with the opencode-atxf plugin. Both
// talk to a scripted OpenAI-compatible model and use their own temporary state, so nothing touches the user's stores.
// Pi starts a session and joins a shared file; OpenCode joins the same file and takes a turn; Pi pulls it and answers;
// OpenCode pulls that answer. Each agent's model request must carry the other agent's turns.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { contentText, serializeTranscript, validateTranscript } from "@leostera/atxf";
import { readShared } from "@leostera/atxf/sync";

const repo = new URL("../..", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "atxf-pi-opencode-"));
const dirs = { pi: join(root, "pi"), opencode: join(root, "opencode"), project: join(root, "project") };
const sharedPath = join(root, "shared", "session.atxf.jsonl");
for (const dir of [...Object.values(dirs), join(dirs.pi, "agent"), join(dirs.opencode, "config", "opencode")]) mkdirSync(dir, { recursive: true });

// One scripted model; the path prefix tells the agents apart.
type Messages = { role: string; content: unknown }[];
const requests: { agent: string; messages: Messages }[] = [];
const model = Bun.serve({
  port: 0,
  async fetch(request) {
    const [, agent] = new URL(request.url).pathname.split("/");
    if (request.url.endsWith("/models")) return Response.json({ data: [{ id: "mock-1", object: "model" }] });
    const { messages } = (await request.json()) as { messages: Messages };
    requests.push({ agent, messages });
    const chunk = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "mock-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const text = `${agent} reply ${requests.length}`;
    return new Response(chunk({ role: "assistant", content: text }) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  },
});
const api = (agent: string) => `http://127.0.0.1:${model.port}/${agent}/v1`;
/** The model request that carried `prompt`, and the reply text it got. */
const requestFor = (prompt: string) => {
  const index = requests.findIndex((r) => JSON.stringify(r.messages).includes(prompt));
  return index < 0 ? undefined : { ...requests[index], reply: `${requests[index].agent} reply ${index + 1}` };
};

// Pi, in RPC mode.
writeFileSync(
  join(dirs.pi, "agent", "models.json"),
  JSON.stringify({ providers: { mock: { baseUrl: api("pi"), api: "openai-completions", apiKey: "x", models: [{ id: "mock-1" }] } } }),
);
const pi = spawn(
  "pi",
  ["--mode", "rpc", "--offline", "-ne", "-e", join(repo, "packages/pi-atxf/src/index.ts"), "--no-mcp", "-ns", "-np", "-nc", "--no-themes"]
    .concat(["--model", "mock/mock-1", "--session-dir", join(dirs.pi, "sessions")]),
  { cwd: dirs.project, env: { ...process.env, PI_CODING_AGENT_DIR: join(dirs.pi, "agent"), XDG_STATE_HOME: join(dirs.pi, "state") }, stdio: ["pipe", "pipe", "pipe"] },
);
const waiters: { match: (e: Record<string, unknown>) => boolean; resolve: () => void }[] = [];
createInterface({ input: pi.stdout }).on("line", (line) => {
  const event = JSON.parse(line) as Record<string, unknown>;
  for (const waiter of waiters.splice(0)) (waiter.match(event) ? waiter.resolve() : waiters.push(waiter));
});
const piEvent = (match: (e: Record<string, unknown>) => boolean) => new Promise<void>((resolve) => waiters.push({ match, resolve }));
let rpcId = 0;
const piPrompt = async (message: string) => {
  const id = `r${++rpcId}`;
  const settled = piEvent((e) => e.type === "agent_settled");
  const responded = piEvent((e) => e.type === "response" && e.id === id);
  pi.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
  await responded;
  if (!message.startsWith("/")) await settled;
};

// OpenCode, in its TUI. The provider comes from the project config; the TUI plugin from the CLI config.
writeFileSync(
  join(dirs.project, "opencode.json"),
  JSON.stringify({
    provider: { mock: { npm: "@ai-sdk/openai-compatible", name: "Mock", api: api("opencode"), options: { baseURL: api("opencode"), apiKey: "x" }, models: { "mock-1": { name: "Mock 1" } } } },
    model: "mock/mock-1",
  }),
);
writeFileSync(join(dirs.opencode, "config", "opencode", "cli.json"), JSON.stringify({ plugins: [join(repo, "packages/opencode-atxf")] }));
const tmuxSession = `atxf-pi-opencode-${process.pid}`;
const tmux = (...args: string[]) => execFileSync("tmux", args, { encoding: "utf8" });
const env = ["config", "data", "state", "cache"].map((kind) => `XDG_${kind.toUpperCase()}_HOME=${join(dirs.opencode, kind)}`);
tmux("new-session", "-d", "-s", tmuxSession, "-x", "200", "-y", "50", "-c", dirs.project, "env", ...env, "PI_CODING_AGENT_DIR=/nonexistent", "opencode", "--standalone");
const screen = () => tmux("capture-pane", "-p", "-t", tmuxSession);
const opencodeType = async (text: string) => {
  tmux("send-keys", "-t", tmuxSession, "-l", text);
  await Bun.sleep(300);
  tmux("send-keys", "-t", tmuxSession, "Enter");
};

const until = async (check: () => Promise<boolean> | boolean, what: string, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${screen()}`);
    await Bun.sleep(250);
  }
};
const sharedTexts = async () => ((await readShared(sharedPath))?.records ?? []).flatMap((r) => (r.type === "message" ? [contentText(r.content as never)] : []));
const shared = async (text: string) => (await sharedTexts()).some((t) => t.includes(text));
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) process.exitCode = 1;
};

try {
  // Pi starts the session and shares it.
  await piPrompt("hello from pi");
  await piPrompt(`/atxf join ${sharedPath}`);
  await until(() => shared("hello from pi"), "Pi to share its session");
  check(true, "Pi shares its session");

  // OpenCode joins: its session becomes a copy of the shared one.
  await until(() => screen().includes("Ask anything"), "the OpenCode TUI to start");
  await opencodeType("opening opencode");
  await until(() => requestFor("opening opencode") !== undefined && screen().includes("opencode reply"), "OpenCode's first reply");
  await opencodeType(`/atxf join ${sharedPath}`);
  await until(() => screen().includes("hello from pi"), "OpenCode to load the shared session");
  check(true, "OpenCode joins the shared session");

  // OpenCode takes a turn with Pi's turn in context, and pushes it.
  await opencodeType("hello from opencode");
  await until(() => requestFor("hello from opencode") !== undefined, "OpenCode's model request");
  const fromOpencode = requestFor("hello from opencode")!;
  check(fromOpencode.agent === "opencode" && JSON.stringify(fromOpencode.messages).includes("hello from pi"), "Pi's turn is in OpenCode's model context");
  await until(() => shared(fromOpencode.reply), "OpenCode to push its turn");
  check(true, "OpenCode pushes its turn");

  // Pi pulls OpenCode's turn on its own, then answers with it in context.
  await Bun.sleep(1_000);
  await piPrompt("and back to pi");
  const fromPi = requestFor("and back to pi")!;
  check(fromPi?.agent === "pi" && JSON.stringify(fromPi.messages).includes("hello from opencode") && JSON.stringify(fromPi.messages).includes(fromOpencode.reply), "OpenCode's turn is in Pi's model context");
  await until(() => shared(fromPi.reply), "Pi to push its turn");

  // OpenCode pulls Pi's answer on its own.
  await until(() => screen().includes(fromPi.reply), "OpenCode to pull Pi's answer");
  check(true, "OpenCode pulls Pi's answer");

  const transcript = (await readShared(sharedPath))!;
  check(validateTranscript(serializeTranscript(transcript)).ok, "the shared session is valid");
  const texts = await sharedTexts();
  check(new Set(texts).size === texts.length, "no turn appears twice");
  check(!texts.some((t) => t.includes("opening opencode")), "OpenCode's pre-join turn stays local");
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  if (process.env.E2E_KEEP) console.log(`tmux attach -t ${tmuxSession}   (${root})`);
  else
    try {
      tmux("kill-session", "-t", tmuxSession);
    } catch {}
  pi.kill();
  model.stop(true);
}
