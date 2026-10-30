# Mapping agents to ATXF

These are informative conversion notes for the agents surveyed while designing ATXF (Pi, Codex, Claude Code, OpenCode, Gemini CLI), as of late October 2026. Source formats change, so converters should pin the versions they support.

## Pi (`~/.pi/agent/sessions/**.jsonl`)

ATXF's tree and context semantics follow Pi, so this mapping is the closest to one-to-one.

| Pi | ATXF |
| --- | --- |
| `session` header | `transcript`. A `parentSession` becomes a `parent` with `relation: fork` |
| `message`, role `user` / `assistant` / `toolResult` | `message`, role `user` / `assistant` / `tool` |
| `thinking` block + `thinkingSignature` | `reasoning` block + `replay` (`kind: signature`) |
| `toolCall` block + `thoughtSignature` | `tool_call` block + `replay` (`kind: thought_signature`) |
| system message `sections` / `toolsAdded` / `toolsRemoved` | `context`: the first one uses `mode: replace`, later ones `mode: patch` |
| `model_change`, `thinking_level_change` | `settings` (`model`, `reasoningEffort`) |
| `compaction` (`firstKeptEntryId`, `systemMessage`) | `compaction` with `strategy: summary` (`firstKeptId`, `snapshot`) |
| `context_edit`, `branch_summary`, `label` | the same-named records (`label` becomes an annotation; its `parentId` is dropped) |
| `custom_message` | `message`, role `user`, `origin.kind: extension`, carrying `display` |
| `custom` | `custom`, with `namespace: pi` or the extension's own namespace |
| `usage` | `usage` |
| `session_info` | `metadata.title` |

Fidelity: `topology: tree`, `instructions: full`, `tools: full`.

## Codex (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]`)

| Codex rollout item | ATXF |
| --- | --- |
| `session_meta` | `transcript`. `forked_from_id` / `parent_thread_id` become `parent` |
| `turn_context` | `settings` (`model`, `reasoningEffort`, `cwd`, `policy` ← approval / sandbox / permission) |
| `event_msg` TurnStarted / TurnComplete / TurnAborted | `turn` start / end |
| `response_item` `message` | `message`. Developer and user-instruction messages become `role: system` or `user` with `origin.kind: agent` |
| `response_item` `reasoning` | `reasoning` block (`summary`, plus `replay` with `kind: encrypted_content`), merged into the following assistant message |
| `function_call` / `custom_tool_call` / `local_shell_call` / `web_search_call` | `tool_call` blocks (`kind` function / custom / function / builtin) |
| `function_call_output` / `custom_tool_call_output` | `message` with `role: tool` |
| `compacted` with `replacement_history` | `compaction` with `strategy: replace` |
| `compacted` without replacement history | `compaction` with `strategy: summary`, `firstKeptId: null` |
| `token_usage_record` / token-count events | `usage` with `cumulative: true` |
| thread rollback event | `leaf` with `reason: rollback` |
| `inter_agent_communication` | `agent_link` with `relation: message` |
| `dynamic_tools_updated` | `context` with `mode: replace`, tools only |

Notes:
- Consecutive Responses items between two user inputs form one assistant step. Group them into one assistant message for each model response. Responses-API item boundaries are not preserved except through `native`.
- Read rollouts with Codex's own parser where possible, because its envelope has decimal-precision quirks.

Fidelity: `topology: linear`, `instructions: partial`, `turns: true`, `usage: aggregate`.

## Claude Code (`~/.claude/projects/<project>/<session>.jsonl`)

Anthropic describes the format as internal and unstable. Prefer `stream-json` output, hooks' `transcript_path`, or the Agent SDK `SessionStore`.

| Claude Code entry | ATXF |
| --- | --- |
| `uuid` / `parentUuid` | `id` / `parentId` (tree-native) |
| several `assistant` lines with the same `message.id` | one assistant `message`, with all of the source lines in `native.records` |
| `thinking` / `redacted_thinking` blocks | `reasoning` (+ `replay` with `kind: signature`, `redacted`) |
| `tool_use` | `tool_call` |
| `user` entry with `tool_result` blocks | one `message` with `role: tool` for each result |
| `isMeta: true` | `display: false` |
| compact boundary + summary (`logicalParentUuid`) | `compaction` with `strategy: summary` |
| `custom-title` / `ai-title` | `metadata.title` |
| `file-history-snapshot` | `checkpoint` |
| `subagents/agent-<id>.jsonl`, `isSidechain` | a child transcript (`parent.relation: subagent`) plus `agent_link` |
| `continued-in` | `metadata` plus a `parent` link with `relation: continuation` on the continuation transcript |

Fidelity: `topology: tree`, `instructions: none` (the system prompt is rebuilt at resume).

## OpenCode (`~/.local/share/opencode/opencode.db`, or `opencode session export`)

| OpenCode v2 | ATXF |
| --- | --- |
| `session_v2` row | `transcript`. `parent_id` becomes `parent.relation: subagent`; `fork_session_id` + `fork_boundary` become `relation: fork` |
| `user` / `synthetic` / `skill` / `shell` messages | `message`, role `user`, with `origin.kind` human / synthetic / extension / command |
| `system` message | `message` with `role: system` |
| `assistant` (one per step) | assistant `message`, with `model`, `tokens`→`usage`, `cost`, `finish`→`stop` |
| assistant `tool` content (state machine) | a `tool_call` block, plus a `tool` message holding the result, plus `tool_status` records for each state |
| `reasoning` content + `native` | `reasoning` + `replay` |
| `compaction` message (completed) | `compaction`: `strategy: replace` when `native.messages` is present, otherwise `summary` |
| `agent-switched` / `model-switched` / `location-switched` | `settings` (`agent` / `model` / `cwd`) |
| `idle` | `turn` end (outcome is carried over). Synthesize a `turn` start before the first input of each turn |
| snapshots, `revert` | `checkpoint`, plus `leaf` with `reason: revert` |

Fidelity: `topology: linear`, `toolLifecycle: true`, `turns: true`.

## Gemini CLI (`~/.gemini/tmp/<project>/chats/session-*.jsonl`)

First replay the `$set` / `$patch` op log, but keep each `$rewindTo` as a `leaf` with `reason: rewind` rather than deleting the messages.

| Gemini record | ATXF |
| --- | --- |
| metadata (`sessionId`, `startTime`, `summary`, `kind`) | `transcript` / `metadata` (`kind: subagent` becomes a `parent` link) |
| `user` | `message` with `role: user` |
| `gemini` + `toolCalls[]` (with results) | an assistant `message` with `tool_call` blocks, plus one `tool` message for each result, plus `tool_status` |
| `thoughts` | `reasoning.summary` |
| `info` / `warning` / `error` | `custom` with `namespace: gemini-cli` (not model context) |

Fidelity: `topology: linear`, `reasoning: summary`.

## ATIF (Harbor)

- **ATXF → ATIF:** linearize the active path, then map messages to steps. Tool calls plus their results become `tool_calls` + `observation`. `reasoning.text`/`summary` becomes `reasoning_content`. Usage becomes `metrics`, with `prompt_tokens = input + cacheRead + cacheWrite` and `cached_tokens = cacheRead`.
- **ATIF → ATXF:** produces a linear transcript. Embedded `subagent_trajectories` become child transcripts.
