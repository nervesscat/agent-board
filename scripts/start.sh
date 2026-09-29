#!/usr/bin/env bash
# Start the board: rebuild if the sources are newer than the build, stop a board already listening
# on the port, start it in the background and wait until it answers.
#
#   scripts/start.sh            # build if stale, (re)start in the background
#   scripts/start.sh --build    # always rebuild first
#   scripts/start.sh --fg       # run in the foreground (Ctrl+C stops it)
#   scripts/start.sh --stop     # just stop it
#
# Logs: data/logs/board.out.log and data/logs/board.err.log
set -euo pipefail

cd "$(dirname "$0")/.."

force_build=0 foreground=0 stop_only=0
for arg in "$@"; do
  case "$arg" in
    --build) force_build=1 ;;
    --fg) foreground=1 ;;
    --stop) stop_only=1 ;;
    -h | --help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

port=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)
port=${port:-47100}
host=$(grep -E '^HOST=' .env 2>/dev/null | cut -d= -f2 || true)
host=${host:-127.0.0.1}
logs=data/logs
mkdir -p "$logs"

board_pids() {
  ss -ltnpH "sport = :$port" 2>/dev/null | { grep -o 'pid=[0-9]*' || true; } | cut -d= -f2 | sort -u
}

stop_board() {
  local pids
  pids=$(board_pids)
  [ -z "$pids" ] && return 0
  echo "Stopping the board on :$port (pid $(echo $pids))"
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 50); do
    [ -z "$(board_pids)" ] && return 0
    sleep 0.1
  done
  kill -9 $(board_pids) 2>/dev/null || true
}

if [ "$stop_only" = 1 ]; then
  stop_board
  exit 0
fi

[ -d node_modules ] || npm install

build=.output/server/index.mjs
if [ "$force_build" = 1 ] || [ ! -f "$build" ] ||
  [ -n "$(find src package.json package-lock.json vite.config.ts -newer "$build" -print -quit)" ]; then
  echo "Building..."
  npm run build > "$logs/build.log" 2>&1 || { echo "Build failed, see $logs/build.log" >&2; exit 1; }
fi

stop_board

if [ "$foreground" = 1 ]; then
  exec npm start
fi

echo "Starting the board on http://localhost:$port"
nohup npm start >> "$logs/board.out.log" 2>> "$logs/board.err.log" &

for _ in $(seq 1 100); do
  if curl -s -o /dev/null "http://$host:$port/"; then
    echo "Up (pid $(echo $(board_pids))). Logs in $logs/board.*.log"
    exit 0
  fi
  sleep 0.2
done
echo "The board did not answer within 20s, see $logs/board.err.log" >&2
exit 1
