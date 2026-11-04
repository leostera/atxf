import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseTranscript, serializeTranscript } from "./jsonl.ts";
import { reconcile, reconciliationKeys } from "./reconcile.ts";
import type { Transcript } from "./types.ts";

/**
 * A shared session: one ATXF file that copies of a session in different agents reconcile into (SPEC §18).
 *
 * Every agent pushes its copy after each turn and pulls what others added between turns. Pushing is a reconcile
 * under a lock file, so concurrent pushes from two agents both land; pulling never writes the shared file.
 */

/** The shared file's transcript, or `undefined` when it does not exist yet. */
export async function readShared(path: string): Promise<Transcript | undefined> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return text === undefined ? undefined : parseTranscript(text);
}

/** How many records of `from` that `to` does not hold, by reconciliation key. */
export function missing(from: Transcript, to: Transcript): number {
  const have = reconciliationKeys(to);
  let count = 0;
  for (const key of reconciliationKeys(from)) if (!have.has(key)) count++;
  return count;
}

export interface PushResult {
  transcript: Transcript;
  /** Records the shared file gained. */
  added: number;
}

/** Reconciles `local` into the shared file, creating it when it does not exist. */
export async function push(path: string, local: Transcript): Promise<PushResult> {
  return withLock(path, async () => {
    const shared = await readShared(path);
    if (shared === undefined) {
      await writeAtomically(path, serializeTranscript(local));
      return { transcript: local, added: local.records.length };
    }
    const added = missing(local, shared);
    if (added === 0) return { transcript: shared, added };
    const { transcript } = reconcile([shared, local]);
    await writeAtomically(path, serializeTranscript(transcript));
    return { transcript, added };
  });
}

export interface PullResult {
  transcript: Transcript;
  /** Records the local copy gains. */
  added: number;
}

/** What `local` gains from the shared file, or `undefined` when it already holds every shared record. */
export async function pull(path: string, local: Transcript): Promise<PullResult | undefined> {
  const shared = await readShared(path);
  if (shared === undefined) return undefined;
  const added = missing(shared, local);
  if (added === 0) return undefined;
  return { transcript: reconcile([local, shared]).transcript, added };
}

async function writeAtomically(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;

/** Runs `fn` holding `<path>.lock`. A lock older than 30 s is taken over: its holder died. */
export async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(lock, "wx");
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) await rm(lock, { force: true });
      else if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`);
      else await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 50));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

/** Where an agent's session is joined to a shared file: `agent:local session` → shared path. */
export class Joins {
  readonly file: string;

  constructor(file = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "atxf", "joins.json")) {
    this.file = file;
  }

  private read(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private write(joins: Record<string, string>) {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(joins, null, 2)}\n`);
  }

  get(agent: string, session: string): string | undefined {
    return this.read()[`${agent}:${session}`];
  }

  set(agent: string, session: string, path: string) {
    this.write({ ...this.read(), [`${agent}:${session}`]: path });
  }

  delete(agent: string, session: string) {
    const { [`${agent}:${session}`]: _, ...rest } = this.read();
    this.write(rest);
  }
}
