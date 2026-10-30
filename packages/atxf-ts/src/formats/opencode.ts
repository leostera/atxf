import {
  buildContext,
  carriedValue,
  compact,
  contentText,
  defineConverter,
  EPOCH,
  IdAllocator,
  isObject,
  isoTime,
  jsonDocument,
  millisFromIso,
  nativeOf,
  nativeOfShared,
  TreeBuilder,
  type AssistantBlock,
  type DecodeContext,
  type Encoded,
  type EntryRecord,
  type J,
  type MessageBody,
  type StopReason,
  type Transcript,
  type TranscriptHeader,
  type Unit,
  type Usage,
  type UserBlock,
  type UserContent,
} from "../index.ts";

/**
 * OpenCode session exports (`opencode session export`): `JSON.stringify({info, messages}, null, 2)` plus a newline,
 * following `SessionTransfer.Data` in `packages/schema` of OpenCode v2.
 */
export const AGENT = "opencode";
export const FORMAT = "opencode/session-export-json";

const framing = jsonDocument({ items: "messages", indent: 2, eol: "\n" });
const canonical = framing.canonical;

// ---------------------------------------------------------------------------------------------------------------
// OpenCode → ATXF. Sessions are linear: each record's parent is the record before it.

function decode(units: Unit[], context: DecodeContext): { header: TranscriptHeader; records: EntryRecord[] } {
  const tree = new TreeBuilder(context);
  const native = (unit: Unit) => nativeOf([unit], AGENT, FORMAT, canonical);
  let start = 0;
  let header = sessionHeader({}, undefined);
  if (units.length > 0 && !context.known.has(0)) {
    const head = units[0]!.value;
    header = sessionHeader(isObject(head) && isObject(head.info) ? head.info : {}, native(units[0]!));
    start = 1;
  } else if (units.length > 0) {
    start = 1;
  }
  let turns = 0;

  for (let index = start; index < units.length; index++) {
    const unit = units[index]!;
    if (context.known.has(index)) {
      const known = context.known.get(index);
      if (known) tree.last = known;
      continue;
    }
    const message: J = isObject(unit.value) ? unit.value : {};
    const id = context.ids.take(typeof message.id === "string" && message.id !== "" ? message.id : `opencode-${index}`);
    const time = isoTime(isObject(message.time) ? message.time.created : undefined, header.time);
    const node = { id, parentId: tree.last, time };
    const push = (record: EntryRecord) => tree.push(record, native(unit));
    const custom = (name: string) => push({ type: "custom", ...node, namespace: AGENT, name });
    const text = typeof message.text === "string" ? message.text : undefined;

    switch (message.type) {
      case "user":
        if (text === undefined) custom("user");
        else push({ type: "message", ...node, role: "user", content: userContent(text, message.files) });
        break;
      case "synthetic":
        if (text === undefined) custom("synthetic");
        else push({ type: "message", ...node, role: "user", content: text, origin: { kind: "synthetic" } });
        break;
      case "system":
        if (text === undefined) custom("system");
        else push({ type: "message", ...node, role: "system", content: text });
        break;
      case "skill":
        if (text === undefined) custom("skill");
        else push(compact({ type: "message" as const, ...node, role: "user" as const, content: text, origin: compact({ kind: "extension" as const, name: typeof message.name === "string" ? message.name : undefined }) }));
        break;
      case "shell":
        if (typeof message.command !== "string") custom("shell");
        else push({ type: "message", ...node, role: "user", content: `$ ${message.command}\n${typeof message.output === "string" ? message.output : ""}`, origin: { kind: "command", name: "shell" } });
        break;
      case "assistant": {
        const records = assistantRecords(message, node, tree);
        if (records.length === 0) custom("assistant");
        else records.forEach((record, i) => tree.push(record, i === 0 ? native(unit) : nativeOfShared(records[0]!.id, AGENT, FORMAT)));
        break;
      }
      case "compaction":
        if (message.status === "completed" && typeof message.summary === "string") {
          push(compact({ type: "compaction" as const, ...node, strategy: "summary" as const, summary: message.summary, firstKeptId: null, reason: message.reason === "auto" || message.reason === "manual" ? message.reason : undefined }));
        } else custom(`compaction:${typeof message.status === "string" ? message.status : "unknown"}`);
        break;
      case "agent-switched":
        if (typeof message.agent === "string") push({ type: "settings", ...node, agent: message.agent });
        else custom("agent-switched");
        break;
      case "model-switched":
        if (isObject(message.model) && typeof message.model.id === "string" && typeof message.model.providerID === "string") {
          push({ type: "settings", ...node, model: compact({ provider: message.model.providerID, id: message.model.id, variant: typeof message.model.variant === "string" ? message.model.variant : undefined }) });
        } else custom("model-switched");
        break;
      case "location-switched":
        if (isObject(message.location) && typeof message.location.directory === "string") push({ type: "settings", ...node, cwd: message.location.directory });
        else custom("location-switched");
        break;
      case "idle":
        push(
          compact({
            type: "turn" as const,
            ...node,
            phase: "end" as const,
            turnId: `turn-${++turns}`,
            outcome: message.outcome === "succeeded" || message.outcome === "failed" || message.outcome === "interrupted" ? message.outcome : undefined,
          }),
        );
        break;
      default:
        custom(typeof message.type === "string" ? message.type : "unparsed");
    }
  }
  return { header, records: tree.records };
}

function sessionHeader(info: J, native: ReturnType<typeof nativeOf> | undefined): TranscriptHeader {
  const time: J = isObject(info.time) ? info.time : {};
  const directory = isObject(info.location) && typeof info.location.directory === "string" ? info.location.directory : undefined;
  const parent = typeof info.parentID === "string" ? { transcriptId: info.parentID, relation: "subagent" as const } : isObject(info.fork) && typeof info.fork.sessionID === "string" ? { transcriptId: info.fork.sessionID, relation: "fork" as const } : undefined;
  return compact({
    type: "transcript" as const,
    atxf: "0.1" as const,
    id: typeof info.id === "string" && info.id !== "" ? info.id : "opencode-session",
    time: isoTime(time.created, EPOCH),
    title: typeof info.title === "string" ? info.title : undefined,
    source: compact({ agent: AGENT, format: FORMAT, sessionId: typeof info.id === "string" ? info.id : undefined }),
    workspace: directory ? { cwd: directory } : undefined,
    parent,
    fidelity: { topology: "linear" as const, toolLifecycle: true, turns: true, native: "all" as const, ids: "stable" as const },
    native,
  });
}

function userContent(text: string, files: unknown): UserContent {
  if (!Array.isArray(files) || files.length === 0) return text;
  const blocks: UserBlock[] = text === "" ? [] : [{ type: "text", text }];
  for (const file of files) {
    if (!isObject(file) || typeof file.mime !== "string") continue;
    if (file.mime.startsWith("image/") && typeof file.data === "string") blocks.push({ type: "image", mediaType: file.mime, data: file.data });
    else blocks.push(compact({ type: "resource" as const, uri: typeof file.uri === "string" ? file.uri : `file:${typeof file.name === "string" ? file.name : "attachment"}`, name: typeof file.name === "string" ? file.name : undefined, mediaType: file.mime }));
  }
  return blocks;
}

const STOPS: Record<string, StopReason> = { stop: "end", "tool-calls": "tool_use", length: "max_tokens", "content-filter": "refusal", error: "error" };

/** An assistant step: one assistant message, then one tool message for each settled tool call. */
function assistantRecords(message: J, node: { id: string; parentId: string | null; time: string }, tree: TreeBuilder): EntryRecord[] {
  if (!Array.isArray(message.content)) return [];
  const model = isObject(message.model) && typeof message.model.id === "string" && typeof message.model.providerID === "string" ? compact({ provider: message.model.providerID, id: message.model.id, variant: typeof message.model.variant === "string" ? message.model.variant : undefined }) : undefined;
  const content: AssistantBlock[] = [];
  const results: { callId: string; name: string; content: UserContent; isError: boolean; time: string }[] = [];
  for (const part of message.content) {
    if (!isObject(part)) continue;
    if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
    else if (part.type === "reasoning" && typeof part.text === "string") {
      content.push(compact({ type: "reasoning" as const, text: part.text, replay: isObject(part.native) && model ? [{ provider: model.provider, kind: "native", data: part.native }] : undefined }));
    } else if (part.type === "tool" && typeof part.id === "string" && typeof part.name === "string" && !tree.hasToolCall(part.id)) {
      const state: J = isObject(part.state) ? part.state : {};
      content.push(isObject(state.input) ? { type: "tool_call", id: part.id, name: part.name, arguments: state.input } : { type: "tool_call", id: part.id, name: part.name, input: typeof state.input === "string" ? state.input : "" });
      if (state.status === "completed" || state.status === "error") {
        const fromContent = Array.isArray(state.content) ? toolContent(state.content) : undefined;
        const errorText = isObject(state.error) && typeof state.error.message === "string" ? state.error.message : "";
        results.push({
          callId: part.id,
          name: part.name,
          content: fromContent ?? errorText,
          isError: state.status === "error",
          time: isoTime(isObject(part.time) ? (part.time.completed ?? part.time.created) : undefined, node.time),
        });
      }
    }
  }
  const tokens: J = isObject(message.tokens) ? message.tokens : {};
  const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
  const cost = typeof message.cost === "number" && Number.isFinite(message.cost) ? { total: message.cost, currency: "USD" } : undefined;
  const usage: Usage | undefined =
    n(tokens.input) !== undefined && n(tokens.output) !== undefined
      ? compact({ input: n(tokens.input)!, output: n(tokens.output)!, reasoning: n(tokens.reasoning), cacheRead: isObject(tokens.cache) ? n(tokens.cache.read) : undefined, cacheWrite: isObject(tokens.cache) ? n(tokens.cache.write) : undefined, cost })
      : undefined;
  const stop = typeof message.finish === "string" ? (STOPS[message.finish] ?? "other") : undefined;
  const assistant: EntryRecord = compact({
    type: "message" as const,
    ...node,
    role: "assistant" as const,
    content,
    model,
    usage,
    stop,
    rawStop: typeof message.rawFinish === "string" ? message.rawFinish : stop === "other" ? message.finish : undefined,
    error: isObject(message.error) && typeof message.error.message === "string" ? { message: message.error.message, code: typeof message.error.type === "string" ? message.error.type : undefined } : undefined,
  }) as EntryRecord;
  const records: EntryRecord[] = [assistant];
  let parentId = node.id;
  for (const result of results) {
    const id = tree.context.ids.take(`${node.id}:${result.callId}`);
    records.push(compact({ type: "message" as const, id, parentId, time: result.time, role: "tool" as const, toolCallId: result.callId, toolName: result.name, content: result.content, isError: result.isError ? true : undefined }));
    parentId = id;
  }
  return records;
}

function toolContent(content: unknown[]): UserContent {
  const blocks: UserBlock[] = [];
  for (const item of content) {
    if (!isObject(item)) continue;
    if (item.type === "text" && typeof item.text === "string") blocks.push({ type: "text", text: item.text });
    else if (item.type === "file" && typeof item.uri === "string") blocks.push(compact({ type: "resource" as const, uri: item.uri, mediaType: typeof item.mime === "string" ? item.mime : undefined, name: typeof item.name === "string" ? item.name : undefined }));
  }
  return blocks;
}

// ---------------------------------------------------------------------------------------------------------------
// ATXF → OpenCode: the active context as an export. Tool results go into the tool part of the call they answer.

const FINISH: Record<StopReason, string> = { end: "stop", tool_use: "tool-calls", max_tokens: "length", refusal: "content-filter", error: "error", aborted: "unknown", other: "unknown" };

function encode(transcript: Transcript): Encoded[] {
  const context = buildContext(transcript);
  const times = new Map(transcript.records.map((record) => [record.id, record.time]));
  const ids = new IdAllocator();
  const msgId = (source: string) => ids.take(source.startsWith("msg_") ? source : `msg_${source}`);
  const results = new Map<string, MessageBody & { role: "tool" }>();
  for (const message of context.messages) if (message.body.role === "tool" && !results.has(message.body.toolCallId)) results.set(message.body.toolCallId, message.body);
  const created = (source: string) => millisFromIso(times.get(source) ?? transcript.header.time);
  const zeroTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

  const out: Encoded[] = [
    {
      value: {
        info: compact({
          id: transcript.header.source.sessionId ?? transcript.header.id,
          projectID: "atxf",
          title: transcript.header.title,
          cost: 0,
          tokens: zeroTokens,
          time: { created: millisFromIso(transcript.header.time), updated: millisFromIso(transcript.records.at(-1)?.time ?? transcript.header.time) },
          location: { directory: transcript.header.workspace?.cwd ?? context.settings.cwd ?? "/" },
        }),
      },
      source: null,
    },
  ];
  if (context.settings.model) {
    out.push({ value: { id: ids.take("msg_atxf_model"), type: "model-switched", model: { id: context.settings.model.id, providerID: context.settings.model.provider }, time: { created: millisFromIso(transcript.header.time) } }, source: null });
  }

  context.messages.forEach((message, index) => {
    const body = message.body;
    const source = message.sourceId;
    const base = { id: msgId(source), time: { created: created(source) } };
    if (message.kind === "compaction_summary" || message.kind === "branch_summary") {
      // A compaction starts the context; a summary later on can only be a user message.
      const summary = contentText(body.content as UserContent);
      out.push({ value: index === 0 ? { ...base, type: "compaction", status: "completed", reason: "auto", summary } : { ...base, type: "user", text: summary, files: [], agents: [], skills: [] }, source });
      return;
    }
    switch (body.role) {
      case "system":
        out.push({ value: { ...base, type: "system", text: contentText(body.content) }, source });
        break;
      case "user": {
        const hidden = body.display === false || (body.origin !== undefined && body.origin.kind !== "human");
        out.push({ value: hidden ? { ...base, type: "synthetic", text: contentText(body.content) } : { ...base, type: "user", text: contentText(body.content), files: [], agents: [], skills: [] }, source });
        break;
      }
      case "tool":
        break; // Written into the tool part of its call.
      case "assistant": {
        const content = body.content.flatMap((block): J[] => {
          switch (block.type) {
            case "text":
              return [{ type: "text", text: block.text }];
            case "reasoning":
              return [{ type: "reasoning", text: block.text ?? (block.summary ?? []).join("\n") }];
            case "image":
              return [];
            case "tool_call": {
              const input = block.arguments ?? { input: block.input ?? "" };
              const result = results.get(block.id);
              const resultText = result ? contentText(result.content) : "";
              const state = !result
                ? { status: "running", input, metadata: {} }
                : result.isError
                  ? { status: "error", input, error: { type: "tool", message: resultText }, content: [{ type: "text", text: resultText }] }
                  : { status: "completed", input, content: [{ type: "text", text: resultText }] };
              return [{ type: "tool", id: block.id, name: block.name, state, time: { created: created(source) } }];
            }
          }
        });
        const usage = body.usage;
        out.push({
          value: compact({
            ...base,
            type: "assistant",
            agent: "build",
            model: { id: body.model?.id ?? "unknown", providerID: body.model?.provider ?? "unknown" },
            content,
            finish: FINISH[body.stop ?? "end"],
            cost: usage?.cost?.total,
            tokens: usage ? { input: usage.input, output: usage.output, reasoning: usage.reasoning ?? 0, cache: { read: usage.cacheRead ?? 0, write: usage.cacheWrite ?? 0 } } : undefined,
          }),
          source,
        });
        break;
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Carrier: marks go in each message's `metadata.atxf`; the transcript rides in the session's `info.metadata.atxf`.

const carrier = {
  mark(value: unknown, source: string | null) {
    const v = value as J;
    if (isObject(v.info)) return { ...v, info: { ...v.info, metadata: { ...(isObject(v.info.metadata) ? v.info.metadata : {}), atxf: { id: source } } } };
    return { ...v, metadata: { ...(isObject(v.metadata) ? v.metadata : {}), atxf: { id: source } } };
  },
  markOf(value: unknown) {
    if (!isObject(value)) return undefined;
    const metadata = isObject(value.info) ? value.info.metadata : value.metadata;
    return isObject(metadata) && isObject(metadata.atxf) && "id" in metadata.atxf ? (metadata.atxf.id as string | null) : undefined;
  },
  attach(values: unknown[], transcript: Transcript) {
    const [head, ...rest] = values as J[];
    const info = head!.info as J;
    return [{ ...head, info: { ...info, metadata: { ...info.metadata, atxf: { ...info.metadata.atxf, transcript: carriedValue(transcript) } } } }, ...rest];
  },
  detach(units: Unit[]) {
    const head = units[0]?.value;
    if (!isObject(head) || !isObject(head.info) || !isObject(head.info.metadata) || !isObject(head.info.metadata.atxf) || !isObject(head.info.metadata.atxf.transcript)) return undefined;
    const { transcript, ...mark } = head.info.metadata.atxf;
    const rest = units.slice();
    rest[0] = { value: { ...head, info: { ...head.info, metadata: { ...head.info.metadata, atxf: mark } } }, raw: "" };
    return { transcript: transcript as Transcript, units: rest };
  },
};

export const opencode = defineConverter({ agent: AGENT, format: FORMAT, framing, decode, encode, carrier });
export default opencode;
