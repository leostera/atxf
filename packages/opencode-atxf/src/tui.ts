import { existsSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseTranscript, serializeTranscript, type Transcript } from "@leostera/atxf";
import { opencode as converter } from "@leostera/atxf/opencode";
import { Joins, pull, push, readShared } from "@leostera/atxf/sync";

/**
 * OpenCode TUI plugin for ATXF. It runs in the TUI rather than the server because only the TUI plugin API can export,
 * import and delete sessions (through its API client) and navigate back to a session after replacing it.
 *
 * The types below are the parts of OpenCode 2's TUI plugin API this plugin uses.
 */
type SessionData = { info: { id: string; location?: { directory: string }; [key: string]: unknown }; messages: unknown[] };
type Route = { type: "home" } | { type: "session"; sessionID: string } | { type: string; [key: string]: unknown };
interface TuiApi {
  client: {
    session: {
      export(input: { sessionID: string }): Promise<SessionData>;
      import(input: SessionData & { location?: { directory: string } }): Promise<{ id: string }>;
      remove(input: { sessionID: string }): Promise<unknown>;
    };
  };
  data: {
    on(type: string, handler: (event: { data: { sessionID: string } }) => void): () => void;
    /** The TUI's own store of sessions and messages. */
    session: {
      evict(sessionID: string): void;
      sync(sessionID: string): Promise<void>;
      message: { sync(sessionID: string): Promise<void> };
    };
  };
  keymap: {
    layer(spec: () => {
      mode: "global";
      commands: { id: string; title: string; group?: string; palette?: boolean; slash?: { name: string; arguments?: boolean }; run(args?: string): unknown }[];
    }): unknown;
  };
  ui: {
    toast: { show(toast: { title?: string; message: string; variant: "info" | "success" | "warning" | "error"; duration?: number }): void };
    router: { current(): Route; navigate(route: Route): void };
    slot(claim: { append: string; render(): unknown }): () => void;
  };
  location?: { directory?: string };
}

const AGENT = "opencode";
const USAGE = "/atxf export [file] · /atxf import <file> · /atxf join <file> · /atxf sync · /atxf leave · /atxf status";

export default {
  id: "atxf",
  setup(api: TuiApi) {
    const joins = new Joins();
    const watchers = new Map<string, FSWatcher>();
    const busy = new Set<string>();
    const pending = new Set<string>();
    let queue: Promise<void> = Promise.resolve();
    const serial = (work: () => Promise<void>) => (queue = queue.then(work, work));
    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") => api.ui.toast.show({ title: "atxf", message, variant });

    const current = () => {
      const route = api.ui.router.current();
      return route.type === "session" ? (route as { sessionID: string }).sessionID : undefined;
    };
    const cwd = () => api.location?.directory ?? process.cwd();
    const local = async (sessionID: string): Promise<Transcript> => converter.toAtxf(`${JSON.stringify(await api.client.session.export({ sessionID }), null, 2)}\n`);

    /** Replaces a session with a transcript, keeping its id, and shows it again. */
    async function replace(sessionID: string, transcript: Transcript) {
      const before = await api.client.session.export({ sessionID });
      // Written for this session: OpenCode message ids are unique across sessions, so the converter scopes them to it.
      const data = JSON.parse(converter.fromAtxf(transcript, { sessionId: sessionID })) as SessionData;
      const location = before.info.location ?? data.info.location;
      const shown = current() === sessionID || current() === undefined;
      // The TUI reacts to these events on its own: on `session.deleted` it drops the session from its store and goes
      // home, and on `session.created` it treats the session as new and empty. Wait for each before going on, then
      // reload the session into the store, or the TUI would show the replaced session without its messages.
      const deleted = nextEvent("session.deleted", sessionID, 5_000);
      await api.client.session.remove({ sessionID });
      await deleted;
      const created = nextEvent("session.created", sessionID, 5_000);
      try {
        await api.client.session.import({ ...data, location });
      } catch (error) {
        // The session is already deleted, and a failed import would lose it: put back what it held.
        await api.client.session.import({ ...before, location: before.info.location });
        await created;
        await reload(sessionID, shown);
        throw error;
      }
      await created;
      await reload(sessionID, shown);
    }

    /** Loads a session the TUI saw deleted and created again into its store, and shows it if it was shown. */
    async function reload(sessionID: string, shown: boolean) {
      api.data.session.evict(sessionID);
      await api.data.session.sync(sessionID);
      await api.data.session.message.sync(sessionID);
      if (shown) api.ui.router.navigate({ type: "session", sessionID });
    }

    /** Resolves with true on the next `type` event for `sessionID`, or with false after `ms`. */
    function nextEvent(type: string, sessionID: string, ms: number): Promise<boolean> {
      return new Promise((done) => {
        const timer = setTimeout(() => finish(false), ms);
        const stop = api.data.on(type, (event) => {
          if (event.data.sessionID === sessionID) finish(true);
        });
        function finish(seen: boolean) {
          clearTimeout(timer);
          stop();
          done(seen);
        }
      });
    }

    async function pushNow(sessionID: string) {
      const path = joins.get(AGENT, sessionID);
      if (path === undefined) return;
      const { added } = await push(path, await local(sessionID));
      if (added > 0) toast(`shared ${added} record${added === 1 ? "" : "s"}`);
    }

    async function pullNow(sessionID: string): Promise<number> {
      const path = joins.get(AGENT, sessionID);
      if (path === undefined) return 0;
      if (busy.has(sessionID)) {
        pending.add(sessionID); // Replacing a running session would lose its turn; pull once it is idle.
        return 0;
      }
      const result = await pull(path, await local(sessionID));
      if (result === undefined) return 0;
      await replace(sessionID, result.transcript);
      toast(`received ${result.added} record${result.added === 1 ? "" : "s"}`);
      return result.added;
    }

    function watchShared(sessionID: string) {
      watchers.get(sessionID)?.close();
      watchers.delete(sessionID);
      const path = joins.get(AGENT, sessionID);
      if (path === undefined) return;
      let debounce: ReturnType<typeof setTimeout> | undefined;
      watchers.set(
        sessionID,
        watch(dirname(path), (_event, name) => {
          if (name !== basename(path)) return;
          clearTimeout(debounce);
          debounce = setTimeout(() => serial(() => pullNow(sessionID).then(() => undefined, (error) => toast(`pull failed: ${error.message}`, "error"))), 200);
        }),
      );
    }

    // Push when a joined session finishes a turn, then pull what arrived while it was running.
    const settled = (sessionID: string) =>
      serial(async () => {
        busy.delete(sessionID);
        if (joins.get(AGENT, sessionID) === undefined) return;
        if (!watchers.has(sessionID)) watchShared(sessionID);
        try {
          await pushNow(sessionID);
          pending.delete(sessionID);
          await pullNow(sessionID);
        } catch (error) {
          toast(`sync failed: ${(error as Error).message}`, "error");
        }
      });
    const unsubscribe = [
      api.data.on("session.execution.started", (event) => void busy.add(event.data.sessionID)),
      ...(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"] as const).map((type) =>
        api.data.on(type, (event) => void settled(event.data.sessionID)),
      ),
    ];

    // Keymap layers belong to a rendered component, so register the command from a slot, as OpenCode's own plugins do.
    const register = () => api.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "atxf.run",
          title: "ATXF: export, import or join a shared session",
          group: "Session",
          palette: true,
          slash: { name: "atxf", arguments: true },
          run: (args?: string) =>
            serial(async () => {
              const [command, ...rest] = (args ?? "").trim().split(/\s+/);
              const target = rest.join(" ");
              const sessionID = current();
              try {
                switch (command) {
                  case "export": {
                    if (sessionID === undefined) return toast("open a session first", "warning");
                    const out = resolve(cwd(), target || `${sessionID}.atxf.jsonl`);
                    writeFileSync(out, serializeTranscript(await local(sessionID)));
                    return toast(`exported to ${out}`, "success");
                  }
                  case "import": {
                    if (!target) return toast(USAGE, "warning");
                    const transcript = parseTranscript(readFileSync(resolve(cwd(), target), "utf8"));
                    const data = JSON.parse(converter.fromAtxf(transcript)) as SessionData;
                    const imported = await api.client.session.import({ ...data, location: { directory: cwd() } });
                    api.ui.router.navigate({ type: "session", sessionID: imported.id });
                    return toast(`imported ${transcript.records.length} records`, "success");
                  }
                  case "join": {
                    if (!target) return toast(USAGE, "warning");
                    if (sessionID === undefined) return toast("open a session first", "warning");
                    const path = resolve(cwd(), target);
                    const existing = existsSync(path) ? await readShared(path) : undefined;
                    joins.set(AGENT, sessionID, path);
                    if (existing === undefined) {
                      await push(path, await local(sessionID));
                      toast(`sharing this session through ${path}`, "success");
                    } else {
                      // Join the session already there: this session becomes a copy of it.
                      await replace(sessionID, existing);
                      toast(`joined ${path} (${existing.records.length} records)`, "success");
                    }
                    watchShared(sessionID);
                    return;
                  }
                  case "sync": {
                    if (sessionID === undefined || joins.get(AGENT, sessionID) === undefined) return toast("this session is not joined; use /atxf join <file>", "warning");
                    await pushNow(sessionID);
                    if ((await pullNow(sessionID)) === 0) toast("in sync");
                    return;
                  }
                  case "leave": {
                    if (sessionID === undefined) return;
                    joins.delete(AGENT, sessionID);
                    watchers.get(sessionID)?.close();
                    watchers.delete(sessionID);
                    return toast("left the shared session");
                  }
                  case "status": {
                    const path = sessionID === undefined ? undefined : joins.get(AGENT, sessionID);
                    return toast(path ? `joined ${path}` : "not joined");
                  }
                  default:
                    return toast(USAGE);
                }
              } catch (error) {
                toast((error as Error).message, "error");
              }
            }),
        },
      ],
    }));
    api.ui.slot({
      append: "app",
      render() {
        register();
        return null;
      },
    });

    return () => {
      for (const stop of unsubscribe) stop();
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    };
  },
};
