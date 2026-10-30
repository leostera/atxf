# ATXF v0.1 specification

**Status:** draft. The key words MUST, SHOULD and MAY are used as in RFC 2119.

The JSON Schema in [`schema/v0.1/atxf.schema.json`](schema/v0.1/atxf.schema.json) defines the shape of each record. This document defines everything a per-line schema cannot express: ordering, references, and how a consumer reconstructs model context and session state.

## 1. Model

An ATXF transcript records one agent session as three layers that share one tree:

| Layer | Answers | Records |
| --- | --- | --- |
| **Context** | What did the model see? | `message`, `context`, `compaction`, `context_edit`, `branch_summary` |
| **State** | Under which settings? | `settings` |
| **Events** | What happened around the model? | `turn`, `tool_status`, `usage`, `checkpoint`, `agent_link`, `custom` |

Three *annotation* records sit outside the tree and apply to the whole transcript: `leaf`, `label` and `metadata`.

## 2. Encoding

- A transcript is UTF-8 [JSON Lines](https://jsonlines.org/): one JSON object per line. Blank lines MUST be ignored.
- The suggested file extension is `.atxf.jsonl`.
- The first record MUST be the `transcript` header, and it MUST appear exactly once.
- Records are append-only. File order is append order, and consumers MUST interpret records in file order.
- Writers SHOULD emit timestamps in UTC. Consumers MUST NOT rely on timestamps for ordering.

## 3. Identity and references

- Every record except the header has an `id` that is unique within the transcript. The header's `id` is the transcript id and lives in a separate namespace.
- Ids are opaque strings. Writers SHOULD reuse source ids when those are unique, which makes round-trips simpler.
- Every reference (`parentId`, `targetId`, `fromId`, `firstKeptId`, `restoreCheckpointId`) MUST point to a tree record that appears **earlier** in the file. The tree is therefore acyclic by construction.
- A tool result (`message` with `role: "tool"`) MUST be a descendant of the assistant message containing the matching `tool_call` block, when that call is present in the transcript. Tool call ids MUST be unique within a transcript.
- Imported transcripts can be truncated. A tool result or `tool_status` whose call is absent is therefore allowed; validators SHOULD warn about it rather than reject it.

## 4. Tree and active leaf

- Tree records carry `parentId`. A value of `null` makes the record a root, and a transcript MAY have several roots (e.g. after a reset).
- The **active leaf** is whichever came last in file order:
  1. the most recently appended tree record, or
  2. the `targetId` of the most recent `leaf` record.
- `leaf.targetId: null` means the active path is empty: the next record starts a new root.
- The **active path** is the chain from the active leaf back to its root.
- Appending a tree record whose `parentId` is not the active leaf is a branch. No other marker is needed.
- `leaf.reason` records *why* the position moved, so source semantics survive:

| Source operation | ATXF encoding |
| --- | --- |
| Pi `/tree` navigation | `leaf` with `reason: navigate`, optionally followed by a `branch_summary` |
| Claude Code rewind | `leaf` with `reason: rewind` (plus `restoreCheckpointId` when files were restored) |
| Codex thread rollback | `leaf` with `reason: rollback`, targeting the record before the dropped turns |
| OpenCode revert | `leaf` with `reason: revert` and `restoreCheckpointId` |
| Gemini CLI `$rewindTo` | `leaf` with `reason: rewind`, targeting the rewound message's parent |

Records on abandoned branches are never deleted. Producers whose source deletes history (e.g. a committed OpenCode revert) SHOULD keep what they have and MAY omit what they cannot recover.

## 5. Building model context

Given the active path `P` (root first), a consumer produces the model's instructions, tools and message list as follows:

1. **Compaction boundary:** let `C` be the last `compaction` on `P`.
   - If there is none, the working range is all of `P`.
   - `strategy: "summary"`: the working range is `C`, then the records from `firstKeptId` up to (not including) `C`, then the records after `C`. If `firstKeptId` is `null`, nothing before `C` is kept.
   - `strategy: "replace"`: the working range is `C`, then the records after `C`.
2. **Instructions and tools:** start from `C.snapshot` if present, otherwise from empty. Then fold the `context` records in the working range, in order:
   - `mode: replace` resets the instructions to its `instructions` and the tools to its `toolsAdded`.
   - `mode: patch` replaces each named section (a `text` of `null` removes it), appends `toolsAdded` (replacing tools of the same name), and removes `toolsRemoved`.
   - Sections keep first-insertion order. When `C.snapshot` is present, `context` records *before* `C` are ignored.
3. **Messages:** walk the working range in order:
   - `message` → itself.
   - `compaction`, summary strategy → a summary message (rendering is consumer-defined; a user-role message prefixed with a note is typical).
   - `compaction`, replace strategy → the `replacement` messages, in order.
   - `branch_summary` → a summary message.
   - Every other record type contributes nothing.
4. **Context edits:** for every `context_edit` on `P`, the latest one per `targetId` wins.
   - `replacement: null` drops the target message from the list.
   - Otherwise the target's `content` is replaced; its role and other fields are unchanged.
   - Edits whose target is outside the working range have no effect.
5. **Replay data:** handled per §10.

`display: false` messages are model context but SHOULD be hidden from transcript UIs. `custom` records are never model context; extensions inject context with a `message` whose `origin.kind` is `extension`.

## 6. Settings

The effective settings at a point are obtained by folding the `settings` records on the path up to that point, field by field: each present field overrides the previous value. Settings are not affected by compaction. `policy` is opaque and source-defined; consumers MUST NOT assume a shape across sources.

## 7. Compaction

- **`summary`** keeps a tail plus a summary (Pi, Claude Code). `firstKeptId` MUST be an ancestor of the compaction, or `null`. `snapshot` SHOULD carry the full instructions and tools at the boundary, when the producer knows them.
- **`replace`** swaps in a complete new base (Codex `replacement_history`, OpenCode provider compaction). Provider-encrypted compaction state goes in the compaction's `replay`.
- In both cases the compacted records stay in the file, so consumers MAY show them.
- `usage` on a compaction is the cost of producing it. It MUST be counted in transcript totals.

## 8. Tool calls

- A call is a `tool_call` block in an assistant message. Its result is a `message` with `role: "tool"`. This split is mandatory even for sources that merge the two (OpenCode, Gemini CLI); producers for those sources split one record into two.
- `kind`:
  - `function`: has JSON `arguments`.
  - `custom`: has free-form `input`.
  - `builtin`: provider-hosted tools, e.g. web search.
- `tool_status` records are OPTIONAL lifecycle events: pending, approved/denied, running, completed/error/cancelled. A call that never ran (denied, aborted) MAY have a `tool_status` but no result message.

## 9. Turns

- `turn` records are OPTIONAL. When present, a turn starts at a `turn` with `phase: start` and ends at the matching `phase: end` with the same `turnId`.
- An `end` MUST carry `outcome`.
- User messages steered in mid-turn belong to the open turn.
- A transcript that ends inside a turn means the session stopped mid-turn.

## 10. Replay data

`replay` holds opaque provider state: thinking signatures, OpenAI `encrypted_content`, Gemini thought signatures, provider compaction blobs.

- Consumers MUST NOT interpret `data`.
- When sending context to a model, a consumer MUST include a `replay` entry only if `provider`, and `api` when present, match the target. Otherwise it MUST drop the entry.
- A reasoning block with no `text` and no `summary` whose replay data was dropped SHOULD be omitted entirely.

## 11. Native passthrough

- `native` carries the verbatim source records an ATXF record was derived from. One ATXF record MAY carry several native records; a native record SHOULD appear in at most one ATXF record.
- A producer that sets `native` on every record SHOULD declare `fidelity.native: "all"`. Converting back to the same source then means emitting the native records in file order.

## 12. Usage

- The buckets are disjoint:
  - `input` excludes cached tokens.
  - `cacheRead` and `cacheWrite` count cached tokens separately.
  - `output` includes `reasoning`.
  - `total = input + cacheRead + cacheWrite + output`.
- Producers MUST convert source conventions (e.g. "prompt tokens including cache") into these buckets.
- Transcript totals are the sum of:
  - `usage` on assistant messages,
  - `usage` on compaction and branch-summary records,
  - non-cumulative `usage` records.

  `cumulative: true` usage records are running totals. Consumers MUST NOT add them to the sum; they MAY use the last one as the total.

## 13. Related transcripts

- Forks, sub-agents, continuations and imports are separate transcripts. The child's header `parent` names the parent transcript and, optionally, the entry it branched from.
- The parent MAY record the interaction with `agent_link` records (spawn, message, result, close).
- Transcripts reference each other by id. `uri` MAY locate the other file.

## 14. Checkpoints

A `checkpoint` records workspace file state at its position in the tree. It holds any of:

- an opaque `snapshot` id,
- a VCS commit,
- a list of changed files.

A `leaf` with `restoreCheckpointId` states that files were restored to that checkpoint when the position moved. ATXF carries file *references*, not file contents.

## 15. Fidelity

The header's `fidelity` declares what the producer could capture: topology, instructions, tools, reasoning, tool lifecycle, turns, usage, native coverage, and whether ids are `stable` (taken from the source, so they match across copies of the same session) or `synthetic` (made up by the converter). Consumers SHOULD treat absent information as unknown, not empty. For example, with `fidelity.instructions: "none"`, a missing `context` record does not mean the system prompt was empty.

## 16. Extensibility and versioning

- Core objects are closed: unknown fields are invalid. Source-specific data belongs in:
  - `native`, for verbatim source records,
  - `ext`, for namespaced extras,
  - `custom` records, for extension state.
- New record types require a new format version. The header's `atxf` field names it.
- Minor versions only add optional fields and record types. Consumers SHOULD process a newer minor version, skipping records that fail validation.

## 17. Integrity

Record hashes make a transcript tamper-evident and let a reader prove that a record belongs to it without reading the rest. They work like Git commits: each record's hash commits to its own content and to the hashes of the records it references, so it covers everything the record depends on.

A header that declares `"integrity": {"alg": "sha256", "canon": "jcs"}` MUST carry `hash`, and so MUST every other record. Without `integrity`, hashes are optional, consumers do not check them, and `seal` records are invalid.

### 17.1 Computing hashes

- `JCS(v)` is the [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON of `v`, as UTF-8.
- `D(tag, bytes)` is `"sha256:"` followed by the lowercase hex SHA-256 of `"atxf/0.1/" + tag + "\n"` and then `bytes`. The tag separates the kinds of hash, so a hash of one kind cannot pass for another.
- The **header hash** is `D("transcript", JCS(header without "hash"))`.
- A record's **content digest** is `D("content", JCS(record without "hash"))`. It covers every field, including `time`, `native` and `ext`.
- A record's **hash** is `D("record", JCS({transcript, content, refs}))`, where:
  - `transcript` is the header hash. It ties the record to this transcript.
  - `content` is the record's content digest.
  - `refs` has one entry for each reference field the record has (`parentId`, `targetId`, `fromId`, `firstKeptId`, `restoreCheckpointId`). Each entry is the hash of the referenced record, or `null` for a null reference.

References always point to earlier records (§3), so a writer can hash each record as it appends it.

Hashes vouch for content, not identity. Two converters, or two versions of one converter, can produce different hashes for the same source session, because `native`, timestamps and field choices differ. Ids identify records (§3). When two copies of a transcript have a record with the same id, equal hashes mean the record and everything it depends on are identical. Different hashes mean the copies conflict there.

### 17.2 Seals

Record hashes cannot detect a missing record that nothing references, such as a deleted branch tip. They also do not cover file order, which decides the active leaf (§4) and which label applies. A `seal` record covers both, for every record before it:

- `count`: the number of records before the seal, excluding the header.
- `chain`: a hash chain over those records in file order. It starts as the header hash, and each record folds in as `chain = D("chain", previousChain + "\n" + recordHash)`. Earlier seals are included.
- `heads`: the hashes of the records before the seal that no other record before it references, sorted. Seals are left out. Every record is reachable from a head by following references, so the heads cover the whole tree. Unlike `chain`, `heads` do not depend on file order, so two copies holding the same records have the same heads.

A seal has a hash of its own (with empty `refs`) and is not part of the tree. A writer MAY append seals at any point, for example at the end of each turn or upload.

Anyone can recompute a seal, so it shows the transcript is complete and unchanged, not who wrote it. Signing seals, to prove who vouches for a transcript, is left to a later version.

### 17.3 Inclusion proofs

To prove that a record is covered by a seal, send the record and, for each record from it to one of the seal's `heads`, the `{transcript, content, refs}` input of that record's hash. The verifier:

1. checks that the first input's `content` is the digest of the record,
2. recomputes each hash, checking that each input's `refs` contains the previous hash,
3. checks that the last hash is the head.

The proof carries only digests of the other records on the path, not their content.

## 18. Privacy

Transcripts routinely contain source code, credentials pasted by users, file paths and personal data. Producers SHOULD offer redaction before export. `native` and `replay` can contain the same sensitive material in less visible form.
