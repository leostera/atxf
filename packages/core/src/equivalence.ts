import { canonicalJson } from "./canonical.ts";
import { buildContext } from "./context.ts";
import type { Transcript, UserContent } from "./types.ts";

/** A message reduced to what every agent format can carry: who said it, its text, tool calls and results. */
export interface PortableMessage {
  role: "user" | "assistant" | "tool" | "summary";
  text: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolCallId?: string;
  isError?: boolean;
  reasoning?: string;
}

/**
 * The conversation a model would see at the active leaf, reduced to portable fields. Two transcripts of the same
 * conversation in different agent formats have equal views; tests compare conversions with it.
 *
 * Formats split one model response differently (Claude Code writes a line per content block, Codex a line per
 * Responses item), so consecutive assistant messages merge into one, and empty text parts are ignored.
 */
export function conversationView(transcript: Transcript, options: { reasoning?: boolean } = {}): PortableMessage[] {
  const view: PortableMessage[] = [];
  for (const { body, kind } of buildContext(transcript).messages) {
    if (kind === "compaction_summary" || kind === "branch_summary") {
      view.push({ role: "summary", text: contentText(body.content as UserContent) });
      continue;
    }
    if (body.role === "system" || body.display === false) continue;
    const origin = body.origin?.kind;
    if (origin && !["human", "model", "tool"].includes(origin)) continue;
    if (body.role === "user") view.push({ role: "user", text: contentText(body.content) });
    if (body.role === "tool") {
      view.push({ role: "tool", text: contentText(body.content), toolCallId: body.toolCallId, isError: body.isError === true });
    }
    if (body.role === "assistant") {
      const text = body.content.flatMap((b) => (b.type === "text" && b.text !== "" ? [b.text] : [])).join("\n");
      const toolCalls = body.content.flatMap((b) =>
        b.type === "tool_call" ? [{ id: b.id, name: b.name, arguments: canonicalJson(b.arguments ?? { input: b.input }) }] : [],
      );
      const reasoning = body.content.flatMap((b) => (b.type === "reasoning" && b.text ? [b.text] : [])).join("\n");
      const previous = view.at(-1);
      if (previous?.role === "assistant") {
        previous.text = [previous.text, text].filter((part) => part !== "").join("\n");
        if (toolCalls.length > 0) previous.toolCalls = [...(previous.toolCalls ?? []), ...toolCalls];
        if (options.reasoning && reasoning) previous.reasoning = [previous.reasoning, reasoning].filter(Boolean).join("\n");
        continue;
      }
      view.push({
        role: "assistant",
        text,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(options.reasoning && reasoning ? { reasoning } : {}),
      });
    }
  }
  return view;
}

export function contentText(content: UserContent): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : block.type === "image" ? "[image]" : (block.text ?? `[${block.uri}]`)))
    .join("\n");
}

/**
 * For formats that store a tool result inside the call it answers (OpenCode, Gemini CLI): each result moves right
 * after the assistant message holding its call, and results whose call is not in the view are dropped.
 */
export function embeddedToolResults(view: PortableMessage[]): PortableMessage[] {
  const results = new Map<string, PortableMessage>();
  for (const message of view) if (message.role === "tool" && message.toolCallId && !results.has(message.toolCallId)) results.set(message.toolCallId, message);
  // Without the results between them, assistant messages that were split by results merge again.
  const merged: PortableMessage[] = [];
  for (const message of view) {
    if (message.role === "tool") continue;
    const previous = merged.at(-1);
    if (message.role === "assistant" && previous?.role === "assistant") {
      merged[merged.length - 1] = {
        ...previous,
        text: [previous.text, message.text].filter((part) => part !== "").join("\n"),
        ...(previous.toolCalls || message.toolCalls ? { toolCalls: [...(previous.toolCalls ?? []), ...(message.toolCalls ?? [])] } : {}),
      };
    } else merged.push({ ...message });
  }
  const out: PortableMessage[] = [];
  for (const message of merged) {
    out.push(message);
    for (const call of message.toolCalls ?? []) {
      const result = results.get(call.id);
      if (result) out.push(result);
    }
  }
  return out;
}

/**
 * For formats whose only summary is a compaction, which must start the context (Codex, OpenCode), or that have none
 * (Gemini CLI): a summary elsewhere is written as a user message, so summaries compare as user messages.
 */
export function summariesAsUser(view: PortableMessage[]): PortableMessage[] {
  return view.map((message) => (message.role === "summary" ? { ...message, role: "user" } : message));
}

