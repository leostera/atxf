import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Astro runs from the site directory; bundling makes import.meta.url unreliable for this.
export const REPO_ROOT = `${resolve(process.cwd(), "../..")}/`;
export const SITE_URL = "https://atxf.leostera.dev";
export const SCHEMA_PATH = "/schema/v0.1/atxf.schema.json";
export const REPO_URL = "https://github.com/leostera/agent-transcript-exchange-format";
export const VERSION = "0.1";

/** Date of the last commit that touched `path`, or today when outside git. */
export function lastUpdated(path: string): string {
  try {
    const date = execFileSync("git", ["log", "-1", "--format=%cs", "--", path], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    if (date) return date;
  } catch {
    // Not a git checkout (e.g. a tarball build); fall through.
  }
  return new Date().toISOString().slice(0, 10);
}

export interface Example {
  slug: string;
  file: string;
  text: string;
}

// Simplest first; a sub-agent child follows its parent.
const EXAMPLE_ORDER = ["minimal", "branching", "codex-style", "revert-and-subagent", "subagent-child", "sealed"];
const order = (file: string) => {
  const index = EXAMPLE_ORDER.indexOf(file.replace(/\.atxf\.jsonl$/, ""));
  return index === -1 ? EXAMPLE_ORDER.length : index;
};

export function examples(): Example[] {
  const dir = `${REPO_ROOT}examples/`;
  return readdirSync(dir)
    .filter((file) => file.endsWith(".atxf.jsonl"))
    .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
    .map((file) => ({ slug: file.replace(/\.atxf\.jsonl$/, ""), file, text: readFileSync(dir + file, "utf8") }));
}

export function schemaText(): string {
  return readFileSync(`${REPO_ROOT}schema/v0.1/atxf.schema.json`, "utf8");
}
