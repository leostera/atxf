// A Pi session as a `feynman conform` log for specs/reconcile.ts: one Mac (Studio) writes it, then pushes it once.
//
// usage: bun scripts/pi-reconcile-log.ts <session.jsonl> > log.jsonl
//        bunx feynman conform reconcile log.jsonl --set maxRecords=100000 --set moves=100000 --set repeats=100000
//
// Every tree record is an append. A record that continues from an ancestor of the active leaf is that many rewinds
// first. One that continues from elsewhere (Pi's /tree) is a navigate to the tip of the target's latest branch,
// then rewinds up to the target. The spec numbers records by position (`e1`, `e2`, …), so the log names them so.
import { readFileSync } from "node:fs";
import { pi } from "../packages/atxf-ts/src/formats/pi.ts";

const transcript = pi.toAtxf(readFileSync(process.argv[2]!, "utf8"), { integrity: false });
const parent = new Map<string, string | null>();
const children = new Map<string, string[]>();
const modelId = new Map<string, string>();
const log: object[] = [{ kind: "spawn", actor: "Mac", label: "Studio" }];
const step = (key: string, inputs?: object) => log.push({ instance: "Studio", key, ...(inputs ? { inputs } : {}) });
const ancestors = (id: string | null) => {
  const out: (string | null)[] = [];
  for (let at = id; at !== null; at = parent.get(at) ?? null) out.push(at);
  return [...out, null];
};
const counts = { appends: 0, rewinds: 0, navigates: 0 };

let leaf: string | null = null;
for (const record of transcript.records) {
  if (!("parentId" in record)) continue;
  const target = record.parentId;
  if (target !== leaf) {
    let up = ancestors(leaf).indexOf(target);
    if (up < 0 && target !== null) {
      let tip = target;
      for (let next = children.get(tip)?.at(-1); next !== undefined; next = children.get(tip)?.at(-1)) tip = next;
      step("navigate", { to: modelId.get(tip) });
      counts.navigates += 1;
      up = ancestors(tip).indexOf(target);
    }
    for (let i = 0; i < up; i++) step("rewind");
    counts.rewinds += Math.max(0, up);
  }
  step("append");
  counts.appends += 1;
  parent.set(record.id, target);
  if (target !== null) children.set(target, [...(children.get(target) ?? []), record.id]);
  modelId.set(record.id, `e${counts.appends}`);
  leaf = record.id;
}
log.push({ instance: "Studio", key: "push" });
log.push({ instance: "Session store", key: "push", from: "Studio" });
log.push({ instance: "Studio", key: "reconciled", from: "Session store" });
for (const line of log) console.log(JSON.stringify(line));
console.error(`${counts.appends} appends, ${counts.rewinds} rewinds, ${counts.navigates} navigates, ${log.length} lines`);
