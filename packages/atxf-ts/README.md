# @leostera/atxf

TypeScript implementation of [ATXF](https://atxf.leostera.dev), the Agent Transcript Exchange Format: types,
validation, hashes and seals, context building, lossless converters for coding-agent sessions, and reconciliation
of diverged copies of a session. Runs on [Bun](https://bun.sh).

## CLI

```sh
bunx @leostera/atxf validate session.atxf.jsonl
bunx @leostera/atxf convert --from pi --to codex session.jsonl > rollout.jsonl
bunx @leostera/atxf convert --from codex --to atxf rollout.jsonl > session.atxf.jsonl
bunx @leostera/atxf reconcile studio.atxf.jsonl laptop.atxf.jsonl > merged.atxf.jsonl
```

Agents: `pi`, `claude-code`, `codex`, `opencode`, `gemini-cli`. Converting a session to another agent's format and
back gives the same session; converting a native file to ATXF and back gives the same bytes.

## Library

```ts
import { buildContext, validateTranscript } from "@leostera/atxf";
import { pi } from "@leostera/atxf/pi";
import { codex } from "@leostera/atxf/codex";
import { reconcile } from "@leostera/atxf/reconcile";

const transcript = pi.toAtxf(await Bun.file("session.jsonl").text());
const rollout = codex.fromAtxf(transcript); // Codex can continue it; reading it back gives `transcript`
const context = buildContext(transcript); // what the model sees at the active leaf
```

`@leostera/atxf/testing` and `@leostera/atxf/laws` hold fast-check generators and the laws every converter must
satisfy, for testing a converter of your own.

## License

MIT
