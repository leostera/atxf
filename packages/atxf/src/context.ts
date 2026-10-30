import { indexTree, pathTo, type TreeIndex } from "./tree.ts";
import type {
  AssistantBlock,
  CompactionRecord,
  ContextEditRecord,
  ContextRecord,
  InstructionSection,
  MessageBody,
  ModelRef,
  Replay,
  ToolDefinition,
  Transcript,
  TreeRecord,
} from "./types.ts";

/** How a context message came about. */
export type ContextMessageKind = "message" | "compaction_summary" | "compaction_replacement" | "branch_summary";

export interface ContextMessage {
  body: MessageBody;
  /** The tree record the message comes from. */
  sourceId: string;
  kind: ContextMessageKind;
}

export interface EffectiveSettings {
  model?: ModelRef;
  reasoningEffort?: string;
  agent?: string;
  mode?: string;
  cwd?: string;
  policy?: Record<string, unknown>;
}

/** The model-visible state at one position in the tree (SPEC §5, §6). */
export interface ModelContext {
  leaf: string | null;
  instructions: { name: string; text: string }[];
  tools: ToolDefinition[];
  messages: ContextMessage[];
  settings: EffectiveSettings;
}

export interface BuildContextOptions {
  /** Position in the tree; defaults to the active leaf. */
  leaf?: string | null;
  /** Keep only replay data for this target (SPEC §10). Without it, replay data is kept as is. */
  target?: { provider: string; api?: string };
  index?: TreeIndex;
}

/**
 * The records that contribute to model context at the end of `path`, in order (SPEC §5 step 1): the last
 * compaction and what it keeps, or the whole path.
 */
export function workingRange(path: readonly TreeRecord[]): { range: TreeRecord[]; compaction?: CompactionRecord; before: TreeRecord[] } {
  const at = path.findLastIndex((record) => record.type === "compaction");
  if (at === -1) return { range: [...path], before: [] };
  const compaction = path[at] as CompactionRecord;
  const after = path.slice(at + 1);
  let kept: TreeRecord[] = [];
  if (compaction.strategy === "summary" && compaction.firstKeptId) {
    const from = path.findIndex((record) => record.id === compaction.firstKeptId);
    if (from !== -1 && from < at) kept = path.slice(from, at);
  }
  return { range: [compaction, ...kept, ...after], compaction, before: path.slice(0, at) };
}

export function buildContext(transcript: Transcript, options: BuildContextOptions = {}): ModelContext {
  const index = options.index ?? indexTree(transcript);
  const leaf = options.leaf === undefined ? index.activeLeaf : options.leaf;
  const path = pathTo(index, leaf);
  const { range, compaction, before } = workingRange(path);

  const promptState = new PromptState();
  if (compaction?.snapshot) {
    promptState.replace(compaction.snapshot.instructions ?? [], compaction.snapshot.tools ?? []);
  } else {
    for (const record of before) if (record.type === "context") promptState.apply(record);
  }
  for (const record of range) if (record.type === "context") promptState.apply(record);

  const edits = latestEdits(path);
  const messages: ContextMessage[] = [];
  for (const record of range) {
    switch (record.type) {
      case "message": {
        const edit = edits.get(record.id);
        if (edit === null) break;
        const body = messageBody(record);
        messages.push({ body: edit === undefined ? body : withContent(body, edit), sourceId: record.id, kind: "message" });
        break;
      }
      case "compaction":
        if (record.strategy === "replace") {
          for (const body of record.replacement ?? []) messages.push({ body, sourceId: record.id, kind: "compaction_replacement" });
        } else {
          messages.push({
            body: { role: "user", content: record.summary ?? "", origin: { kind: "synthetic", name: "compaction" } },
            sourceId: record.id,
            kind: "compaction_summary",
          });
        }
        break;
      case "branch_summary":
        messages.push({
          body: { role: "user", content: record.summary, origin: { kind: "synthetic", name: "branch_summary" } },
          sourceId: record.id,
          kind: "branch_summary",
        });
        break;
    }
  }

  return {
    leaf,
    ...promptState.snapshot(),
    messages: options.target ? filterReplay(messages, options.target) : messages,
    settings: foldSettings(path),
  };
}

/**
 * The working range at `leaf` with context edits applied (SPEC §5 steps 1 and 4), as records: edited messages carry
 * their replacement content, omitted ones and the edits themselves are dropped. Linear formats synthesize from this.
 */
export function projectRange(transcript: Transcript, options: { leaf?: string | null; index?: TreeIndex } = {}): TreeRecord[] {
  const index = options.index ?? indexTree(transcript);
  const path = pathTo(index, options.leaf === undefined ? index.activeLeaf : options.leaf);
  const edits = latestEdits(path);
  return workingRange(path).range.flatMap((record): TreeRecord[] => {
    if (record.type === "context_edit") return [];
    if (record.type !== "message") return [record];
    const edit = edits.get(record.id);
    if (edit === undefined) return [record];
    if (edit === null) return [];
    const { type, id, parentId, time, native, ext } = record;
    return [{ type, id, parentId, time, ...(native ? { native } : {}), ...(ext ? { ext } : {}), ...withContent(messageBody(record), edit) } as TreeRecord];
  });
}

/** Folds `settings` records field by field (SPEC §6). */
export function foldSettings(path: readonly TreeRecord[]): EffectiveSettings {
  const settings: EffectiveSettings = {};
  for (const record of path) {
    if (record.type !== "settings") continue;
    for (const key of ["model", "reasoningEffort", "agent", "mode", "cwd", "policy"] as const) {
      if (record[key] !== undefined) (settings as Record<string, unknown>)[key] = record[key];
    }
  }
  return settings;
}

/** Instructions and tool loadout, folded from `context` records (SPEC §5 step 2). */
export class PromptState {
  private sections = new Map<string, string>();
  private tools = new Map<string, ToolDefinition>();

  replace(instructions: readonly InstructionSection[], tools: readonly ToolDefinition[]) {
    this.sections = new Map();
    this.tools = new Map();
    for (const section of instructions) if (section.text !== null) this.sections.set(section.name, section.text);
    for (const tool of tools) this.tools.set(tool.name, tool);
  }

  apply(record: ContextRecord) {
    if (record.mode === "replace") return this.replace(record.instructions ?? [], record.toolsAdded ?? []);
    for (const section of record.instructions ?? []) {
      if (section.text === null) this.sections.delete(section.name);
      else this.sections.set(section.name, section.text);
    }
    for (const name of record.toolsRemoved ?? []) this.tools.delete(name);
    for (const tool of record.toolsAdded ?? []) this.tools.set(tool.name, tool);
  }

  snapshot(): { instructions: { name: string; text: string }[]; tools: ToolDefinition[] } {
    return {
      instructions: [...this.sections].map(([name, text]) => ({ name, text })),
      tools: [...this.tools.values()],
    };
  }
}

function latestEdits(path: readonly TreeRecord[]): Map<string, ContextEditRecord["replacement"]> {
  const edits = new Map<string, ContextEditRecord["replacement"]>();
  for (const record of path) if (record.type === "context_edit") edits.set(record.targetId, record.replacement);
  return edits;
}

const ENVELOPE_KEYS = new Set(["type", "id", "parentId", "time", "native", "ext"]);

/** A `message` record without its envelope. */
export function messageBody(record: TreeRecord & { type: "message" }): MessageBody {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !ENVELOPE_KEYS.has(key))) as unknown as MessageBody;
}

function withContent(body: MessageBody, replacement: NonNullable<ContextEditRecord["replacement"]>): MessageBody {
  if (body.role === "assistant" || body.role === "tool") {
    const blocks = typeof replacement === "string" ? [{ type: "text" as const, text: replacement }] : replacement;
    return { ...body, content: blocks } as MessageBody;
  }
  return { ...body, content: replacement } as MessageBody;
}

function matches(replay: Replay, target: { provider: string; api?: string }) {
  return replay.provider === target.provider && (replay.api === undefined || target.api === undefined || replay.api === target.api);
}

function filterReplay(messages: ContextMessage[], target: { provider: string; api?: string }): ContextMessage[] {
  const keep = (replay: Replay[] | undefined) => {
    const kept = replay?.filter((entry) => matches(entry, target));
    return kept && kept.length > 0 ? kept : undefined;
  };
  return messages.map((message) => {
    const body = message.body;
    if (body.role !== "assistant") return message;
    const content = body.content.flatMap((block): AssistantBlock[] => {
      if (!("replay" in block) || block.replay === undefined) return [block];
      const { replay: _, ...rest } = block;
      const replay = keep(block.replay);
      const filtered = (replay ? { ...rest, replay } : rest) as AssistantBlock;
      if (filtered.type === "reasoning" && filtered.text === undefined && filtered.summary === undefined && !replay) return [];
      return [filtered];
    });
    const { replay: _, ...rest } = body;
    const replay = keep(body.replay);
    return { ...message, body: { ...rest, ...(replay ? { replay } : {}), content } };
  });
}
