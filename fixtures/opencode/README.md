# Fixtures

- `export-2.0.20.json`: a real `opencode session export` from OpenCode 2.0.20, recorded against a scripted OpenAI-compatible server: a prompt, a step that reads `README.md` with the `read` tool, its answer, an idle marker, and a second prompt and answer.

- `export-hand-built.json`: an export written by hand from `SessionTransfer.Data` and `SessionMessage` in OpenCode's `packages/schema`, laid out the way `opencode session export` writes it. It covers agent and model switches, a system update, a prompt, an assistant step with reasoning and settled tool calls (one failed), a compaction and an idle marker. It was written before a real session was available; OpenCode 2.0.20 no longer imports it as is (compactions now require `recent`).
