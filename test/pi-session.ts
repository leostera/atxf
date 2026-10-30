#!/usr/bin/env bun
// Checks one real Pi session: through every format and back, byte for byte, and its conversation without carry.
// Run by test/chain.test.ts in a process of its own per session, so memory never outlives one session.
import { conversationView, embeddedToolResults, summariesAsUser, type PortableMessage } from "@atxf/core";
import { claudeCode } from "@atxf/claude-code";
import { codex } from "@atxf/codex";
import { geminiCli } from "@atxf/gemini-cli";
import { opencode } from "@atxf/opencode";
import { pi } from "@atxf/pi";

// Not ./converters.ts: that brings in fast-check, which this process has no use for.
const converters = [pi, claudeCode, codex, geminiCli, opencode].map((converter) => ({ converter }));

const views: Record<string, (view: PortableMessage[]) => PortableMessage[]> = {
  codex: summariesAsUser,
  opencode: (view) => embeddedToolResults(summariesAsUser(view)),
  "gemini-cli": (view) => embeddedToolResults(summariesAsUser(view)),
};

const file = process.argv[2]!;
const text = await Bun.file(file).text();
const transcript = pi.toAtxf(text);
const expected = JSON.stringify(conversationView(transcript));
Bun.gc(true);

for (const { converter } of converters) {
  const view = views[converter.agent];
  // Each step's intermediate is dropped before the next, so at most a few copies of the session are alive.
  if (pi.fromAtxf(converter.toAtxf(converter.fromAtxf(transcript))) !== text) fail(`did not survive ${converter.agent}`);
  const clean = conversationView(converter.toAtxf(converter.fromAtxf(transcript, { carry: false })));
  const want = view ? JSON.stringify(view(conversationView(transcript))) : expected;
  if (JSON.stringify(view ? view(clean) : clean) !== want) fail(`lost its conversation through ${converter.agent} without carry`);
  // Left alone, the collector lets every format's garbage pile up before it runs; the peak would grow with each.
  Bun.gc(true);
}

function fail(message: string): never {
  console.error(`${file}: ${message}`);
  process.exit(1);
}
