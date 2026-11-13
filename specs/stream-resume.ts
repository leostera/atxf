// Reading a live Pi session across evictions.
//
// Pi appends lines to a session file. The Mac's daemon sends each line, in order, to a reader in the cloud (Axo's
// SessionDO), which pushes it into `pi.stream()`, writes the record it returns to R2 under the line it came from,
// and then, in a separate write, saves the stream's `state()` as its checkpoint. The reader may be evicted at any
// moment, losing its memory; the next line it gets finds no stream, so it resumes one from the checkpoint
// (`pi.stream({ resume })`) and asks the daemon to resend whatever came after it. A deploy may change how the
// reader reads in between.
//
// This works because resuming is exact: a stream resumed from a state returns the very records, hashes included,
// that the saved stream would have. Lines read again after an eviction write the same records under the same lines.
// A state saved by another reader version is refused, and the reader starts over from the first line.
//
// A record here is its hash, folded from the hash before it, its line and the reader version that read it, as the
// record hash covers its parent's (SPEC §17): "start>1@1>2@1" is lines 1 and 2 read by version 1.
import { atMost, budget, crash, defineActor, defineMessage, defineProperty, defineRule, defineScenario, defineSpec, defineVariable, defineZone, type WorldView } from "@leostera/feynman";

/** A stream as the reader holds it: the next line it reads, the hash of the last record, the version reading. */
interface Stream {
  next: number;
  prev: string;
  version: number;
}
/** A record written to R2: the line it came from and its hash. */
interface Stored {
  line: number;
  hash: string;
}

const hashOf = (prev: string, line: number, version: number) => `${prev}>${line}@${version}`;

/** The records one stream of `version` reads from lines 1..n, never stopped. */
function unbroken(lines: number, version: number): Stored[] {
  const out: Stored[] = [];
  let prev = "start";
  for (let line = 1; line <= lines; line++) out.push({ line, hash: (prev = hashOf(prev, line, version)) });
  return out;
}

// A state names the reader version that wrote it, and another version refuses it (`PI_STREAM_STATE`).
const versionedState = defineRule("versionedState", { description: "A checkpoint saved by another reader version is refused, and the reader starts over." });
// R2 holds one record per line: a line read again after an eviction overwrites its record rather than adding one.
const recordsByLine = defineRule("recordsByLine", { description: "Records are written to R2 under the line they came from." });

const Line = defineMessage("Line", { line: Number }, { name: "session line", over: "websocket", ordered: true });
const Resend = defineMessage("Resend", { from: Number }, { name: "resend from line", over: "websocket", ordered: true, tone: "reply" });

// An eviction may happen at most once on a path; `--set faults=2` raises it. The daemon and Pi do not restart here.
const faults = budget("faults", 1);
// How many lines Pi writes, and how often the reader is deployed, on one path.
const lines = defineVariable("lines", 3);
const deploys = defineVariable("deploys", 1);

const mac = defineZone({ name: "Mac", description: "where Pi writes the session" });
const cloud = defineZone({ name: "Cloud", description: "where the session is read and stored" });

export const Daemon = defineActor({
  name: "Daemon",
  description: "Tails the session file Pi writes and sends each new line to the reader, in order.",
  zone: mac,
  singleton: true,
  initialState: () => ({ written: 0, sent: 0 }),
  display: {
    icon: "laptop",
    status: (s) => `${s.written} line(s) written, ${s.sent} sent`,
    mood: (s) => (s.sent < s.written ? "busy" : "ok"),
  },
  actions: {
    write: {
      with: [atMost(lines)],
      label: "Pi writes a line",
      description: "Pi appends an entry to the session file.",
      run: (state) => void (state.written += 1),
    },
  },
  transitions: {
    send: {
      description: "Sends the next line it has not sent.",
      when: (s) => s.sent < s.written,
      sends: [Line],
      run(state, _, ctx) {
        state.sent += 1;
        ctx.send(ctx.the(Reader), Line, { line: state.sent });
      },
    },
    resend: {
      on: Resend,
      description: "Sends again from the line the reader asks for.",
      say: (_s, msg) => `Resending from line ${msg.from}`,
      run: (state, msg) => void (state.sent = Math.min(state.sent, msg.from - 1)),
    },
  },
});

export const Reader = defineActor({
  name: "Reader",
  description: "Axo's SessionDO: reads each line into a Pi stream, stores the record in R2 and checkpoints the stream.",
  zone: cloud,
  singleton: true,
  // In memory: `stream`, gone on eviction. Kept: the checkpoint and R2 (its own storage), the code's version, and
  // whether it ever resumed. `waiting` is the line it asked to be resent from, until it arrives.
  initialState: () => ({ stream: null as Stream | null, waiting: null as number | null, checkpoint: null as Stream | null, r2: [] as Stored[], version: 1, resumed: false }),
  display: {
    icon: "cloud",
    status: (s) => (s.stream ? `reading line ${s.stream.next}, version ${s.version}` : `evicted, version ${s.version}`),
    mood: (s) => (s.stream ? "ok" : "off"),
    rows: (s) => [
      { group: "R2", label: `${s.r2.length} record(s)`, detail: s.r2.map((r) => r.line).join(", ") || "none" },
      { group: "checkpoint", label: s.checkpoint ? `before line ${s.checkpoint.next}` : "none", detail: s.checkpoint ? `version ${s.checkpoint.version}` : undefined },
    ],
  },
  actions: {
    deploy: {
      with: [atMost(deploys)],
      label: "Deploy",
      description: "A new reader version is deployed, which restarts it: its stream is gone, its storage stays.",
      run(state) {
        state.version += 1;
        state.stream = null;
        state.waiting = null;
      },
    },
  },
  transitions: {
    line: {
      on: Line,
      description: "Pushes the line into its stream and writes the record it returns to R2 under that line.",
      sources: ["packages/atxf-ts/src/codec.ts:182-205"],
      sends: [Resend],
      say: (s, msg) => `Line ${msg.line}: ${s.r2.length} record(s) in R2`,
      run(state, msg, ctx) {
        if (state.stream === null) {
          // Evicted: resume from the checkpoint, unless another version saved it.
          const saved = state.checkpoint;
          const usable = saved !== null && (saved.version === state.version || !versionedState.on);
          state.stream = usable ? { ...saved, version: state.version } : { next: 1, prev: "start", version: state.version };
          state.resumed ||= usable;
          if (msg.line !== state.stream.next) {
            state.waiting = state.stream.next;
            return ctx.send(ctx.the(Daemon), Resend, { from: state.stream.next }, `Resuming before line ${state.stream.next}`);
          }
        }
        const stream = state.stream;
        if (msg.line !== stream.next) return ctx.note(msg.line < stream.next ? "A line it has read: nothing new." : `Waiting for line ${stream.next}.`);
        state.waiting = null;
        const hash = hashOf(stream.prev, msg.line, stream.version);
        const record = { line: msg.line, hash };
        state.r2 = recordsByLine.on ? [...state.r2.filter((r) => r.line !== msg.line), record].sort((a, b) => a.line - b.line) : [...state.r2, record];
        state.stream = { next: msg.line + 1, prev: hash, version: stream.version };
      },
    },
    checkpoint: {
      description: "Saves the stream's state to its storage, after the records it covers are in R2.",
      sources: ["packages/atxf-ts/src/codec.ts:171-181"],
      when: (s) => s.stream !== null && (s.checkpoint?.next !== s.stream.next || s.checkpoint?.version !== s.stream.version),
      run: (state) => void (state.checkpoint = { ...state.stream! }),
    },
    evicted: crash({ keeps: ["checkpoint", "r2", "version", "resumed"], spend: faults, description: "The reader is evicted from memory; its storage stays." }),
  },
});

const daemon = (w: WorldView) => w.the(Daemon).state;
const reader = (w: WorldView) => w.the(Reader).state;
const caughtUp = (w: WorldView) => w.quiet && daemon(w).sent === daemon(w).written && reader(w).stream?.next === daemon(w).written + 1;

const eachLineOnce = defineProperty("eachLineOnce", {
  description: "R2 holds at most one record for each line, however often the reader was evicted.",
  always: (w) => new Set(reader(w).r2.map((r) => r.line)).size === reader(w).r2.length,
  needs: [recordsByLine],
});

const asIfNeverStopped = defineProperty("asIfNeverStopped", {
  description: "Once the reader has caught up, R2 holds exactly what one stream of its version reads from the whole file.",
  always: (w) => !caughtUp(w) || JSON.stringify(reader(w).r2) === JSON.stringify(unbroken(daemon(w).written, reader(w).version)),
  needs: [versionedState, recordsByLine],
});

const chainIsWhole = defineProperty("chainIsWhole", {
  description: "Every record in R2 continues the one before it: the hash chain has no gap or repeat, whatever was evicted or deployed.",
  always: (w) => {
    const r2 = reader(w).r2;
    return !caughtUp(w) || r2.every((r, i) => r.hash.startsWith(`${i === 0 ? "start" : r2[i - 1]!.hash}>`));
  },
  needs: [recordsByLine],
});

const resumesAfterEviction = defineProperty("resumesAfterEviction", {
  description: "A reader evicted mid-session resumes from its checkpoint and catches up.",
  reachable: (w) => caughtUp(w) && reader(w).resumed && daemon(w).written === 3,
});

const startsOverAfterDeploy = defineProperty("startsOverAfterDeploy", {
  description: "After a deploy, the reader reads the session again with its new version and catches up.",
  reachable: (w) => caughtUp(w) && reader(w).version === 2 && daemon(w).written >= 2,
});

const evictedMidSession = defineScenario("Evicted mid-session", {
  description: "The reader is evicted after it stored line 2 but before it saved the checkpoint; it resumes before line 2, gets line 2 again, and writes the same record.",
  run(s) {
    const pi = s.the(Daemon);
    const reader = s.the(Reader);
    s.act(pi, "write");
    s.settle();
    s.act(pi, "write");
    s.settle({ until: (w) => w.the(Reader).state.r2.length === 2 && w.the(Reader).state.checkpoint?.next === 2 });
    s.step(reader, "evicted");
    s.act(pi, "write");
    s.settle();
  },
});

const deployBetweenLines = defineScenario("Deploy between lines", {
  description: "A deploy between lines refuses the old checkpoint; the reader starts over from line 1 and rewrites every record with its new version.",
  run(s) {
    const pi = s.the(Daemon);
    const reader = s.the(Reader);
    s.act(pi, "write");
    s.act(pi, "write");
    s.settle();
    s.act(reader, "deploy");
    s.act(pi, "write");
    s.settle();
  },
});

export default defineSpec({
  name: "Resuming a Pi stream",
  description: "A reader of a live Pi session is evicted and redeployed, and still stores exactly what one unbroken read gives.",
  actors: [Daemon, Reader],
  properties: [eachLineOnce, asIfNeverStopped, chainIsWhole, resumesAfterEviction, startsOverAfterDeploy],
  scenarios: [evictedMidSession, deployBetweenLines],
});
