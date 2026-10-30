# atxf

The Rust implementation of [ATXF](https://atxf.leostera.dev), the Agent Transcript Exchange Format: coding-agent
sessions as a JSONL tree of records. It mirrors [`@leostera/atxf`](../atxf-ts) and writes the same bytes and hashes.

- `atxf::transcript`: read and write `.atxf.jsonl`.
- `atxf::validate`: the JSON Schema and the cross-record rules of the spec.
- `atxf::tree`, `atxf::context`: the active path and the context a model sees.
- `atxf::integrity`: Merkle hashes, seals and inclusion proofs.
- `atxf::formats`: lossless converters for Pi, Claude Code, Codex, OpenCode and Gemini CLI.
- `atxf::reconcile`: merge diverged copies of one session.

```rust
use atxf::{formats, Converter};

let transcript = formats::PI.to_atxf(&std::fs::read_to_string("session.jsonl")?, true)?;
let rollout = formats::CODEX.from_atxf(&transcript, true)?; // Codex can continue it; reading it back gives `transcript`
```

The `atxf` binary has the same commands as the TypeScript CLI:

```sh
atxf validate session.atxf.jsonl
atxf convert --from pi --to codex session.jsonl > rollout.jsonl
atxf reconcile studio.atxf.jsonl laptop.atxf.jsonl > merged.atxf.jsonl
```

## Parity with TypeScript

`scripts/cross-check.sh` and `scripts/cross-check-generated.ts` at the repository root run both implementations on
fixtures, examples and generated transcripts. They fail on any difference in output. JSON follows JavaScript semantics
where it shows: key order, number printing, UTF-16 string ordering and `Date.parse`. Schema validation messages are
worded by each validator; which transcripts pass is the same.

## License

MIT
