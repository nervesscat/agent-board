# Retro CRT

A piece is a contour field drawn the way a vector display draws: one continuous trace at a time, a
crisp core with a halo around it, a faint trail where the beam has just been. It is seen through a
green-phosphor monitor, so the screen adds what a monitor adds — scanlines at a fixed pitch, a slow
roll of refresh, bloom, grain, a glass vignette, and one blanked interval where the raster loses the
picture. The terrain is the approved register: an implied ground seen from above, iso-lines at an
interval the release's notes choose, three trace weights, one deliberate interruption. What this lane
adds is the age of the machine showing it.

Each release gets its own piece from its own notes and version. The six SVGs beside this file are
0.2.2, 0.2.3 and 0.2.4, dark and light; `manifest.json` records what each one was made from.
`scripts/release-art/retro-crt.mjs` makes them.

## The palette, exact

The lane's four hexes, and nothing else — no fifth colour, no black, no white, no tint that is not one
of these at some opacity:

| role        | hex       | dark variant                           | light variant                          |
| ----------- | --------- | -------------------------------------- | -------------------------------------- |
| `ground`    | `#0B1A12` | the field the phosphor sits on         | the ink of every trace                 |
| `phosphor`  | `#7CFFA8` | the beam: medium and light traces      | the glow: bloom, trail and burn-in     |
| `highlight` | `#E8FFE9` | the hottest trace, and the glass sheen | the field: the screen printed positive |
| `shadow`    | `#04100A` | scanlines and the glass vignette       | scanlines and the glass vignette       |

Dark is the monitor as it is: a dark green field, a mint beam, the brightest traces almost white.
Light is the same screen printed as a positive: the highlight becomes the paper, the ground becomes
the ink, and the phosphor survives as the green underglow, multiplied into the paper so it sits like
ink rather than light. The palette table in `manifest.json` is the same four values; only the roles
swap, which is why the pair reads as one object in two exposures rather than as two designs.

## From a release's notes to a screen

The notes are read, not illustrated. Three themes are counted as keyword stems against the number of
bullets (saturating, so a long release cannot run away with the score), and the bullet count gives a
density. Those four numbers and the version then set the field and the monitor's condition:

| signal in the notes                                                                    | measure      | what it does to the piece                                                                                                |
| -------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| many hands: agent, shared, tickets, lanes, delegation, reviews, orchestration          | `hands`      | number of summits (4–16); more summits, smaller and overlapping — an archipelago rather than one crest                   |
| the length of the release                                                              | `density`    | contour interval, dropouts and the heavy trace's share: a busy release gets closer contours and more of them bitten away |
| precision: focus rings, cache, safe area, sticky header, clock, websocket, cap         | `precision`  | one long ridge through the middle; the steadiest beam (least jitter); the narrowest blanked interval; the tightest bloom |
| wayfinding: move, split, remove, menu, palette, rename, resume, settings, find, window | `wayfinding` | a wide blanked interval to see through, more jitter, and a softer beam                                                   |
| the version                                                                            | seed         | summit positions, aspect, rotation, warp phases, the blanking's y and wobble, the grain's turbulence seed                |

Nothing else is random at render time. The seed is the FNV-1a hash of `retro-crt/<version>`, so the
same version and notes write the same bytes on every run; the test regenerates the committed pieces
and compares them byte for byte. The contour interval is recorded in the manifest as
`field.interval` (`0.9 / (levels - 1)`, in the normalised height the terrain is sampled at): 0.050
for 0.2.2, 0.053 for 0.2.3, 0.082 for 0.2.4.

## The three pieces

| release | what the notes asked for                                                                                        | field and screen                                                                                                                                 | what it reads as                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 0.2.2   | agents, shared tickets, lanes, reviews, project agents — 160 bullets                                            | 16 summits, 19 intervals (0.050), no ridge, 67 px blanking, 48 dropouts, the most jitter (3.06)                                                  | a crowded screen: many small measured peaks, several of them blooming, one band where the beam blanks                         |
| 0.2.3   | focus rings, phone safe area, websocket proxy, CI cache, stall clock, sticky header — 16 bullets                | 8 summits over one long ridge, 18 intervals (0.053, the tightest), the steadiest beam (1.35), the narrowest blanking (30 px), the tightest bloom | a held ridge under even pressure: rings packed close, the glow concentrated where they crowd, and a single thin blanking scar |
| 0.2.4   | split Instructions, Daily into the menu, command palette, preview in a window, Resume card removed — 14 bullets | 11 summits, 12 intervals (0.082, the widest), one cleared interval (89 px), the most wander (2.53)                                               | open ground with a way through it: contours stop at the blanking and resume beyond it, and the eye crosses on the gap         |

The three are one family because they share the field, the four hexes, the trace weights, the
scanlines, the grain and the 1600×900 frame; they differ in the terrain, the interval and how well the
beam holds.

## Why this works above a changelog

- **One trace, one weight scale.** Contours are drawn at 1.9 px (the hot trace: `highlight` on dark,
  `ground` on light), 1.25 px and 0.82 px, at 0.95, 0.8 and 0.52 opacity. Every fifth level is hot,
  so the hierarchy is regular enough to read as a measurement and irregular enough not to look like a
  chart. No fill, no gradient behind the lines, no focal object — a heading over the piece has nothing
  to fight.
- **Bloom with a source.** The halo is a copy of the hot trace alone, blurred by `feGaussianBlur`
  (5.0–10.0 px, set by precision), with a tighter unfiltered 5.5 px halo under it. It is not a blur on
  the artwork: the medium and light traces stay crisp, so the bloom reads as the screen's, not as a
  filter that was put on the drawing.
- **Persistence and the blanking.** A copy of the hot and medium traces is displaced 7–10 px along the
  sweep, blurred 2.2 px and dropped to 0.15 opacity — the previous frame still fading. One horizontal
  interval is blanked: the trace stops there, and the lines bend into the gap before they go, because
  the beam is pulled as it loses the line. On 0.2.2 it is 67 px tall, on 0.2.4 89 px, on 0.2.3 30 px.
- **Age that stays out of the type.** Scanlines are a 1 px `shadow` line every 6 px at 0.34 opacity
  (0.10 on light); the vignette is a radial `shadow` wash that only reaches 0.55 at the corners (0.13
  on light) and starts at 58% of the frame (66% on light), so it is a glass edge and not a frame; the grain is `feTurbulence` at 0.9 base frequency, `screen` at 0.12 on dark and
  `multiply` at 0.09 on light. All of them are low-frequency or low-contrast enough that the card's
  text, above and below, never sits on a busy edge.
- **Cheap and static.** 17–36 KB per piece, no external assets, no scripts, no text; the SVG is a
  single file with four filters and two gradients. The test holds it under 150 KB, at 16:9 and
  palette-closed.

## Where this treatment is worst

**0.2.4.** It is the release with the least to say — fourteen bullets, and the notes are almost all
wayfinding words — so the mapping sends it to the two ends of the range at once: the widest contour
interval (12 levels, 0.082) and the widest blanked interval (89 px). At full size that still composes:
a ring cluster in the top left, the gap, and long open ground below. At the card's size it is the
thinnest of the three, and the strong trace covers 1.88% of the frame against 3.27% on 0.2.3, dropping
to 1.38% at a third scale (the other two lose a quarter to a third of theirs too, but from more).

The honest list of what I would tune first: bring the interval to about 14 levels, cap the blanking
near 60 px so the gap stays a way through and not a seam, and let one more summit through the top
right so the field above the gap is not carried by a single cluster.

0.2.3 is the best-looking piece of the three — the tight ridge and the bloom around its crowded rings
is the most striking image this treatment makes. That is also its risk: the concentric, glowing rings
are the closest the direction comes to a neon contour poster, which is the edge of the "no radar"
rule. It stays on the right side because the trace is a plotted line with weight and dropouts, not an
emission ring, but it is the piece I would look at hardest before shipping.

## At one third scale

At 1600×900 the card is sharp; at 533×300 (one third) the six pieces were rendered into a canvas and
measured, not eyeballed. Deviations are from each piece's own median luminance:

| piece       | ink, full | ink, ⅓       | strong trace, full | strong trace, ⅓ | column-edge energy, full → ⅓ |
| ----------- | --------- | ------------ | ------------------ | --------------- | ---------------------------- |
| 0.2.2 dark  | 29.0%     | 30.4% (+1.4) | 3.63%              | 2.49% (−31%)    | 5.86 → 6.70                  |
| 0.2.3 dark  | 32.9%     | 33.8% (+0.8) | 3.27%              | 2.68% (−18%)    | 5.26 → 6.12                  |
| 0.2.4 dark  | 22.2%     | 23.1% (+0.9) | 1.88%              | 1.38% (−27%)    | 4.24 → 4.76                  |
| 0.2.2 light | 30.7%     | 34.3% (+3.6) | 5.03%              | 3.83% (−24%)    | 6.84 → 7.70                  |
| 0.2.3 light | 29.7%     | 32.0% (+2.3) | 4.17%              | 3.48% (−17%)    | 5.94 → 6.77                  |
| 0.2.4 light | 27.6%     | 28.8% (+1.2) | 2.54%              | 2.01% (−21%)    | 4.68 → 5.15                  |

The reading: **total ink holds** (1–4 points either way) and **edge energy per pixel goes up**, because antialiasing spreads each line over more pixels at the smaller size. What is lost is the
core of the brightest traces — about a fifth to a third of their area — which is why the piece leans on
the halo and the burn-in at small sizes. Those are area effects and they are scale-invariant: a 6–10 px
bloom is still 2–3 px at a third, and the vignette, the burn-in and the blanking all keep their
relative size exactly.

The individual artifacts, in the order they survive:

1. **Bloom and burn-in** — survive intact. This is what makes the piece read as a screen at 1/3, and
   why the hot trace can lose a third of its area without the drawing thinning.
2. **Vignette and blanking** — survive intact; they are the composition's large shapes.
3. **The hot trace (1.9 px)** — 0.63 px at 1/3: still a solid hairline, and the piece's structure.
4. **The medium trace (1.25 px)** — 0.42 px: a fine line, still present where the bloom backs it.
5. **Scanlines** — the pitch is 6 px, so at 1/3 it lands on 2 px: still a texture, and the 1 px dark
   line becomes a sub-pixel darkening. No moiré on a 1×, 2× or 3× display because the pitch divides by
   whole pixels down to 1.
6. **Grain** — averages into a slight tint. First artifact to go, and it carries no meaning.
7. **Jitter and the light trace (0.82 px)** — degrade to a tooth and a veil rather than to a wobble and
   a line. Nothing structural depends on either: every level has a heavier sibling, and the terrain
   is carried by the hot and medium traces.

So nothing is lost that the composition needs; what is lost is the finest grain of the degradation,
which is the correct thing for a card to drop. 533 px is the floor I would defend. Below that the
light trace and 0.2.3's 30 px blanking go first, and 0.2.4 is already the thinnest of the three.

## The next release

```
gh release view vX.Y.Z --json body --jq .body > scripts/release-art/notes/vX.Y.Z.md
node scripts/release-art/retro-crt.mjs
```

That writes `vX.Y.Z-dark.svg`, `vX.Y.Z-light.svg` and updates `manifest.json`, for a release nobody
has drawn. The generator takes no dependencies, makes both variants from the same terrain, and is
covered by `scripts/release-art/retro-crt.test.mjs`: same bytes twice, committed files match a fresh
run, 16:9 and under 150 KB, palette-closed to the four hexes, a release about moving things gets a
wider blanking and a less steady beam than one about precision, an unseen release gets its own piece
without a manifest, and the three releases differ.

When the direction is wired into the update card, read `manifest.json` rather than a filename: it maps
each version to its two files, its seed, the theme scores, the field parameters and the screen's
condition.

## What was tried and rejected

- **A blur over the whole artwork.** One filter on the root group gave the piece a soft, distant look
  and took the grain, the scanlines and the card's edges with it. The bloom is a copy of the hot trace
  instead, so the screen can be soft where the beam is bright and crisp where it is not.
- **A vertical blanking bar.** It looked like a scrollbar or a cursor, and it is not what a raster does
  (the retrace is horizontal). The deliberate interruption is a horizontal blanked interval, with the
  contours bent into it.
- **A drawn monitor frame.** A bezel or rounded mask makes the piece a screenshot of a device and
  breaks the card's edge-to-edge cover. The "glass" is the vignette alone: a radial `shadow` wash, no
  drawn edge.
- **The light variant as the same greens on a lighter ground.** `#7CFFA8` on a pale field lost almost
  all contrast, and the piece read as a washed-out dark one. Inverting the roles — highlight as paper,
  ground as ink, phosphor as a multiplied glow — keeps the palette identical and makes the pair read
  as two exposures of one screen.
- **Heavier scanlines.** At 0.5 opacity the panel read as a terminal emulator, which the lane forbids.
  At 0.34 on dark and 0.10 on light, with a 6 px pitch, it is a texture at full size and a tint at
  card size, and it never becomes a screenshot.
