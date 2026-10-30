# @leostera/atxf

TypeScript implementation of [ATXF](https://atxf.leostera.dev), the Agent Transcript Exchange Format: types,
validation, hashes and seals, context building, lossless converters for coding-agent sessions, and reconciliation
of diverged copies of a session. Runs on Node 22 or later and on [Bun](https://bun.sh).

## CLI

```sh
npx @leostera/atxf validate session.atxf.jsonl      # or bunx
npx @leostera/atxf convert --from pi --to codex session.jsonl > rollout.jsonl
npx @leostera/atxf convert --from codex --to atxf rollout.jsonl > session.atxf.jsonl
npx @leostera/atxf reconcile studio.atxf.jsonl laptop.atxf.jsonl > merged.atxf.jsonl
```

Agents: `pi`, `claude-code`, `codex`, `opencode`, `gemini-cli`. Converting a session to another agent's format and
back gives the same session; converting a native file to ATXF and back gives the same bytes.

## Library

```ts
import { readFileSync } from "node:fs";
import { buildContext, validateTranscript } from "@leostera/atxf";
import { pi } from "@leostera/atxf/pi";
import { codex } from "@leostera/atxf/codex";
import { reconcile } from "@leostera/atxf/reconcile";

const transcript = pi.toAtxf(readFileSync("session.jsonl", "utf8"));
const rollout = codex.fromAtxf(transcript); // Codex can continue it; reading it back gives `transcript`
const context = buildContext(transcript); // what the model sees at the active leaf
```

The JSON Schema is at `@leostera/atxf/schema.json`.

`@leostera/atxf/testing` holds fast-check generators, and `@leostera/atxf/laws` the laws every converter must
satisfy, for testing a converter of your own. Both need `fast-check`; `laws` runs under `bun test`.

## License

MIT
