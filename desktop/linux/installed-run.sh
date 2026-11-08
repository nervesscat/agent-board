#!/usr/bin/env bash
# Run by install-test.sh as its test user, under Xvfb, with the bare environment of a launch from the
# desktop: starts the installed app with no AGENT_BOARD_HOME (PORT only, to stay off 47100) and checks
# where it keeps its files, the PATH its server got from the login shell, the window's WM_CLASS against
# the desktop entry, and that SIGTERM, as a logout sends, stops the app and its server. The app's update
# check asks a feed served here on 127.0.0.1 (AGENT_BOARD_UPDATE_FEED, as desktop/smoke.mjs does), never
# GitHub's releases: its only release is 0.0.0, older than any build, so it offers nothing.
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

# The feed: latest.yml and latest-linux.yml (electron-updater adds ?noCache=…), each request a line in
# $asked; it writes its port to $feed_port once it listens.
feed_port=$HOME/feed-$port.port asked=$HOME/feed-$port.asked
rm -f "$feed_port" "$asked"
# shellcheck disable=SC2016 # JavaScript, not shell
"$node" -e '
  const fs = require("node:fs")
  const [portFile, asked] = process.argv.slice(1)
  const yml = "version: 0.0.0\nfiles:\n  - url: agent-board-0.0.0.none\n    sha512: none\n    size: 0\n" +
    "path: agent-board-0.0.0.none\nsha512: none\nreleaseDate: \"2026-01-01T00:00:00.000Z\"\n"
  const server = require("node:http").createServer((req, res) => {
    fs.appendFileSync(asked, `${req.url}\n`)
    if (/^\/latest(-linux)?\.yml(\?|$)/.test(req.url)) res.writeHead(200).end(yml)
    else res.writeHead(404).end()
  })
  server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(server.address().port)))
' "$feed_port" "$asked" &
feed=$!
trap 'kill "$feed" 2>/dev/null' EXIT
for _ in $(seq 1 50); do [ -s "$feed_port" ] && break; sleep 0.1; done
check "the update feed listens on 127.0.0.1:$(cat "$feed_port" 2>/dev/null)" test -s "$feed_port"

PORT=$port AGENT_BOARD_UPDATE_FEED=http://127.0.0.1:$(cat "$feed_port" 2>/dev/null)/ \
  "$launcher" >"$HOME/app-$port.log" 2>&1 &
app=$!
check "/api/health answers on :$port" answers 90000
# What the start-up check asked, if this copy checks at all (an unpacked one cannot update itself).
for _ in $(seq 1 20); do [ -s "$asked" ] && break; sleep 0.5; done
if [ -s "$asked" ]; then
  echo "note: the update check asked the local feed for $(head -n 1 "$asked")"
else
  echo "note: no update check in 10 s (a copy that cannot update itself, or its check off)"
fi

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

# The window, found by its title and not its class, so that the WM_CLASS check below can fail: titled
# CrossBoard as it opens, then by its page ("Set up · CrossBoard" on this fresh home). xwininfo prints a
# title it cannot show in its locale as "(failure in conversion from UTF8_STRING to ...)", and this
# launch's bare environment has no LANG, so it runs in C.UTF-8 (built into glibc since 2.35, in Debian,
# Ubuntu, Fedora and Arch alike). It waits for the page's title, so that the check runs on the window
# as the user gets it: up to 60 s after /api/health answered (twice the 30 s it had before, for CI's
# 4-vCPU runner, where the window and its page come up slower than on a desktop), and over as soon as
# the title shows. A window that never gets past "CrossBoard" is still checked, with a note.
wm='' page=''
for _ in $(seq 1 120); do
  windows=$(LC_ALL=C.UTF-8 xwininfo -root -tree 2>/dev/null)
  page=$(printf '%s\n' "$windows" | LC_ALL=C grep -E ' · CrossBoard": \(' | head -n 1)
  [ -z "$wm" ] && wm=$(printf '%s\n' "$windows" | LC_ALL=C grep -E '"CrossBoard": \(' | head -n 1)
  [ -n "$page" ] && break
  sleep 0.5
done
if [ -n "$page" ]; then wm=$page; else echo "note: the window's title never went past CrossBoard in 60 s"; fi
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
