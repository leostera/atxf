/**
 * JSON Patch (RFC 6902) between JSON values, as converters use it to keep what a native record holds beyond the
 * ATXF fields it maps to (SPEC §11.2): the patch that turns the record written back from ATXF into the original.
 *
 * `diff` is deterministic and the same in every implementation: objects are compared key by key, in UTF-16 code
 * unit order of the keys (as RFC 8785 sorts them), so the patch does not depend on the order of keys in the input;
 * arrays of the same length element by element; anything else is replaced whole. Only `add`, `replace` and
 * `remove` are used.
 */

export type PatchOperation =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether two JSON values are equal, ignoring the order of object keys. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

/** One step of a JSON Pointer (RFC 6901). */
const escape = (token: string) => token.replaceAll("~", "~0").replaceAll("/", "~1");
const unescape = (token: string) => token.replaceAll("~1", "/").replaceAll("~0", "~");

/** The patch that turns `from` into `to`. Empty when they are equal as JSON. */
export function diff(to: unknown, from: unknown): PatchOperation[] {
  const ops: PatchOperation[] = [];
  walk(to, from, "", ops);
  return ops;
}

function walk(to: unknown, from: unknown, path: string, ops: PatchOperation[]) {
  if (jsonEqual(to, from)) return;
  if (isPlainObject(to) && isPlainObject(from)) {
    const keys = [...new Set([...Object.keys(to), ...Object.keys(from)])].sort();
    for (const key of keys) {
      const at = `${path}/${escape(key)}`;
      if (!Object.hasOwn(to, key)) ops.push({ op: "remove", path: at });
      else if (!Object.hasOwn(from, key)) ops.push({ op: "add", path: at, value: to[key] });
      else walk(to[key], from[key], at, ops);
    }
    return;
  }
  if (Array.isArray(to) && Array.isArray(from) && to.length === from.length) {
    to.forEach((item, index) => walk(item, from[index], `${path}/${index}`, ops));
    return;
  }
  ops.push({ op: "replace", path, value: to });
}

/** `value` with `ops` applied, in order. Throws when a path does not exist. Does not change `value`. */
export function applyPatch<T>(value: T, ops: readonly PatchOperation[]): T {
  let root = structuredClone(value) as Json;
  for (const operation of ops) root = applyOne(root, operation);
  return root as T;
}

function applyOne(root: Json, operation: PatchOperation): Json {
  if (operation.path === "") {
    if (operation.op === "remove") throw new RangeError("a patch cannot remove the whole value");
    return structuredClone(operation.value) as Json;
  }
  const tokens = operation.path.slice(1).split("/").map(unescape);
  const last = tokens.pop()!;
  let parent: Json = root;
  for (const token of tokens) {
    const next: Json | undefined = Array.isArray(parent) ? parent[Number(token)] : isPlainObject(parent) && Object.hasOwn(parent, token) ? parent[token] : undefined;
    if (next === undefined) throw new RangeError(`no value at ${operation.path}`);
    parent = next;
  }
  if (Array.isArray(parent)) {
    const index = last === "-" ? parent.length : Number(last);
    if (!Number.isInteger(index) || index < 0 || index > parent.length) throw new RangeError(`no index ${last} at ${operation.path}`);
    if (operation.op === "add") parent.splice(index, 0, structuredClone(operation.value) as Json);
    else if (index === parent.length) throw new RangeError(`no value at ${operation.path}`);
    else if (operation.op === "replace") parent[index] = structuredClone(operation.value) as Json;
    else parent.splice(index, 1);
    return root;
  }
  if (!isPlainObject(parent)) throw new RangeError(`no object at ${operation.path}`);
  if (operation.op === "remove" || operation.op === "replace") {
    if (!Object.hasOwn(parent, last)) throw new RangeError(`no value at ${operation.path}`);
  }
  if (operation.op === "remove") delete parent[last];
  else parent[last] = structuredClone(operation.value) as Json;
  return root;
}
