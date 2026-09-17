#!/bin/bash
# Runs every EC2 live check against one live, one after another (read-only).
#   TONIGHT=557246 ./ec2-live-suite.sh [out_dir]
# Earlier lives for the batch test: LIVES='{"556923":"15-09-2026"}' (default below).
set -u
cd "$(dirname "$0")"
: "${TONIGHT:?TONIGHT=<live_id> is required}"
OUT="${1:-live-suite-$TONIGHT-$(date +%H%M)}"
mkdir -p "$OUT"
export TONIGHT
export LIVES="${LIVES:-{\"556923\":\"15-09-2026\",\"556369\":\"11-09-2026\"}}"
tests=(ec2-live-features-test.js ec2-live-goods-test.js ec2-live-e2e.js ec2-live-truth-test.js ec2-live-winfix-test.js ec2-live-batch-test.js ec2-live-composer-test.js ec2-live-cache-test.js ec2-live-measure-api.js ec2-live-tally-test.js)
printf '%-32s %-6s %s\n' test result "PASS/FAIL lines" > "$OUT/summary.txt"
for t in "${tests[@]}"; do
  start=$(date +%s)
  SHOT_DIR="$OUT" node "$t" > "$OUT/${t%.js}.log" 2>&1
  code=$?
  p=$(grep -c ' PASS ' "$OUT/${t%.js}.log"); f=$(grep -c ' FAIL \|^FAILED' "$OUT/${t%.js}.log")
  printf '%-32s %-6s %s pass / %s fail · exit %s · %ss\n' "$t" "$([ $code = 0 ] && echo ok || echo FAIL)" "$p" "$f" "$code" "$(( $(date +%s) - start ))" | tee -a "$OUT/summary.txt"
done
rm -rf chrome-profile2 chrome-profile-truth chrome-profile-features chrome-profile-* 2>/dev/null
rm -f redesign-*.png row.png batch-tip-*.png batch-rows-*.png batch-picker.png composer-*.png 2>/dev/null
echo "done → $OUT/summary.txt"
