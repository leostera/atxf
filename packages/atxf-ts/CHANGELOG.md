# Changelog

All notable changes to `@leostera/atxf`. Versions are the package's own; every release so far implements ATXF 0.1
(`ATXF_VERSIONS`).

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
