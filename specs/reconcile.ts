// Reconciling copies of one session.
//
// Two Macs hold copies of the same session and keep working offline: each appends to its copy, and may rewind to
// the parent of where it is, or navigate to the tip of another branch (Pi's /tree).
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
import {
  atMost,
  budget,
  crash,
  defineActor,
  defineMessage,
  defineProperty,
  defineScenario,
  defineVariable,
  defineSpec,
  defineZone,
  input,
  lose,
  nullable,
  oneOf,
  recordOf,
  type Setup,
  type WorldView,
} from "@leostera/feynman";

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

/** The tips of a copy's branches other than the active leaf, by display id: where a Mac can navigate to. */
const otherTips = (copy: Copy) => {
  const ids = displayIds(copy);
  const parents = new Set(Object.values(copy).filter((r) => r.kind === "node" && r.ref !== null).map((r) => r.ref));
  const leaf = activeLeaf(copy);
  return Object.values(copy)
    .filter((r) => r.kind === "node" && !parents.has(r.key) && r.key !== leaf)
    .map((r) => ids[r.key]!);
};

const keysOf = (copy: Copy) => Object.keys(copy).sort().join(",");
/** Whether a Mac holds records the store has not sent back to it. */
const changed = (s: { records: Copy; heard: string }) => keysOf(s.records) !== s.heard;
const clockOf = (copy: Copy) => Math.max(0, ...Object.values(copy).map((r) => r.time));

const records = recordOf({ key: String, id: String, kind: oneOf("node", "leaf"), ref: nullable(String), time: Number });
const Push = defineMessage("Push", { records }, { name: "push copy", over: "https" });
// The store sends every reconciled copy down one websocket per Mac, which delivers them in the order they were sent.
// Pushes are separate HTTPS requests, so they may arrive in any order. Without `ordered`, every property still holds
// (10.7M states, every world), but the search no longer fits in the 5M states of feynman.config.ts.
const Reconciled = defineMessage("Reconciled", { records, version: Number }, { name: "reconciled copy", over: "websocket", tone: "reply", ordered: true });

// Either message may be lost, and a Mac may restart, at most once on any path. The store keeps everything it holds
// and never restarts mid-step, so it has no crash. `--set faults=2` raises it.
const faults = budget("faults", 1);
// How often a Mac may append or push on one path; `--set repeats=3` raises both.
const repeats = defineVariable("repeats", 2);
// How often a Mac may move its leaf on one path, by rewinding or navigating: one bound for both. One per Mac covers a
// move on both Macs at once and the tie-break between their leaf moves, of either kind; a second only adds orders
// of the same events, and takes the search past 5M states. `--set moves=2` raises it.
const moves = defineVariable("moves", 1);
const leafMoves = atMost(moves);
// How many records a Mac's copy may hold before it stops appending. `feynman conform --set maxRecords=…` raises it to
// read a real session against the spec.
const maxRecords = defineVariable("maxRecords", 4);

const macs = defineZone({ name: "Macs", description: "working offline, then syncing", place: { arrange: "row" } });
const cloud = defineZone({ name: "Cloud", description: "the session store every Mac syncs through" });

export const Store = defineActor({
  name: "Session store",
  description: "Keeps the reconciled session and sends it to every Mac after each push.",
  zone: cloud,
  singleton: true,
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
    push: {
      on: Push,
      description: "Reconciles the pushed copy with its own and sends the result to every Mac.",
      sources: ["packages/atxf-ts/src/reconcile.ts#reconcile"],
      sends: [Reconciled],
      say: (s) => `Reconciled: ${Object.keys(s.records).length} records, version ${s.version}`,
      run(state, msg, ctx) {
        state.records = union(state.records, msg.records);
        state.version += 1;
        for (const mac of ctx.all(Mac)) ctx.send(mac, Reconciled, { records: state.records, version: state.version });
      },
    },
    pushLost: lose(Push, { spend: faults }),
  },
});

export const Mac = defineActor({
  name: "Mac",
  description: "Runs the agent; appends to its copy of the session, rewinds and navigates.",
  zone: macs,
  // `heard`: the records of the last reconciled copy it got back. It has unpushed work while it holds others.
  initialState: () => ({ records: {} as Copy, seen: 0, heard: "" }),
  display: {
    icon: "laptop",
    names: ["Studio", "Laptop"],
    status: (s) => `${Object.keys(s.records).length} records${changed(s) ? ", not in sync" : ""}`,
    mood: (s) => (changed(s) ? "busy" : "ok"),
  },
  actions: {
    append: {
      with: [atMost(repeats)],
      label: "Append",
      description: "The agent appends a record at the active leaf. Ids are given by position, as Codex and Gemini CLI do, so two Macs can pick the same one.",
      uses: [maxRecords],
      when: (s, model) => Object.keys(s.records).length < model.get(maxRecords),
      run(state, _inputs, ctx) {
        const parent = activeLeaf(state.records);
        const id = `e${Object.values(state.records).filter((r) => r.kind === "node").length + 1}`;
        const key = ctx.hash(`${ctx.label}|${id}|${parent}`);
        state.records = { ...state.records, [key]: { key, id, kind: "node", ref: parent, time: clockOf(state.records) + 1 } };
      },
    },
    rewind: {
      with: [leafMoves],
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
    navigate: {
      with: [leafMoves],
      label: "Navigate",
      description: "Moves to the tip of another branch, appending a leaf move; it continues from there.",
      // A tip by display id, from any Mac's copy: the checker tries each, and a Mac without it stays where it is.
      // Moving to an ancestor is a rewind.
      inputs: { to: input(String, { examples: (w): string[] => [...new Set(w.all(Mac).flatMap((m) => otherTips(m.state.records)))].sort() }) },
      when: (s) => otherTips(s.records).length > 0,
      run(state, { to }, ctx) {
        const ids = displayIds(state.records);
        const target = Object.values(state.records).find((r) => ids[r.key] === to && otherTips(state.records).includes(to));
        if (target === undefined) return ctx.note(`No other tip ${to} here: it stays where it is.`);
        const time = clockOf(state.records) + 1;
        const key = ctx.hash(`${ctx.label}|leaf|${target.key}|${clockOf(state.records)}`);
        state.records = { ...state.records, [key]: { key, id: `leaf${time}`, kind: "leaf", ref: target.key, time } };
      },
    },
    push: {
      with: [atMost(repeats)],
      label: "Push",
      description: "Sends its whole copy to the session store.",
      sources: ["packages/atxf-ts/src/sync.ts#push"],
      sends: [Push],
      run(state, _inputs, ctx) {
        ctx.send(ctx.the(Store), Push, { records: state.records });
      },
    },
  },
  transitions: {
    reconciled: {
      on: Reconciled,
      description: "Reconciles the store's copy with its own, which may have moved on since it pushed.",
      sources: ["packages/atxf-ts/src/sync.ts#pull"],
      say: (s) => `Reconciled: ${Object.keys(s.records).length} records`,
      run(state, msg, ctx) {
        if (msg.version <= state.seen) return ctx.note("An older version, overtaken by a later one: nothing new.");
        state.records = union(state.records, msg.records);
        state.seen = msg.version;
        state.heard = keysOf(msg.records);
      },
    },
    reconciledLost: lose(Reconciled, { spend: faults }),
    crash: crash({ keeps: ["records", "seen", "heard"], spend: faults }),
  },
});

const copies = (w: WorldView) => [w.the(Store).state.records, ...w.all(Mac).map((m) => m.state.records)];

const noRecordIsLost = defineProperty("noRecordIsLost", {
  description: "No copy ever loses a record: reconciling only adds.",
  everyStep: (before, after) => {
    const was = copies(before);
    const is = copies(after);
    return was.every((copy, i) => Object.keys(copy).every((key) => key in (is[i] ?? {})));
  },
});

const everyRecordHasItsParent = defineProperty("everyRecordHasItsParent", {
  description: "In every copy, every record's parent or target is there too, so the tree is whole.",
  always: (w) => copies(w).every((copy) => Object.values(copy).every((r) => r.ref === null || r.ref in copy)),
});

const idsAreUnique = defineProperty("idsAreUnique", {
  description: "In every copy, records sharing an id get distinct display ids: both are kept.",
  always: (w) => copies(w).every((copy) => new Set(Object.values(displayIds(copy))).size === Object.keys(copy).length),
});

const sameRecordsSamePlace = defineProperty("sameRecordsSamePlace", {
  description: "Copies holding the same records show the same active leaf, whatever order they were reconciled in.",
  always: (w) => {
    const all = copies(w);
    return all.every((a) => all.every((b) => keysOf(a) !== keysOf(b) || activeLeaf(a) === activeLeaf(b)));
  },
});

const convergesOnceQuiet = defineProperty("convergesOnceQuiet", {
  description: "Once nothing is in flight, Macs that saw the latest version and changed nothing since hold exactly the store's records.",
  always: (w) => {
    if (!w.quiet) return true;
    const store = w.the(Store).state;
    return w.all(Mac).every((m) => changed(m.state) || m.state.seen !== store.version || keysOf(m.state.records) === keysOf(store.records));
  },
});

const storeHoldsEveryPush = defineProperty("storeHoldsEveryPush", {
  description: "Once nothing is in flight, the store holds every record of every Mac that pushed and changed nothing since.",
  always: (w) => !w.quiet || w.all(Mac).every((m) => changed(m.state) || m.state.seen === 0 || Object.keys(m.state.records).every((key) => key in w.the(Store).state.records)),
});

// What must be possible: without these, a spec in which nobody ever syncs would keep every property above.

/** Two records that share an id, both in the store: positional ids collided, and reconciling kept both. */
const collision = (copy: Copy) => {
  const nodes = Object.values(copy).filter((r) => r.kind === "node");
  return new Set(nodes.map((r) => r.id)).size < nodes.length;
};

const branchesAreKept = defineProperty("branchesAreKept", {
  description: "Two Macs can append different records under one id, and the store keeps both as sibling branches.",
  reachable: (w) => collision(w.the(Store).state.records),
});

const everyMacCatchesUp = defineProperty("everyMacCatchesUp", {
  description: "Both Macs can end up holding the store's records, with branches from both of them.",
  reachable: (w) => {
    const store = w.the(Store).state.records;
    return w.quiet && collision(store) && w.all(Mac).every((m) => keysOf(m.state.records) === keysOf(store));
  },
});

const navigatesToAnotherBranch = defineProperty("navigatesToAnotherBranch", {
  description: "A Mac can move to a branch it did not write, and every copy that reconciled its move is there with it.",
  reachable: (w) => {
    const store = w.the(Store).state.records;
    const leaf = activeLeaf(store);
    const event = positioning(store);
    return w.quiet && collision(store) && event?.kind === "leaf" && leaf !== null && w.all(Mac).every((m) => activeLeaf(m.state.records) === leaf);
  },
});

const shared = (w: Setup) => {
  const records: Copy = {
    k1: { key: "k1", id: "e1", kind: "node", ref: null, time: 1 },
    k2: { key: "k2", id: "e2", kind: "node", ref: "k1", time: 2 },
  };
  w.set(Store, { records, version: 1 });
  w.spawn(Mac, "Studio", { records });
  w.spawn(Mac, "Laptop", { records });
};

const divergeAndReconcile = defineScenario("Diverge and reconcile", {
  description: "Both Macs append to the same two records offline and pick the same id; the store keeps both as sibling branches, and the later one is the active leaf.",
  setup: shared,
  run(s) {
    const [studio, laptop] = s.all(Mac);
    s.act(studio!, "append");
    s.act(laptop!, "append");
    s.act(studio!, "push");
    s.act(laptop!, "push");
    s.settle();
  },
});

const rewindOnOneMac = defineScenario("Rewind on one Mac", {
  description: "The Laptop rewinds and pushes; its leaf move is the latest event, so every copy moves back with it, and the branch it left stays.",
  setup: shared,
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

const pushTwice = defineScenario("Push twice", {
  description: "Pushing the same copy again changes no records: reconciling is idempotent.",
  setup: shared,
  run(s) {
    const [studio] = s.all(Mac);
    s.act(studio!, "append");
    s.act(studio!, "push");
    s.act(studio!, "push");
    s.settle();
  },
});

const navigateToTheOtherBranch = defineScenario("Navigate to the other branch", {
  description: "Both Macs append under the same id; once reconciled, the Studio navigates to the Laptop's branch, and every copy follows it there.",
  setup: shared,
  run(s) {
    const [studio, laptop] = s.all(Mac);
    s.act(studio!, "append");
    s.act(laptop!, "append");
    s.act(studio!, "push");
    s.act(laptop!, "push");
    s.settle();
    const ids = displayIds(studio!.state.records);
    const mine = activeLeaf(studio!.state.records);
    const other = Object.values(studio!.state.records).find((r) => r.kind === "node" && r.id === "e3" && r.key !== mine);
    s.act(studio!, "navigate", { to: ids[other!.key]! });
    s.act(studio!, "push");
    s.settle();
  },
});

export default defineSpec({
  name: "Reconciling session copies",
  description: "Two Macs keep working on copies of one session; the session store reconciles them into one tree that keeps every branch.",
  actors: [Store, Mac],
  properties: [noRecordIsLost, everyRecordHasItsParent, idsAreUnique, sameRecordsSamePlace, convergesOnceQuiet, storeHoldsEveryPush, branchesAreKept, everyMacCatchesUp, navigatesToAnotherBranch],
  scenarios: [divergeAndReconcile, rewindOnOneMac, navigateToTheOtherBranch, pushTwice],
});
