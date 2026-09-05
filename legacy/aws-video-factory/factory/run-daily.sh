#!/bin/bash
# Prime Speaks — Daily Market Update Runner
# Checks if today is a trading day (not a weekend or NSE holiday) before running.

LOG="${LOG_FILE:-/tmp/prime-speaks.log}"
echo "$(date '+%Y-%m-%d %H:%M:%S') — Checking if today is a trading day..." >> "$LOG"

# Skip weekends (handled by cron, but double check)
DOW=$(date +%u)  # 1=Mon, 7=Sun
if [ "$DOW" -gt 5 ]; then
  echo "$(date '+%Y-%m-%d') — Weekend, skipping." >> "$LOG"
  exit 0
fi

# NSE holidays — update annually. Add NSE_HOLIDAYS_<YEAR> for each new year.
# Source: https://www.nseindia.com/resources/exchange-communication-holidays
NSE_HOLIDAYS_2026="
2026-01-26
2026-02-17
2026-03-10
2026-03-14
2026-03-31
2026-04-01
2026-04-04
2026-04-14
2026-04-18
2026-05-01
2026-05-12
2026-06-26
2026-07-07
2026-08-15
2026-08-26
2026-10-02
2026-10-20
2026-10-21
2026-10-23
2026-11-04
2026-11-25
2026-12-25
"

TODAY=$(date +%Y-%m-%d)
CURRENT_YEAR=$(date +%Y)
HOLIDAY_VAR="NSE_HOLIDAYS_$CURRENT_YEAR"
HOLIDAYS="${!HOLIDAY_VAR}"

# Fail loudly if no holiday list exists for the current year — better to error
# than to run on every NSE holiday because the variable silently expanded to "".
if [ -z "$HOLIDAYS" ]; then
  echo "$(date '+%Y-%m-%d') — ERROR: $HOLIDAY_VAR not defined in run-daily.sh. Refusing to run without a current-year holiday list. Update the script." >> "$LOG"
  exit 1
fi

if echo "$HOLIDAYS" | grep -q "$TODAY"; then
  echo "$(date '+%Y-%m-%d') — NSE holiday, skipping." >> "$LOG"
  exit 0
fi

echo "$(date '+%Y-%m-%d') — Trading day confirmed. Running pipeline..." >> "$LOG"

VIDEO_DIR="${VIDEO_DIR:-/Volumes/wininstall/trading-dashboard/video}"
NPX_BIN="${NPX_BIN:-/usr/local/bin/npx}"
cd "$VIDEO_DIR" || { echo "$(date '+%Y-%m-%d %H:%M:%S') — ERROR: cannot cd to $VIDEO_DIR" >> "$LOG"; exit 1; }
"$NPX_BIN" tsx factory/pipeline.ts >> "$LOG" 2>&1

echo "$(date '+%Y-%m-%d %H:%M:%S') — Pipeline finished." >> "$LOG"
