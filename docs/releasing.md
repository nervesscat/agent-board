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
  (that is `pnpm desktop:package`, then the copies under both names in `desktop/dist/release`), a smoke
  test of the unpacked app.
- **Linux packages** (`ubuntu-24.04`): the same on Linux, with the packaging tools CI's `desktop-linux`
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
- The installers are not code-signed: Windows SmartScreen asks once (More info, Run anyway).
