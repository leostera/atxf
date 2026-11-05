import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Astro runs from the site directory; bundling makes import.meta.url unreliable for this.
export const REPO_ROOT = `${resolve(process.cwd(), "../..")}/`;
export const SITE_URL = "https://atxf.leostera.dev";
export const REPO_URL = "https://github.com/leostera/atxf";

/** One published version of the specification. */
export interface SpecVersion {
  version: string;
  /** Where the site renders it. */
  href: string;
  /** Its content collection entry, and the repository file it comes from. */
  entry: string;
  source: string;
  /** `current` is what the reference libraries implement; `draft` is proposed and not implemented yet. */
  stage: "current" | "draft";
  /** The RFD that proposes it, for drafts. */
  proposal?: { label: string; href: string };
}

export const SPEC_VERSIONS: readonly SpecVersion[] = [
  { version: "0.1", href: "/", entry: "spec", source: "SPEC.md", stage: "current" },
  {
    version: "0.2",
    href: "/v0.2/",
    entry: "spec-v02",
    source: "SPEC-v0.2.md",
    stage: "draft",
    proposal: { label: "RFD0001: Actors and user agents", href: `${REPO_URL}/blob/main/docs/rfds/RFD0001-actors.md` },
  },
];

/** The version the reference libraries implement; mappings and examples are written for it. */
export const VERSION = "0.1";
export const schemaPath = (version: string) => `/schema/v${version}/atxf.schema.json`;
export const SCHEMA_PATH = schemaPath(VERSION);

export function specVersion(version: string): SpecVersion {
  const spec = SPEC_VERSIONS.find((v) => v.version === version);
  if (!spec) throw new Error(`unknown spec version ${version}`);
  return spec;
}

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

export function schemaText(version: string = VERSION): string {
  return readFileSync(`${REPO_ROOT}schema/v${version}/atxf.schema.json`, "utf8");
}
