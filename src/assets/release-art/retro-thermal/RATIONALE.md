# Retro thermal

A piece is the approved contour field put through a heat press: an implied terrain seen from
straight above, iso-lines at an interval the notes choose, three line weights, one fold. What the
treatment adds is the print. The lines are raised bone on char, each carried by a blurred emboss
pair — a light pass off to the upper left, a dark pass off to the lower right — so the ink sits in a
pressed groove rather than on the surface. Where the field is densest it is stained with rust. The
bands between contours carry a dot-matrix stencil instead of ink. A soft bloom sits behind the
summits as if the plate were still warm. No labels, no frame, no north: nothing that would make it a
map instead of a print.

Each release gets its own piece from its own notes and version. The six SVGs beside this file are
the series for 0.2.2, 0.2.3 and 0.2.4, dark and light; `manifest.json` records what each one was
made from. `scripts/release-art/retro-thermal.mjs` makes them, with no dependencies.

## The palette, as exact hexes

| hex       | name      | where it is used                                                                            |
| --------- | --------- | ------------------------------------------------------------------------------------------- |
| `#201A17` | char      | the sheet in the dark variant; the ink in the light one                                     |
| `#D8C7A6` | bone      | the sheet in the light variant; the ink in the dark one; the bloom behind summits           |
| `#A34A2A` | rust      | the stain at the dense part of the field, the accent stencil, the misregistered heavy lines |
| `#120E0C` | shadow    | the dark half of the emboss pair and the fold's shading on paper                            |
| `#FFFFFF` | highlight | the lit half of the emboss pair, and nothing else                                           |
| `#000000` | black     | the dark half of the emboss pair on char, and nothing else                                  |

Nothing else is drawn with any other colour: the test reads every hex out of the six pieces and
fails on one outside this set. Black and white are not hues here — they are the light and the
shadow that make a pressed edge, which is why they are allowed where the palette would otherwise
have nothing hard enough.

## From a release's notes to a field

Three themes are counted (`hands`, `precision`, `wayfinding`, each keyword stem counted against the
number of bullets, saturating so a long release cannot run away with the score), and the count of
bullets gives a density. Those four numbers, plus the version's seed, set the terrain and the
pressure:

| signal in the notes                                                        | measure      | what it does to the print                                                                                    |
| -------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| many hands: agent, shared, tickets, lanes, delegation, reviews             | `hands`      | number of summits (4–16); more summits, smaller and more overlapping — an archipelago rather than one crest  |
| the length of the release                                                  | `density`    | contour levels (8–20, so the interval narrows), nicks in the lines, and the heat: more bloom, heavier stains |
| precision: focus rings, cache, safe area, sticky header, clock, retry, cap | `precision`  | one long ridge through the middle; the least wobble; many levels packed close                                |
| wayfinding: move, split, remove, menu, palette, rename, resume, settings   | `wayfinding` | a wide cleared corridor across the field instead of a fold, plus the most wobble                             |
| the version                                                                | seed         | peak positions, aspect, rotation, warp phases, the fold's angle and slip, the grain's turbulence seed        |

The deliberate interruption is one of two things, never both: a **corridor** when the release is
about moving things and dropping clutter, otherwise a **fold** — a straight crease where the
contours stop, the ground on each side of it slips a few pixels along the fold, and the emboss turns
into a hard lit edge. It is the one gesture that reads at any size, and it is what keeps the busy
releases from being an all-over texture.

Nothing else is random at render time. The seed is the FNV-1a hash of `retro-thermal/<version>`, so
the same version and notes write the same bytes on every run; the test regenerates the committed
pieces and compares them byte for byte.

## The three pieces

| release | what the notes asked for                                                             | what the field did                                                                        | what it reads as                                                                                                |
| ------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 0.2.2   | agents, shared tickets, lanes, reviews — 160 bullets                                 | 16 summits, 20 levels (interval 0.047), no ridge, no corridor, a fold, the heaviest stain | a crowded, hot archipelago: many small peaks, the dot screens and rust running through them, one fold across it |
| 0.2.3   | focus rings, cache, phone safe area, proxy, sticky header — 16 bullets               | 8 summits plus one long crest, 18 levels (the tightest), the stillest hand, a fold        | a held ridge under even pressure: the lines stay parallel and close, and the rust sits in one stained streak    |
| 0.2.4   | split Instructions, move Daily, remove the Resume card, command palette — 14 bullets | 10 summits, 12 levels (interval 0.082, the widest), the most wobble, a cleared corridor   | open ground with a way through it: whole contours stop at the corridor and start again on its far side          |

The three are one family because they share the sheet, the ink, the rust, the emboss, the dot
screens, the grain and the 1600×900 frame; they differ in the terrain, the interval, the heat and
what interrupts it.

## Why this works above a changelog

- **Two tones and one accent.** Char `#201A17` with bone `#D8C7A6` ink, or the reverse on paper.
  Rust `#A34A2A` appears three ways, all of them small: as a blurred stain where the field is
  densest, as a stencil band along the contour nearest the hottest summit, and as a misregistered
  pass under the heaviest lines. There is no gradient anywhere; the only softness is the bloom, the
  stain and the grain.
- **Three line weights, all heavier than a drawn field would use.** Contours are drawn at 1.7, 2.5
  and 3.7 px, and every fifth level is pressed deeper. That is deliberate: this piece has to hold
  its edges at a third of its size, where a 1 px line would disappear into the grain.
- **The emboss is the whole treatment, and it is cheap.** Each weight group's path data is written
  once and printed three times through `<use>`: a blurred shadow down-right, a blurred highlight
  up-left, then the crisp line. Nine print passes cost about as much as three, and a piece is 13–22
  KB.
- **Dot screens instead of fills.** Two contour lines carry a stencil of dots — a 20 px rust band
  near the hottest summit, fading at both ends, and a 30 px band lower down. On a steep slope the
  band follows the terrain, so it reads as tone where the ground crowds and nowhere else.
- **Misregistration, not a second colour.** The heaviest lines are struck twice, the rust plate
  1.8 px off its bed. It is one clearly handmade gesture that is not a contour, and it is why the
  piece reads as printed matter rather than as a vector illustration.
- **Nothing in the middle of the frame.** The summits are off-centre, stretched, partly outside the
  frame and carried by fractal relief, so no contour closes into a clean circle at the centre of the
  piece. A heading over it has nothing to fight.

## What was tried and rejected

- **A wide bright crease of lit paper.** The first fold was a 26 px soft shadow with a 5 px white
  edge on top; on bone it read as a strip of tape laid across the sheet. Replaced by a narrow
  cleared band, a slip of the ground on each side of it, and a 1.6 px lit edge: the geometry says
  "fold", the shading only supports it.
- **Rust as a circular stain in the middle of the field.** The obvious way to do "heat", and about
  three iterations away from a wax seal — which the brief forbids. The stains are elongated, off
  centre, never on the hottest summit itself, and always under the lines.
- **A single rust plate over every line.** Tempting and wrong: with rust under every heavy line the
  accent was everywhere, so it said nothing. It is now under the heavy lines only, and the accent
  that means "densest" is the stencil band and the stain.
- **Coarse paper blotches.** The first tooth layer (baseFrequency 0.038 at 0.12) made the char look
  like tanned hide, which is the one reading the brief rules out. Halved and finer: the sheet is
  matte ink now, with grain rather than leather.

## Where this treatment is worst

**0.2.2, plainly.** It is the busy release and the notes send it to every ceiling at once: 16
summits, 20 levels at the tightest interval, the most nicks, the broadest bloom and the heaviest
stain. The emboss halos are roughly 5 px wide, so in the dense parts they touch each other and the
gap between neighbouring contours fills with light instead of paper. At card size the many small
rings stop reading as _many summits_ and become one ribbed warm texture — the idea is carried by
count alone, and count is exactly what the treatment's noise budget cannot afford. The measured
loss says the same thing: at 1/3 the tone range falls 24% (dark) and 29% (light), against 7% and
12% for 0.2.4.

The fix is a ceiling rather than a new gesture: cap the levels around 16 and the bloom at 0.8 for
releases above ~0.9 density, and let the fold carry the composition instead of the crowd. 0.2.3 and
0.2.4 are handled well — the ridge gives the quiet release a spine and the corridor gives the
reorganising release an obvious way through — but 0.2.3 is the second-weakest, for the opposite
reason: with the tightest interval its halos almost meet, and its lines look slightly doubled on
paper even though they are the gentlest in the series.

## How the degradation survives at 1/3

The claim is checkable, so it is measured: each piece is rasterised at 1600×900 and at 533×300 and
the pixels compared (tone range = p95 − p05 of luminance; rust = share of pixels above 0.45
saturation; warm = share above 0.3).

| piece       | tone range 1/1 → 1/3 | kept | rust 1/1 → 1/3 | warm 1/1 → 1/3 |
| ----------- | -------------------- | ---- | -------------- | -------------- |
| 0.2.2 dark  | 0.486 → 0.368        | 76%  | 0.28% → 0.19%  | 4.6% → 4.7%    |
| 0.2.2 light | 0.486 → 0.346        | 71%  | 0.02% → 0%     | 1.2% → 1.2%    |
| 0.2.3 dark  | 0.362 → 0.300        | 83%  | 0.65% → 0.61%  | 11.6% → 11.8%  |
| 0.2.3 light | 0.375 → 0.283        | 75%  | 0.05% → 0%     | 3.9% → 4.0%    |
| 0.2.4 dark  | 0.196 → 0.183        | 93%  | 0.56% → 0.49%  | 6.5% → 6.7%    |
| 0.2.4 light | 0.194 → 0.171        | 88%  | 0.05% → 0%     | 2.7% → 2.6%    |

What that means in the artwork rather than in the table:

- **The dots go to tone, and tone is the point.** At 1/3 the 5.5 px stencil and the 6 px accent
  stencil are smaller than a screen pixel, so individual dots merge. That is the degradation
  working: the band stops being a texture and becomes a _density_, and the density is what was
  saying "steep here". The warm share barely moves because what a viewer reads as rust is the
  merged field, not the dots — the one thing that genuinely disappears is the crisp dot edge, down
  by a third in the dark variant and gone on paper.
- **The emboss survives as weight, not as a halo.** The blurred pair is 1.3–2.4 px at 1/1, so at 1/3
  it is sub-pixel — it cannot read as a separate highlight and shadow. It reads as a slightly warm
  line and a slightly dark one on either side of the ink, which is why the lines still look raised
  and why the highlight peak (p95) drops while the piece does not lose its structure.
- **The three weights survive as three.** 3.7, 2.5 and 1.7 px become 1.2, 0.8 and 0.6 px: the
  hierarchy is still there, and it is the hierarchy, not the hairline detail, that a viewer reads.
- **The composition is carried by the things that cannot blur away:** the line spacing (the
  interval the notes chose), the fold or corridor (a straight edge, the only hard geometry in the
  piece), and the stain (a soft patch, which is what a degraded stain becomes anyway). That is why
  0.2.4 keeps 93% of its tone range where 0.2.2 keeps 76%: the sparse field has nothing that _needs_
  the resolution the busy one loses.
- **Paper degrades differently from ink.** On bone the light line of the emboss bleaches a little and
  the grain all but vanishes, so the light pieces lose more of their degradation than the dark ones
  and rely on the char ink and the rust stain; they are the safer of the two to show small, and the
  less "thermal".

## The next release

```
gh release view vX.Y.Z --json body --jq .body > scripts/release-art/notes/vX.Y.Z.md
node scripts/release-art/retro-thermal.mjs
```

That writes `vX.Y.Z-light.svg`, `vX.Y.Z-dark.svg` and updates `manifest.json`, for a release nobody
has drawn. The generator takes no dependencies, makes both variants from the same terrain, and is
covered by `scripts/release-art/retro-thermal.test.mjs` (same bytes twice, the committed files match
a fresh run, 16:9 and under 150 KB, colours inside the palette, a synthesised unseen release gets
its own piece, the three releases differ).

When the direction is wired into the update card, read `manifest.json` rather than a filename: it
maps each version to its two files, its seed, the notes it was read from, the theme scores and the
field parameters that produced it. The card wants `object-fit: cover` on a 16:9 slot at the top and
the type on the solid ground below; `data-variant` on the root is there for a theme switch that
swaps the two files instead of recolouring one.
