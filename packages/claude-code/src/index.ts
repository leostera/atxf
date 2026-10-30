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
  nativeOfShared,
  sha256,
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
} from "@atxf/core";

/**
 * Claude Code session files (`~/.claude/projects/<project>/<session>.jsonl`), as written by Claude Code 2.1. Anthropic
 * calls the format internal and unstable; this converter follows the entries observed in real sessions.
 */
export const AGENT = "claude-code";
export const FORMAT = "claude-code/session-jsonl";

// ---------------------------------------------------------------------------------------------------------------
// Claude Code → ATXF

function decode(units: Unit[], context: DecodeContext): { header: TranscriptHeader; records: EntryRecord[] } {
  const tree = new TreeBuilder(context);
  const native = (unit: Unit) => nativeOf([unit], AGENT, FORMAT);
  const header = sessionHeader(units);

  units.forEach((unit, index) => {
    const entry: J = isObject(unit.value) ? unit.value : {};
    if (context.known.has(index)) {
      if (typeof entry.uuid === "string") tree.alias(entry.uuid, context.known.get(index) ?? tree.resolve(entry.parentUuid));
      return;
    }
    const time = isoTime(entry.timestamp, header.time);
    const id = context.ids.take(typeof entry.uuid === "string" && entry.uuid !== "" ? entry.uuid : `claude-line-${index + 1}`);
    // Entries without a parent link (queue operations, snapshots) hang off the latest record.
    const parentId = "parentUuid" in entry ? tree.resolve(entry.parentUuid) : tree.last;
    const node = { id, parentId, time };
    const custom = (name: string) => {
      tree.alias(entry.uuid, id);
      tree.push({ type: "custom", ...node, namespace: AGENT, name }, native(unit));
    };

    switch (entry.type) {
      case "user": {
        const records = userRecords(entry, node, tree);
        if (records.length === 0) return custom("user");
        tree.alias(entry.uuid, records.at(-1)!.id);
        records.forEach((record, i) => tree.push(record, i === 0 ? native(unit) : nativeOfShared(records[0]!.id, AGENT, FORMAT)));
        return;
      }
      case "assistant": {
        const body = assistantBody(entry, tree);
        if (!body) return custom("assistant");
        tree.alias(entry.uuid, id);
        tree.push({ type: "message", ...node, ...body } as EntryRecord, native(unit));
        return;
      }
      case "summary":
      case "custom-title":
      case "ai-title": {
        const title = [entry.summary, entry.customTitle, entry.aiTitle, entry.title].find((value) => typeof value === "string");
        if (title === undefined) return custom(entry.type);
        tree.alias(entry.uuid, parentId);
        tree.push({ type: "metadata", id, time, title }, native(unit));
        return;
      }
      case "last-prompt": {
        const targetId = tree.resolve(entry.leafUuid);
        if (targetId === null) return custom("last-prompt");
        tree.push({ type: "leaf", id, time, targetId, reason: "navigate" }, native(unit));
        return;
      }
      case "file-history-snapshot":
        tree.alias(entry.uuid, id);
        tree.push(compact({ type: "checkpoint" as const, ...node, snapshot: typeof entry.messageId === "string" ? entry.messageId : undefined }), native(unit));
        return;
      case "system":
        return custom(typeof entry.subtype === "string" ? `system:${entry.subtype}` : "system");
      case "attachment":
        return custom(isObject(entry.attachment) && typeof entry.attachment.type === "string" ? `attachment:${entry.attachment.type}` : "attachment");
      default:
        return custom(typeof entry.type === "string" ? entry.type : "unparsed");
    }
  });
  return { header, records: tree.records };
}

function sessionHeader(units: Unit[]): TranscriptHeader {
  const entries = units.map((unit) => unit.value).filter(isObject);
  const first = entries.find((entry) => typeof entry.sessionId === "string") ?? {};
  const withCwd = entries.find((entry) => typeof entry.cwd === "string");
  const withTime = entries.find((entry) => isoTime(entry.timestamp, "") !== "");
  const withBranch = entries.find((entry) => typeof entry.gitBranch === "string");
  return compact({
    type: "transcript" as const,
    atxf: "0.1" as const,
    id: typeof first.sessionId === "string" && first.sessionId !== "" ? first.sessionId : "claude-code-session",
    time: isoTime(withTime?.timestamp, EPOCH),
    source: compact({
      agent: AGENT,
      format: FORMAT,
      version: typeof first.version === "string" ? first.version : undefined,
      sessionId: typeof first.sessionId === "string" ? first.sessionId : undefined,
    }),
    workspace:
      withCwd || withBranch
        ? compact({ cwd: withCwd?.cwd, vcs: withBranch ? { type: "git", branch: withBranch.gitBranch as string } : undefined })
        : undefined,
    fidelity: { topology: "tree" as const, instructions: "none" as const, tools: "none" as const, native: "all" as const, ids: "stable" as const },
  });
}

/** A user entry: a prompt, tool results (one ATXF message each), or a compaction summary. */
function userRecords(entry: J, node: { id: string; parentId: string | null; time: string }, tree: TreeBuilder): EntryRecord[] {
  const message = entry.message;
  if (!isObject(message)) return [];
  if (entry.isCompactSummary === true) {
    // Claude Code starts a compacted context at a new root (the compact boundary). A summary below a message
    // does not cut the context: it is a branch summary.
    const summary = textOf(message.content);
    if (node.parentId === null || tree.typeOf(node.parentId) === "custom") {
      return [{ type: "compaction", ...node, strategy: "summary", summary, firstKeptId: null }];
    }
    return [{ type: "branch_summary", ...node, fromId: node.parentId, summary }];
  }
  const display = entry.isMeta === true ? { display: false } : {};
  if (typeof message.content === "string") return [{ type: "message", ...node, role: "user", content: message.content, ...display }];
  if (!Array.isArray(message.content)) return [];

  const records: EntryRecord[] = [];
  const blocks: UserBlock[] = [];
  let parentId = node.parentId;
  for (const block of message.content) {
    if (!isObject(block)) continue;
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const owner = tree.toolCallOwner(block.tool_use_id);
      // ATXF requires a result to sit below its call; one elsewhere stays in native only.
      if (owner !== undefined && !tree.isAncestor(owner, parentId)) continue;
      const id = records.length === 0 ? node.id : tree.context.ids.take(`${node.id}:${block.tool_use_id}`);
      records.push(
        compact({
          type: "message" as const,
          id,
          parentId,
          time: node.time,
          role: "tool" as const,
          toolCallId: block.tool_use_id,
          content: toolResultContent(block.content),
          isError: block.is_error === true ? true : undefined,
        }),
      );
      parentId = id;
    } else {
      const converted = userBlock(block);
      if (converted) blocks.push(converted);
    }
  }
  if (blocks.length > 0) {
    const id = records.length === 0 ? node.id : tree.context.ids.take(`${node.id}:text`);
    records.push({ type: "message", id, parentId, time: node.time, role: "user", content: blocks, ...display });
  }
  return records;
}

function userBlock(block: J): UserBlock | undefined {
  if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
  if (block.type === "image" && isObject(block.source)) {
    const source = block.source;
    if (source.type === "base64" && typeof source.media_type === "string") {
      return compact({ type: "image" as const, mediaType: source.media_type, data: typeof source.data === "string" ? source.data : undefined });
    }
    if (source.type === "url" && typeof source.url === "string") return { type: "image", mediaType: "image/*", uri: source.url };
  }
  return undefined;
}

function toolResultContent(content: unknown): UserContent {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => (isObject(block) ? [userBlock(block)].filter((b): b is UserBlock => b !== undefined) : []));
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => (isObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n");
}

const STOPS: Record<string, StopReason> = {
  end_turn: "end",
  stop_sequence: "end",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  refusal: "refusal",
};

function assistantBody(entry: J, tree: TreeBuilder): MessageBody | undefined {
  const message = entry.message;
  if (!isObject(message) || !Array.isArray(message.content)) return undefined;
  const model = typeof message.model === "string" ? { provider: "anthropic", id: message.model } : undefined;
  const signature = (data: unknown, kind: string) =>
    typeof data === "string" && data !== "" ? [compact({ provider: "anthropic", model: model?.id, kind, data })] : undefined;
  const content: AssistantBlock[] = [];
  for (const block of message.content) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
    else if (block.type === "thinking" && typeof block.thinking === "string") {
      content.push(compact({ type: "reasoning" as const, text: block.thinking, replay: signature(block.signature, "signature") }));
    } else if (block.type === "redacted_thinking") {
      content.push(compact({ type: "reasoning" as const, redacted: true, replay: signature(block.data, "redacted_thinking") }));
    } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string" && !tree.hasToolCall(block.id)) {
      content.push({ type: "tool_call", id: block.id, name: block.name, arguments: isObject(block.input) ? block.input : {} });
    }
  }
  const stop = typeof message.stop_reason === "string" ? (STOPS[message.stop_reason] ?? "other") : undefined;
  return compact({
    role: "assistant" as const,
    content,
    model,
    usage: usageOf(message.usage),
    stop,
    rawStop: stop === "other" ? message.stop_reason : undefined,
    responseId: typeof message.id === "string" ? message.id : undefined,
    error: entry.isApiErrorMessage === true ? { message: textOf(message.content) || "API error" } : undefined,
  });
}

function usageOf(value: unknown): Usage | undefined {
  if (!isObject(value)) return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
  const input = n(value.input_tokens);
  const output = n(value.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  return compact({ input, output, cacheRead: n(value.cache_read_input_tokens), cacheWrite: n(value.cache_creation_input_tokens) });
}

// ---------------------------------------------------------------------------------------------------------------
// ATXF → Claude Code: the active context as one linear chain of entries.

/** Claude Code uses UUIDs; ATXF ids map to stable name-based ones. */
export function uuidFor(id: string): string {
  const h = sha256(`atxf:${id}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const CLAUDE_STOPS: Record<StopReason, string> = {
  end: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  error: "end_turn",
  aborted: "end_turn",
  refusal: "refusal",
  other: "end_turn",
};

function encode(transcript: Transcript): Encoded[] {
  const context = buildContext(transcript);
  const times = new Map(transcript.records.map((record) => [record.id, record.time]));
  const sessionId = transcript.header.source.sessionId ?? transcript.header.id;
  const cwd = transcript.header.workspace?.cwd ?? context.settings.cwd ?? "/";
  const out: Encoded[] = [];
  const used = new Set<string>();
  let parentUuid: string | null = null;
  let time = transcript.header.time;

  const line = (fields: J, source: string) => {
    time = times.get(source) ?? time;
    let uuid = uuidFor(source);
    for (let n = 2; used.has(uuid); n++) uuid = uuidFor(`${source}#${n}`);
    used.add(uuid);
    out.push({ value: { parentUuid, isSidechain: false, ...fields, uuid, timestamp: time, cwd, sessionId, version: "atxf" }, source });
    parentUuid = uuid;
  };

  for (const message of context.messages) {
    const body = message.body;
    if (message.kind === "compaction_summary" || message.kind === "branch_summary") {
      line({ type: "user", isCompactSummary: true, message: { role: "user", content: textOf(body.content) } }, message.sourceId);
      continue;
    }
    switch (body.role) {
      case "system":
      case "user": {
        const hidden = body.role === "system" || body.display === false || (body.origin !== undefined && body.origin.kind !== "human");
        line({ type: "user", ...(hidden ? { isMeta: true } : {}), message: { role: "user", content: claudeContent(body.content) } }, message.sourceId);
        break;
      }
      case "tool":
        line(
          {
            type: "user",
            message: {
              role: "user",
              content: [compact({ type: "tool_result", tool_use_id: body.toolCallId, content: claudeContent(body.content), is_error: body.isError ? true : undefined })],
            },
          },
          message.sourceId,
        );
        break;
      case "assistant": {
        const content = body.content.flatMap((block): J[] => {
          switch (block.type) {
            case "text":
              return [{ type: "text", text: block.text }];
            case "reasoning": {
              const signature = block.replay?.find((r) => r.provider === "anthropic" && r.kind === "signature")?.data;
              return [compact({ type: "thinking", thinking: block.text ?? (block.summary ?? []).join("\n"), signature })];
            }
            case "tool_call":
              return [{ type: "tool_use", id: block.id, name: block.name, input: block.arguments ?? { input: block.input } }];
            case "image":
              return [];
          }
        });
        line(
          {
            type: "assistant",
            message: compact({
              model: body.model?.id ?? "unknown",
              id: body.responseId ?? `msg_${message.sourceId}`,
              type: "message",
              role: "assistant",
              content,
              stop_reason: CLAUDE_STOPS[body.stop ?? "end"],
              usage: {
                input_tokens: body.usage?.input ?? 0,
                output_tokens: body.usage?.output ?? 0,
                cache_read_input_tokens: body.usage?.cacheRead ?? 0,
                cache_creation_input_tokens: body.usage?.cacheWrite ?? 0,
              },
            }),
          },
          message.sourceId,
        );
        break;
      }
    }
  }
  return out;
}

function claudeContent(content: UserContent): string | J[] {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image" && block.data !== undefined) return { type: "image", source: { type: "base64", media_type: block.mediaType, data: block.data } };
    if (block.type === "image") return { type: "image", source: { type: "url", url: block.uri ?? "" } };
    return { type: "text", text: block.text ?? `[${block.uri}]` };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Carrier: marks go in an `atxf` key on each entry; the transcript rides on a first entry of type `atxf`, which
// Claude Code does not know and skips.

const carrier = {
  mark(value: unknown, source: string | null) {
    return { ...(value as J), atxf: { id: source } };
  },
  markOf(value: unknown) {
    return isObject(value) && isObject(value.atxf) && "id" in value.atxf ? (value.atxf.id as string | null) : undefined;
  },
  attach(values: unknown[], transcript: Transcript) {
    return [{ type: "atxf", transcript: carriedValue(transcript) }, ...values];
  },
  detach(units: Unit[]) {
    const index = units.findIndex((unit) => isObject(unit.value) && unit.value.type === "atxf" && isObject(unit.value.transcript));
    if (index === -1) return undefined;
    return { transcript: (units[index]!.value as J).transcript as Transcript, units: units.filter((_, i) => i !== index) };
  },
};

export const claudeCode = defineConverter({ agent: AGENT, format: FORMAT, framing: jsonl, decode, encode, carrier });
export default claudeCode;
