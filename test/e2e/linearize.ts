// Linearizing sessions across real agents: `bun test/e2e/linearize.ts [scenario...]`.
//
// Needs `pi`, `codex` and `opencode` on PATH; Claude Code runs through `bunx @anthropic-ai/claude-code`. Every agent
// talks to one scripted model (OpenAI chat completions, OpenAI Responses and Anthropic messages) and keeps its
// state in a temporary directory, so nothing touches the user's stores.
//
// In each scenario, agent A starts a session and its file is copied to agent B, as when a session moves to a second
// machine or a second agent (through ATXF, carried). A and B are each told a different codeword. Both copies are read
// into ATXF, reconciled (SPEC §18), linearized (§18.1), and written for agent C, which continues the session and is
// asked for both codewords: its model request must carry both, A's first, and both copies' tool results. On a
// codeword turn the model first runs a shell command with the agent's own tool, so every copy holds a tool call.
//
// `ATXF_E2E_PI_MODEL=provider/model` has Pi answer as C with a real model, which must name both codewords.
// `ATXF_E2E_KEEP=1` keeps every agent's files. Arguments pick scenarios: an agent (`codex`), `a,b,c`, or `fan-out`
// (Pi forks 10 subagents, and `atxf linearize` merges them back).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { buildContext, contentText, indexTree, leaves, linearize, serializeTranscript, validateTranscript, type Transcript } from "../../packages/atxf-ts/src/index.ts";
import { formats } from "../../packages/atxf-ts/src/formats/index.ts";
import { reconcile } from "../../packages/atxf-ts/src/reconcile.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "atxf-linearize-e2e-")));
const project = join(root, "project");
mkdirSync(project, { recursive: true });

// ---------------------------------------------------------------------------------------------------------------
// The scripted model: it records each request's text and answers with a short line, in the API it was asked in.

const requests: { agent: string; text: string }[] = [];
const model = Bun.serve({
  port: 0,
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    const agent = url.pathname.split("/")[1]!;
    if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "mock-1", object: "model" }], models: [] });
    if (request.method !== "POST") return Response.json({});
    const text = await request.text();
    requests.push({ agent, text });
    const reply = `Noted (${agent} ${requests.length}).`;
    const call = toolCall(text, requests.length);
    const headers = { "content-type": "text/event-stream" };
    if (url.pathname.endsWith("/chat/completions")) return new Response(chatCompletion(reply, call), { headers });
    if (url.pathname.endsWith("/responses")) return new Response(responses(reply, requests.length, call), { headers });
    if (url.pathname.endsWith("/messages")) return new Response(anthropic(reply, requests.length, call), { headers });
    return Response.json({});
  },
});
const api = (agent: string) => `http://127.0.0.1:${model.port}/${agent}`;

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * On a codeword turn, before the tool has run, the model runs `echo ONE-$((40+2))` (or TWO) with the agent's shell
 * tool. Its output, `ONE-42`, is in no prompt or call, so finding it in a later request means the result got there.
 */
function toolCall(request: string, n: number): ToolCall | undefined {
  const prompts = ["We are naming a release", "Codeword one is", "Codeword two is", "What are the two codewords"];
  const [last, at] = prompts.map((p) => [p, request.lastIndexOf(p)] as const).reduce((a, b) => (b[1] > a[1] ? b : a));
  const word = last === "Codeword one is" ? "ONE" : last === "Codeword two is" ? "TWO" : undefined;
  if (word === undefined || at < 0 || request.indexOf(`${word}-42`, at) >= 0) return undefined;
  const body = JSON.parse(request) as { tools?: { name?: string; function?: { name: string } }[] };
  const shells: Record<string, string> = { bash: "command", Bash: "command", shell: "command", exec_command: "cmd" };
  const name = (body.tools ?? []).map((t) => t.function?.name ?? t.name ?? "").find((t) => t in shells);
  if (name === undefined) return undefined;
  return { id: `call_${n}`, name, arguments: JSON.stringify({ [shells[name]!]: `echo ${word}-$((40+2))` }) };
}

function chatCompletion(text: string, call?: ToolCall) {
  const chunk = (delta: unknown, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "mock-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  if (call) {
    const delta = { role: "assistant", tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }] };
    return `${chunk(delta)}${chunk({}, "tool_calls")}data: [DONE]\n\n`;
  }
  return `${chunk({ role: "assistant", content: text })}${chunk({}, "stop")}data: [DONE]\n\n`;
}

function responses(text: string, n: number, call?: ToolCall) {
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const item = call
    ? { type: "function_call", id: `fc_${n}`, call_id: call.id, name: call.name, arguments: call.arguments, status: "completed" }
    : { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  const response = { id: `resp_${n}`, object: "response", status: "completed", model: "mock-1", output: [item], usage };
  return [
    event("response.created", { response: { ...response, status: "in_progress", output: [] } }),
    event("response.output_item.added", { output_index: 0, item }),
    ...(call ? [] : [event("response.output_text.delta", { output_index: 0, content_index: 0, item_id: item.id, delta: text })]),
    event("response.output_item.done", { output_index: 0, item }),
    event("response.completed", { response }),
  ].join("");
}

function anthropic(text: string, n: number, call?: ToolCall) {
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const message = { id: `msg_${n}`, type: "message", role: "assistant", model: "claude-mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } };
  const block = call
    ? [
        event("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${n}`, name: call.name, input: {} } }),
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: call.arguments } }),
      ]
    : [event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }), event("content_block_delta", { index: 0, delta: { type: "text_delta", text } })];
  return [
    event("message_start", { message }),
    ...block,
    event("content_block_stop", { index: 0 }),
    event("message_delta", { delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
    event("message_stop", {}),
  ].join("");
}

// ---------------------------------------------------------------------------------------------------------------
// Agents. Each runs one turn per process, in its own home, and can be handed a native session file to continue.

interface Session {
  /** The agent's own id for the session. */
  id: string;
  /** Where the agent keeps it (a file, or for OpenCode the session's export). */
  file: string;
}

interface Agent {
  name: keyof typeof formats;
  /** Starts a session with `prompt`. */
  start(home: string, prompt: string): Promise<Session>;
  /** Continues `session` with `prompt`. */
  turn(home: string, session: Session, prompt: string): Promise<void>;
  /** The session's native text, as the agent keeps it now. */
  read(home: string, session: Session): Promise<string>;
  /** Hands the agent a native session to continue. */
  install(home: string, text: string): Promise<Session>;
}

async function run(command: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<string> {
  const cwd = options.cwd ?? project;
  // OpenCode takes its directory from $PWD, not the process's working directory.
  const child = Bun.spawn(command, { cwd, env: { ...process.env, PWD: cwd, ...options.env }, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 240_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${command.slice(0, 3).join(" ")} exited with ${code}\n${stderr.slice(-2000)}\n${stdout.slice(-1000)}`);
  return stdout;
}

const filesUnder = (dir: string, suffix: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const path = join(d, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(suffix)) out.push(path);
    }
  };
  try {
    walk(dir);
  } catch {}
  return out;
};
const newest = (files: string[]) => files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!;

const piAgent: Agent = {
  name: "pi",
  async start(home, prompt) {
    const sessions = join(home, "sessions");
    await this.turn(home, { id: "", file: sessions }, prompt);
    const file = newest(filesUnder(sessions, ".jsonl"));
    return { id: basename(file), file };
  },
  async turn(home, session, prompt) {
    const real = process.env.ATXF_E2E_PI_MODEL;
    if (real && basename(home) === "c") {
      // The real model and its provider come from the user's Pi agent directory and extensions.
      const where = ["--session", session.file];
      answers.push(await run(["pi", "-p", "--no-mcp", "-ns", "-np", "-nc", "--no-themes", "--model", real, ...where, prompt]));
      return;
    }
    mkdirSync(join(home, "agent"), { recursive: true });
    const provider = { baseUrl: `${api("pi")}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "mock-1" }] };
    writeFileSync(join(home, "agent", "models.json"), JSON.stringify({ providers: { mock: provider } }));
    const where = session.id ? ["--session", session.file] : ["--session-dir", session.file];
    await run(["pi", "-p", "--offline", "-ne", "--no-mcp", "-ns", "-np", "-nc", "--no-themes", "--model", "mock/mock-1", ...where, prompt], { env: { PI_CODING_AGENT_DIR: join(home, "agent") } });
  },
  async read(_home, session) {
    return readFileSync(session.file, "utf8");
  },
  async install(home, text) {
    const file = join(home, "sessions", `installed-${Date.now()}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return { id: basename(file), file };
  },
};

const codexAgent: Agent = {
  name: "codex",
  async start(home, prompt) {
    await this.turn(home, { id: "", file: "" }, prompt);
    const file = newest(filesUnder(join(home, "sessions"), ".jsonl"));
    return { id: codexId(readFileSync(file, "utf8")), file };
  },
  async turn(home, session, prompt) {
    const provider = `model_providers.mock={name="mock",base_url="${api("codex")}/v1",wire_api="responses",env_key="MOCK_KEY"}`;
    const flags = ["--skip-git-repo-check", "-c", "model_provider=mock", "-c", provider, "-m", "mock-1"];
    const command = session.id ? ["codex", "exec", "resume", ...flags, session.id, prompt] : ["codex", "exec", ...flags, prompt];
    await run(command, { env: { CODEX_HOME: home, MOCK_KEY: "x" } });
  },
  async read(_home, session) {
    return readFileSync(session.file, "utf8");
  },
  async install(home, text) {
    const id = codexId(text);
    const file = join(home, "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-00-${id}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return { id, file };
  },
};
function codexId(text: string): string {
  const meta = JSON.parse(text.slice(0, text.indexOf("\n"))) as { type: string; payload: { id: string } };
  if (meta.type !== "session_meta") throw new Error("a rollout without session_meta");
  return meta.payload.id;
}

const opencodeEnv = (home: string) => ({ XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache") });
const opencodeAgent: Agent = {
  name: "opencode",
  async start(home, prompt) {
    const before = new Set(await opencodeSessions(home));
    await this.turn(home, { id: "", file: "" }, prompt);
    const id = (await opencodeSessions(home)).find((s) => !before.has(s))!;
    return { id, file: id };
  },
  async turn(home, session, prompt) {
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    const provider = { npm: "@ai-sdk/openai-compatible", name: "Mock", options: { baseURL: `${api("opencode")}/v1`, apiKey: "x" }, models: { "mock-1": { name: "Mock 1" } } };
    writeFileSync(join(cwd, "opencode.json"), JSON.stringify({ provider: { mock: provider }, model: "mock/mock-1" }));
    await run(["opencode", "run", "--standalone", "--auto", "-m", "mock/mock-1", ...(session.id ? ["-s", session.id] : []), prompt], { cwd, env: opencodeEnv(home) });
  },
  async read(home, session) {
    return run(["opencode", "session", "export", "--standalone", session.id], { cwd: join(home, "project"), env: opencodeEnv(home) });
  },
  async install(home, text) {
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    const file = join(home, `import-${Date.now()}.json`);
    writeFileSync(file, text);
    await run(["opencode", "session", "import", "--standalone", file], { cwd, env: opencodeEnv(home) });
    const id = (JSON.parse(text) as { info: { id: string } }).info.id;
    return { id, file: id };
  },
};
async function opencodeSessions(home: string): Promise<string[]> {
  const cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true });
  const out = await run(["opencode", "session", "list", "--standalone"], { cwd, env: opencodeEnv(home) }).catch(() => "");
  return out.split("\n").flatMap((line) => (line.startsWith("ses_") ? [line.split("\t")[0]!] : []));
}

const claudeEnv = (home: string) => ({ CLAUDE_CONFIG_DIR: home, ANTHROPIC_BASE_URL: api("claude"), ANTHROPIC_API_KEY: "x" });
const claudeAgent: Agent = {
  name: "claude-code",
  async start(home, prompt) {
    await this.turn(home, { id: "", file: "" }, prompt);
    const file = newest(filesUnder(join(home, "projects"), ".jsonl"));
    return { id: basename(file, ".jsonl"), file };
  },
  async turn(home, session, prompt) {
    const resume = session.id ? ["--resume", session.id] : [];
    await run(["bunx", "@anthropic-ai/claude-code@latest", "-p", "--model", "claude-mock", "--allowedTools=Bash", ...resume, prompt], { env: claudeEnv(home) });
  },
  async read(_home, session) {
    return readFileSync(session.file, "utf8");
  },
  async install(home, text) {
    const first = text.split("\n").map((line) => (line ? (JSON.parse(line) as { sessionId?: string }) : {})).find((entry) => entry.sessionId);
    const id = first?.sessionId ?? crypto.randomUUID();
    const file = join(home, "projects", project.replaceAll("/", "-").replaceAll(".", "-"), `${id}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return { id, file };
  },
};

const agents = { pi: piAgent, codex: codexAgent, opencode: opencodeAgent, claude: claudeAgent };

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const CODEWORDS = ["MARMALADE", "TANGERINE"];
/** What a real model answered, with `ATXF_E2E_PI_MODEL`. */
const answers: string[] = [];
let failed = 0;
const check = (ok: boolean, what: string, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failed++;
};

async function scenario(a: Agent, b: Agent, c: Agent) {
  const label = `${a.name} + ${b.name} → ${c.name}`;
  console.log(`\n# ${label}`);
  const dir = join(root, label.replace(/[^a-z]+/g, "-"));
  const home = (n: string) => join(dir, n);
  for (const n of ["a", "b", "c"]) mkdirSync(home(n), { recursive: true });
  try {
    const sessionA = await a.start(home("a"), "We are naming a release. I will tell you codewords; remember each one. Reply with one short line.");
    // B gets A's session in its own format: the same file for the same agent, or through ATXF, carried.
    const textA = await a.read(home("a"), sessionA);
    const handed = a.name === b.name ? textA : formats[b.name].fromAtxf(formats[a.name].toAtxf(textA));
    const sessionB = await b.install(home("b"), handed);
    await a.turn(home("a"), sessionA, `Codeword one is ${CODEWORDS[0]}. Reply with one short line.`);
    await b.turn(home("b"), sessionB, `Codeword two is ${CODEWORDS[1]}. Reply with one short line.`);

    const copies = [formats[a.name].toAtxf(await a.read(home("a"), sessionA)), formats[b.name].toAtxf(await b.read(home("b"), sessionB))];
    check(copies[0]!.header.id === copies[1]!.header.id, "both copies read as the same session", `${copies[0]!.header.id} and ${copies[1]!.header.id}`);
    const reconciled = reconcile(copies).transcript;
    const branches = leaves(indexTree(reconciled)).length;
    check(branches >= 2, `the copies reconcile into branches (${branches})`);
    const { transcript: linear } = linearize(reconciled);
    check(validateTranscript(serializeTranscript(linear)).ok, "the linearized session is valid");
    const context = contextText(linear);
    check(CODEWORDS.every((word) => context.includes(word)), "its context holds both codewords");
    check(["ONE-42", "TWO-42"].every((output) => context.includes(output)), "and both tool results", `ONE-42: ${context.includes("ONE-42")}, TWO-42: ${context.includes("TWO-42")}`);

    const sessionC = await c.install(home("c"), formats[c.name].fromAtxf(linear, { carry: false, tree: true }));
    const before = requests.length;
    await c.turn(home("c"), sessionC, "What are the two codewords? Answer with just the two words.");
    if (process.env.ATXF_E2E_PI_MODEL && c.name === "pi") {
      const answer = answers.at(-1) ?? "";
      check(CODEWORDS.every((word) => answer.toUpperCase().includes(word)), `a real model answers with both codewords: ${JSON.stringify(answer.trim().slice(0, 80))}`);
      return;
    }
    const asked = requests.slice(before).filter((r) => r.text.includes("What are the two codewords"));
    const sent = asked.at(-1)?.text ?? "";
    check(asked.length > 0, `${c.name} asked the model`);
    check(CODEWORDS.every((word) => sent.includes(word)), `${c.name} sent both codewords to the model`, `found ${CODEWORDS.filter((w) => sent.includes(w)).join(", ") || "neither"}`);
    check(sent.indexOf(CODEWORDS[0]!) < sent.indexOf(CODEWORDS[1]!), "in the order they were told");
    const ran = ["ONE-42", "TWO-42"].filter((output) => sent.includes(output));
    check(ran.length === 2, `${c.name} sent both copies' tool results to the model`, `found ${ran.join(", ") || "neither"}`);
    // Each prompt once: the prefix the copies share is not repeated, and no turn comes twice.
    const times = (needle: string) => sent.split(needle).length - 1;
    const counts = ["We are naming a release", `Codeword one is ${CODEWORDS[0]}`, `Codeword two is ${CODEWORDS[1]}`].map(times);
    check(counts.every((n) => n === 1), "each earlier prompt reaches the model once", `counts ${counts.join(", ")}`);
    // Codex adds its environment as a user message of its own, and `opencode run` quotes the prompt it stores, so
    // count the prompts by their text, not the user messages.
    const prompts = linear.records.flatMap((r) => (r.type === "message" && r.role === "user" ? [contentText(r.content as never)] : []));
    const once = ["We are naming a release", `Codeword one is`, `Codeword two is`].map((p) => prompts.filter((t) => t.includes(p)).length);
    check(once.every((n) => n === 1), "the linear session holds each prompt once", `counts ${once.join(", ")}`);

    const after = formats[c.name].toAtxf(await c.read(home("c"), sessionC));
    const told = contextText(after);
    check(CODEWORDS.every((word) => told.includes(word)) && told.includes("What are the two codewords"), `${c.name}'s session reads back with every turn`);
  } catch (error) {
    check(false, label, (error as Error).message.slice(0, 1500));
  }
}

/**
 * Fan out and back: a Pi session forks `count` subagents (`pi --fork`), each suggesting its own name, and
 * `atxf linearize --from pi --to pi` merges the session and every fork into one session file, which Pi continues.
 */
async function fanOut(count: number) {
  const label = `pi forks ${count} subagents → pi`;
  console.log(`\n# ${label}`);
  const dir = join(root, `fan-out-${count}`);
  // Ordinary words: a real model asked to repeat "codewords" from subagents may take them for secrets.
  const words = ["AMBER", "BIRCH", "CEDAR", "DAHLIA", "EMBER", "FALCON", "GRANITE", "HARBOR", "IVORY", "JUNIPER", "KESTREL", "LANTERN"].slice(0, count);
  try {
    const main = await piAgent.start(join(dir, "main"), "We are naming a release. Each helper will suggest one name. Reply with one short line.");
    const forks: string[] = [];
    for (const [k, word] of words.entries()) {
      const sessions = join(dir, `fork-${k}`, "sessions");
      const home = join(dir, `fork-${k}`);
      mkdirSync(join(home, "agent"), { recursive: true });
      writeFileSync(join(home, "agent", "models.json"), readFileSync(join(dir, "main", "agent", "models.json")));
      await run(["pi", "-p", "--offline", "-ne", "--no-mcp", "-ns", "-np", "-nc", "--no-themes", "--model", "mock/mock-1", "--fork", main.file, "--session-dir", sessions, `Helper ${k + 1} suggests the name ${word}. Reply with one short line.`], {
        env: { PI_CODING_AGENT_DIR: join(home, "agent") },
      });
      forks.push(newest(filesUnder(sessions, ".jsonl")));
    }
    const cli = join(import.meta.dir, "../../packages/atxf-ts/src/cli.ts");
    const merged = await run(["bun", cli, "linearize", "--from", "pi", "--to", "pi", main.file, ...forks]);
    const sessionC = await piAgent.install(join(dir, "c"), merged);
    const linear = formats.pi.toAtxf(merged);
    check(leaves(indexTree(linear)).length === 1, "the merged session is one path");
    const before = requests.length;
    await piAgent.turn(join(dir, "c"), sessionC, `List the ${count} suggested names, in capitals, separated by commas.`);
    if (process.env.ATXF_E2E_PI_MODEL) {
      const answer = (answers.at(-1) ?? "").toUpperCase();
      const found = words.filter((word) => answer.includes(word));
      check(found.length === count, `a real model names all ${count} suggestions (${found.length})`, answer.slice(0, 200));
      return;
    }
    const sent = requests.slice(before).find((r) => r.text.includes(`List the ${count} suggested names`))?.text ?? "";
    const found = words.filter((word) => sent.includes(word));
    check(found.length === count, `pi sent all ${count} subagents' suggestions to the model (${found.length})`);
    check(sent.split("We are naming a release").length - 1 === 1, "and the session they forked from once");
    check(words.every((word) => sent.split(word).length - 1 === 1), "each subagent's suggestion once");
  } catch (error) {
    check(false, label, (error as Error).message.slice(0, 1500));
  }
}

function contextText(transcript: Transcript): string {
  return buildContext(transcript).messages.map((m) => (typeof m.body.content === "string" ? m.body.content : contentText(m.body.content as never))).join("\n");
}

const all: [Agent, Agent, Agent][] = [
  [piAgent, piAgent, piAgent],
  [codexAgent, codexAgent, codexAgent],
  [opencodeAgent, opencodeAgent, opencodeAgent],
  [claudeAgent, claudeAgent, claudeAgent],
  [piAgent, codexAgent, opencodeAgent],
  [claudeAgent, opencodeAgent, codexAgent],
  [codexAgent, claudeAgent, piAgent],
  [opencodeAgent, piAgent, claudeAgent],
];
const wanted = process.argv.slice(2);
try {
  for (const [a, b, c] of all) {
    const names = [a, b, c].map((x) => Object.entries(agents).find(([, v]) => v === x)![0]);
    if (wanted.length && !wanted.some((w) => names.join(",") === w || names.every((n) => n === w))) continue;
    await scenario(a, b, c);
  }
  if (wanted.length === 0 || wanted.includes("fan-out")) await fanOut(10);
} finally {
  model.stop(true);
  if (!process.env.ATXF_E2E_KEEP) rmSync(root, { recursive: true, force: true });
  else console.log(`\nkept ${root}`);
}
console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
process.exitCode = failed ? 1 : 0;
