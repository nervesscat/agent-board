# Faceted tension: release art

One abstract SVG piece per release, drawn by `generate.mjs` from the release's version and its
GitHub release notes. The direction is a field of hard-edged planes over a soft, grained field:
shards that look like they are holding something in, with refracted light on a few edges.

The artwork is generated, not drawn. A release nobody has seen yet gets its own piece by pointing
the script at its notes; the committed SVG is the build artifact, so the card never changes under
a release.

## What the seed drives

`themesOf(notes)` reads the release's bullet list and returns three 0..1 signals, so the notes
become composition rather than being transcribed into symbols:

| signal     | read from the notes                                                        | what it does in the drawing                                                |
| ---------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `density`  | how many changes the release has (log-scaled)                              | more planes, more cut directions, more field lines and grain, wider spread |
| `holding`  | the share of precision words (focus, safe area, sticky, cache, clock, cap) | fewer, larger planes; cuts in fewer directions; tighter, quieter seams     |
| `clearing` | the share of wayfinding words (move, split, menu, palette, remove, reorg)  | a straight-edged channel cut through the mass; more negative space         |

The version seeds a PRNG (`mulberry32` over an FNV-1a hash) that sets everything the notes do not:
the refraction angle, the plane count, the cluster's cropped shape, which cells are deep ink or
rust, which edges catch light, the field's line rhythm and the grain. The dark and light variants
share the exact same geometry and differ only in palette and in a few mode-specific weights (seam opacity, facet and band mixes).

Nothing in the output depends on the clock, the filesystem, randomness or a font, and all numbers
are rounded to fixed precision: the same version and notes give the same bytes. `--check` proves
it and is what a CI job can hold the committed files to.

## The drawing

1. A wash of paper (light) or ink (dark), with a ruled field and a stepped halftone in one corner:
   the soft, grainy field.
2. One irregular mass that is cropped by at least two frame edges, so it is structure seen through
   the frame rather than an object in it.
3. Straight cuts through the mass in the refraction angle's family, some square to it, some across
   the cell's long axis. Precision releases cut in fewer directions; busy ones splinter more.
4. One cleared channel for wayfinding releases, cut with two parallel lines and dropped, so the
   void has the same hard edges as the planes.
5. Flat fills per plane: quiet tint, mid tint, panel tint, deep ink, rust accent. A plane can carry
   a stepped facet band along one edge. No gradients, no filters, no blur, no blend modes.
6. Bands of refracted light across two to five planes: a flat, hard-edged strip of the paper colour
   mixed into that plane, with one hairline edge.
7. Two edges catch light: a pale stroke with a shadow line on one side and a thin rust line on the
   other, so the edge reads as light displaced by the mass rather than a glow.
8. Grain: a seeded tile of pixels over the whole frame, plus a dither tile.

Palette: paper/ink ground, one cool hue (steel), one warm hue (rust). Everything else is a mix of
those. Dark and light are different grounds of the same piece, not separate drawings.

## Commands

```sh
# regenerate every committed piece from its notes snapshot
node scripts/release-art/generate.mjs --all      # or: pnpm art:release

# fail if the committed SVGs drifted from what the generator makes
node scripts/release-art/generate.mjs --all --check

# one release, with its notes from GitHub
gh release view v0.2.5 --json body -q .body > scripts/release-art/releases/v0.2.5.md
node scripts/release-art/generate.mjs --version 0.2.5 --notes scripts/release-art/releases/v0.2.5.md
```

The script uses Node only: no dependencies, no build step. It writes to
`src/assets/release-art/faceted-tension/<version>-<mode>.svg` and refuses a file over 150 KB.

## The next release

1. Save its notes as `scripts/release-art/releases/v<version>.md` (the command above).
2. Run `node scripts/release-art/generate.mjs --version <version> --notes <the file>`.
3. Commit the two SVGs with the notes snapshot.

There is no per-release drawing step and nothing to hand place: the version changes the seed and
the notes change the three signals, so the piece is new but still from the same family.

## Wiring it into the update card

The card's top half takes the piece of the release it announces: import the SVG URL (Vite handles
it as an asset) and pick `-dark` or `-light` from the app's theme, or inline the SVG when it needs
to inherit theme colours. One row of the artifact per release, generated when the release is cut
and committed with it, keeps the asset stable between builds.
