import { isTreeRecord, type EntryRecord, type Transcript, type TreeRecord } from "./types.ts";

/** Lookup structures over a transcript's tree (SPEC §4). */
export interface TreeIndex {
  /** Tree records by id. */
  nodes: Map<string, TreeRecord>;
  /** Child ids by parent id, in file order. Roots are under `null`. */
  children: Map<string | null, string[]>;
  /** The active leaf (SPEC §4), or null for an empty active path. */
  activeLeaf: string | null;
}

export function indexTree(transcript: Transcript): TreeIndex {
  const nodes = new Map<string, TreeRecord>();
  const children = new Map<string | null, string[]>();
  let activeLeaf: string | null = null;
  for (const record of transcript.records) {
    if (isTreeRecord(record)) {
      nodes.set(record.id, record);
      const siblings = children.get(record.parentId) ?? [];
      siblings.push(record.id);
      children.set(record.parentId, siblings);
      activeLeaf = record.id;
    } else if (record.type === "leaf") {
      activeLeaf = record.targetId;
    }
  }
  return { nodes, children, activeLeaf };
}

/** The records from the root to `leaf`, root first. */
export function pathTo(index: TreeIndex, leaf: string | null): TreeRecord[] {
  const path: TreeRecord[] = [];
  const seen = new Set<string>();
  for (let cursor = leaf; cursor !== null; ) {
    const node = index.nodes.get(cursor);
    if (!node || seen.has(cursor)) break;
    seen.add(cursor);
    path.push(node);
    cursor = node.parentId;
  }
  return path.reverse();
}

export function activePath(transcript: Transcript, index: TreeIndex = indexTree(transcript)): TreeRecord[] {
  return pathTo(index, index.activeLeaf);
}

/** Every leaf of the tree (records with no children), in file order. */
export function leaves(index: TreeIndex): string[] {
  return [...index.nodes.keys()].filter((id) => !index.children.has(id));
}

export function annotations(transcript: Transcript): Exclude<EntryRecord, TreeRecord>[] {
  return transcript.records.filter((record): record is Exclude<EntryRecord, TreeRecord> => !isTreeRecord(record));
}
