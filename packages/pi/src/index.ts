import {
  buildContext,
  carriedValue,
  compact,
  defineConverter,
  EPOCH,
  IdAllocator,
  isObject,
  isoTime,
  jsonl,
  millisFromIso,
  nativeOf,
  TreeBuilder,
  type AssistantBlock,
  type DecodeContext,
  type Encoded,
  type EntryRecord,
  type J,
  type MessageBody,
  type ModelRef,
  type Replay,
  type StopReason,
  type ToolDefinition,
  type Transcript,
  type TranscriptHeader,
  type Unit,
  type Usage,
  type UserBlock,
  type UserContent,
} from "@atxf/core";

/**
 * Pi session files (`~/.pi/agent/sessions/**.jsonl`), session version 3, as documented in Pi's
 * `docs/session-format.md` and `docs/message-types.md`.
 */
export const AGENT = "pi";
export const FORMAT = "pi/session-jsonl";

// ---------------------------------------------------------------------------------------------------------------
// Pi → ATXF

function decode(units: Unit[], context: DecodeContext): { header: TranscriptHeader; records: EntryRecord[] } {
  const tree = new TreeBuilder(context);
  const native = (unit: Unit) => nativeOf([unit], AGENT, FORMAT);
  let start = 0;
  let header: TranscriptHeader;
  const first = units[0]?.value;
  if (isObject(first) && first.type === "session" && !context.known.has(0)) {
    header = sessionHeader(first, native(units[0]!));
    start = 1;
  } else {
    header = sessionHeader({}, undefined);
  }
  let hasContext = context.base?.records.some((record) => record.type === "context") ?? false;

  for (let index = start; index < units.length; index++) {
    const unit = units[index]!;
    const entry = unit.value;
    if (context.known.has(index)) {
      if (isObject(entry) && typeof entry.id === "string") {
        tree.alias(entry.id, context.known.get(index) ?? tree.parentOf(entry.parentId));
      }
      continue;
    }
    const record = entryRecord(entry, index, tree, context, header.time, hasContext);
    if (record.type === "context") hasContext = true;
    tree.push(record, native(unit));
  }
  return { header, records: tree.records };
}

function sessionHeader(session: J, native: ReturnType<typeof nativeOf> | undefined): TranscriptHeader {
  const id = typeof session.id === "string" && session.id !== "" ? session.id : "pi-session";
  return compact({
    type: "transcript" as const,
    atxf: "0.1" as const,
    id,
    time: isoTime(session.timestamp, EPOCH),
    source: compact({
      agent: AGENT,
      format: FORMAT,
      version: session.version === undefined ? undefined : String(session.version),
      sessionId: typeof session.id === "string" ? session.id : undefined,
    }),
    workspace: typeof session.cwd === "string" ? { cwd: session.cwd } : undefined,
    parent:
      typeof session.parentSession === "string" && session.parentSession !== ""
        ? { transcriptId: session.parentSession, uri: session.parentSession, relation: "fork" as const }
        : undefined,
    fidelity: { topology: "tree" as const, instructions: "full" as const, tools: "full" as const, native: "all" as const, ids: "stable" as const },
    native,
  });
}

function entryRecord(entry: unknown, index: number, tree: TreeBuilder, context: DecodeContext, fallbackTime: string, hasContext: boolean): EntryRecord {
  const e: J = isObject(entry) ? entry : {};
  const id = context.ids.take(typeof e.id === "string" && e.id !== "" ? e.id : `pi-line-${index + 1}`);
  const parentId = tree.parentOf(e.parentId);
  const time = isoTime(e.timestamp, fallbackTime);
  const node = { id, parentId, time };
  const custom = (): EntryRecord => {
    tree.alias(e.id, id);
    return { type: "custom", ...node, namespace: AGENT, name: typeof e.type === "string" ? e.type : "unparsed" };
  };
  const annotation = <R extends EntryRecord>(record: R): R => {
    tree.alias(e.id, parentId);
    return record;
  };
  const treeRecord = <R extends EntryRecord>(record: R): R => {
    tree.alias(e.id, id);
    return record;
  };

  switch (e.type) {
    case "message": {
      const body = messageBody(e.message, tree);
      if (body === "context") return treeRecord(contextRecord(node, e.message, hasContext));
      if (body === undefined) return custom();
      return treeRecord({ type: "message", ...node, ...body } as EntryRecord);
    }
    case "model_change":
      if (typeof e.provider !== "string" || typeof e.modelId !== "string") return custom();
      return treeRecord({ type: "settings", ...node, model: { provider: e.provider, id: e.modelId } });
    case "thinking_level_change":
      if (typeof e.thinkingLevel !== "string") return custom();
      return treeRecord({ type: "settings", ...node, reasoningEffort: e.thinkingLevel });
    case "usage": {
      const usage = usageOf(e.usage);
      if (!usage) return custom();
      return treeRecord(
        compact({
          type: "usage" as const,
          ...node,
          kind: typeof e.kind === "string" ? e.kind : "unknown",
          model: typeof e.provider === "string" && typeof e.model === "string" ? { provider: e.provider, id: e.model } : undefined,
          usage,
        }),
      );
    }
    case "compaction": {
      if (typeof e.summary !== "string") return custom();
      let firstKeptId = tree.resolve(e.firstKeptEntryId);
      if (firstKeptId !== null && !tree.isAncestor(firstKeptId, parentId)) firstKeptId = null;
      const snapshot = isObject(e.systemMessage) ? promptOf(e.systemMessage) : undefined;
      return treeRecord(
        compact({
          type: "compaction" as const,
          ...node,
          strategy: "summary" as const,
          summary: e.summary,
          firstKeptId,
          snapshot: snapshot ? compact({ instructions: snapshot.instructions, tools: snapshot.tools }) : undefined,
          tokensBefore: Number.isInteger(e.tokensBefore) && e.tokensBefore >= 0 ? e.tokensBefore : undefined,
          usage: usageOf(e.usage),
        }),
      );
    }
    case "context_edit": {
      const targetId = tree.resolve(e.targetId);
      if (targetId === null || tree.typeOf(targetId) !== "message") return custom();
      const replacement = e.replacement === null ? null : replacementOf(e.replacement);
      if (replacement === undefined) return custom();
      return treeRecord({ type: "context_edit", ...node, targetId, replacement });
    }
    case "branch_summary": {
      const fromId = tree.resolve(e.fromId);
      if (fromId === null || typeof e.summary !== "string") return custom();
      return treeRecord(compact({ type: "branch_summary" as const, ...node, fromId, summary: e.summary, usage: usageOf(e.usage) }));
    }
    case "custom":
      tree.alias(e.id, id);
      return compact({
        type: "custom" as const,
        ...node,
        namespace: AGENT,
        name: typeof e.customType === "string" && e.customType !== "" ? e.customType : "custom",
        data: e.data,
      });
    case "custom_message": {
      const content = userContent(e.content);
      if (content === undefined) return custom();
      return treeRecord(
        compact({
          type: "message" as const,
          ...node,
          role: "user" as const,
          content,
          origin: compact({ kind: "extension" as const, name: typeof e.customType === "string" && e.customType !== "" ? e.customType : undefined }),
          display: typeof e.display === "boolean" ? e.display : undefined,
        }),
      );
    }
    case "label": {
      const targetId = tree.resolve(e.targetId);
      if (targetId === null) return custom();
      return annotation({ type: "label", id, time, targetId, label: typeof e.label === "string" ? e.label : null });
    }
    case "session_info":
      if (typeof e.name !== "string") return custom();
      return annotation({ type: "metadata", id, time, title: e.name });
    default:
      return custom();
  }
}

/** A Pi message as an ATXF message body; "context" for a system message; undefined when it has no portable form. */
function messageBody(message: unknown, tree: TreeBuilder): MessageBody | "context" | undefined {
  if (!isObject(message)) return undefined;
  switch (message.role) {
    case "system":
      return "context";
    case "user": {
      const content = userContent(message.content);
      return content === undefined ? undefined : { role: "user", content };
    }
    case "assistant": {
      if (!Array.isArray(message.content)) return undefined;
      const model: ModelRef | undefined =
        typeof message.provider === "string" && typeof message.model === "string"
          ? compact({ provider: message.provider, id: message.model, api: typeof message.api === "string" ? message.api : undefined })
          : undefined;
      const replayBase = { provider: model?.provider ?? "unknown", api: model?.api, model: model?.id };
      const content: AssistantBlock[] = [];
      for (const block of message.content) {
        if (!isObject(block)) continue;
        if (block.type === "text" && typeof block.text === "string") {
          content.push(compact({ type: "text" as const, text: block.text, replay: replay(replayBase, "text_signature", block.textSignature) }));
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          content.push(
            compact({
              type: "reasoning" as const,
              text: block.thinking,
              redacted: block.redacted === true ? true : undefined,
              replay: replay(replayBase, "signature", block.thinkingSignature),
            }),
          );
        } else if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
          if (tree.hasToolCall(block.id)) continue; // ATXF tool call ids are unique; a repeat stays in native only.
          content.push(
            compact({
              type: "tool_call" as const,
              id: block.id,
              name: block.name,
              namespace: typeof block.namespace === "string" ? block.namespace : undefined,
              arguments: isObject(block.arguments) ? block.arguments : {},
              replay: replay(replayBase, "thought_signature", block.thoughtSignature),
            }),
          );
        } else if (block.type === "image" && typeof block.mimeType === "string") {
          content.push(compact({ type: "image" as const, mediaType: block.mimeType, data: typeof block.data === "string" ? block.data : undefined }));
        }
      }
      return compact({
        role: "assistant" as const,
        content,
        model,
        usage: usageOf(message.usage),
        stop: stopOf(message.stopReason),
        rawStop:
          typeof message.rawStopReason === "string"
            ? message.rawStopReason
            : typeof message.stopReason === "string" && stopOf(message.stopReason) === "other"
              ? message.stopReason
              : undefined,
        responseId: typeof message.responseId === "string" ? message.responseId : undefined,
        error: typeof message.errorMessage === "string" ? { message: message.errorMessage } : undefined,
      });
    }
    case "toolResult": {
      if (typeof message.toolCallId !== "string") return undefined;
      const content = userContent(message.content);
      if (content === undefined) return undefined;
      return compact({
        role: "tool" as const,
        toolCallId: message.toolCallId,
        toolName: typeof message.toolName === "string" ? message.toolName : undefined,
        content,
        isError: typeof message.isError === "boolean" ? message.isError : undefined,
        details: isObject(message.details) ? message.details : undefined,
      });
    }
    case "custom": {
      const content = userContent(message.content);
      if (content === undefined) return undefined;
      return compact({
        role: "user" as const,
        content,
        origin: compact({ kind: "extension" as const, name: typeof message.customType === "string" && message.customType !== "" ? message.customType : undefined }),
        display: typeof message.display === "boolean" ? message.display : undefined,
      });
    }
    case "bashExecution": {
      if (message.excludeFromContext === true || typeof message.command !== "string") return undefined;
      const output = typeof message.output === "string" ? message.output : "";
      return { role: "user", content: `$ ${message.command}\n${output}`, origin: { kind: "command", name: "bash" } };
    }
    default:
      return undefined;
  }
}

function contextRecord(node: { id: string; parentId: string | null; time: string }, message: J, hasContext: boolean): EntryRecord {
  const { instructions, tools, removed } = promptOf(message);
  return compact({
    type: "context" as const,
    ...node,
    mode: hasContext ? ("patch" as const) : ("replace" as const),
    instructions: instructions.length > 0 ? instructions : undefined,
    toolsAdded: tools.length > 0 ? tools : undefined,
    toolsRemoved: hasContext && removed.length > 0 ? removed : undefined,
  });
}

function promptOf(message: J) {
  const instructions: { name: string; text: string | null }[] = [];
  if (isObject(message.sections)) {
    for (const [name, text] of Object.entries(message.sections)) {
      if (typeof text === "string" || text === null) instructions.push({ name, text });
    }
  }
  const text = textOf(message.content);
  if (text) instructions.push({ name: "system", text });
  const tools: ToolDefinition[] = [];
  for (const tool of Array.isArray(message.toolsAdded) ? message.toolsAdded : []) {
    if (!isObject(tool) || typeof tool.name !== "string") continue;
    tools.push(
      compact({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : undefined,
        parameters: isObject(tool.parameters) ? tool.parameters : undefined,
      }),
    );
  }
  const removed: string[] = [];
  for (const tool of Array.isArray(message.toolsRemoved) ? message.toolsRemoved : []) {
    if (isObject(tool) && typeof tool.name === "string") removed.push(tool.name);
  }
  return { instructions, tools, removed };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => (isObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n");
}

function userContent(content: unknown): UserContent | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const blocks: UserBlock[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") blocks.push({ type: "text", text: block.text });
    else if (block.type === "image" && typeof block.mimeType === "string") {
      blocks.push(compact({ type: "image" as const, mediaType: block.mimeType, data: typeof block.data === "string" ? block.data : undefined }));
    }
  }
  return blocks;
}

function replacementOf(value: unknown): UserContent | AssistantBlock[] | undefined {
  return userContent(value);
}

function replay(base: { provider: string; api?: string; model?: string }, kind: string, data: unknown): Replay[] | undefined {
  return typeof data === "string" && data !== "" ? [compact({ ...base, kind, data })] : undefined;
}

const STOPS: Record<string, StopReason> = { stop: "end", toolUse: "tool_use", length: "max_tokens", error: "error", aborted: "aborted" };

function stopOf(value: unknown): StopReason | undefined {
  if (typeof value !== "string") return undefined;
  return STOPS[value] ?? "other";
}

const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined);
const amount = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

function usageOf(value: unknown): Usage | undefined {
  if (!isObject(value)) return undefined;
  const input = count(value.input);
  const output = count(value.output);
  if (input === undefined || output === undefined) return undefined;
  const cost = isObject(value.cost) && amount(value.cost.total) !== undefined ? value.cost : undefined;
  return compact({
    input,
    output,
    cacheRead: count(value.cacheRead),
    cacheWrite: count(value.cacheWrite),
    reasoning: count(value.reasoning),
    total: count(value.totalTokens),
    cost: cost
      ? compact({
          input: amount(cost.input),
          output: amount(cost.output),
          cacheRead: amount(cost.cacheRead),
          cacheWrite: amount(cost.cacheWrite),
          total: amount(cost.total)!,
        })
      : undefined,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// ATXF → Pi: the active context as a linear Pi session.

function encode(transcript: Transcript): Encoded[] {
  const context = buildContext(transcript);
  const times = new Map(transcript.records.map((record) => [record.id, record.time]));
  const out: Encoded[] = [];
  const ids = new IdAllocator();
  let parentId: string | null = null;
  let time = transcript.header.time;

  out.push({
    value: compact({
      type: "session",
      version: 3,
      id: transcript.header.source.sessionId ?? transcript.header.id,
      timestamp: transcript.header.time,
      cwd: transcript.header.workspace?.cwd ?? context.settings.cwd ?? "",
    }),
    source: null,
  });
  const entry = (fields: J, source: string | null) => {
    if (source) time = times.get(source) ?? time;
    const id = ids.take(source ?? "atxf");
    out.push({ value: { type: fields.type, id, parentId, timestamp: time, ...fields }, source });
    parentId = id;
  };

  if (context.instructions.length > 0 || context.tools.length > 0) {
    entry(
      {
        type: "message",
        message: compact({
          role: "system",
          content: "",
          sections: context.instructions.length > 0 ? Object.fromEntries(context.instructions.map((s) => [s.name, s.text])) : undefined,
          toolsAdded:
            context.tools.length > 0
              ? context.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? {} }))
              : undefined,
          timestamp: millisFromIso(time),
        }),
      },
      null,
    );
  }
  if (context.settings.model) {
    entry({ type: "model_change", provider: context.settings.model.provider, modelId: context.settings.model.id }, null);
  }
  if (context.settings.reasoningEffort) entry({ type: "thinking_level_change", thinkingLevel: context.settings.reasoningEffort }, null);

  for (const message of context.messages) {
    // A summary first in the context is a retain-none compaction. Later on (a branch summary, or a compaction kept
    // in the range of a later one) it must not cut the context: it is a branch summary.
    const summary = message.kind === "compaction_summary" || message.kind === "branch_summary";
    if (summary && parentId === null) {
      const id = ids.take(message.sourceId);
      time = times.get(message.sourceId) ?? time;
      // Retain-none: Pi marks it by pointing firstKeptEntryId at the compaction itself.
      out.push({
        value: { type: "compaction", id, parentId, timestamp: time, summary: textOf(message.body.content), firstKeptEntryId: id, tokensBefore: 0 },
        source: message.sourceId,
      });
      parentId = id;
      continue;
    }
    if (summary) {
      entry({ type: "branch_summary", fromId: parentId, summary: textOf(message.body.content) }, message.sourceId);
      continue;
    }
    const body = message.body;
    if (body.role === "user" && ((body.origin && body.origin.kind !== "human") || body.display === false)) {
      // Pi's form for context that no person typed, or that is hidden: a custom message.
      const customType = body.origin ? [body.origin.kind, body.origin.name].filter(Boolean).join(":") : "atxf";
      entry({ type: "custom_message", customType, content: piUserContent(body.content), display: body.display ?? true }, message.sourceId);
      continue;
    }
    entry({ type: "message", message: piMessage(body, millisFromIso(times.get(message.sourceId) ?? time)) }, message.sourceId);
  }
  return out;
}

const PI_STOPS: Record<StopReason, string> = {
  end: "stop",
  tool_use: "toolUse",
  max_tokens: "length",
  error: "error",
  aborted: "aborted",
  refusal: "stop",
  other: "stop",
};

function piMessage(body: MessageBody, timestamp: number): J {
  switch (body.role) {
    case "system":
      return { role: "system", content: typeof body.content === "string" ? body.content : textOf(body.content), timestamp };
    case "user":
      return { role: "user", content: piUserContent(body.content), timestamp };
    case "tool":
      return compact({
        role: "toolResult",
        toolCallId: body.toolCallId,
        toolName: body.toolName ?? "",
        content: typeof body.content === "string" ? [{ type: "text", text: body.content }] : piUserContent(body.content),
        details: body.details,
        isError: body.isError === true,
        timestamp,
      });
    case "assistant": {
      const signature = (replay: Replay[] | undefined, kind: string) => replay?.find((r) => r.kind === kind && typeof r.data === "string")?.data;
      const content = body.content.map((block): J => {
        switch (block.type) {
          case "text":
            return compact({ type: "text", text: block.text, textSignature: signature(block.replay, "text_signature") });
          case "reasoning":
            return compact({
              type: "thinking",
              thinking: block.text ?? (block.summary ?? []).join("\n"),
              thinkingSignature: signature(block.replay, "signature"),
              redacted: block.redacted,
            });
          case "tool_call":
            return compact({
              type: "toolCall",
              id: block.id,
              name: block.name,
              arguments: block.arguments ?? (block.input === undefined ? {} : { input: block.input }),
              namespace: block.namespace,
              thoughtSignature: signature(block.replay, "thought_signature"),
            });
          case "image":
            return { type: "text", text: "[image]" };
        }
      });
      const usage = body.usage;
      return compact({
        role: "assistant",
        content,
        api: body.model?.api ?? "unknown",
        provider: body.model?.provider ?? "unknown",
        model: body.model?.id ?? "unknown",
        responseId: body.responseId,
        usage: {
          input: usage?.input ?? 0,
          output: usage?.output ?? 0,
          cacheRead: usage?.cacheRead ?? 0,
          cacheWrite: usage?.cacheWrite ?? 0,
          totalTokens: usage?.total ?? (usage ? usage.input + usage.output : 0),
          cost: {
            input: usage?.cost?.input ?? 0,
            output: usage?.cost?.output ?? 0,
            cacheRead: usage?.cost?.cacheRead ?? 0,
            cacheWrite: usage?.cost?.cacheWrite ?? 0,
            total: usage?.cost?.total ?? 0,
          },
        },
        stopReason: PI_STOPS[body.stop ?? "end"],
        rawStopReason: body.rawStop,
        errorMessage: body.error?.message,
        timestamp,
      });
    }
  }
}

function piUserContent(content: UserContent): string | J[] {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image" && block.data !== undefined) return { type: "image", data: block.data, mimeType: block.mediaType };
    if (block.type === "image") return { type: "text", text: `[image ${block.uri ?? ""}]`.trim() };
    return { type: "text", text: block.text ?? `[${block.uri}]` };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Carrier: marks go in an `atxf` key on each entry; the transcript rides on the session header.

const carrier = {
  mark(value: unknown, source: string | null) {
    return { ...(value as J), atxf: { id: source } };
  },
  markOf(value: unknown) {
    return isObject(value) && isObject(value.atxf) && "id" in value.atxf ? (value.atxf.id as string | null) : undefined;
  },
  attach(values: unknown[], transcript: Transcript) {
    const [header, ...rest] = values as J[];
    return [{ ...header, atxf: { ...header!.atxf, transcript: carriedValue(transcript) } }, ...rest];
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

export const pi = defineConverter({ agent: AGENT, format: FORMAT, framing: jsonl, decode, encode, carrier });
export default pi;
