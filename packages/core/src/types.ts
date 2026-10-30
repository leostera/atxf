/**
 * TypeScript types for ATXF v0.1 records. They mirror `schema/v0.1/atxf.schema.json`; the schema is canonical.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Replay {
  provider: string;
  api?: string;
  model?: string;
  kind?: string;
  data: unknown;
}

export interface ModelRef {
  provider: string;
  id: string;
  api?: string;
  variant?: string;
}

export interface Cost {
  currency?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  total?: number;
  cost?: Cost;
}

export interface Native {
  source: string;
  format?: string;
  version?: string;
  records: unknown[];
}

export type Ext = Record<string, unknown>;

export interface TextBlock {
  type: "text";
  text: string;
  replay?: Replay[];
}
export interface ImageBlock {
  type: "image";
  mediaType: string;
  data?: string;
  uri?: string;
}
export interface ResourceBlock {
  type: "resource";
  uri: string;
  name?: string;
  mediaType?: string;
  text?: string;
}
export interface ReasoningBlock {
  type: "reasoning";
  text?: string;
  summary?: string[];
  redacted?: boolean;
  replay?: Replay[];
}
export type ToolKind = "function" | "custom" | "builtin";
export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  kind?: ToolKind;
  namespace?: string;
  arguments?: Record<string, unknown>;
  input?: string;
  replay?: Replay[];
}

export type UserBlock = TextBlock | ImageBlock | ResourceBlock;
export type AssistantBlock = TextBlock | ReasoningBlock | ToolCallBlock | ImageBlock;
export type UserContent = string | UserBlock[];

export type OriginKind = "human" | "model" | "tool" | "agent" | "synthetic" | "extension" | "hook" | "command" | "subagent";
export interface Origin {
  kind: OriginKind;
  name?: string;
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "error" | "aborted" | "refusal" | "other";
export interface ErrorInfo {
  message: string;
  code?: string;
}

export interface SystemBody {
  role: "system";
  content: UserContent;
  origin?: Origin;
  display?: boolean;
}
export interface UserBody {
  role: "user";
  content: UserContent;
  origin?: Origin;
  display?: boolean;
}
export interface AssistantBody {
  role: "assistant";
  content: AssistantBlock[];
  origin?: Origin;
  display?: boolean;
  model?: ModelRef;
  usage?: Usage;
  stop?: StopReason;
  rawStop?: string;
  responseId?: string;
  error?: ErrorInfo;
  replay?: Replay[];
}
export interface ToolBody {
  role: "tool";
  toolCallId: string;
  toolName?: string;
  content: UserContent;
  isError?: boolean;
  details?: Record<string, unknown>;
  origin?: Origin;
  display?: boolean;
}
export type MessageBody = SystemBody | UserBody | AssistantBody | ToolBody;

export interface ToolDefinition {
  name: string;
  kind?: ToolKind;
  namespace?: string;
  description?: string;
  parameters?: Record<string, unknown>;
}
export interface InstructionSection {
  name: string;
  text: string | null;
}
export interface ContextSnapshot {
  instructions?: InstructionSection[];
  tools?: ToolDefinition[];
}

export interface TranscriptLink {
  transcriptId: string;
  entryId?: string;
  uri?: string;
  relation: "fork" | "subagent" | "continuation" | "import";
}

export interface Fidelity {
  topology?: "tree" | "linear" | "linearized";
  instructions?: "full" | "partial" | "none";
  tools?: "full" | "partial" | "none";
  reasoning?: "raw" | "summary" | "encrypted" | "mixed" | "none";
  toolLifecycle?: boolean;
  turns?: boolean;
  usage?: "per-response" | "aggregate" | "none";
  native?: "all" | "partial" | "none";
  ids?: "stable" | "synthetic";
}

export interface TranscriptHeader {
  type: "transcript";
  atxf: "0.1";
  id: string;
  time: string;
  title?: string;
  source: { agent: string; version?: string; format?: string; sessionId?: string };
  workspace?: {
    cwd?: string;
    roots?: string[];
    vcs?: { type: string; remote?: string; branch?: string; commit?: string };
  };
  parent?: TranscriptLink;
  fidelity?: Fidelity;
  integrity?: { alg: "sha256"; canon: "jcs" };
  native?: Native;
  ext?: Ext;
  hash?: string;
}

interface Envelope {
  id: string;
  time: string;
  native?: Native;
  ext?: Ext;
  /** Required when the header declares `integrity`. See SPEC.md, Integrity. */
  hash?: string;
}
interface Node extends Envelope {
  parentId: string | null;
}

export type MessageRecord = Node & { type: "message" } & MessageBody;
export interface ContextRecord extends Node {
  type: "context";
  mode: "replace" | "patch";
  instructions?: InstructionSection[];
  toolsAdded?: ToolDefinition[];
  toolsRemoved?: string[];
}
export interface SettingsRecord extends Node {
  type: "settings";
  model?: ModelRef;
  reasoningEffort?: string;
  agent?: string;
  mode?: string;
  cwd?: string;
  policy?: Record<string, unknown>;
}
export interface CompactionRecord extends Node {
  type: "compaction";
  strategy: "summary" | "replace";
  summary?: string;
  firstKeptId?: string | null;
  replacement?: MessageBody[];
  snapshot?: ContextSnapshot;
  reason?: "auto" | "manual";
  tokensBefore?: number;
  model?: ModelRef;
  usage?: Usage;
  replay?: Replay[];
}
export interface ContextEditRecord extends Node {
  type: "context_edit";
  targetId: string;
  replacement: null | UserContent | AssistantBlock[];
}
export interface BranchSummaryRecord extends Node {
  type: "branch_summary";
  fromId: string;
  summary: string;
  usage?: Usage;
}
export interface TurnRecord extends Node {
  type: "turn";
  phase: "start" | "end";
  turnId: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  error?: ErrorInfo;
}
export type ToolStatus = "pending" | "approved" | "denied" | "running" | "completed" | "error" | "cancelled";
export interface ToolStatusRecord extends Node {
  type: "tool_status";
  toolCallId: string;
  status: ToolStatus;
  progress?: unknown;
  error?: ErrorInfo;
}
export interface UsageRecord extends Node {
  type: "usage";
  kind: string;
  model?: ModelRef;
  usage: Usage;
  cumulative?: boolean;
}
export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  from?: string;
  additions?: number;
  deletions?: number;
}
export interface CheckpointRecord extends Node {
  type: "checkpoint";
  snapshot?: string;
  vcs?: { commit?: string; ref?: string };
  files?: FileChange[];
}
export interface AgentLinkRecord extends Node {
  type: "agent_link";
  relation: "spawn" | "message" | "result" | "close";
  transcriptId: string;
  uri?: string;
  agent?: { name?: string; role?: string };
  toolCallId?: string;
  content?: UserContent;
}
export interface CustomRecord extends Node {
  type: "custom";
  namespace: string;
  name: string;
  data?: unknown;
}
export interface LeafRecord extends Envelope {
  type: "leaf";
  targetId: string | null;
  reason?: "navigate" | "rewind" | "rollback" | "revert" | "reset";
  restoreCheckpointId?: string;
}
export interface LabelRecord extends Envelope {
  type: "label";
  targetId: string;
  label: string | null;
}
export interface MetadataRecord extends Envelope {
  type: "metadata";
  title?: string;
  archived?: boolean;
  tags?: string[];
}

export type TreeRecord =
  | MessageRecord
  | ContextRecord
  | SettingsRecord
  | CompactionRecord
  | ContextEditRecord
  | BranchSummaryRecord
  | TurnRecord
  | ToolStatusRecord
  | UsageRecord
  | CheckpointRecord
  | AgentLinkRecord
  | CustomRecord;
/** Commits to every record before it. See SPEC.md, Integrity. */
export interface SealRecord extends Envelope {
  type: "seal";
  count: number;
  chain: string;
  heads: string[];
}
export type AnnotationRecord = LeafRecord | LabelRecord | MetadataRecord | SealRecord;
export type EntryRecord = TreeRecord | AnnotationRecord;
export type AtxfRecord = TranscriptHeader | EntryRecord;

/** A parsed transcript: the header and the remaining records in file order. */
export interface Transcript {
  header: TranscriptHeader;
  records: EntryRecord[];
}

export const TREE_TYPES: ReadonlySet<string> = new Set([
  "message",
  "context",
  "settings",
  "compaction",
  "context_edit",
  "branch_summary",
  "turn",
  "tool_status",
  "usage",
  "checkpoint",
  "agent_link",
  "custom",
]);

export function isTreeRecord(record: EntryRecord): record is TreeRecord {
  return TREE_TYPES.has(record.type);
}
