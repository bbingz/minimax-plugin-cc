#!/bin/bash
set -u
OUT_DIR=/tmp/mm-p5
rm -rf "$OUT_DIR"; mkdir -p "$OUT_DIR"

SCENARIOS=("401:invalid_key" "model:invalid_model" "cwd:bad_cwd" "term:sigterm_midway")
LOCALES=(en_US.UTF-8 zh_CN.UTF-8 C POSIX)
MOCK_HOME=/tmp/mm-p5-mock-home
MOCK_CWD=/tmp/mm-p5-mock-cwd

for SCEN in "${SCENARIOS[@]}"; do
  KIND="${SCEN%%:*}"; TAG="${SCEN#*:}"
  for LOC in "${LOCALES[@]}"; do
    FILE="$OUT_DIR/${TAG}_${LOC}.out"
    echo "=== scenario=$KIND locale=$LOC ===" > "$FILE"
    case "$KIND" in
      401)
        LC_ALL=$LOC mini-agent -t "hi" -w /tmp >> "$FILE" 2>&1
        echo "exit=$?" >> "$FILE"
        ;;
      model)
        LC_ALL=$LOC HOME=$MOCK_HOME mini-agent -t "hi" -w "$MOCK_CWD" >> "$FILE" 2>&1
        echo "exit=$?" >> "$FILE"
        ;;
      cwd)
        LC_ALL=$LOC mini-agent -t "hi" -w /definitely/does/not/exist >> "$FILE" 2>&1
        echo "exit=$?" >> "$FILE"
        ;;
      term)
        (LC_ALL=$LOC mini-agent -t "Count slowly from 1 to 200" -w /tmp >> "$FILE" 2>&1) &
        PID=$!; sleep 3; kill -TERM $PID 2>/dev/null; wait $PID 2>/dev/null
        echo "exit=$?" >> "$FILE"
        ;;
    esac
  done
done

echo ""
echo "# Sentinel audit per sample"
for f in "$OUT_DIR"/*.out; do
  STRIPPED=$(sed 's/\x1b\[[0-9;]*m//g' "$f")
  L1=$(echo "$STRIPPED" | grep -c "Please configure a valid API Key" || true)
  L1b=$(echo "$STRIPPED" | grep -c "Configuration file not found" || true)
  L1c=$(echo "$STRIPPED" | grep -c "ImportError: Using SOCKS proxy" || true)
  L3A=$(echo "$STRIPPED" | grep -c "Retry failed" || true)
  L3B=$(echo "$STRIPPED" | grep -cE "Session Statistics:" || true)
  LOG=$(echo "$STRIPPED" | grep -c "Log file:" || true)
  EXIT=$(grep -E "^exit=" "$f" | tail -1 | awk -F= '{print $2}')
  echo "$(basename $f) exit=$EXIT L1_auth=$L1 L1_cfgmiss=$L1b L1_socks=$L1c L3_retry=$L3A L3_stats=$L3B log_line=$LOG"
done
