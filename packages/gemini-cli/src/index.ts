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
  jsonl,
  nativeOf,
  nativeOfShared,
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
  type UserBlock,
  type UserContent,
} from "@atxf/core";

/**
 * Gemini CLI chat recordings (`~/.gemini/tmp/<project>/chats/session-*.jsonl`), following
 * `packages/core/src/services/chatRecordingTypes.ts`: a metadata line, then message records and `$set`, `$patch`
 * and `$rewindTo` operations.
 */
export const AGENT = "gemini-cli";
export const FORMAT = "gemini-cli/chat-jsonl";

// ---------------------------------------------------------------------------------------------------------------
// Gemini CLI → ATXF. Messages follow each other; `$rewindTo` moves back, and later messages branch from there.

function decode(units: Unit[], context: DecodeContext): { header: TranscriptHeader; records: EntryRecord[] } {
  const tree = new TreeBuilder(context);
  const native = (unit: Unit) => nativeOf([unit], AGENT, FORMAT);
  let start = 0;
  let header: TranscriptHeader;
  const first = units[0]?.value;
  if (isMetadata(first) && !context.known.has(0)) {
    header = sessionHeader(first, native(units[0]!));
    start = 1;
  } else {
    header = sessionHeader({}, undefined);
  }
  // The active position: Gemini's rewinds move it back to before a message.
  let leaf: string | null = tree.last;

  for (let index = start; index < units.length; index++) {
    const unit = units[index]!;
    const record: J = isObject(unit.value) ? unit.value : {};
    if (context.known.has(index)) {
      const known = context.known.get(index);
      if (typeof record.id === "string") tree.alias(record.id, known ?? leaf);
      if (known) leaf = known;
      continue;
    }
    const id = context.ids.take(typeof record.id === "string" && record.id !== "" && typeof record.type === "string" ? record.id : `gemini-${index}`);
    const time = isoTime(record.timestamp, header.time);
    const node = { id, parentId: leaf, time };
    const pushNode = (entry: EntryRecord, extra: EntryRecord[] = []) => {
      tree.push(entry, native(unit));
      for (const derived of extra) tree.push(derived, nativeOfShared(entry.id, AGENT, FORMAT));
      if (typeof record.id === "string") tree.alias(record.id, entry.id);
      leaf = (extra.at(-1) ?? entry).id;
    };
    const custom = (name: string) => pushNode({ type: "custom", ...node, namespace: AGENT, name });

    if (typeof record.$rewindTo === "string") {
      const target = tree.resolve(record.$rewindTo);
      if (target === null) {
        custom("$rewindTo");
        continue;
      }
      // Rewinding to a message removes it and what follows: the position moves to its parent.
      const parent = tree.records.find((r) => r.id === target && "parentId" in r) as { parentId: string | null } | undefined;
      const targetId = parent?.parentId ?? null;
      tree.push({ type: "leaf", id, time, targetId, reason: "rewind" }, native(unit));
      leaf = targetId;
      continue;
    }
    if (isObject(record.$set) && typeof record.$set.summary === "string") {
      tree.push({ type: "metadata", id, time, title: record.$set.summary }, native(unit));
      continue;
    }
    switch (record.type) {
      case "user": {
        const content = partsContent(record.content);
        if (content === undefined) custom("user");
        else pushNode({ type: "message", ...node, role: "user", content });
        break;
      }
      case "gemini": {
        const [assistant, ...results] = geminiRecords(record, node, tree);
        if (!assistant) custom("gemini");
        else pushNode(assistant, results);
        break;
      }
      default:
        custom(typeof record.type === "string" ? record.type : Object.keys(record).find((key) => key.startsWith("$")) ?? "unparsed");
    }
  }
  return { header, records: tree.records };
}

function isMetadata(value: unknown): value is J {
  return isObject(value) && typeof value.sessionId === "string" && value.type === undefined && !("$set" in value);
}

function sessionHeader(meta: J, native: ReturnType<typeof nativeOf> | undefined): TranscriptHeader {
  return compact({
    type: "transcript" as const,
    atxf: "0.1" as const,
    id: typeof meta.sessionId === "string" && meta.sessionId !== "" ? meta.sessionId : "gemini-session",
    time: isoTime(meta.startTime, EPOCH),
    title: typeof meta.summary === "string" ? meta.summary : undefined,
    source: compact({ agent: AGENT, format: FORMAT, sessionId: typeof meta.sessionId === "string" ? meta.sessionId : undefined }),
    workspace: Array.isArray(meta.directories) && meta.directories.every((d: unknown) => typeof d === "string") && meta.directories.length > 0 ? { roots: meta.directories } : undefined,
    fidelity: { topology: "linear" as const, reasoning: "summary" as const, native: "all" as const, ids: "stable" as const },
    native,
  });
}

/** Gemini `PartListUnion` as ATXF content: text parts as text, inline images as images, anything else dropped. */
function partsContent(parts: unknown): UserContent | undefined {
  if (typeof parts === "string") return parts;
  const list = Array.isArray(parts) ? parts : isObject(parts) ? [parts] : undefined;
  if (!list) return undefined;
  const blocks: UserBlock[] = [];
  for (const part of list) {
    if (typeof part === "string") blocks.push({ type: "text", text: part });
    else if (isObject(part) && typeof part.text === "string") blocks.push({ type: "text", text: part.text });
    else if (isObject(part) && isObject(part.inlineData) && typeof part.inlineData.mimeType === "string") {
      blocks.push(compact({ type: "image" as const, mediaType: part.inlineData.mimeType, data: typeof part.inlineData.data === "string" ? part.inlineData.data : undefined }));
    } else if (isObject(part) && isObject(part.functionResponse)) {
      const response = part.functionResponse.response;
      blocks.push({ type: "text", text: isObject(response) && typeof response.output === "string" ? response.output : JSON.stringify(response ?? null) });
    }
  }
  return blocks;
}

/** A `gemini` record: the assistant message, then one tool message for each tool call with a result. */
function geminiRecords(record: J, node: { id: string; parentId: string | null; time: string }, tree: TreeBuilder): EntryRecord[] {
  const model = typeof record.model === "string" ? { provider: "google", id: record.model } : undefined;
  const content: AssistantBlock[] = [];
  for (const thought of Array.isArray(record.thoughts) ? record.thoughts : []) {
    if (!isObject(thought)) continue;
    const text = [thought.subject, thought.description].filter((part) => typeof part === "string" && part !== "").join(": ");
    content.push({ type: "reasoning", summary: [text] });
  }
  const text = partsContent(record.content);
  if (text !== undefined) for (const block of typeof text === "string" ? [{ type: "text" as const, text }] : text) if (block.type === "text") content.push(block);
  const results: EntryRecord[] = [];
  let parentId = node.id;
  for (const call of Array.isArray(record.toolCalls) ? record.toolCalls : []) {
    if (!isObject(call) || typeof call.id !== "string" || typeof call.name !== "string" || tree.hasToolCall(call.id)) continue;
    if (content.some((block) => block.type === "tool_call" && block.id === call.id)) continue;
    content.push({ type: "tool_call", id: call.id, name: call.name, arguments: isObject(call.args) ? call.args : {} });
    if (call.result !== undefined && call.result !== null) {
      const id = tree.context.ids.take(`${node.id}:${call.id}`);
      results.push(
        compact({
          type: "message" as const,
          id,
          parentId,
          time: isoTime(call.timestamp, node.time),
          role: "tool" as const,
          toolCallId: call.id,
          toolName: call.name,
          content: partsContent(call.result) ?? "",
          isError: call.status === "error" ? true : undefined,
        }),
      );
      parentId = id;
    }
  }
  const tokens: J = isObject(record.tokens) ? record.tokens : {};
  const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
  const usage =
    n(tokens.input) !== undefined && n(tokens.output) !== undefined
      ? compact({ input: n(tokens.input)!, output: n(tokens.output)!, cacheRead: n(tokens.cached), reasoning: n(tokens.thoughts), total: n(tokens.total) })
      : undefined;
  const assistant = compact({ type: "message" as const, ...node, role: "assistant" as const, content, model, usage }) as EntryRecord;
  return [assistant, ...results];
}

// ---------------------------------------------------------------------------------------------------------------
// ATXF → Gemini CLI: the active context as a chat recording. Tool results go into the call they answer.

function encode(transcript: Transcript): Encoded[] {
  const context = buildContext(transcript);
  const times = new Map(transcript.records.map((record) => [record.id, record.time]));
  const ids = new IdAllocator();
  const results = new Map<string, MessageBody & { role: "tool" }>();
  for (const message of context.messages) if (message.body.role === "tool" && !results.has(message.body.toolCallId)) results.set(message.body.toolCallId, message.body);
  const lastTime = transcript.records.at(-1)?.time ?? transcript.header.time;
  const out: Encoded[] = [
    {
      value: compact({ sessionId: transcript.header.source.sessionId ?? transcript.header.id, projectHash: "atxf", startTime: transcript.header.time, lastUpdated: lastTime, summary: transcript.header.title, kind: "main" }),
      source: null,
    },
  ];

  for (const message of context.messages) {
    const body = message.body;
    const source = message.sourceId;
    const base = { id: ids.take(source), timestamp: times.get(source) ?? transcript.header.time };
    if (message.kind === "compaction_summary" || message.kind === "branch_summary") {
      // Gemini CLI has no summary record: a summary is a user message.
      out.push({ value: { ...base, type: "user", content: contentText(body.content as UserContent) }, source });
      continue;
    }
    switch (body.role) {
      case "system":
        out.push({ value: { ...base, type: "info", content: contentText(body.content) }, source });
        break;
      case "user": {
        const hidden = body.display === false || (body.origin !== undefined && body.origin.kind !== "human");
        out.push({ value: { ...base, type: hidden ? "info" : "user", content: geminiParts(body.content) }, source });
        break;
      }
      case "tool":
        break; // Written into the call it answers.
      case "assistant": {
        const text = body.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
        const thoughts = body.content.flatMap((block) => (block.type === "reasoning" ? [{ subject: "", description: block.text ?? (block.summary ?? []).join("\n"), timestamp: base.timestamp }] : []));
        const toolCalls = body.content.flatMap((block) => {
          if (block.type !== "tool_call") return [];
          const result = results.get(block.id);
          return [
            compact({
              id: block.id,
              name: block.name,
              args: block.arguments ?? { input: block.input ?? "" },
              result: result ? [{ text: contentText(result.content) }] : undefined,
              status: result ? (result.isError ? "error" : "success") : "scheduled",
              timestamp: base.timestamp,
            }),
          ];
        });
        const usage = body.usage;
        out.push({
          value: compact({
            ...base,
            type: "gemini",
            content: text,
            thoughts: thoughts.length > 0 ? thoughts : undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            tokens: usage ? { input: usage.input, output: usage.output, cached: usage.cacheRead ?? 0, thoughts: usage.reasoning, total: usage.total ?? usage.input + usage.output } : undefined,
            model: body.model?.id,
          }),
          source,
        });
        break;
      }
    }
  }
  return out;
}

function geminiParts(content: UserContent): string | J[] {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "text") return { text: block.text };
    if (block.type === "image" && block.data !== undefined) return { inlineData: { mimeType: block.mediaType, data: block.data } };
    if (block.type === "image") return { text: "[image]" };
    return { text: block.text ?? `[${block.uri}]` };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Carrier: marks go in an `atxf` key on each record; the transcript rides on the metadata line.

const carrier = {
  mark(value: unknown, source: string | null) {
    return { ...(value as J), atxf: { id: source } };
  },
  markOf(value: unknown) {
    return isObject(value) && isObject(value.atxf) && "id" in value.atxf ? (value.atxf.id as string | null) : undefined;
  },
  attach(values: unknown[], transcript: Transcript) {
    const [meta, ...rest] = values as J[];
    return [{ ...meta, atxf: { ...meta!.atxf, transcript: carriedValue(transcript) } }, ...rest];
  },
  detach(units: Unit[]) {
    const index = units.findIndex((unit) => isObject(unit.value) && isObject(unit.value.atxf) && isObject(unit.value.atxf.transcript));
    if (index === -1) return undefined;
    const value = units[index]!.value as J;
    const { transcript, ...mark } = value.atxf;
    const rest = units.slice();
    rest[index] = { value: { ...value, atxf: mark }, raw: units[index]!.raw };
    return { transcript: transcript as Transcript, units: rest };
  },
};

export const geminiCli = defineConverter({ agent: AGENT, format: FORMAT, framing: jsonl, decode, encode, carrier });
export default geminiCli;
