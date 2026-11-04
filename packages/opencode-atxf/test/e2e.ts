// End to end with a real OpenCode TUI: `bun packages/opencode-atxf/test/e2e.ts`. Needs `opencode` and `tmux`.
//
// OpenCode runs in tmux with private config, data and state directories and a scripted OpenAI-compatible model.
// It starts a session and joins a shared file; another agent (simulated through the Pi converter) adds a turn;
// OpenCode pulls it on its own, sends it to the model on its next request, and pushes its reply back.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentText, serializeTranscript, validateTranscript } from "@leostera/atxf";
import { pi } from "@leostera/atxf/pi";
import { push, readShared } from "@leostera/atxf/sync";

const root = mkdtempSync(join(tmpdir(), "opencode-atxf-e2e-"));
const project = join(root, "project");
const config = join(root, "config");
const sharedPath = join(root, "shared", "session.atxf.jsonl");
for (const dir of [project, join(config, "opencode")]) mkdirSync(dir, { recursive: true });

const requests: { role: string; content: unknown }[][] = [];
const model = Bun.serve({
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "mock-1", object: "model" }] });
    const body = (await request.json()) as { messages: { role: string; content: unknown }[] };
    requests.push(body.messages);
    const text = `opencode reply ${requests.length}`;
    const chunk = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "mock-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return new Response(chunk({ role: "assistant", content: text }) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  },
});
writeFileSync(
  join(project, "opencode.json"),
  JSON.stringify({
    provider: { mock: { npm: "@ai-sdk/openai-compatible", name: "Mock", api: `http://127.0.0.1:${model.port}/v1`, options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "x" }, models: { "mock-1": { name: "Mock 1" } } } },
    model: "mock/mock-1",
  }),
);
// TUI plugins are declared in the CLI configuration.
writeFileSync(join(config, "opencode", "cli.json"), JSON.stringify({ plugins: [new URL("..", import.meta.url).pathname] }));

const session = `atxf-e2e-${process.pid}`;
const env = { XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache") };
const tmux = (...args: string[]) => execFileSync("tmux", args, { encoding: "utf8" });
tmux("new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", project, "env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), "opencode", "--standalone");
const screen = () => tmux("capture-pane", "-p", "-t", session);
const type = async (text: string) => {
  tmux("send-keys", "-t", session, "-l", text);
  await Bun.sleep(300);
  tmux("send-keys", "-t", session, "Enter");
};
const until = async (check: () => Promise<boolean> | boolean, what: string, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${screen()}`);
    await Bun.sleep(250);
  }
};
const sharedTexts = async () => ((await readShared(sharedPath))?.records ?? []).flatMap((r) => (r.type === "message" ? [contentText(r.content as never)] : []));
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) process.exitCode = 1;
};

try {
  await until(() => screen().includes("mock-1") || screen().length > 200, "the TUI to start");
  await Bun.sleep(1500);
  await type("hello from opencode");
  await until(() => requests.length >= 1 && screen().includes("opencode reply 1"), "the first reply");
  await type(`/atxf join ${sharedPath}`);
  await until(async () => (await sharedTexts()).some((t) => t.includes("hello from opencode")), "the shared session");
  check(true, "joining shares the OpenCode session");

  // Another agent takes a turn: it opens the shared session in its own format, adds a prompt and pushes.
  const other = pi.fromAtxf((await readShared(sharedPath))!);
  const last = other.trimEnd().split("\n").map((l) => JSON.parse(l)).findLast((e) => e.type !== "session");
  const line = { type: "message", id: "pi-turn", parentId: last?.id ?? null, timestamp: new Date().toISOString(), message: { role: "user", content: "hello from pi", timestamp: Date.now() } };
  await push(sharedPath, pi.toAtxf(`${other.endsWith("\n") ? other : `${other}\n`}${JSON.stringify(line)}\n`));

  await until(() => screen().includes("hello from pi"), "OpenCode to pull the other agent's turn");
  check(true, "OpenCode pulls the other agent's turn on its own");

  await type("and back to opencode");
  // OpenCode also asks the model for titles, so find the request that carries the new prompt.
  const asked = () => requests.findIndex((messages) => JSON.stringify(messages).includes("and back to opencode"));
  await until(() => asked() >= 0, "the model request for the new prompt");
  check(JSON.stringify(requests[asked()]).includes("hello from pi"), "the other agent's turn is in OpenCode's model context");
  await until(async () => (await sharedTexts()).some((t) => t.includes("and back to opencode")), "OpenCode to push its turn", 20_000);
  await until(async () => (await sharedTexts()).some((t) => t.includes(`opencode reply ${asked() + 1}`)), "OpenCode's reply in the shared session", 20_000);
  check(true, "OpenCode's reply reaches the shared session");
  const shared = (await readShared(sharedPath))!;
  check(validateTranscript(serializeTranscript(shared)).ok, "the shared session is valid");
  const texts = await sharedTexts();
  check(new Set(texts).size === texts.length, "no turn appears twice");
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  if (process.env.E2E_KEEP) console.log(`tmux attach -t ${session}   (${root})`);
  else try { tmux("kill-session", "-t", session); } catch {}
  model.stop(true);
}
