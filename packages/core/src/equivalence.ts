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
      const text = body.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      const toolCalls = body.content.flatMap((b) =>
        b.type === "tool_call" ? [{ id: b.id, name: b.name, arguments: canonicalJson(b.arguments ?? { input: b.input }) }] : [],
      );
      const reasoning = body.content.flatMap((b) => (b.type === "reasoning" && b.text ? [b.text] : [])).join("\n");
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
