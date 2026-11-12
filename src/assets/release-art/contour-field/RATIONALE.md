# Contour field

A piece is an implied terrain seen from straight above: iso-lines at a fixed interval, a hand's
wobble in every one, two tonal bands laid along measured lines, and grain that nicks the lines. It is
a plotted field that was drawn by a person afterwards. No labels, no frame, no axis, no scale, no
north — nothing that would make it a map instead of a measurement.

Each release gets its own piece from its own notes and version. The six SVGs beside this file are the
series for 0.2.2, 0.2.3 and 0.2.4, light and dark; `manifest.json` records what each one was made
from. `scripts/release-art/contour-field.mjs` makes them.

## From a release's notes to a field

The notes are read, not illustrated. Three themes are counted (`hands`, `precision`, `wayfinding`,
each keyword stem counted against the number of bullets, saturating so a long release cannot run
away with the score), and the count of bullets gives a density. Those four numbers, plus the version's
seed, then set the terrain:

| signal in the notes                                                        | measure      | what it does to the drawing                                                                                           |
| -------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------- |
| many hands: agent, shared, tickets, lanes, delegation, reviews             | `hands`      | number of summits (4–16); more summits, smaller and more overlapping — an archipelago rather than one crest           |
| the length of the release                                                  | `density`    | contour interval and the number of nicks: a busy release gets more levels packed closer, and more of them bitten away |
| precision: focus rings, cache, safe area, sticky header, clock, retry, cap | `precision`  | one long ridge through the middle; the least wobble; the fewest cuts                                                  |
| wayfinding: move, split, remove, menu, palette, rename, resume, settings   | `wayfinding` | a wide cleared corridor across the field, plus the most wobble and the most interruptions                             |
| the version                                                                | seed         | peak positions, aspect, rotation, warp phases, the grain's turbulence seed                                            |

Nothing else is random at render time. The seed is the FNV-1a hash of `contour-field/<version>`, so
the same version and notes write the same bytes on every machine and every run.

## The three pieces

| release | what the notes asked for                                                             | what the field did                                                                                        | what it reads as                                                                                            |
| ------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 0.2.2   | agents, shared tickets, lanes, reviews — 160 bullets                                 | 16 summits, 18 intervals, no ridge, no corridor, the most nicks                                           | a crowded archipelago: many small measured peaks, several of them honoured with a rust band                 |
| 0.2.3   | focus rings, cache, phone safe area, proxy, sticky header — 16 bullets               | 10 summits plus one long crest, 19 intervals (the tightest), 1.46 wobble (the stillest hand), no corridor | a held ridge under even pressure; the lines stay parallel and close, and the ground is quiet                |
| 0.2.4   | split Instructions, move Daily, remove the Resume card, command palette — 14 bullets | 11 summits, 12 intervals (the widest spacing), 1.9 wobble, one cleared corridor                           | open ground with a way through it: whole contour lines stop at the corridor and start again on its far side |

The three are one family because they share the paper, the ink, the rust, the hand, the grain and the
1600×900 frame; they differ in the terrain and in what interrupts it.

## Why this works above a changelog

- **Paper and ink, one accent.** Warm paper `#f3f0e8` with `#1c1b18` lines (light) or near-black
  `#15161a` with bone `#ded9cc` lines (dark). Rust `#a2563a` / `#c9714b` appears once per piece: a
  12 px band along one measured contour, at 16% on paper and 10% on ink. The other band is a 34 px
  ink wash along a lower contour, blurred so it reads as a shadowed slope and not as a fat stroke.
  There is no gradient anywhere; the only softness is that wash and the grain.
- **Three line weights.** Contours are drawn at 0.9, 1.32 and 1.9 px with opacity to match (0.48,
  0.62, 0.82), and every fifth level is dug a little deeper. The piece has a subject and depth without
  a focal object in the middle of the frame, so a heading over it has nothing to fight.
- **Misregistration.** Five to eight lines are printed twice, the second pass a hair off its bed
  (`translate(2.6 -1.8)`, rust at 24%). It is the one clearly handmade gesture that is not a line:
  the piece reads as printed matter rather than as a vector illustration.
- **Grain that does real work.** A seeded `feTurbulence` overlay (0.16 multiply on paper, 0.14 screen
  on ink) is the paper's tooth, and 30–50 seeded nicks eat short bites out of the contours so the
  lines are not perfectly continuous. The field is interrupted in its geometry, not just washed with
  noise.
- **Cheap and static.** 9–15 KB per piece, no external assets, no filters that depend on the theme.
  At 1600×900 a piece covers the card's top half with `object-fit: cover`; the type below never sits
  on it.

## What was tried and rejected

- **Filled elevation bands between integer levels.** Topographically correct, but on gentle ground the
  band became a wide blob and read as a stain, and on steep ground as a sticker. Replaced by bands
  laid along chosen measured lines: constant width, always coherent with the terrain.
- **A single dominant peak.** The most obvious way to make a contour piece, and the fastest route to a
  mountain silhouette with a logo's symmetry. The summits are deliberately off-centre, stretched,
  partly outside the frame, and carried by fractal relief so no line closes into a clean circle at the
  middle of the piece.

## Where this direction is worst

**0.2.2.** It is the busy release, and the theme mapping sends it to the ceilings: 16 summits, 18
intervals, the most nicks. At card size the many small rings collapse into a fine pattern, and the
strongest reading becomes "contour map" rather than "many hands working together". The idea is
carried by count alone — there is no single gesture that says collaboration, which is exactly why it
is the piece I would re-tune first if this direction wins: fewer summits (around 11), and let the
corridor appear so the composition has a way through it.

0.2.3 and 0.2.4 are handled well: the ridge gives the quiet release a spine, and the corridor gives
the reorganising release an obvious shape without illustrating a menu or an arrow. 0.2.4 is the
thinnest piece of the three — the fewest contours and the widest spacing — so below roughly 600 px of
card width it leans on the corridor and its single rust band to stay a composition rather than a
nearly empty sheet; that is the second thing I would tune.

## The next release

```
gh release view vX.Y.Z --json body --jq .body > scripts/release-art/notes/vX.Y.Z.md
node scripts/release-art/contour-field.mjs
```

That writes `vX.Y.Z-light.svg`, `vX.Y.Z-dark.svg` and updates `manifest.json`, for a release nobody
has drawn. The generator takes no dependencies, makes both variants from the same terrain, and is
covered by `scripts/release-art/contour-field.test.mjs` (same bytes twice, committed files match a
fresh run, 16:9 and under 150 KB, a synthesised unseen release gets its own piece, the three releases
differ).

When the direction is wired into the update card, read `manifest.json` rather than a filename: it maps
each version to its two files, its seed, the theme scores and the field parameters that produced it.
