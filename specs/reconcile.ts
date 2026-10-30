// Reconciling copies of one session.
//
// Two Macs hold copies of the same session and keep working offline: each appends to its copy, and may rewind.
// Whenever a Mac pushes its copy, the session store reconciles it with what it has and sends the result to every
// Mac, which reconciles it with its own copy. Reconciliation is a union of records keyed by their Merkle hash
// (SPEC §17), so it is commutative, associative and idempotent, and no copy ever loses a record: divergent
// suffixes become sibling branches. Ids are only labels. Copies that number records by position (Codex, Gemini)
// give two different records the same id; the one with the smaller hash keeps it and the other is renamed. The
// active leaf is a function of the records alone: the latest positioning event (a tip or a leaf move), ties
// broken by hash, so every copy with the same records shows the same place.
//
// The records here keep only what decides reconciliation: id, parent, hash and a Lamport time. Content is folded
// into the hash.
import { defineSpec, message } from "@leostera/feynman";

/** A record as reconciliation sees it. `key` is its Merkle hash: it covers the parent's key, so it names the
 * record and everything it depends on. */
interface Rec {
  key: string;
  id: string;
  kind: "node" | "leaf";
  /** For a node, its parent's key; for a leaf move, its target's key. */
  ref: string | null;
  time: number;
}
type Copy = Record<string, Rec>;

/** The union of copies. Records with the same key are the same record, so the union keeps one. */
function union(...copies: Copy[]): Copy {
  const out: Copy = {};
  for (const copy of copies) for (const rec of Object.values(copy)) out[rec.key] = rec;
  return out;
}

/** Display ids: for records sharing an id, the smallest key keeps it; the others get `id~key`. */
function displayIds(copy: Copy): Record<string, string> {
  const byId: Record<string, string[]> = {};
  for (const rec of Object.values(copy)) (byId[rec.id] ??= []).push(rec.key);
  const out: Record<string, string> = {};
  for (const [id, keys] of Object.entries(byId)) {
    keys.sort();
    keys.forEach((key, i) => (out[key] = i === 0 ? id : `${id}~${key.slice(0, 6)}`));
  }
  return out;
}

/** The latest positioning event: a leaf move, or a node no other node points at. Ties go to the smaller key. */
function positioning(copy: Copy): Rec | undefined {
  const referenced = new Set(Object.values(copy).filter((r) => r.kind === "node" && r.ref !== null).map((r) => r.ref));
  const candidates = Object.values(copy).filter((r) => r.kind === "leaf" || !referenced.has(r.key));
  candidates.sort((a, b) => b.time - a.time || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return candidates[0];
}

/** The active leaf: the node the positioning event puts the session at. */
function activeLeaf(copy: Copy): string | null {
  const event = positioning(copy);
  return event === undefined ? null : event.kind === "leaf" ? event.ref : event.key;
}

const keysOf = (copy: Copy) => Object.keys(copy).sort().join(",");
/** Whether a Mac holds records the store has not sent back to it. */
const changed = (s: { records: Copy; heard: string }) => keysOf(s.records) !== s.heard;
const clockOf = (copy: Copy) => Math.max(0, ...Object.values(copy).map((r) => r.time));

export default defineSpec(
  "Reconciling session copies",
  {
    description: "Two Macs keep working on copies of one session; the session store reconciles them into one tree that keeps every branch.",
    messages: {
      Push: message<{ records: Copy }>({ name: "push copy", over: "https" }),
      Reconciled: message<{ records: Copy; version: number }>({ name: "reconciled copy", over: "websocket", tone: "reply" }),
    },
  },
  (spec) => {
    const { Push, Reconciled } = spec.messages;
    const macs = spec.defineZone({ name: "Macs", description: "working offline, then syncing", place: { arrange: "row" } });
    const cloud = spec.defineZone({ name: "Cloud" });

    const Store = spec.defineActor({
      name: "Session store",
      description: "Keeps the reconciled session and sends it to every Mac after each push.",
      zone: cloud,
      singleton: true,
      durable: ["records", "version"],
      initialState: () => ({ records: {} as Copy, version: 0 }),
      display: {
        icon: "database",
        status: (s) => `${Object.keys(s.records).length} records, version ${s.version}`,
        mood: () => "info",
        rows: (s) => {
          const ids = displayIds(s.records);
          const leaf = activeLeaf(s.records);
          return Object.values(s.records)
            .filter((r) => r.kind === "node")
            .sort((a, b) => a.time - b.time)
            .map((r) => ({ group: "session", label: ids[r.key]!, detail: r.key === leaf ? "active leaf" : r.ref ? `after ${ids[r.ref] ?? "?"}` : "root", mood: r.key === leaf ? ("ok" as const) : undefined }));
        },
      },
      transitions: {
        [Push]: {
          description: "Reconciles the pushed copy with its own and sends the result to every Mac.",
          sends: [Reconciled],
          say: (s) => `Reconciled: ${Object.keys(s.records).length} records, version ${s.version}`,
          run(state, msg, ctx) {
            state.records = union(state.records, msg.records);
            state.version += 1;
            for (const mac of ctx.all(Mac)) ctx.send(mac, Reconciled, { records: state.records, version: state.version });
          },
        },
      },
    });

    const Mac = spec.defineActor({
      name: "Mac",
      description: "Runs the agent; appends to its copy of the session, and rewinds.",
      zone: macs,
      // `heard`: the records of the last reconciled copy it got back. It has unpushed work while it holds others.
      durable: ["records", "seen", "heard"],
      initialState: () => ({ records: {} as Copy, seen: 0, heard: "" }),
      display: {
        icon: "laptop",
        names: ["Studio", "Laptop"],
        status: (s) => `${Object.keys(s.records).length} records${changed(s) ? ", not in sync" : ""}`,
        mood: (s) => (changed(s) ? "busy" : "ok"),
      },
      actions: {
        append: {
          label: "Append",
          description: "The agent appends a record at the active leaf. Ids are given by position, as Codex and Gemini CLI do, so two Macs can pick the same one.",
          when: (s) => Object.keys(s.records).length < 4,
          run(state, _inputs, ctx) {
            const parent = activeLeaf(state.records);
            const id = `e${Object.values(state.records).filter((r) => r.kind === "node").length + 1}`;
            const key = ctx.hash(`${ctx.label}|${id}|${parent}`);
            state.records = { ...state.records, [key]: { key, id, kind: "node", ref: parent, time: clockOf(state.records) + 1 } };
          },
        },
        rewind: {
          label: "Rewind",
          description: "Moves back to the parent of the active leaf, appending a leaf move.",
          when: (s) => {
            const leaf = activeLeaf(s.records);
            return leaf !== null && s.records[leaf]?.ref != null;
          },
          run(state, _inputs, ctx) {
            const target = state.records[activeLeaf(state.records)!]!.ref;
            const key = ctx.hash(`${ctx.label}|leaf|${target}|${clockOf(state.records)}`);
            state.records = { ...state.records, [key]: { key, id: `leaf${clockOf(state.records) + 1}`, kind: "leaf", ref: target, time: clockOf(state.records) + 1 } };
          },
        },
        push: {
          label: "Push",
          description: "Sends its whole copy to the session store.",
          sends: [Push],
          run(state, _inputs, ctx) {
            ctx.send(ctx.the(Store), Push, { records: state.records });
          },
        },
      },
      transitions: {
        [Reconciled]: {
          description: "Reconciles the store's copy with its own, which may have moved on since it pushed.",
          say: (s) => `Reconciled: ${Object.keys(s.records).length} records`,
          run(state, msg, ctx) {
            if (msg.version <= state.seen) return ctx.note("An older version, overtaken by a later one: nothing new.");
            state.records = union(state.records, msg.records);
            state.seen = msg.version;
            state.heard = keysOf(msg.records);
          },
        },
      },
    });

    const copies = (w: { the: (a: typeof Store) => { state: { records: Copy } }; all: (a: typeof Mac) => { state: { records: Copy } }[] }) => [
      w.the(Store).state.records,
      ...w.all(Mac).map((m) => m.state.records),
    ];

    spec.defineProperties({
      noRecordIsLost: {
        description: "No copy ever loses a record: reconciling only adds.",
        everyStep: (before, after) => {
          const was = copies(before);
          const is = copies(after);
          return was.every((copy, i) => Object.keys(copy).every((key) => key in (is[i] ?? {})));
        },
      },
      everyRecordHasItsParent: {
        description: "In every copy, every record's parent or target is there too, so the tree is whole.",
        always: (w) => copies(w).every((copy) => Object.values(copy).every((r) => r.ref === null || r.ref in copy)),
      },
      idsAreUnique: {
        description: "In every copy, records sharing an id get distinct display ids: both are kept.",
        always: (w) => copies(w).every((copy) => new Set(Object.values(displayIds(copy))).size === Object.keys(copy).length),
      },
      sameRecordsSamePlace: {
        description: "Copies holding the same records show the same active leaf, whatever order they were reconciled in.",
        always: (w) => {
          const all = copies(w);
          return all.every((a) => all.every((b) => keysOf(a) !== keysOf(b) || activeLeaf(a) === activeLeaf(b)));
        },
      },
      convergesOnceQuiet: {
        description: "Once nothing is in flight, Macs that saw the latest version and changed nothing since hold exactly the store's records.",
        always: (w) => {
          if (!w.quiet) return true;
          const store = w.the(Store).state;
          return w.all(Mac).every((m) => changed(m.state) || m.state.seen !== store.version || keysOf(m.state.records) === keysOf(store.records));
        },
      },
      storeHoldsEveryPush: {
        description: "Once nothing is in flight, the store holds every record of every Mac that pushed and changed nothing since.",
        always: (w) => !w.quiet || w.all(Mac).every((m) => changed(m.state) || m.state.seen === 0 || Object.keys(m.state.records).every((key) => key in w.the(Store).state.records)),
      },
    });

    const shared = (w: { spawn: (a: typeof Mac, label: string, state: { records: Copy }) => unknown; set: (a: typeof Store, state: { records: Copy; version: number }) => void }) => {
      const records: Copy = {
        k1: { key: "k1", id: "e1", kind: "node", ref: null, time: 1 },
        k2: { key: "k2", id: "e2", kind: "node", ref: "k1", time: 2 },
      };
      w.set(Store, { records, version: 1 });
      w.spawn(Mac, "Studio", { records });
      w.spawn(Mac, "Laptop", { records });
    };

    spec.defineScenario({
      name: "Diverge and reconcile",
      description: "Both Macs append to the same two records offline and pick the same id; the store keeps both as sibling branches, and the later one is the active leaf.",
      setup: (w) => shared(w as never),
      run(s) {
        const [studio, laptop] = s.all(Mac);
        s.act(studio!, "append");
        s.act(laptop!, "append");
        s.act(studio!, "push");
        s.act(laptop!, "push");
        s.settle();
      },
    });

    spec.defineScenario({
      name: "Rewind on one Mac",
      description: "The Laptop rewinds and pushes; its leaf move is the latest event, so every copy moves back with it, and the branch it left stays.",
      setup: (w) => shared(w as never),
      run(s) {
        const [studio, laptop] = s.all(Mac);
        s.act(studio!, "append");
        s.act(studio!, "push");
        s.settle();
        s.act(laptop!, "rewind");
        s.act(laptop!, "push");
        s.settle();
      },
    });

    spec.defineScenario({
      name: "Push twice",
      description: "Pushing the same copy again changes no records: reconciling is idempotent.",
      setup: (w) => shared(w as never),
      run(s) {
        const [studio] = s.all(Mac);
        s.act(studio!, "append");
        s.act(studio!, "push");
        s.act(studio!, "push");
        s.settle();
      },
    });

    return { Store, Mac };
  },
);
