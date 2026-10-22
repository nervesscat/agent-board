#!/usr/bin/env bash
# Builds the Linux packages of the desktop app in a container and installs and checks each one in a
# container of its distribution (README: "Install"), from any machine with Docker, Windows included
# (Git Bash). It builds what is committed on the checkout's HEAD, never its working tree.
#
#   desktop/linux/docker-test.sh build      # node:24-bookworm: pnpm desktop:package, then the smoke
#                                           # test of the unpacked app under Xvfb
#   desktop/linux/docker-test.sh deb        # debian:bookworm   (install-test.sh)
#   desktop/linux/docker-test.sh rpm        # fedora:latest
#   desktop/linux/docker-test.sh pacman     # archlinux:latest
#   desktop/linux/docker-test.sh appimage   # debian:bookworm
#   desktop/linux/docker-test.sh all        # all of the above, in that order
#   desktop/linux/docker-test.sh copy <dir> # the four packages out to <dir>
#   desktop/linux/docker-test.sh clean      # removes the work volume
#
# The build and the packages live in a Docker volume (ab-linux-work), so no node_modules of the host
# is ever used in Linux. Containers run with seccomp unconfined so that Chromium's sandbox can make
# its user namespaces, as on a desktop; the app's sandbox stays on. Ports 9250 to 9295 inside them.
set -euo pipefail

# Git Bash would rewrite the container paths below as Windows paths.
export MSYS_NO_PATHCONV=1
repo=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
volume=ab-linux-work
dist=/work/repo/desktop/dist

container() {
  local name=$1
  shift
  docker run --rm --name "ab-linux-$name" --shm-size=1g --security-opt seccomp=unconfined \
    -v "$volume:/work" "$@"
}

build() {
  # HEAD as a bundle, which a worktree (whose .git is only a pointer) can be cloned from too.
  local bundle
  # Git and Docker on Windows take the folder as Windows names it.
  bundle=$(cd "$(mktemp -d)" && { pwd -W 2>/dev/null || pwd; })
  git -C "$repo" bundle create "$bundle/repo.bundle" HEAD
  # shellcheck disable=SC2016 # expanded in the container
  container build -v "$bundle:/src:ro" node:24-bookworm bash -euo pipefail -c '
    apt-get update -qq
    # Packaging (rpmbuild, bsdtar), a display, and what Electron itself needs to run here.
    apt-get install -y -qq git rpm libarchive-tools xvfb xauth file libgtk-3-0 libnss3 libgbm1       libasound2 libxss1 libxtst6 libnotify4 libsecret-1-0 >/dev/null
    git config --global --add safe.directory "*"
    rm -rf /work/repo
    git clone -q /src/repo.bundle /work/repo
    id builder >/dev/null 2>&1 || useradd -m builder
    chown -R builder /work/repo
    cp "$(command -v node)" /work/node
    runuser -u builder -- bash -euo pipefail -c "
      cd /work/repo
      mkdir -p ~/bin
      corepack enable --install-directory ~/bin
      export PATH=~/bin:\$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
      pnpm install --frozen-lockfile
      pnpm desktop:package
      file desktop/dist/linux-unpacked/resources/board/.output/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node
      xvfb-run -a pnpm desktop:smoke --port 9250
    "'
  rm -rf "$bundle"
}

# install <format> <image> <package glob in desktop/dist> <port>
install() {
  container "$1" -e REPO=/work/repo -e NODE=/work/node "$2" bash -c \
    "bash /work/repo/desktop/linux/install-test.sh $1 $dist/$3 $4"
}

case "${1:-}" in
  build) build ;;
  deb) install deb debian:bookworm 'agent-board_*_amd64.deb' 9260 ;;
  rpm) install rpm fedora:latest 'agent-board-*.x86_64.rpm' 9270 ;;
  pacman) install pacman archlinux:latest 'agent-board-*.pacman' 9280 ;;
  appimage) install appimage debian:bookworm 'agent-board-*-x86_64.AppImage' 9290 ;;
  all)
    # Through bash, so a checkout that lost the script's exec bit runs it all the same.
    for step in build deb rpm pacman appimage; do bash "$0" "$step"; done
    ;;
  copy)
    out=$(cd "${2:?a folder to copy the packages to}" && { pwd -W 2>/dev/null || pwd; })
    container copy -v "$out:/out" debian:bookworm bash -c \
      "cp $dist/*.AppImage $dist/*.deb $dist/*.rpm $dist/*.pacman /out/"
    ;;
  clean) docker volume rm "$volume" ;;
  *)
    sed -n '2,19p' "$0"
    exit 2
    ;;
esac
