#!/usr/bin/env bash
# Test double for `snip36 prove virtual-os`. Behaviour from the environment:
#   FAKE_MODE  ok (default) | fail | hang | nooutput | leftover | partial
#                fail      exit 3 with an error message
#                hang      never ends, a fake runner listens on --port
#                nooutput  exit 0 without writing the output files
#                leftover  like ok, but a fake runner is left running after the exit
#                partial   like ok, but a line of stdout comes in two pieces
#   FAKE_SLEEP seconds before finishing (default 0.2)
#   FAKE_TRACE file receiving "start <ms> port=<p>", "env …" and "end <ms>" lines
#   FAKE_TRACE_ARGS when set, an "args …" line is traced too
#   FAKE_LEAK  when set, the fail message repeats this value
set -u
all="$*"
out="" port="" tx=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --tx-json) tx="$2"; shift 2 ;;
    *) shift ;;
  esac
done
trace() { [[ -n "${FAKE_TRACE:-}" ]] && echo "$*" >> "$FAKE_TRACE"; return 0; }
trace "start $(date +%s%3N) port=$port"
trace "env chain=${STARKNET_CHAIN_ID:-} account=${STARKNET_ACCOUNT_ADDRESS:-} project=${SNIP36_PROJECT_DIR:-} txmode=$(stat -c %a "$tx") cwd=$PWD"
[[ -n "${FAKE_TRACE_ARGS:-}" ]] && trace "args $all"
echo "Running virtual OS..."
echo "progress: step 1/2" >&2
case "${FAKE_MODE:-ok}" in
  fail)
    echo "Error: Transaction execution failed: Vote is not open${FAKE_LEAK:+ ($FAKE_LEAK)}" >&2
    trace "end $(date +%s%3N)"
    exit 3 ;;
  hang)
    node -e 'require("net").createServer().listen(Number(process.argv[1]), "127.0.0.1")' "$port" fake-runner &
    sleep 3600 ;;
  leftover)
    node -e 'require("net").createServer().listen(Number(process.argv[1]), "127.0.0.1")' "$port" fake-runner & ;;
  nooutput)
    trace "end $(date +%s%3N)"
    exit 0 ;;
  partial)
    printf 'abc'; sleep 0.2; printf 'def\r\nlast' ;;
esac
sleep "${FAKE_SLEEP:-0.2}"
base="${out%.proof}"
printf 'FAKEPROOF' > "$base.proof"
printf '["0x1","0x2"]' > "$base.proof_facts"
printf '{"l2_to_l1_messages":[{"from_address":"0xa","to_address":"0xb","payload":["0x1"]}]}' > "$base.raw_messages.json"
trace "end $(date +%s%3N)"
exit 0
