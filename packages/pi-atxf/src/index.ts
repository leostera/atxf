import { existsSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseTranscript, serializeTranscript, type Transcript } from "@leostera/atxf";
import { pi as converter } from "@leostera/atxf/pi";
import { Joins, pull, push, readShared } from "@leostera/atxf/sync";

const AGENT = "pi";
const USAGE = `/atxf export [file]   write this session as ATXF (default: ./<session id>.atxf.jsonl)
/atxf import <file>   open an ATXF session in Pi
/atxf join <file>     share this session through <file>, or join the session already in it
/atxf sync            exchange turns with the shared session now
/atxf leave           stop sharing
/atxf status          show what this session is joined to`;

/**
 * State that outlives one extension runtime. Pi replaces the runtime when it switches sessions, which a pull does,
 * so the command context that can switch sessions is kept here for the next runtime.
 */
const shared = ((globalThis as { __atxfPi?: { commandContext?: ExtensionCommandContext } }).__atxfPi ??= {});

export default function atxf(pi: ExtensionAPI) {
  const joins = new Joins();
  let watcher: FSWatcher | undefined;
  let busy: Promise<void> = Promise.resolve();
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const sessionFile = (ctx: ExtensionContext) => ctx.sessionManager.getSessionFile();
  const joined = (ctx: ExtensionContext) => {
    const file = sessionFile(ctx);
    return file === undefined ? undefined : joins.get(AGENT, file);
  };
  const local = (file: string): Transcript => converter.toAtxf(readFileSync(file, "utf8"));
  const status = (ctx: ExtensionContext, text: string | undefined) => ctx.hasUI && ctx.ui.setStatus("atxf", text);
  const serial = (work: () => Promise<void>) => (busy = busy.then(work, work));

  /** Writes a transcript as a new Pi session file next to the current ones and returns its path. */
  const writeSession = (ctx: ExtensionContext, transcript: Transcript) => {
    const text = converter.fromAtxf(transcript);
    const id = String(JSON.parse(text.slice(0, text.indexOf("\n"))).id ?? transcript.header.id);
    const file = join(ctx.sessionManager.getSessionDir(), `${new Date().toISOString().replaceAll(/[:.]/g, "-")}_${id}.jsonl`);
    writeFileSync(file, text);
    return file;
  };

  async function pushNow(ctx: ExtensionContext) {
    const file = sessionFile(ctx);
    const path = joined(ctx);
    if (file === undefined || path === undefined || !existsSync(file)) return;
    const { added } = await push(path, local(file));
    if (added > 0) status(ctx, `atxf: shared ${added} record${added === 1 ? "" : "s"}`);
  }

  /** Brings in what others added. Needs a command context: replacing the session is command-only in Pi. */
  async function pullNow(ctx: ExtensionCommandContext): Promise<number> {
    const file = sessionFile(ctx);
    const path = joined(ctx);
    if (file === undefined || path === undefined || !existsSync(file)) return 0;
    await ctx.waitForIdle();
    const result = await pull(path, local(file));
    if (result === undefined) return 0;
    writeFileSync(file, converter.fromAtxf(result.transcript));
    await ctx.switchSession(file, {
      withSession: async (next) => {
        shared.commandContext = next;
        next.ui.setStatus("atxf", `atxf: received ${result.added} record${result.added === 1 ? "" : "s"}`);
      },
    });
    return result.added;
  }

  function watchShared(ctx: ExtensionContext) {
    watcher?.close();
    watcher = undefined;
    const path = joined(ctx);
    if (path === undefined) return;
    watcher = watch(dirname(path), (_event, name) => {
      if (name !== basename(path)) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => serial(() => onSharedChange(ctx, path)), 200);
    });
  }

  async function onSharedChange(ctx: ExtensionContext, path: string) {
    const file = sessionFile(ctx);
    if (file === undefined || joined(ctx) !== path) return;
    const theirs = await readShared(path);
    if (theirs === undefined) return;
    const command = shared.commandContext;
    if (command !== undefined) {
      try {
        await pullNow(command);
        return;
      } catch {
        shared.commandContext = undefined; // That context belongs to a replaced session.
      }
    }
    const result = await pull(path, local(file));
    if (result !== undefined) status(ctx, `atxf: ${result.added} new record${result.added === 1 ? "" : "s"} — run /atxf sync`);
  }

  pi.on("session_start", async (_event, ctx) => {
    watchShared(ctx);
    if (joined(ctx) !== undefined) status(ctx, `atxf: joined ${basename(joined(ctx)!)}`);
  });

  pi.on("session_shutdown", async () => {
    clearTimeout(debounce);
    watcher?.close();
    watcher = undefined;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (joined(ctx) === undefined) return;
    await serial(async () => {
      try {
        await pushNow(ctx);
      } catch (error) {
        ctx.ui.notify(`atxf: push failed: ${(error as Error).message}`, "error");
      }
    });
  });

  pi.registerCommand("atxf", {
    description: "Export, import or join ATXF sessions shared with other agents",
    getArgumentCompletions: (prefix) =>
      ["export", "import", "join", "sync", "leave", "status"].filter((c) => c.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      shared.commandContext = ctx;
      const [command, ...rest] = args.trim().split(/\s+/);
      const target = rest.join(" ");
      const file = sessionFile(ctx);
      const say = (message: string, type: "info" | "warning" | "error" = "info") => ctx.ui.notify(message, type);
      try {
        switch (command) {
          case "export": {
            if (file === undefined || !existsSync(file)) return say("atxf: this session has no file yet; send a message first", "warning");
            const out = resolve(ctx.cwd, target || `${ctx.sessionManager.getSessionId()}.atxf.jsonl`);
            writeFileSync(out, serializeTranscript(local(file)));
            return say(`atxf: exported to ${out}`);
          }
          case "import": {
            if (!target) return say(USAGE, "warning");
            const transcript = parseTranscript(readFileSync(resolve(ctx.cwd, target), "utf8"));
            await ctx.switchSession(writeSession(ctx, transcript), {
              withSession: async (next) => {
                shared.commandContext = next;
                next.ui.notify(`atxf: imported ${transcript.records.length} records from ${target}`, "info");
              },
            });
            return;
          }
          case "join": {
            if (!target) return say(USAGE, "warning");
            const path = resolve(ctx.cwd, target);
            const existing = await readShared(path);
            if (existing === undefined) {
              // Start the shared session from this one.
              if (file === undefined || !existsSync(file)) return say("atxf: this session has no file yet; send a message first", "warning");
              joins.set(AGENT, file, path);
              await push(path, local(file));
              watchShared(ctx);
              status(ctx, `atxf: joined ${basename(path)}`);
              return say(`atxf: sharing this session through ${path}`);
            }
            // Join the session already there: open it here, then keep it in sync.
            const opened = writeSession(ctx, existing);
            joins.set(AGENT, opened, path);
            await ctx.switchSession(opened, {
              withSession: async (next) => {
                shared.commandContext = next;
                next.ui.notify(`atxf: joined ${path} (${existing.records.length} records)`, "info");
              },
            });
            return;
          }
          case "sync": {
            if (joined(ctx) === undefined) return say("atxf: this session is not joined; use /atxf join <file>", "warning");
            await pushNow(ctx);
            const added = await pullNow(ctx);
            if (added === 0) status(ctx, `atxf: in sync with ${basename(joined(ctx)!)}`);
            return;
          }
          case "leave": {
            if (file !== undefined) joins.delete(AGENT, file);
            watcher?.close();
            watcher = undefined;
            status(ctx, undefined);
            return say("atxf: left the shared session");
          }
          case "status": {
            const path = joined(ctx);
            return say(path ? `atxf: joined ${path}` : "atxf: not joined");
          }
          default:
            return say(USAGE);
        }
      } catch (error) {
        say(`atxf: ${(error as Error).message}`, "error");
      }
    },
  });
}
