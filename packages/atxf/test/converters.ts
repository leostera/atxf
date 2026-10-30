import { createHash } from "node:crypto";
import type { Converter } from "../src/index.ts";
import { arbitraryTranscript, noisyJsonDocument, noisyJsonl } from "../src/testing.ts";
import { claudeCode } from "../src/formats/claude-code.ts";
import { codex } from "../src/formats/codex.ts";
import { geminiCli } from "../src/formats/gemini-cli.ts";
import { opencode } from "../src/formats/opencode.ts";
import { pi } from "../src/formats/pi.ts";
import type fc from "fast-check";

/** Every converter, with an arbitrary for its native files. */
export const converters: { converter: Converter; nativeFiles: fc.Arbitrary<string> }[] = [pi, claudeCode, codex, geminiCli].map((converter) => ({
  converter,
  nativeFiles: arbitraryTranscript({ integrity: false }).chain((t) => noisyJsonl(converter.fromAtxf(t, { carry: false }))),
}));
converters.push({
  converter: opencode,
  nativeFiles: arbitraryTranscript({ integrity: false }).chain((t) => noisyJsonDocument(opencode.fromAtxf(t, { carry: false }), "messages")),
});

export interface Prompt {
  text: string;
  time: string;
  /** Makes the ids of the appended record: two Macs appending with different tags write different ids. */
  tag: string;
}

/** Append one user prompt to a native file the way each agent writes it, after the file's last record. */
export function appendPrompt(agent: string, file: string, { text, time, tag }: Prompt): string {
  const lines = () => file.trimEnd().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
  const line = (value: unknown) => (file === "" || file.endsWith("\n") ? file : `${file}\n`) + JSON.stringify(value) + "\n";
  switch (agent) {
    case "pi": {
      const parentId = lines().findLast((entry) => entry.type !== "session")?.id ?? null;
      return line({ type: "message", id: tag, parentId, timestamp: time, message: { role: "user", content: text, timestamp: Date.parse(time) } });
    }
    case "claude-code": {
      const parentUuid = lines().findLast((entry) => typeof entry.uuid === "string")?.uuid ?? null;
      const uuid = `${createHash("sha256").update(tag).digest("hex").slice(0, 8)}-0000-4000-8000-000000000001`;
      return line({ parentUuid, isSidechain: false, type: "user", message: { role: "user", content: text }, uuid, timestamp: time, sessionId: "s" });
    }
    case "codex":
      return line({ timestamp: time, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    case "gemini-cli":
      return line({ id: tag, timestamp: time, type: "user", content: text });
    case "opencode": {
      const doc = JSON.parse(file);
      doc.messages.push({ id: `msg_${tag}`, type: "user", text, files: [], agents: [], skills: [], time: { created: Date.parse(time) } });
      return JSON.stringify(doc, null, 2) + "\n";
    }
  }
  throw new Error(`no way to append to a ${agent} file`);
}
