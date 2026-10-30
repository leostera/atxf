# ATXF: Agent Transcript Exchange Format

Specification: **https://atxf.leostera.dev**

**ATXF** is a JSON Schema and JSONL format for exchanging coding-agent session transcripts between tools such as Pi, Codex, Claude Code, OpenCode and Gemini CLI.

> Status: **v0.1 draft**. Expect breaking changes until v1.

## Why

Every coding agent stores sessions differently: in-file trees, Responses-API rollouts, Anthropic message logs, SQLite event stores, op logs. Existing interchange formats such as [ATIF](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md) linearize sessions for evaluation, which loses branches, rewinds and compaction semantics.

ATXF aims to be general enough to hold any of these formats without losing their structure. For example, ATXF has a branching tree, OpenCode records tool lifecycles and Codex records turn policies. Each source record can also be carried verbatim alongside, so a converter can go back to the original format.

## Design in one screen

- **One JSONL file per transcript.** The first line is a `transcript` header. Records are append-only.
- **A tree.** Records link through `id`/`parentId`, and branches are never deleted. Rewinds, rollbacks and reverts become `leaf` moves.
- **Three layers on one tree:**
  - **context:** what the model saw (`message`, `context`, `compaction`, `context_edit`, `branch_summary`).
  - **state:** under which settings (`settings`).
  - **events:** what happened around the model (`turn`, `tool_status`, `usage`, `checkpoint`, `agent_link`, `custom`).
- **Provider-neutral messages.** Roles are `system | user | assistant | tool`. Content blocks are `text | image | resource | reasoning | tool_call`.
- **Opaque replay data** (thinking signatures, encrypted reasoning) travels in `replay`. It is passed back only to the provider that produced it.
- **Lossless escape hatch.** `native` carries the verbatim source records; `ext` and `custom` carry namespaced extras.
- **Fidelity is declared, not guessed.** The header says what the producer could capture: topology, instructions, reasoning, and so on.

```jsonl
{"type":"transcript","atxf":"0.1","id":"t1","time":"2026-10-29T12:00:00Z","source":{"agent":"pi"}}
{"type":"message","id":"e1","parentId":null,"time":"2026-10-29T12:00:01Z","role":"user","content":"What does README.md say?"}
{"type":"message","id":"e2","parentId":"e1","time":"2026-10-29T12:00:03Z","role":"assistant","content":[{"type":"tool_call","id":"call-1","name":"read","arguments":{"path":"README.md"}}],"stop":"tool_use"}
{"type":"message","id":"e3","parentId":"e2","time":"2026-10-29T12:00:03Z","role":"tool","toolCallId":"call-1","content":"# Demo"}
```

## Contents

| Path | What |
| --- | --- |
| [`SPEC.md`](SPEC.md) | Normative semantics: tree, active leaf, context building, compaction, usage, replay |
| [`schema/v0.1/atxf.schema.json`](schema/v0.1/atxf.schema.json) | JSON Schema (draft 2020-12) for one record (one line) |
| [`docs/mappings.md`](docs/mappings.md) | How Pi, Codex, Claude Code, OpenCode, Gemini CLI and ATIF map onto ATXF |
| [`examples/`](examples) | Example transcripts in the style of each source |
| [`src/validate.ts`](src/validate.ts) | Reference validator: schema plus cross-record invariants |
| [`sites/atxf.leostera.dev/`](sites/atxf.leostera.dev) | The specification website (Astro + Kumo), deployed to https://atxf.leostera.dev |

## Validate a transcript

```sh
bun install
bun src/cli.ts path/to/session.atxf.jsonl
bun run check   # typecheck and tests
```

## Roadmap

- A reference `buildContext` implementation for SPEC §5, with conformance fixtures.
- Converters: Pi, Codex, Claude Code and OpenCode to ATXF, and ATXF to ATIF.
- Native seed generation: ATXF to a target agent's session format, for cross-agent continuation.

## License

MIT
