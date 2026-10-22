#!/usr/bin/env bash
# Installs one Linux package of the desktop app in this throwaway container and checks it as a user
# would have it (README: "Install"). Run it as root, in a container, never on a machine you keep:
#
#   desktop/linux/install-test.sh deb|rpm|pacman|appimage <package file> <port>
#
# deb in Debian or Ubuntu, rpm in Fedora, pacman in Arch, the AppImage in any of them. It:
#   1. installs the package with the distribution's own manager (its dependencies from the repos), and
#      checks the launcher on PATH, the desktop entry (desktop-file-validate) and the hicolor icons;
#   2. runs `desktop/smoke.mjs` against the installed folder as a user, under Xvfb;
#   3. starts the installed app as a desktop launch does (no AGENT_BOARD_HOME, a bare PATH, the tools
#      folder only in ~/.bashrc) and checks the XDG folders, the server's PATH, the window's WM_CLASS
#      against the entry's StartupWMClass, and that SIGTERM (a logout) stops the server too;
#   4. uninstalls it, and checks that the user's settings and data are still there.
# The AppImage is extracted for the smoke test (a container has no FUSE), and also run as it is with
# APPIMAGE_EXTRACT_AND_RUN=1.
#
# REPO is a checkout with node_modules (pnpm install) for the smoke test, by default the one this
# script is in; NODE is the node that runs it (default: node on PATH). Ports <port> to <port>+5 are used.
set -euo pipefail

format=${1:?format: deb, rpm, pacman or appimage}
pkg=$(realpath "${2:?the package file}")
port=${3:?a port}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=${REPO:-$(cd "$here/../.." && pwd)}
node=${NODE:-$(command -v node)}
user=abtest
home=/home/$user
run_port=$((port + 5))
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
step() { printf '\n== %s\n' "$*"; }
as_user() { runuser -u "$user" -- env HOME="$home" USER="$user" LOGNAME="$user" "$@"; }

# shellcheck disable=SC1091 # the container's own
. /etc/os-release
step "tools for the checks ($ID)"
case "$ID" in
  debian | ubuntu)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq xvfb xauth x11-utils desktop-file-utils procps file >/dev/null
    ;;
  fedora)
    dnf install -y -q xorg-x11-server-Xvfb xorg-x11-xauth xwininfo desktop-file-utils procps-ng \
      file shadow-utils util-linux >/dev/null
    ;;
  arch)
    pacman -Syu --noconfirm --needed xorg-server-xvfb xorg-xauth xorg-xwininfo desktop-file-utils \
      procps-ng file >/dev/null
    ;;
  *)
    echo "no recipe for $ID" >&2
    exit 2
    ;;
esac
id "$user" >/dev/null 2>&1 || useradd -m -s /bin/bash "$user"

step "1. install $(basename "$pkg")"
case "$format" in
  deb)
    apt-get install -y "$pkg"
    files=$(dpkg -L agent-board)
    ;;
  rpm)
    dnf install -y "$pkg"
    files=$(rpm -ql agent-board)
    ;;
  pacman)
    pacman -U --noconfirm "$pkg"
    files=$(pacman -Qlq agent-board)
    ;;
  appimage)
    # What the AppImage does not carry and a desktop has: GTK 3, NSS, GBM, ALSA and the like.
    case "$ID" in
      debian | ubuntu)
        # ALSA's library is libasound2t64 since Ubuntu 24.04 and Debian 13 (the 64-bit time_t
        # transition), libasound2 before; whichever this release has.
        asound=libasound2t64
        apt-cache show "$asound" >/dev/null 2>&1 || asound=libasound2
        apt-get install -y -qq libgtk-3-0 libnss3 libgbm1 "$asound" libxss1 libxtst6 libnotify4           libsecret-1-0 >/dev/null
        ;;
      fedora) dnf install -y -q gtk3 nss mesa-libgbm alsa-lib libXScrnSaver libnotify >/dev/null ;;
      arch) pacman -S --noconfirm --needed gtk3 nss mesa alsa-lib libxss libnotify >/dev/null ;;
    esac
    install -m 0755 -o "$user" "$pkg" "$home/agent-board.AppImage"
    (cd "$home" && as_user ./agent-board.AppImage --appimage-extract >/dev/null)
    files=$(cd "$home/squashfs-root" && find . -type f -o -type l | sed 's|^\.|/|')
    ;;
  *)
    echo "unknown format $format" >&2
    exit 2
    ;;
esac

if [ "$format" = appimage ]; then
  dir=$home/squashfs-root
  entry=$dir/agent-board.desktop
  check "the AppImage holds the app ($dir/agent-board)" test -x "$dir/agent-board"
else
  check "a launcher on PATH ($(command -v agent-board || true))" command -v agent-board
  dir=$(dirname "$(readlink -f "$(command -v agent-board)")")
  entry=/usr/share/applications/agent-board.desktop
  check "the app is installed in $dir" test -x "$dir/agent-board"
  sizes=$(printf '%s\n' "$files" | sed -n 's|^/usr/share/icons/hicolor/\([0-9]*\)x[0-9]*/apps/agent-board\.png$|\1|p' |
    sort -n | tr '\n' ' ')
  check "hicolor icons from 16 to 256 px ($sizes)" bash -c "[[ ' $sizes' == *' 16 '* && ' $sizes' == *' 256 '* ]]"
fi
check "the desktop entry is there ($entry)" test -f "$entry"
check "the desktop entry validates" desktop-file-validate "$entry"
for key in 'Name=CrossBoard' 'Icon=agent-board' 'StartupWMClass=agent-board' 'Categories=Development;'; do
  check "the desktop entry says $key" grep -qx "$key" "$entry"
done
if [ "$format" != appimage ]; then
  exec_path=$(sed -n 's/^Exec=\([^ ]*\).*/\1/p' "$entry" | tr -d '"')
  check "its Exec starts the app ($exec_path)" test -x "$exec_path"
fi
check "the app is an x86-64 ELF" bash -c "file -L '$dir/agent-board' | grep -q 'ELF 64-bit.*x86-64'"
check "the packed better-sqlite3 is an x86-64 ELF" bash -c \
  "file '$dir/resources/board/.output/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node' | grep -q 'ELF 64-bit.*x86-64'"

step "2. the smoke test on $dir"
if as_user xvfb-run -a "$node" "$repo/desktop/smoke.mjs" --app "$dir" --port "$port"; then
  ok "the smoke test passes"
else
  bad "the smoke test"
fi

step "3. a launch from the desktop, on :$run_port"
mkdir -p "$home/tools"
printf '#!/bin/sh\necho stand-in gh\n' >"$home/tools/gh"
chmod 755 "$home/tools/gh"
# shellcheck disable=SC2016 # written for the user's shell to expand
printf '\nexport PATH="$HOME/tools:$PATH"\n' >>"$home/.bashrc"
chown -R "$user" "$home"
if [ "$format" = appimage ]; then launcher=$dir/agent-board; else launcher=$(command -v agent-board); fi
if as_user env -i HOME="$home" USER="$user" LOGNAME="$user" SHELL=/bin/bash PATH=/usr/bin:/bin \
  xvfb-run -a bash "$here/installed-run.sh" "$launcher" "$run_port" "$node"; then
  ok "the launch from the desktop"
else
  bad "the launch from the desktop"
fi

if [ "$format" = appimage ]; then
  step "the AppImage run as it is (APPIMAGE_EXTRACT_AND_RUN=1), on :$run_port"
  if as_user env APPIMAGE_EXTRACT_AND_RUN=1 PORT="$run_port" AGENT_BOARD_HOME="$home/appimage-home" \
    xvfb-run -a bash "$here/installed-run.sh" --health-only "$home/agent-board.AppImage" "$run_port" "$node"; then
    ok "the AppImage answers /api/health"
  else
    bad "the AppImage run as it is"
  fi
else
  step "4. uninstall"
  case "$format" in
    deb) apt-get remove -y agent-board ;;
    rpm) dnf remove -y agent-board ;;
    pacman) pacman -R --noconfirm agent-board ;;
  esac
  check "the app's folder is gone ($dir)" test ! -e "$dir"
  check "the launcher is gone" bash -c '! command -v agent-board'
  check "the desktop entry is gone" test ! -e "$entry"
  check "the settings are still there" test -f "$home/.config/agent-board/config.env"
  check "the data is still there" test -f "$home/.local/share/agent-board/data/board.db"
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "install test of $(basename "$pkg") FAILED ($failures)"
  exit 1
fi
echo "install test of $(basename "$pkg") passed"
