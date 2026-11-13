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
  type FormatReader,
  type EntryRecord,
  type J,
  type MessageBody,
  type ModelRef,
  type Replay,
  type StopReason,
  type ToolDefinition,
  type InstructionSection,
  type CustomRecord,
  type Transcript,
  type TranscriptHeader,
  type Unit,
  type Usage,
  type UserBlock,
  type UserContent,
  ATXF_VERSION,
  applyPatch,
  diff,
  type NestedCalls,
  type PatchOperation,
} from "../index.ts";

/**
 * Pi session files (`~/.pi/agent/sessions/**.jsonl`), session version 3, as documented in Pi's
 * `docs/session-format.md` and `docs/message-types.md`.
 */
export const AGENT = "pi";
export const FORMAT = "pi/session-jsonl";
/** Custom-record namespace for a Pi entry with no ATXF form: `data` is the whole entry. */
const ENTRY = "pi.entry";
/** Custom-record namespace for a line that is not JSON: `data.text` is the line. */
const LINE = "pi.line";
/** The Pi custom type of an entry carrying an ATXF record Pi has no entry for: `data` is the record. */
const CARRIED = "atxf.record";

// ---------------------------------------------------------------------------------------------------------------
// Pi → ATXF

function decode(units: Unit[], context: DecodeContext): { header: TranscriptHeader; records: EntryRecord[] } {
  const read = reader(context);
  const { header, took } = read.start(units[0]);
  for (let index = took ? 1 : 0; index < units.length; index++) read.next(units[index]!, index);
  return { header, records: read.tree.records };
}

/**
 * Reads a Pi file one unit at a time, in file order. Each unit becomes its record from what came before it alone,
 * so reading a file whole (`decode`) and reading it as Pi appends to it (`stream`) give the same records.
 */
function reader(context: DecodeContext, retain = true): FormatReader & { tree: TreeBuilder } {
  const tree = new TreeBuilder(context, retain);
  const native = (unit: Unit) => nativeOf([unit], AGENT, FORMAT);
  let header: TranscriptHeader | undefined;
  let hasContext = context.base?.records.some((record) => record.type === "context") ?? false;
  return {
    tree,
    start(first) {
      const value = first?.value;
      if (isObject(value) && value.type === "session" && !context.known.has(0)) {
        const { entry: session, reverse } = unpatched(value);
        header = withNative(reversed(patched(sessionHeader(session as J), session, sessionEntry), reverse), native(first!));
        return { header, took: true };
      }
      // A file without a session line: the header says so, and the whole-tree writer writes none.
      header = { ...sessionHeader({}), ext: { [AGENT]: { session: false } } };
      return { header, took: false };
    },
    next(unit, index) {
      const entry = unit.value;
      if (context.known.has(index)) {
        if (isObject(entry) && typeof entry.id === "string") {
          tree.alias(entry.id, context.known.get(index) ?? tree.parentOf(entry.parentId));
        }
        return undefined;
      }
      const { entry: value, reverse } = unpatched(entry);
      const read = entryRecord(value === entry ? unit : { ...unit, value }, index, tree, context, header!.time, hasContext);
      const last = tree.last;
      const record = reversed(isLine(read) ? read : patched(read, value, (r) => piEntry(r, last)), reverse);
      if (record.type === "context") hasContext = true;
      return tree.push(record, native(unit));
    },
  };
}

/**
 * `record` with what `value`, the native entry it was read from, holds beyond it: the patch from the entry `write`
 * gives for the record back to `value` (SPEC §11.2), in `ext.pi.patch`.
 */
function patched<R extends EntryRecord | TranscriptHeader>(record: R, value: unknown, write: (record: R) => unknown): R {
  const patch = diff(value, write(record));
  return patch.length === 0 ? record : { ...record, ext: { ...record.ext, pi: { patch } } };
}

/**
 * An entry the whole-tree writer wrote, without what it added: `atxf.patch`, the patch that turns the record read
 * from the entry into the record it was written for, when Pi cannot hold all of it (SPEC §11.2).
 */
function unpatched(entry: unknown): { entry: unknown; reverse?: PatchOperation[] } {
  if (!isObject(entry) || !isObject(entry.atxf) || !Array.isArray(entry.atxf.patch) || Object.keys(entry.atxf).length !== 1) return { entry };
  const { atxf, ...rest } = entry;
  return { entry: rest, reverse: atxf.patch as PatchOperation[] };
}

/** `record` with the reverse patch applied; unpatched when it does not apply. */
function reversed<R>(record: R, reverse: PatchOperation[] | undefined): R {
  if (reverse === undefined) return record;
  try {
    return applyPatch(record, reverse);
  } catch {
    return record;
  }
}

function withNative<R extends EntryRecord | TranscriptHeader>(record: R, native: ReturnType<typeof nativeOf> | undefined): R {
  return native === undefined ? record : { ...record, native };
}

function sessionHeader(session: J, native?: ReturnType<typeof nativeOf>): TranscriptHeader {
  const id = typeof session.id === "string" && session.id !== "" ? session.id : "pi-session";
  return compact({
    type: "transcript" as const,
    atxf: ATXF_VERSION,
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

function entryRecord(unit: Unit, index: number, tree: TreeBuilder, context: DecodeContext, fallbackTime: string, hasContext: boolean): EntryRecord {
  const entry = unit.value;
  const e: J = isObject(entry) ? entry : {};
  const id = context.ids.take(typeof e.id === "string" && e.id !== "" ? e.id : `pi-line-${index + 1}`);
  const parentId = tree.parentOf(e.parentId);
  const time = isoTime(e.timestamp, fallbackTime);
  const node = { id, parentId, time };
  // An entry with no ATXF form is kept whole, as a custom record: never refused, never dropped (SPEC §11.2).
  const custom = (): EntryRecord => {
    tree.alias(e.id, id);
    if (entry === null && unit.raw.trim() !== "null") {
      return { type: "custom", ...node, namespace: LINE, name: "line", data: { text: unit.raw.replace(/\n$/, "") } };
    }
    return { type: "custom", ...node, namespace: ENTRY, name: typeof e.type === "string" && e.type !== "" ? e.type : "entry", data: entry };
  };
  const annotation = <R extends EntryRecord>(record: R): R => {
    tree.alias(e.id, parentId);
    return record;
  };
  const treeRecord = <R extends EntryRecord>(record: R): R => {
    tree.alias(e.id, id);
    return record;
  };

  if (!isObject(entry)) return custom();
  switch (e.type) {
    case "message": {
      const body = messageBody(e.message, tree, time);
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
          files: filesOf(e.details),
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
    case "custom": {
      tree.alias(e.id, id);
      const carried = carriedRecord(e, node);
      if (carried) return carried;
      return compact({
        type: "custom" as const,
        ...node,
        namespace: AGENT,
        name: typeof e.customType === "string" && e.customType !== "" ? e.customType : "custom",
        data: e.data,
      });
    }
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

const isLine = (record: EntryRecord): record is CustomRecord => record.type === "custom" && record.namespace === LINE;

/** The ATXF record a Pi custom entry written by `encodeTree` carries, with the entry's id, parent and time. */
function carriedRecord(e: J, node: { id: string; parentId: string | null; time: string }): EntryRecord | undefined {
  if (e.customType !== CARRIED || !isObject(e.data) || typeof e.data.type !== "string") return undefined;
  const { type, parentId, id: _, time: __, ...rest } = e.data;
  const tree = parentId !== undefined;
  return (tree ? { type, id: node.id, parentId: node.parentId, time: node.time, ...rest } : { type, id: node.id, time: node.time, ...rest }) as EntryRecord;
}

/** A Pi message as an ATXF message body; "context" for a system message; undefined when it has no portable form. */
function messageBody(message: unknown, tree: TreeBuilder, time: string): MessageBody | "context" | undefined {
  if (!isObject(message)) return undefined;
  // Pi's message timestamp is when the message began (the request, for an assistant message); the entry's is when
  // it was written. ATXF keeps the first only when it differs.
  const began = isoTime(message.timestamp, time);
  const startTime = millisFromIso(began) === millisFromIso(time) ? undefined : began;
  switch (message.role) {
    case "system":
      return "context";
    case "user": {
      const content = userContent(message.content);
      return content === undefined ? undefined : compact({ role: "user" as const, content, startTime });
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
        responseModel: typeof message.responseModel === "string" ? message.responseModel : undefined,
        reasoningEffort: typeof message.thinkingLevel === "string" ? message.thinkingLevel : undefined,
        providerReasoningEffort: typeof message.providerThinkingLevel === "string" ? message.providerThinkingLevel : undefined,
        error: typeof message.errorMessage === "string" ? { message: message.errorMessage } : undefined,
        startTime,
        durationMs: duration(message.durationMs),
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
        nestedCalls: nestedCallsOf(message.nestedCalls),
        startTime,
        durationMs: duration(message.durationMs),
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

const duration = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
const strings = (value: unknown) => (Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined);

/** Pi's compaction details: the files the compacted history read and modified. */
function filesOf(details: unknown): { read?: string[]; modified?: string[] } | undefined {
  if (!isObject(details)) return undefined;
  const files = compact({ read: strings(details.readFiles), modified: strings(details.modifiedFiles) });
  return Object.keys(files).length === 0 ? undefined : files;
}

const NESTED_STATUS = new Set(["ok", "error", "unfinished"]);

/** Pi's record of the calls a tool made, when it has the shape ATXF gives it (SPEC §8). */
function nestedCallsOf(value: unknown): NestedCalls | undefined {
  if (!isObject(value) || !Array.isArray(value.calls) || typeof value.complete !== "boolean") return undefined;
  const calls: NestedCalls["calls"] = [];
  for (const call of value.calls) {
    if (!isObject(call) || typeof call.id !== "string" || typeof call.name !== "string" || !NESTED_STATUS.has(call.status)) return undefined;
    calls.push(
      compact({
        id: call.id,
        name: call.name,
        arguments: isObject(call.arguments) ? call.arguments : undefined,
        argumentsBytes: count(call.argumentsBytes),
        status: call.status,
        durationMs: duration(call.durationMs),
        error: typeof call.error === "string" ? call.error : undefined,
      }),
    );
  }
  return { calls, complete: value.complete };
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
    cacheWrite1h: count(value.cacheWrite1h),
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
// ATXF → Pi, the whole tree: every record as its Pi entry, with what the record kept of its entry (SPEC §11.2).

/** The session line for a transcript header. */
function sessionEntry(header: TranscriptHeader): J {
  const version = header.source.version;
  return compact({
    type: "session",
    version: version === undefined ? 3 : /^\d+$/.test(version) ? Number(version) : version,
    id: header.source.sessionId ?? header.id,
    timestamp: header.time,
    cwd: header.workspace?.cwd ?? "",
    parentSession: header.parent?.relation === "fork" ? (header.parent.uri ?? header.parent.transcriptId) : undefined,
  });
}

/** What ATXF fields a record holds besides its envelope. */
function fieldsOf(record: EntryRecord): string[] {
  return Object.keys(record).filter((key) => !["type", "id", "parentId", "time", "ext", "native", "hash"].includes(key));
}

const only = (record: EntryRecord, ...keys: string[]) => fieldsOf(record).every((key) => keys.includes(key));

/**
 * The Pi entry for a record, before its patch. `last` is the last tree record before it, the parent Pi gives an
 * entry that is not part of the tree in ATXF (a label, the session name).
 */
function piEntry(record: EntryRecord, last: string | null): unknown {
  const parentId = "parentId" in record ? record.parentId : last;
  const entry = (type: string, fields: J): J => ({ type, id: record.id, parentId, timestamp: record.time, ...fields });
  const carried = () => {
    const { id: _, time: __, ext: ___, native: ____, hash: _____, ...data } = record as J;
    return entry("custom", { customType: CARRIED, data });
  };
  switch (record.type) {
    case "message": {
      if (record.role === "user" && record.origin?.kind === "extension") {
        return entry("custom_message", { customType: record.origin.name ?? "", content: piUserContent(record.content), display: record.display ?? true });
      }
      return entry("message", { message: piMessage(record, millisFromIso(record.startTime ?? record.time)) });
    }
    case "context":
      return entry("message", { message: piSystem(record.instructions, record.toolsAdded, record.toolsRemoved, millisFromIso(record.time)) });
    case "settings":
      if (record.model && only(record, "model") && only({ ...record.model, type: "x" } as unknown as EntryRecord, "provider", "id")) {
        return entry("model_change", { provider: record.model.provider, modelId: record.model.id });
      }
      if (record.reasoningEffort !== undefined && only(record, "reasoningEffort")) return entry("thinking_level_change", { thinkingLevel: record.reasoningEffort });
      return carried();
    case "usage":
      return entry("usage", compact({ kind: record.kind, provider: record.model?.provider, model: record.model?.id, usage: piUsage(record.usage) }));
    case "compaction":
      if (record.strategy !== "summary" || record.summary === undefined) return carried();
      return entry(
        "compaction",
        compact({
          summary: record.summary,
          firstKeptEntryId: record.firstKeptId ?? record.id,
          tokensBefore: record.tokensBefore,
          details: record.files ? compact({ readFiles: record.files.read, modifiedFiles: record.files.modified }) : undefined,
          usage: record.usage ? piUsage(record.usage) : undefined,
          systemMessage: record.snapshot ? piSystem(record.snapshot.instructions, record.snapshot.tools, undefined, millisFromIso(record.time)) : undefined,
        }),
      );
    case "context_edit":
      return entry("context_edit", { targetId: record.targetId, replacement: record.replacement === null ? null : piUserContent(record.replacement as UserContent) });
    case "branch_summary":
      return entry("branch_summary", compact({ fromId: record.fromId, summary: record.summary, usage: record.usage ? piUsage(record.usage) : undefined }));
    case "custom":
      if (record.namespace === ENTRY) return record.data;
      if (record.namespace === AGENT) return entry("custom", compact({ customType: record.name, data: record.data }));
      return carried();
    case "label":
      return entry("label", { targetId: record.targetId, label: record.label });
    case "metadata":
      return record.title !== undefined && only(record, "title") ? entry("session_info", { name: record.title }) : carried();
    default:
      return carried();
  }
}

/** A Pi system message: instructions as sections, the one named `system` as its content. */
function piSystem(instructions: InstructionSection[] | undefined, tools: ToolDefinition[] | undefined, removed: string[] | undefined, timestamp: number): J {
  const sections = (instructions ?? []).filter((section) => section.name !== "system");
  const system = (instructions ?? []).find((section) => section.name === "system");
  return compact({
    role: "system",
    content: system?.text ?? "",
    sections: sections.length > 0 ? Object.fromEntries(sections.map((section) => [section.name, section.text])) : undefined,
    toolsAdded: tools?.map((tool) => compact({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    toolsRemoved: removed?.map((name) => ({ name })),
    timestamp,
  });
}

/** `value` with the patch `kept` holds in `ext.pi`; unpatched when the patch no longer applies. */
function restored(kept: EntryRecord | TranscriptHeader, value: unknown): unknown {
  const patch = (kept.ext?.[AGENT] as { patch?: PatchOperation[] } | undefined)?.patch;
  if (!Array.isArray(patch)) return value;
  try {
    return applyPatch(value, patch);
  } catch {
    return value;
  }
}

/**
 * Every record as its Pi entry. Each entry is read back, and one whose record does not come back as written gets
 * `atxf.patch`, which turns the record read into the record written, so a transcript from any source survives
 * (SPEC §11.2). Pi ignores the `atxf` key, as it does the mark of a carried transcript.
 */
function encodeTree(transcript: Transcript): Encoded[] {
  const out = treeEntries(transcript);
  const text = out.map((unit) => (unit.raw === undefined ? jsonl.canonical(unit.value) : `${unit.raw}\n`)).join("");
  const back = pi.toAtxf(text, { integrity: false });
  const offset = out.length - transcript.records.length;
  if (back.records.length !== transcript.records.length || offset < 0) return out;
  const reverse = (unit: Encoded, to: unknown, from: unknown) => {
    const patch = diff(to, from);
    if (patch.length > 0 && unit.raw === undefined && isObject(unit.value) && !("atxf" in unit.value)) unit.value = { ...unit.value, atxf: { patch } };
  };
  if (offset === 1) reverse(out[0]!, comparableHeader(transcript.header), comparableHeader(back.header));
  transcript.records.forEach((record, index) => reverse(out[offset + index]!, comparable(record), comparable(back.records[index]!)));
  return out;
}

/** What a record keeps when written without native: not native, nor what integrity recomputes. */
function comparable(record: EntryRecord): J {
  const { native: _, hash: __, ...rest } = record as J;
  return rest;
}

function comparableHeader(header: TranscriptHeader): J {
  const { native: _, hash: __, integrity: ___, fidelity, ...rest } = header as J;
  if (fidelity === undefined) return rest;
  // Whether the transcript holds native records, and the digest of their file, are the reader's to say.
  const { nativeDigest: ____, native: _____, ...kept } = fidelity as J;
  return { ...rest, fidelity: kept };
}

function treeEntries(transcript: Transcript): Encoded[] {
  const kept = transcript.header.ext?.[AGENT] as { session?: boolean } | undefined;
  const out: Encoded[] = kept?.session === false ? [] : [{ value: restored(transcript.header, sessionEntry(transcript.header)), source: null }];
  let last: string | null = null;
  for (const record of transcript.records) {
    if (isLine(record)) {
      const text = isObject(record.data) && typeof record.data.text === "string" ? record.data.text : "";
      out.push({ value: null, raw: text, source: record.id });
    } else {
      out.push({ value: restored(record, piEntry(record, last)), source: record.id });
    }
    if ("parentId" in record) last = record.id;
  }
  return out;
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
        nestedCalls: body.nestedCalls,
        isError: body.isError === true,
        timestamp,
        durationMs: body.durationMs,
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
      return compact({
        role: "assistant",
        content,
        api: body.model?.api ?? "unknown",
        provider: body.model?.provider ?? "unknown",
        model: body.model?.id ?? "unknown",
        responseId: body.responseId,
        responseModel: body.responseModel,
        thinkingLevel: body.reasoningEffort,
        providerThinkingLevel: body.providerReasoningEffort,
        usage: piUsage(body.usage),
        stopReason: PI_STOPS[body.stop ?? "end"],
        rawStopReason: body.rawStop,
        errorMessage: body.error?.message,
        timestamp,
        durationMs: body.durationMs,
      });
    }
  }
}

/** Usage as Pi writes it: every bucket and cost present, zero when unknown. */
function piUsage(usage: Usage | undefined): J {
  return compact({
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    cacheWrite1h: usage?.cacheWrite1h,
    reasoning: usage?.reasoning,
    totalTokens: usage?.total ?? (usage ? usage.input + usage.output : 0),
    cost: {
      input: usage?.cost?.input ?? 0,
      output: usage?.cost?.output ?? 0,
      cacheRead: usage?.cost?.cacheRead ?? 0,
      cacheWrite: usage?.cost?.cacheWrite ?? 0,
      total: usage?.cost?.total ?? 0,
    },
  });
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

export const pi = defineConverter({ agent: AGENT, format: FORMAT, framing: jsonl, decode, encode, encodeTree, carrier, reader: (context) => reader(context, false) });
export default pi;
