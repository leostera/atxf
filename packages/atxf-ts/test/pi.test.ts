import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { activePath, addIntegrity, indexTree } from "../src/index.ts";
import { describeConverterLaws } from "../src/laws.ts";
import { pi } from "../src/formats/pi.ts";

const fixture = (name: string) => ({ name, text: readFileSync(new URL(`../../../fixtures/pi/${name}`, import.meta.url), "utf8") });

describeConverterLaws(pi, { fixtures: [fixture("session-every-field.jsonl")] });

describe("an entry Pi appends after a carried annotation", () => {
  // A whole tree written for Pi carries a seal (or a leaf) as a custom entry, and Pi parents its next entry on it.
  test("continues from where the annotation sits", () => {
    const sealed = addIntegrity(pi.toAtxf(fixture("session-every-field.jsonl").text), { seal: { id: "seal-1", time: "2026-01-01T00:00:00.000Z" } });
    const lines = pi.fromAtxf(sealed, { carry: false, tree: true }).trimEnd().split("\n");
    const seal = JSON.parse(lines.at(-1)!) as { id: string; type: string };
    expect(seal.type).toBe("custom");
    const next = { type: "message", id: "after-seal", parentId: seal.id, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "next", timestamp: 0 } };
    const read = pi.toAtxf(`${lines.join("\n")}\n${JSON.stringify(next)}\n`);
    const after = read.records.find((record) => record.id === "after-seal") as { parentId: string | null };
    expect(after.parentId).toBe(indexTree(sealed).activeLeaf);
    expect(activePath(read).length).toBe(activePath(sealed).length + 1);
  });
});
