# Releasing

A release is a GitHub Release tagged `v<version>`, where `<version>` is the `version` of
`desktop/app/package.json`, holding the desktop app's installers. Each installer is attached twice: under its
versioned name and under a stable, versionless one, so the download links below always reach the newest
release.

## Download links

`https://github.com/nervesscat/agent-board/releases/latest` is the newest release's page. Each file of the
newest release, by its stable name:

| Platform       | File                    | Link                                                                                           |
| -------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| Windows (x64)  | installer               | https://github.com/nervesscat/agent-board/releases/latest/download/agent-board-setup-x64.exe   |
| Linux (x86_64) | AppImage                | https://github.com/nervesscat/agent-board/releases/latest/download/agent-board-x86_64.AppImage |
| Linux (x86_64) | Debian / Ubuntu package | https://github.com/nervesscat/agent-board/releases/latest/download/agent-board_amd64.deb       |
| Linux (x86_64) | Fedora / RHEL package   | https://github.com/nervesscat/agent-board/releases/latest/download/agent-board.x86_64.rpm      |
| Linux (x86_64) | Arch package            | https://github.com/nervesscat/agent-board/releases/latest/download/agent-board.pacman          |

These are the links for a landing page or a README badge: they do not change from one release to the next.
The versioned files of the same release are `agent-board-setup-<version>.exe`,
`agent-board-<version>-x86_64.AppImage`, `agent-board_<version>_amd64.deb`,
`agent-board-<version>.x86_64.rpm` and `agent-board-<version>.pacman`. `latest` is the newest release
that is not a draft or a pre-release, and a version with a suffix (`0.2.0-beta.1`) is published as a
pre-release by both the workflow and `pnpm release`, so `latest` stays on the newest stable one.

`pnpm desktop:package` builds the Windows installer on Windows and the four Linux packages on Linux
(README: "The desktop app"), and a release needs all five.

## Update metadata

Each release also carries the files the installed app's updater (electron-updater) reads:
`latest.yml` for Windows and `latest-linux.yml` for Linux. electron-builder writes them beside the
packages in `desktop/dist`; each names the version and the versioned files, every one with its sha512
(base64) and size. `latest-linux.yml` lists all four Linux packages, so each kind of install finds its
own by its extension (the AppImage, the `.deb`, the `.rpm`, the `.pacman`). The packed app has
`resources/app-update.yml`, which points it at this repo's GitHub Releases
(`provider: github`, `owner: nervesscat`, `repo: agent-board`); `pnpm desktop:package` fails without it,
or when the app's `electron-updater` is not inside `app.asar`.

`pnpm release` (and `--stage-only`, the workflow's step) checks the metadata before it stages anything:
for the version being released, listing each of the platform's versioned files and nothing else, with
the sha512 that file has. It then copies it to `desktop/dist/release` under its own name, and it is
uploaded with the packages to the same release. The app downloads an update only when the human presses
Download and install in Settings, Updates; the download is checked against the sha512 in the metadata,
and one that does not match is refused and nothing is installed (README: "Updating").

The updater follows `releases/latest` and so offers only stable releases; a pre-release (a version
with a suffix) is offered only to an app whose Updates section has **Include pre-releases** on.

## Release artwork

The card that greets the app at start shows a picture of the release above its notes. The board serves it
from `public/release-art/`, one file per theme:

- `public/release-art/<version>-light.svg`
- `public/release-art/<version>-dark.svg`

`<version>` is the release's version without the tag's `v` (`v0.3.0` → `0.3.0-light.svg`). The card
picks the file by the page's theme, and falls back to the light one on a dark page, so a release may
ship one variant only. Each is a 16:9 SVG (1600×900, say), drawn to sit edge to edge and purely
decorative: the card gives it an empty `alt`.

Artwork is optional and never required for a release. Put the files in `public/` before running
`pnpm desktop:package`, and they are packaged with the board's other public assets; a release without
them gets the card's placeholder header instead of a broken image.

**Trying an update before it is released.** Never publish a release to test one. Serve a folder with a
`latest-linux.yml` (or `latest.yml`) and the packages it names over HTTP, e.g. the `desktop/dist` of a
build with a higher version (`python3 -m http.server 8120 --bind 127.0.0.1 --directory desktop/dist`),
and start an installed app with `AGENT_BOARD_UPDATE_FEED=http://127.0.0.1:8120/` in its environment:
it then checks that folder instead of GitHub. `desktop/updates.test.mjs` does the same against a feed it
serves itself on `127.0.0.1`, for each kind of install, the refusal of a wrong sha512 among them.

**Checking the pacman install by hand.** The suite stands in at the package manager and the relaunch;
the real `pacman -U` is checked here, on a machine where replacing the installed app is fine (it installs
a real package, with a polkit prompt):

1. In a worktree, set a version higher than the installed one in `desktop/app/package.json` and run
   `pnpm desktop:package`. Serve what it built to the app:
   `python3 -m http.server 8120 --bind 127.0.0.1 --directory desktop/dist`.
2. Start the installed app with `AGENT_BOARD_UPDATE_FEED=http://127.0.0.1:8120/` in its environment.
3. Settings, Updates: **Check now** finds the higher version; **Download and install** asks polkit for
   authorization. The board's server stops before pacman runs, the app goes away for a moment, and the
   new version comes back by itself with its window open.
4. `curl -s http://127.0.0.1:<PORT>/api/health` answers `{"ok":true}` (`<PORT>` is the board's, 47100
   by default), and Settings, Updates shows the new installed version. One board server runs, not the
   old one beside it.
5. If the app does not come back, `~/.local/share/agent-board/data/logs/board.err.log` has an error line
   naming the binary to start by hand (`/opt/CrossBoard/agent-board`); running it brings the new version
   up, and the old board is not left on the port.

## 1. Prepare

1. Set the new version in `desktop/app/package.json` (`0.2.0`, say) and merge it like any other change.
2. Check out the commit to release, clean, with every check passing (CONTRIBUTING.md).

## 2a. With GitHub Actions: push the tag

```
git tag v0.2.0
git push origin v0.2.0
```

`.github/workflows/release.yml` runs on the tag (or by hand, Actions, Release, Run workflow, which
releases `v<version>` at the commit it runs on):

- **Windows installer** (`windows-latest`): `pnpm install --frozen-lockfile`, `pnpm release --stage-only`
  (that is `pnpm desktop:package`, then the copies under both names in `desktop/dist/release`, with
  `latest.yml`), a smoke test of the unpacked app.
- **Linux packages** (`ubuntu-24.04`): the same on Linux (with `latest-linux.yml`), with the packaging tools CI's `desktop-linux`
  job installs (`rpm`, `libarchive-tools`, Xvfb and Electron's libraries), and the smoke test under
  `xvfb-run`.
- **Publish the GitHub Release**: only when both builds succeeded, so a release never goes out with a
  platform missing. It creates the release for the tag (or adds to it) with the run's own
  `GITHUB_TOKEN` (`contents: write` on this job alone) and uploads every file. No other secret is used.

A tag that is not `v<version of desktop/app/package.json>` fails the publish job.

## 2b. Without GitHub Actions: `pnpm release`

`scripts/release.mjs` does the same from a checkout, on the platform it runs on. `gh` must be signed in
(`gh auth login`) with write access to the repo, and the commit must be on origin.

```
pnpm release --dry-run   # the tag, the files under both names and the gh commands; changes nothing
pnpm release             # pnpm desktop:package, copies to desktop/dist/release, creates or adds to the release
```

1. On Windows, `pnpm release`: builds the installer and creates the release `v<version>` at the
   checked-out commit with `agent-board-setup-<version>.exe` and `agent-board-setup-x64.exe`
   (`gh release create v<version> … --target <commit> --generate-notes`).
2. On Linux (a Linux machine, or WSL with the Electron and packaging dependencies the release workflow
   installs: `rpm`, `libarchive-tools` and Electron's libraries), from the same commit,
   `pnpm release`: builds the Linux packages and adds them to the same release
   (`gh release upload v<version> … --clobber`).

Each run uploads its platform's update metadata too (`latest.yml`, `latest-linux.yml`).

Either platform can go first: the first run creates the release, the next adds to it, and a run again
replaces its own files (`--clobber`). Until the second platform's run, the release has only the first
platform's files, and its stable links for the other platform answer 404.

The script refuses a working tree with uncommitted changes, a commit that is not on origin, and a tag
already on origin at another commit (`--force` uploads anyway); an annotated tag counts at the commit it
points to. It also refuses when it cannot ask origin for the tag (`git ls-remote origin` fails), with or
without `--force`. `src/routeTree.gen.ts`, which the build
regenerates, is not one of those changes: the script puts it back before that check and after its own
build, so a run again or `--skip-build` after a build is not refused. `--skip-build` uses the installers already
in `desktop/dist`; `--stage-only` builds and copies and publishes nothing (the workflow's step).

## After a release

- Check the release page and each link in the table above.
- An installed app of the previous version offers the new one in Settings, Updates, after Check now.
- The installers are not code-signed: Windows SmartScreen asks once (More info, Run anyway). With a
  signed installer, electron-updater would also check that an update is signed by the same publisher
  (`publisherName`), on top of the sha512.
