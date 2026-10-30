#!/usr/bin/env bash
# Runs the TypeScript and Rust CLIs on the same inputs and fails on any difference in output or exit code.
# usage: scripts/cross-check.sh [native files as <agent>:<path>...]
set -uo pipefail
cd "$(dirname "$0")/.."

cargo build --quiet --release --manifest-path packages/atxf-rs/Cargo.toml || exit 1
ts=(bun packages/atxf-ts/src/cli.ts)
rs=(packages/atxf-rs/target/release/atxf)
agents=(pi claude-code codex opencode gemini-cli)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0
checks=0

# Compares one command. Validation messages from the JSON Schema are worded by each validator, so `validate`
# compares exit codes and the lines that are not schema errors.
compare() {
  local label=$1
  shift
  "${ts[@]}" "$@" >"$work/ts.out" 2>"$work/ts.err"
  local ts_code=$?
  "${rs[@]}" "$@" >"$work/rs.out" 2>"$work/rs.err"
  local rs_code=$?
  if [[ $1 == validate ]]; then
    for side in ts rs; do grep -v ': error: schema: ' "$work/$side.out" >"$work/$side.cmp" || true; done
  else
    cp "$work/ts.out" "$work/ts.cmp"
    cp "$work/rs.out" "$work/rs.cmp"
  fi
  checks=$((checks + 1))
  if [[ $ts_code != "$rs_code" ]] || ! cmp -s "$work/ts.cmp" "$work/rs.cmp"; then
    failures=$((failures + 1))
    echo "DIFF $label (exit ts=$ts_code rs=$rs_code)"
    diff <(head -c 4000 "$work/ts.cmp") <(head -c 4000 "$work/rs.cmp") | head -20
    head -5 "$work/ts.err" "$work/rs.err"
  fi
}

inputs=(
  "claude-code:fixtures/claude-code/harbor-hello.jsonl"
  "codex:fixtures/codex/rollout-hand-built.jsonl"
  "gemini-cli:fixtures/gemini-cli/session-hand-built.jsonl"
  "opencode:fixtures/opencode/export-hand-built.json"
)
for example in examples/*.atxf.jsonl; do inputs+=("atxf:$example"); done
inputs+=("$@")

for input in "${inputs[@]}"; do
  from=${input%%:*}
  file=${input#*:}
  for to in atxf "${agents[@]}"; do
    for carry in "" --no-carry; do
      [[ $to == atxf && -n $carry ]] && continue
      compare "$from→$to $carry $file" convert --from "$from" --to "$to" $carry "$file"
      # Back again, through the other side's output, so decode sees encoded output too.
      if [[ $to != atxf && $to != "$from" ]]; then
        "${ts[@]}" convert --from "$from" --to "$to" $carry "$file" >"$work/mid.$to" 2>/dev/null &&
          compare "$from→$to→atxf $carry $file" convert --from "$to" --to atxf "$work/mid.$to"
      fi
    done
  done
  if [[ $from == atxf ]]; then
    compare "validate $file" validate "$file"
  else
    "${ts[@]}" convert --from "$from" --to atxf "$file" >"$work/as.atxf.jsonl"
    compare "validate $from→atxf $file" validate "$work/as.atxf.jsonl"
  fi
done

compare "reconcile examples" reconcile examples/minimal.atxf.jsonl examples/minimal.atxf.jsonl
compare "reconcile sealed" reconcile examples/sealed.atxf.jsonl examples/sealed.atxf.jsonl

echo "$checks checks, $failures differences"
[[ $failures == 0 ]]
