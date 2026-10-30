import {
  buildContext,
  carriedValue,
  compact,
  defineConverter,
  EPOCH,
  isObject,
  isoTime,
  jsonl,
  nativeOf,
  TreeBuilder,
  type AssistantBlock,
  type DecodeContext,
  type Encoded,
  type EntryRecord,
  type J,
  type MessageBody,
  type Transcript,
  type TranscriptHeader,
  type Unit,
  type Usage,
  type UserBlock,
  type UserContent,
} from "@atxf/core";

/**
 * Codex rollout files (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), following `codex-rs/history` and
 * `codex-rs/protocol` at commit 4bc746c. Each line is `{timestamp, ordinal?, type, payload}`.
 */
export const AGENT = "codex";
export const FORMAT = "codex/rollout-jsonl";

// ---------------------------------------------------------------------------------------------------------------
// Codex → ATXF. Rollouts are linear: each record's parent is the record before it.

function decode(units: Unit[], context: DecodeContext): { header: TranscriptHeader; records: EntryRecord[] } {
  const tree = new TreeBuilder(context);
  const native = (unit: Unit) => nativeOf([unit], AGENT, FORMAT);
  let start = 0;
  let header: TranscriptHeader;
  const first = units[0]?.value;
  if (isObject(first) && first.type === "session_meta" && isObject(first.payload) && !context.known.has(0)) {
    header = sessionHeader(first, native(units[0]!));
    start = 1;
  } else {
    header = sessionHeader({}, undefined);
  }
  let provider = isObject(first) && isObject(first.payload) && typeof first.payload.model_provider === "string" ? first.payload.model_provider : "openai";
  let turns = 0;

  for (let index = start; index < units.length; index++) {
    const unit = units[index]!;
    if (context.known.has(index)) {
      const known = context.known.get(index);
      if (known) tree.last = known;
      continue;
    }
    const line: J = isObject(unit.value) ? unit.value : {};
    const payload: J = isObject(line.payload) ? line.payload : {};
    const id = context.ids.take(`codex-${index + 1}`);
    const node = { id, parentId: tree.last, time: isoTime(line.timestamp, header.time) };
    const push = (record: EntryRecord) => tree.push(record, native(unit));
    const custom = (name: string) => push({ type: "custom", ...node, namespace: AGENT, name });

    switch (line.type) {
      case "response_item": {
        const body = responseItem(payload, tree);
        if (!body) {
          custom(`response_item:${typeof payload.type === "string" ? payload.type : "unknown"}`);
          break;
        }
        push({ type: "message", ...node, ...body } as EntryRecord);
        break;
      }
      case "turn_context":
        if (typeof payload.model === "string") provider = typeof payload.model_provider === "string" ? payload.model_provider : provider;
        push(
          compact({
            type: "settings" as const,
            ...node,
            model: typeof payload.model === "string" ? { provider, id: payload.model } : undefined,
            reasoningEffort: typeof payload.effort === "string" ? payload.effort : undefined,
            cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
            policy:
              payload.approval_policy !== undefined || payload.sandbox_policy !== undefined
                ? compact({ approval: payload.approval_policy, sandbox: payload.sandbox_policy })
                : undefined,
          }),
        );
        break;
      case "compacted": {
        const replacement = Array.isArray(payload.replacement_history)
          ? payload.replacement_history.flatMap((item: unknown) => {
              const body = isObject(item) ? responseItem(isObject(item.item) ? item.item : item, undefined) : undefined;
              return body && body.role !== "tool" ? [body] : [];
            })
          : undefined;
        if (replacement && replacement.length > 0) push({ type: "compaction", ...node, strategy: "replace", replacement });
        else if (typeof payload.message === "string") push({ type: "compaction", ...node, strategy: "summary", summary: payload.message, firstKeptId: null });
        else custom("compacted");
        break;
      }
      case "event_msg": {
        const event = typeof payload.type === "string" ? payload.type : "unknown";
        if (event === "task_started" || event === "turn_started") {
          push({ type: "turn", ...node, phase: "start", turnId: typeof payload.turn_id === "string" ? payload.turn_id : `turn-${++turns}` });
        } else if (event === "task_complete" || event === "turn_complete" || event === "turn_aborted") {
          push({
            type: "turn",
            ...node,
            phase: "end",
            turnId: typeof payload.turn_id === "string" ? payload.turn_id : `turn-${turns}`,
            outcome: event === "turn_aborted" ? "interrupted" : "succeeded",
          });
        } else if (event === "token_count" && isObject(payload.info) && tokenUsage(payload.info.total_token_usage)) {
          push({ type: "usage", ...node, kind: "token_count", usage: tokenUsage(payload.info.total_token_usage)!, cumulative: true });
        } else {
          custom(`event_msg:${event}`);
        }
        break;
      }
      case "token_usage_record": {
        const usage = tokenUsage(payload.total_token_usage ?? payload.usage ?? payload);
        if (usage) push({ type: "usage", ...node, kind: "token_usage_record", usage, cumulative: true });
        else custom("token_usage_record");
        break;
      }
      default:
        custom(typeof line.type === "string" ? line.type : "unparsed");
    }
  }
  return { header, records: tree.records };
}

function sessionHeader(line: J, native: ReturnType<typeof nativeOf> | undefined): TranscriptHeader {
  const meta: J = isObject(line.payload) ? line.payload : {};
  const git: J = isObject(meta.git) ? meta.git : {};
  const parent = typeof meta.forked_from_id === "string" ? meta.forked_from_id : typeof meta.parent_thread_id === "string" ? meta.parent_thread_id : undefined;
  return compact({
    type: "transcript" as const,
    atxf: "0.1" as const,
    id: typeof meta.id === "string" && meta.id !== "" ? meta.id : "codex-session",
    time: isoTime(meta.timestamp, isoTime(line.timestamp, EPOCH)),
    source: compact({
      agent: AGENT,
      format: FORMAT,
      version: typeof meta.cli_version === "string" ? meta.cli_version : undefined,
      sessionId: typeof meta.id === "string" ? meta.id : undefined,
    }),
    workspace:
      typeof meta.cwd === "string" || typeof git.branch === "string"
        ? compact({
            cwd: typeof meta.cwd === "string" ? meta.cwd : undefined,
            vcs:
              typeof git.branch === "string" || typeof git.commit_hash === "string"
                ? compact({
                    type: "git",
                    branch: typeof git.branch === "string" ? git.branch : undefined,
                    commit: typeof git.commit_hash === "string" ? git.commit_hash : undefined,
                    remote: typeof git.repository_url === "string" ? git.repository_url : undefined,
                  })
                : undefined,
          })
        : undefined,
    parent: parent ? { transcriptId: parent, relation: typeof meta.forked_from_id === "string" ? ("fork" as const) : ("subagent" as const) } : undefined,
    fidelity: {
      topology: "linear" as const,
      instructions: "partial" as const,
      turns: true,
      usage: "aggregate" as const,
      native: "all" as const,
      ids: "synthetic" as const,
    },
    native,
  });
}

/** A Responses item as a message body, or undefined when it has none (or, without a tree, a tool call). */
function responseItem(item: J, tree: TreeBuilder | undefined): MessageBody | undefined {
  switch (item.type) {
    case "message": {
      if (!Array.isArray(item.content)) return undefined;
      if (item.role === "assistant") {
        const content: AssistantBlock[] = item.content.flatMap((part: unknown) =>
          isObject(part) && typeof part.text === "string" ? [{ type: "text" as const, text: part.text }] : [],
        );
        return { role: "assistant", content };
      }
      const content = userContent(item.content);
      if (item.role === "developer" || item.role === "system") return { role: "system", content };
      return { role: "user", content };
    }
    case "reasoning": {
      const summary = Array.isArray(item.summary) ? item.summary.flatMap((s: unknown) => (isObject(s) && typeof s.text === "string" ? [s.text] : [])) : [];
      const text = Array.isArray(item.content) ? item.content.flatMap((c: unknown) => (isObject(c) && typeof c.text === "string" ? [c.text] : [])).join("\n") : undefined;
      const replay = typeof item.encrypted_content === "string" ? [{ provider: "openai", api: "responses", kind: "encrypted_content", data: item.encrypted_content }] : undefined;
      // A reasoning block needs text, a summary or replay data; an empty item keeps an empty summary.
      return {
        role: "assistant",
        content: [compact({ type: "reasoning" as const, text, summary: summary.length || (text === undefined && !replay) ? summary : undefined, replay })],
      };
    }
    case "function_call":
    case "custom_tool_call":
    case "local_shell_call":
    case "web_search_call": {
      if (!tree) return undefined;
      const id = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : undefined;
      if (id === undefined || tree.hasToolCall(id)) return undefined;
      return { role: "assistant", content: [toolCall(item, id)] };
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      if (typeof item.call_id !== "string" || !tree) return undefined;
      const output = item.output;
      const isError = isObject(output) && output.success === false ? true : undefined;
      const content = typeof output === "string" ? output : isObject(output) && typeof output.content === "string" ? output.content : Array.isArray(output) ? userContent(output) : "";
      return compact({ role: "tool" as const, toolCallId: item.call_id, content, isError });
    }
    default:
      return undefined;
  }
}

function toolCall(item: J, id: string): AssistantBlock {
  switch (item.type) {
    case "function_call": {
      let args: unknown;
      try {
        args = JSON.parse(item.arguments);
      } catch {
        args = undefined;
      }
      return isObject(args)
        ? compact({ type: "tool_call" as const, id, name: String(item.name ?? ""), kind: "function" as const, namespace: typeof item.namespace === "string" ? item.namespace : undefined, arguments: args })
        : { type: "tool_call", id, name: String(item.name ?? ""), kind: "function", input: typeof item.arguments === "string" ? item.arguments : "" };
    }
    case "custom_tool_call":
      return { type: "tool_call", id, name: String(item.name ?? ""), kind: "custom", input: typeof item.input === "string" ? item.input : "" };
    case "local_shell_call":
      return { type: "tool_call", id, name: "local_shell", kind: "builtin", arguments: isObject(item.action) ? item.action : {} };
    default:
      return { type: "tool_call", id, name: "web_search", kind: "builtin", arguments: isObject(item.action) ? item.action : {} };
  }
}

function userContent(parts: unknown[]): UserContent {
  const blocks: UserBlock[] = [];
  for (const part of parts) {
    if (!isObject(part)) continue;
    if (typeof part.text === "string") blocks.push({ type: "text", text: part.text });
    else if (part.type === "input_image" && typeof part.image_url === "string") {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(part.image_url);
      blocks.push(match ? { type: "image", mediaType: match[1]!, data: match[2]! } : { type: "image", mediaType: "image/*", uri: part.image_url });
    }
  }
  return blocks;
}

function tokenUsage(value: unknown): Usage | undefined {
  if (!isObject(value)) return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
  const input = n(value.input_tokens);
  const output = n(value.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  return compact({
    input,
    output,
    cacheRead: n(value.cached_input_tokens),
    cacheWrite: n(value.cache_write_input_tokens),
    reasoning: n(value.reasoning_output_tokens),
    total: n(value.total_tokens),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// ATXF → Codex: the active context as a rollout.

function encode(transcript: Transcript): Encoded[] {
  const context = buildContext(transcript);
  const times = new Map(transcript.records.map((record) => [record.id, record.time]));
  const out: Encoded[] = [];
  let time = transcript.header.time;
  const line = (type: string, payload: J, source: string | null) => {
    if (source) time = times.get(source) ?? time;
    out.push({ value: { timestamp: time, type, payload }, source });
  };

  const instructions = context.instructions.filter((s) => s.text !== null).map((s) => s.text).join("\n\n");
  line(
    "session_meta",
    compact({
      id: transcript.header.source.sessionId ?? transcript.header.id,
      timestamp: transcript.header.time,
      cwd: transcript.header.workspace?.cwd ?? context.settings.cwd ?? "/",
      originator: "atxf",
      cli_version: "0.0.0",
      source: "cli",
      model_provider: context.settings.model?.provider,
      base_instructions: instructions ? { text: instructions } : undefined,
    }),
    null,
  );
  if (context.settings.model || context.settings.reasoningEffort || context.settings.cwd) {
    line(
      "turn_context",
      compact({ cwd: context.settings.cwd ?? transcript.header.workspace?.cwd ?? "/", model: context.settings.model?.id, effort: context.settings.reasoningEffort }),
      null,
    );
  }

  context.messages.forEach((message, index) => {
    const body = message.body;
    const source = message.sourceId;
    if (message.kind === "compaction_summary" || message.kind === "branch_summary") {
      // A compaction starts the context; a summary later on can only be a user message.
      if (index === 0) line("compacted", { message: textOf(body.content as UserContent) }, source);
      else line("response_item", { type: "message", role: "user", content: codexContent(body.content as UserContent) }, source);
      return;
    }
    switch (body.role) {
      case "system":
      case "user": {
        const hidden = body.role === "system" || body.display === false || (body.origin !== undefined && body.origin.kind !== "human");
        line("response_item", { type: "message", role: hidden ? "developer" : "user", content: codexContent(body.content) }, source);
        break;
      }
      case "tool":
        line(
          "response_item",
          { type: "function_call_output", call_id: body.toolCallId, output: body.isError ? { content: textOf(body.content), success: false } : textOf(body.content) },
          source,
        );
        break;
      case "assistant":
        if (body.content.length === 0) line("response_item", { type: "message", role: "assistant", content: [] }, source);
        for (const block of body.content) {
          if (block.type === "reasoning") {
            const encrypted = block.replay?.find((r) => r.provider === "openai" && r.kind === "encrypted_content")?.data;
            line(
              "response_item",
              compact({
                type: "reasoning",
                summary: (block.summary ?? []).map((text) => ({ type: "summary_text", text })),
                content: block.text !== undefined ? [{ type: "reasoning_text", text: block.text }] : undefined,
                encrypted_content: typeof encrypted === "string" ? encrypted : null,
              }),
              source,
            );
          } else if (block.type === "text") {
            line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: block.text }] }, source);
          } else if (block.type === "tool_call") {
            if (block.kind === "custom" || (block.arguments === undefined && block.input !== undefined)) {
              line("response_item", { type: block.kind === "custom" ? "custom_tool_call" : "function_call", call_id: block.id, name: block.name, ...(block.kind === "custom" ? { input: block.input ?? "" } : { arguments: block.input ?? "" }) }, source);
            } else {
              line("response_item", compact({ type: "function_call", name: block.name, namespace: block.namespace, arguments: JSON.stringify(block.arguments ?? {}), call_id: block.id }), source);
            }
          }
        }
        break;
    }
  });
  return out;
}

function codexContent(content: UserContent): J[] {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  return content.map((block) => {
    if (block.type === "text") return { type: "input_text", text: block.text };
    if (block.type === "image") return { type: "input_image", image_url: block.data !== undefined ? `data:${block.mediaType};base64,${block.data}` : (block.uri ?? "") };
    return { type: "input_text", text: block.text ?? `[${block.uri}]` };
  });
}

function textOf(content: UserContent): string {
  if (typeof content === "string") return content;
  return content.map((block) => (block.type === "text" ? block.text : block.type === "image" ? "[image]" : (block.text ?? `[${block.uri}]`))).join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Carrier: marks go in an `atxf` key on each line; the transcript rides on a line of type `atxf` after the session
// meta. Codex skips lines it cannot parse.

const carrier = {
  mark(value: unknown, source: string | null) {
    return { ...(value as J), atxf: { id: source } };
  },
  markOf(value: unknown) {
    return isObject(value) && isObject(value.atxf) && "id" in value.atxf ? (value.atxf.id as string | null) : undefined;
  },
  attach(values: unknown[], transcript: Transcript) {
    const [meta, ...rest] = values as J[];
    return [meta, { timestamp: meta!.timestamp, type: "atxf", payload: { transcript: carriedValue(transcript) } }, ...rest];
  },
  detach(units: Unit[]) {
    const index = units.findIndex((unit) => isObject(unit.value) && unit.value.type === "atxf" && isObject(unit.value.payload) && isObject(unit.value.payload.transcript));
    if (index === -1) return undefined;
    return { transcript: (units[index]!.value as J).payload.transcript as Transcript, units: units.filter((_, i) => i !== index) };
  },
};

export const codex = defineConverter({ agent: AGENT, format: FORMAT, framing: jsonl, decode, encode, carrier });
export default codex;
