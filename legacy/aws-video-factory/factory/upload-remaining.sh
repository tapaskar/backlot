#!/bin/bash
# Upload remaining earnings videos that hit YouTube quota
# Run daily until all are done

LOG="${LOG_FILE:-/tmp/prime-speaks-earnings.log}"
VIDEO_DIR="${VIDEO_DIR:-/Volumes/wininstall/trading-dashboard/video}"
QUEUE_FILE="${QUEUE_FILE:-$VIDEO_DIR/factory/.upload-queue.txt}"
NPX_BIN="${NPX_BIN:-/usr/local/bin/npx}"
MAX_PER_DAY="${MAX_PER_DAY:-12}"

if [ ! -f "$QUEUE_FILE" ]; then
  echo "No upload queue found."
  exit 0
fi

remaining=$(wc -l < "$QUEUE_FILE" | tr -d ' ')
if [ "$remaining" -eq 0 ]; then
  echo "Queue empty. All done."
  rm -f "$QUEUE_FILE"
  exit 0
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') — Processing $remaining queued earnings videos (max $MAX_PER_DAY/day)" >> "$LOG"

cd "$VIDEO_DIR"
attempted=0
uploaded=0
requeued=0
failed=0
temp_file=$(mktemp)

while IFS= read -r ticker; do
  if [ -z "$ticker" ]; then continue; fi
  attempted=$((attempted + 1))

  # Past the daily cap → re-queue without attempting upload
  if [ "$attempted" -gt "$MAX_PER_DAY" ]; then
    echo "$ticker" >> "$temp_file"
    continue
  fi

  echo "  [$attempted/$remaining] $ticker..." >> "$LOG"
  "$NPX_BIN" tsx factory/earnings-pipeline.ts "$ticker" >> "$LOG" 2>&1
  rc=$?

  case "$rc" in
    0)
      # Successful upload — drop from queue
      uploaded=$((uploaded + 1))
      ;;
    2)
      # Transient upload failure (YouTube quota / auth / network) — keep in queue for retry
      echo "$ticker" >> "$temp_file"
      requeued=$((requeued + 1))
      echo "  $ticker — UPLOAD FAILED (rc=2), re-queued for next run" >> "$LOG"
      ;;
    *)
      # Hard failure (data fetch, script generation, audio, etc.) — drop from queue
      # so we don't keep wasting compute on something that will keep failing
      failed=$((failed + 1))
      echo "  $ticker — HARD FAILURE (rc=$rc), dropped from queue" >> "$LOG"
      ;;
  esac
done < "$QUEUE_FILE"

# Update queue with whatever we re-queued + whatever we never attempted
mv "$temp_file" "$QUEUE_FILE"
new_remaining=$(wc -l < "$QUEUE_FILE" | tr -d ' ')
echo "$(date '+%Y-%m-%d %H:%M:%S') — Batch done. Attempted $attempted, uploaded $uploaded, re-queued $requeued, hard-failed $failed, remaining $new_remaining" >> "$LOG"

if [ "$new_remaining" -eq 0 ]; then
  rm -f "$QUEUE_FILE"
  echo "All earnings videos uploaded!" >> "$LOG"
fi
