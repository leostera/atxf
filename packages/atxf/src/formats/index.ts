import type { Converter } from "../convert.ts";
import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { geminiCli } from "./gemini-cli.ts";
import { opencode } from "./opencode.ts";
import { pi } from "./pi.ts";

export { claudeCode, codex, geminiCli, opencode, pi };

/** Every converter, by agent name. */
export const formats: Readonly<Record<string, Converter>> = {
  pi,
  "claude-code": claudeCode,
  codex,
  opencode,
  "gemini-cli": geminiCli,
};
