# Contour field on tape

A piece is the approved contour-field direction, recorded and played back on analog tape: an
implied terrain seen from above, iso-lines at an interval the release's notes pick, three line
weights, and one deliberate interruption. The recording is what this direction adds — a one to
three pixel chroma split, a soft bloom under the crisp lines, two to four tracking bands that pull
part of the field sideways, dropouts where the signal went, a slow wobble along the y-axis, and
grain. No gradient, no glow, no frame, no axis, no label: every mark is a line, a cut, or noise.

The six SVGs beside this file are the series for 0.2.2, 0.2.3 and 0.2.4, light and dark.
`manifest.json` records what each one was made from. `scripts/release-art/retro-vhs.mjs` makes them
and `scripts/release-art/retro-vhs.test.mjs` holds them to it.

## The palette, exactly

Four hexes, and nothing else in any file:

| name        | hex       | light variant | dark variant | role                                             |
| ----------- | --------- | ------------- | ------------ | ------------------------------------------------ |
| tape black  | `#101014` | ink           | ground       | the lines on paper, the tape's field in the dark |
| signal      | `#E6E1D6` | ground        | ink          | the paper, the signal in the dark                |
| chroma red  | `#FF4D6D` | chroma        | chroma       | the red pass, offset one way                     |
| chroma cyan | `#4DE1FF` | chroma        | chroma       | the cyan pass, offset the other way              |

Only ground and ink swap between the variants. The chroma belongs to the tape, so it does not change
with the theme. No true black or white is used at all: the highlight rolloff is the ink or the signal
at five to six percent behind a wide blur, which keeps the piece inside the four hexes and also keeps
it from ever blowing out. The test reads every hex out of every committed piece and fails on one that
is not in the table.

## From the notes to the field

The notes are read, not illustrated. Each release body is dropped into `scripts/release-art/notes/`
as GitHub writes it. Four signals are counted — many hands, precision, wayfinding, and length — and
they set the terrain; the version's seed sets everything else.

| signal in the notes                                                        | measure      | what it does to the drawing                                                         |
| -------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------- |
| many hands: agent, shared, tickets, lanes, delegation, reviews             | `hands`      | number of summits (4–16); more summits, smaller and more overlapping                |
| the length of the release                                                  | `density`    | contour interval, the nicks, and how much signal the tape loses                     |
| precision: focus rings, cache, safe area, sticky header, clock, retry, cap | `precision`  | one long ridge through the middle, and the least drift and the fewest interruptions |
| wayfinding: move, split, remove, menu, palette, rename, resume, settings   | `wayfinding` | a wide cleared corridor, the most drift, and the most tracking bands                |
| the version                                                                | seed         | summits, aspect, rotation, warp phases, grain and tracking-noise seeds              |

The seed is the FNV-1a hash of `retro-vhs/<version>`, so the same version and notes write the same
bytes on every machine and every run.

## From the field to the recording

The tape's damage has its own mapping, kept separate from the terrain so that a release's _shape_
and its _recording_ can disagree — a busy release can be a clean recording, and the other way round.

| treatment         | how it is made                                                                                                                                                                                                                   | what drives it                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| chroma split      | red and cyan copies of the heavy and medium lines, each with a wider, fainter echo behind it, blurred 0.7 px and 1.8 px, at 30–34% and 12%                                                                                       | `hands`: every hand lays the line down a little apart (1.8–3 px) |
| bloom             | the whole field again, 0.7 px heavier, blurred 3 px, at 10–12% under the crisp lines                                                                                                                                             | fixed: tape's softness, not the theme                            |
| tracking bands    | two to four horizontal strips, each one or two broken segments 36–66% of the width, the field inside shifted 2–8 px sideways, its chroma at the lane's 3 px ceiling, anisotropic noise at 7–13%, a 1.2 px tear at the lower edge | `wayfinding`: a reorganising release is the one pulled sideways  |
| dropouts          | thin horizontal slots cut out of the line geometry (4–22 px wide, 0.8–1.7 px tall), plus streak-shaped gaps of bare ground painted over the lines                                                                                | `density`: a busy release loses more signal                      |
| wobble along y    | every line offset in y by long-wavelength noise, 0.8–3.4 px over the frame, and a little more along its length                                                                                                                   | `precision` reduces it, `wayfinding` increases it                |
| highlight rolloff | one wide blurred ellipse of ink behind the field where the contours are densest, at 5–6%, so the light is uneven without a gradient                                                                                              | the busiest contour level                                        |
| grain             | fractal `feTurbulence` at 1.15 base frequency, three octaves, 12% multiply on paper and 10% screen on ink                                                                                                                        | seeded per version                                               |

The lines are drawn at 2.35, 1.62 and 1.12 px with opacity 0.8, 0.58 and 0.4, and every fifth level is
dug a little deeper. They are deliberately heavier than a pencil contour would be, because the bloom
eats half a pixel off each side and because they have to hold when the piece is shown at a third of
its size.

## The three pieces

| release | what the notes asked for                                   | field                                        | tape                                                          | what it reads as                                                                                                                 |
| ------- | ---------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 0.2.2   | agents, shared tickets, lanes, reviews — 160 bullets       | 16 summits, 18 intervals, no corridor        | 2.8 px split, 3 bands shifting 4–5 px, 18 dropouts, drift 2.1 | a crowded archipelago, the busiest recording: colour on both shoulders of the dense lines, and the tape losing lines all over it |
| 0.2.3   | focus rings, cache, safe area, proxy, clock, sticky header | 10 summits plus one long ridge, 17 intervals | 2.3 px split, 2 bands shifting 2.5 px, 11 dropouts, drift 1.5 | a held ridge under even pressure: the steadiest piece, one or two clean slips across a quiet field                               |
| 0.2.4   | split Instructions, move Daily, command palette, no Resume | 11 summits, 13 intervals, one corridor       | 2.2 px split, 3 bands shifting 5–6 px, 13 dropouts, drift 2.6 | open ground with a way through it, the most pulled sideways: the bands and the corridor both run horizontally                    |

The three are one family because they share the paper, the signal, the two chroma passes, the
frame, the bloom, the grain and the 1600×900 canvas; they differ in the terrain and in how much of
the recording survived.

## Why this register fits an app card

- **Two hues and two grounds.** The piece is ink on its ground with a faint warm/cool fringe; it
  never has a colour field to fight a heading. The chroma is kept at 30–34% and blurred, so it reads
  as a fringe on a line and not as an accent area.
- **No gradient and no glow.** The only softness is the bloom, the rolloff and the grain, all of them
  derived from the four hexes. There is no `feGaussianBlur` on a bright colour, no additive glow, no
  scanline overlay stacked under the chroma split, and no VHS chrome — nothing in the frame is a
  tape, a play head or a timecode.
- **No focal object.** The contours cross the whole frame and the summits are off-centre and partly
  outside it, so a title above or a changelog below has nothing to compete with.
- **Quiet damage.** Every artifact is at or below a few pixels of the 1600-pixel canvas: the bands
  displace a strip by under 1% of the width, the chroma split is under 0.2%, the dropouts are thin,
  and the grain is at 10–12% opacity. The piece looks used, not broken.

## How the degradation survives at a third of its size

At 533 px wide — the card's top half on a laptop — everything measured in the 1600-pixel canvas
shrinks by three:

- **Survives as structure.** The tracking bands are 14–48 px tall, so 5–16 px at card size, and the
  2–6 px sideways shift becomes 0.7–2 px: the contours visibly break and resume, which is the
  piece's strongest card-size gesture. The corridor, the summits and the three line weights (0.78,
  0.54 and 0.37 px) all still separate. The bloom's 3 px blur becomes 1 px, which reads as a soft
  line rather than a hard vector.
- **Survives as colour.** The chroma split becomes 0.7–1 px, so the two passes merge into one warm
  or cool rim on the heavy lines. You stop counting the two channels and start reading "this was
  played back off something", which is the point. The 2.8 px split on 0.2.2 is the widest; it stays
  a rim and not an outline because the chroma never exceeds 34% and is never drawn without ink over
  it.
- **Survives as tone, not texture.** The grain's period falls below a device pixel at 1× and it
  flattens into the 10–12% lift it was adding. On a 2× screen it comes back as fine dust. This is the
  one element the treatment does not rely on at card size.
- **Goes first.** The smallest dropouts (4 px wide) and the 1 px tape hits become a lighter fleck;
  that is why the painted dropout streaks run 14–66 px wide and why the bands carry the damage
  instead of the flecks. The 1.2 px tear at a band's lower edge fades out entirely; the band is
  carried by its displacement, not its edge.

## Where this treatment is worst

**0.2.4.** It is the reorganising release, so it gets the widest cleared corridor, the most drift
(2.6 px) and three of the widest tracking bands — and the terrain that is left is the thinnest of
the three (13 intervals, 11 summits, one corridor). Both the shape's interruption and the tape's
run horizontally, so they stack rather than cross: at card size the bands can read as faint ruled
seams on open ground, and with the fewest lines there is the least for the chroma fringe to cling to.
The recording has less material to damage, so the piece reads as "a few lines that slipped" where
0.2.2 reads as "a recording that survived a crowd". It is still a composition, and it is the piece I
would tune first: let two or three contours run across the corridor instead of clearing it entirely,
or make the tracking bands slip vertically for this release, so the two interruptions cross and the
eye gets a corner instead of a seam. 0.2.3 is the next weakest claim, but for the opposite reason: it
is deliberately the calmest recording, and at card size it can pass for the plain contour field,
which is exactly what a direction that is inseparable from its degradation does not want.

## What was tried and rejected

- **A scanline pattern under the chroma split.** The fastest way to say "VHS", and the fastest way to
  make a card look cheap: it stacks a regular full-frame texture with the fringe and the two fight.
  The tracking bands do the same job locally, and they move the contour lines rather than tinting
  them.
- **A glowing chroma pass.** Drawing red and cyan at full opacity under a bright blur gave the neon
  poster the brief rules out. Keeping the passes at 30–34%, blurring them less than a pixel, and
  always drawing the ink line on top made the fringe read as a recording artifact.
- **A full-width band.** The first pass clipped the displaced field to a single rectangle per band.
  It read as a strip cut out with a knife, with visible vertical edges — a UI block, not a tape. The
  bands are now broken segments with ragged vertical ends and straight top and bottom edges, which is
  what a head losing its track actually leaves.
- **A white highlight.** A true white rolloff broke the palette and read as a light leak. The
  rolloff is the ink at 5–6% behind a 48 px blur.
- **A strong dropout.** Larger painted gaps turned the field into damaged stock footage. The painted
  ground streaks stay at half the count of the cut dropouts and are never wider than 66 px.

## The next release

```
gh release view vX.Y.Z --json body --jq .body > scripts/release-art/notes/vX.Y.Z.md
node scripts/release-art/retro-vhs.mjs
```

That writes `vX.Y.Z-light.svg`, `vX.Y.Z-dark.svg` and updates `manifest.json`, for a release nobody
has drawn. The generator takes no dependencies, makes both variants from the same terrain, and the
test covers: the same bytes twice, the committed files matching a fresh run, 16:9 and under 150 KB,
only the four hexes, chroma, bloom, bands and grain present in every piece, and a synthesised unseen
release getting its own piece.

When this direction is wired into the update card, read `manifest.json` rather than a filename: it
maps each version to its two files, its seed, the theme scores, the terrain and the tape settings
that produced it. The piece is 16:9 and edge to edge, so it goes into the card's top half with
`object-fit: cover`; the light and dark variants follow the card's theme, and the art never has to be
regenerated to match it.
