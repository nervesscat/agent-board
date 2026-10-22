#!/usr/bin/env bash
# Run by install-test.sh as its test user, under Xvfb, with the bare environment of a launch from the
# desktop: starts the installed app with no AGENT_BOARD_HOME (PORT only, to stay off 47100) and checks
# where it keeps its files, the PATH its server got from the login shell, the window's WM_CLASS against
# the desktop entry, and that SIGTERM, as a logout sends, stops the app and its server.
#
#   installed-run.sh [--health-only] <launcher> <port> <node>
set -uo pipefail

health_only=0
if [ "${1:-}" = --health-only ]; then
  health_only=1
  shift
fi
launcher=${1:?the launcher}
port=${2:?a port}
node=${3:?node}
failures=0

ok() { printf 'ok   %s\n' "$*"; }
bad() {
  printf 'FAIL %s\n' "$*"
  failures=$((failures + 1))
}
check() {
  local what=$1
  shift
  if "$@"; then ok "$what"; else bad "$what"; fi
}
# shellcheck disable=SC2016 # JavaScript, not shell
answers() {
  "$node" -e '
    const [port, ms] = process.argv.slice(1).map(Number)
    const until = Date.now() + ms
    const up = async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok } catch { return false }
    }
    ;(async () => {
      do { if (await up()) process.exit(0); await new Promise((r) => setTimeout(r, 500)) } while (Date.now() < until)
      process.exit(1)
    })()' "$port" "$1"
}
mine() { pgrep -u "$(id -u)" "$@"; }

PORT=$port "$launcher" >"$HOME/app-$port.log" 2>&1 &
app=$!
check "/api/health answers on :$port" answers 90000

if [ "$health_only" = 1 ]; then
  kill -KILL "$app" 2>/dev/null
  pkill -KILL -u "$(id -u)" -x agent-board || true
  wait "$app" 2>/dev/null
  [ "$failures" -eq 0 ]
  exit
fi

config=$HOME/.config/agent-board
data=$HOME/.local/share/agent-board
check "config.env is in $config" test -f "$config/config.env"
check "the window's profile is in $config/electron" test -d "$config/electron"
check "the database is in $data/data" test -f "$data/data/board.db"
check "the logs are in $data/data/logs" test -f "$data/data/logs/board.out.log"
check "nothing is written to the old layout ($data/config.env)" test ! -e "$data/config.env"

server=$(mine -f 'resources/board/.output/server/index.mjs' | head -n 1)
check "the board's server runs (${server:-none})" test -n "$server"
server_path=$(tr '\0' '\n' <"/proc/${server:-0}/environ" 2>/dev/null | sed -n 's/^PATH=//p')
check "its PATH has $HOME/tools from ~/.bashrc ($server_path)" \
  bash -c "[[ ':$server_path:' == *':$HOME/tools:'* ]]"
check "gh on that PATH is the one in $HOME/tools" \
  bash -c "[ \"\$(PATH='$server_path' command -v gh)\" = '$HOME/tools/gh' ]"

wm=''
for _ in $(seq 1 60); do
  wm=$(xwininfo -root -tree | grep -E '"CrossBoard": \(' | head -n 1)
  [ -n "$wm" ] && break
  sleep 0.5
done
check "the window's WM_CLASS is agent-board, as the entry's StartupWMClass ($wm)" \
  bash -c "printf '%s' '$wm' | grep -qE '\\(\"[^\"]*\" \"agent-board\"\\)'"

kill -TERM "$app"
(
  sleep 20
  kill -KILL "$app" 2>/dev/null && echo 'still running 20 s after SIGTERM: killed'
) &
watchdog=$!
wait "$app"
code=$?
kill "$watchdog" 2>/dev/null
check "SIGTERM ends the app (exit $code)" test "$code" -ne 137
sleep 1
# The pattern in brackets, so that it does not match this check's own command line.
check "and its server ($(mine -f 'server/index[.]mjs' | tr '\n' ' '))" \
  bash -c "! pgrep -u $(id -u) -f 'server/index[.]mjs' >/dev/null"
check "the port :$port is free" bash -c "! (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null"
pkill -KILL -u "$(id -u)" -x agent-board || true

[ "$failures" -eq 0 ]
