# Changelog

All notable changes to `@leostera/atxf`. Versions are the package's own; every release so far implements ATXF 0.1
(`ATXF_VERSIONS`).

## Unreleased

- **`linearize`** and **`atxf linearize`** (SPEC §18.1): every branch of a transcript on one path, turn by turn in
  the order they happened, so an agent continuing a reconciled session sees what every copy did, word for word. The
  result is a new transcript forked from the source (`fidelity.topology: "linearized"`). `atxf linearize` reconciles
  several copies first, and with `--from`/`--to` it reads and writes an agent's own files:
  `atxf linearize --from pi --to pi a.jsonl b.jsonl`. It works on all 2,614 local Pi sessions. In those that branch
  and never compacted, every message is in context afterwards (151 instead of 17 in one). Also in the Rust crate and
  CLI.
- **`reconcile` refuses copies read differently** (SPEC §18). Two copies of a session share no record but start
  with the same first answer when one was converted without carry: every record has a different key, and their
  union held the whole conversation twice, so linearizing gave the next agent every prompt twice. Found by
  `test/e2e/linearize.ts`. Copies forked before the first answer still reconcile. The CLI reports errors as
  `atxf: <message>` instead of a stack trace, as the Rust one does.
- **Fix (Pi):** an entry Pi appended after a carried annotation (a seal or leaf written as an `atxf.record` custom
  entry, e.g. in a reconciled tree) read as a new root. It now continues from where the annotation sits, as after
  Pi's own labels. Reading changed, so `PI_STREAM_STATE` is now `pi/session-jsonl stream 2`: states saved by 0.4.0
  are refused, and the reader starts over.
- **Test:** `test/pi-linearize.test.ts`. Two Pis continue one session apart, the copies are reconciled and
  linearized in ATXF, and a third Pi continues the linear file and remembers what both did. It runs against a scripted model, or a
  real one with `ATXF_E2E_MODEL`. It is skipped without `pi`.

## 0.4.0

- **Pi without native.** A Pi session read, stripped of `native` and written back loses nothing: every entry comes
  back equal as JSON (key order aside), and reads back as the same transcript. Checked on 2,164 real sessions
  (414,984 entries). `native` is now only what keeps the file byte for byte (SPEC §11.2).
  - New ATXF fields, all optional, in the 0.1 and 0.2 schemas: `startTime` and `durationMs` on messages;
    `responseModel`, `reasoningEffort` and `providerReasoningEffort` on assistant messages; `usage.cacheWrite1h`;
    `nestedCalls` on tool results (calls a tool made itself, never model context); compaction `files`. Validators
    of 0.3.0 and earlier reject records that use them.
  - What Pi holds beyond them (assistant `diagnostics`, `constrainedSampling`, …) is kept in `ext.pi.patch`, an
    RFC 6902 patch against what the writer gives.
- **Whole-tree writer:** `fromAtxf(t, { carry: false, tree: true })` (CLI `convert --no-carry --tree`) writes every
  record, branches and compacted history included. Any transcript, from any agent, written this way reads back as
  itself: a record Pi cannot hold in full gets the rest in its entry's `atxf.patch`, which Pi ignores.
  `Converter.tree` says whether a converter can.
- **Nothing is refused.** A Pi entry with no ATXF form becomes a `custom` record with `namespace: "pi.entry"` and
  the entry in `data` (it was `namespace: "pi"`, named after its type, with nothing else). A line that is not JSON
  becomes `namespace: "pi.line"` with `data.text`. `pi.stream().push` no longer throws: blank lines add nothing,
  text with several lines is read a line at a time, and a line carrying a transcript is read as its entry.
- **Resumable streams:** `stream.state()` returns the stream's state as JSON, and `pi.stream({ resume: state })`
  goes on from it: pushing the lines after it returns the records and hashes the saved stream would have. The
  state holds the header and every record's id, parent, type and hash, so it grows with the number of records,
  not their content: about 155 bytes per record (3 MB for a 121 MB session, 1.4 MB gzipped). It names the reader's
  version (`PI_STREAM_STATE`), and another version refuses it. The `atxf` crate reads Pi as a stream too
  (`PiStream`), writing and resuming the same states; `atxf stream` drives either from the command line.
- **`atxf fidelity --from <agent> [--json] <file|dir>…`** and `addFidelity`, `formatFidelity`, `isLossless`: what
  a session keeps without native, entry by entry.
- `diff`, `applyPatch` and `jsonEqual`: JSON Patch between JSON values, as converters compute it. `applyPatch`
  applies `add`, `replace` and `remove` only.
- Law 6 in `@leostera/atxf/laws`: without native, for converters that write whole trees.
- The Pi writer also writes `reasoning` and `cacheWrite1h` usage, durations and the response model when carrying.

## 0.3.0

- **`pi.stream()`** reads a Pi session as Pi writes it: push one line at a time and get that line's records back,
  each final when returned and the same as `toAtxf` gives for the whole file (its header has no
  `fidelity.nativeDigest`, which only a finished file has). It keeps only the ids and hashes later lines refer to,
  so a session of any length streams in bounded memory. `Converter.stream` and `TranscriptStream` type it; other
  converters do not stream yet.
- **`TreeBuilder`** takes `retain: false` to build without keeping every record.
- **Law 5** in `@leostera/atxf/laws`: a converter that streams returns `toAtxf`'s records line by line, and the
  streamed transcript writes back the same file.
- The schema validator compiles on first use instead of on import. Compiling generates code, which Cloudflare
  Workers refuse, so a Worker that only converts can now import the package.

## 0.2.0

- `@leostera/atxf/sync`: push an agent's copy of a session into one shared file and pull what others added.
- OpenCode 2.0.20 import, and OpenCode message ids scoped to the session they are written for
  (`fromAtxf(t, { sessionId })`).
- `ATXF_VERSION` and `ATXF_VERSIONS` name the format versions written and accepted.
- Faster validation of tool results.

## 0.1.1

- Keep the `atxf` bin when publishing.

## 0.1.0

- First release: the ATXF 0.1 types, schema and validator, converters for Pi, Codex, Claude Code, OpenCode and
  Gemini CLI, `buildContext`, integrity and reconciliation, and the `atxf` CLI.
