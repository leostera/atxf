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
  "opencode:fixtures/opencode/export-2.0.20.json"
  "pi:fixtures/pi/session-every-field.jsonl"
)
for example in examples/*.atxf.jsonl; do inputs+=("atxf:$example"); done
inputs+=("$@")

for input in "${inputs[@]}"; do
  from=${input%%:*}
  file=${input#*:}
  for to in atxf "${agents[@]}"; do
    for carry in "" --no-carry "--no-carry --tree"; do
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

# Streams saved after line k and resumed, by either implementation from either's state, return what one stream
# over the whole file returns; and both write the same state. Every cut for short files, a few for long ones.
stream_check() {
  local file=$1 n cuts k flags
  n=$(awk 'END { print NR }' "$file")
  if ((n <= 40)); then cuts=$(seq 0 "$n"); else cuts=$(for i in 0 1 2 3 4 5 6 7 8; do echo $((n * i / 8)); done | sort -un); fi
  for flags in "" --no-integrity; do
    "${ts[@]}" stream --from pi $flags "$file" >"$work/whole" 2>/dev/null
    compare "stream $flags $file" stream --from pi $flags "$file"
    for k in $cuts; do
      "${ts[@]}" stream --from pi $flags --lines "1:$k" --state "$work/ts.state" "$file" >"$work/ts.head" 2>/dev/null
      "${rs[@]}" stream --from pi $flags --lines "1:$k" --state "$work/rs.state" "$file" >"$work/rs.head" 2>/dev/null
      checks=$((checks + 2))
      if ! cmp -s "$work/ts.state" "$work/rs.state" || ! cmp -s "$work/ts.head" "$work/rs.head"; then
        failures=$((failures + 1))
        echo "DIFF stream state after line $k $flags $file"
      fi
      for side in ts rs; do
        local other=rs
        [[ $side == rs ]] && other=ts
        if [[ $side == ts ]]; then cmd=("${ts[@]}"); else cmd=("${rs[@]}"); fi
        "${cmd[@]}" stream --from pi --lines "$((k + 1)):$n" --resume "$work/$other.state" "$file" >"$work/tail" 2>/dev/null
        checks=$((checks + 1))
        if ! cmp -s <(sed '$d' "$work/ts.head"; cat "$work/tail") "$work/whole"; then
          failures=$((failures + 1))
          echo "DIFF stream resumed by $side from $other after line $k $flags $file"
        fi
      done
    done
  done
}
for input in "${inputs[@]}"; do
  [[ ${input%%:*} == pi ]] && stream_check "${input#*:}"
done

compare "reconcile examples" reconcile examples/minimal.atxf.jsonl examples/minimal.atxf.jsonl
compare "reconcile sealed" reconcile examples/sealed.atxf.jsonl examples/sealed.atxf.jsonl

echo "$checks checks, $failures differences"
[[ $failures == 0 ]]
