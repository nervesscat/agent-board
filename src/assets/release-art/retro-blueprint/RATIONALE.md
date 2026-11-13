# Retro blueprint

A contour field printed as a cyanotype contact print. The field is the one the direction already
settled: an implied terrain seen from above, seeded summits, iso-lines at an interval the release's
notes choose, three line weights and one deliberate interruption. What the print changes is the
surface: the lines are exposed white out of a prussian ground, a blurred mid-wash plate sits behind
them, the chemistry failed in patches so the lines fade instead of ending on a cut, the paper's fibre
and grain lie over all of it, and the frame dissolves back into the sheet.

No labels, no frame, no north, no dimension lines and no title block: nothing that would make it a
blueprint drawing rather than a print of a measured field.

## Palette (exact)

Four inks, and nothing else is painted. Pure black and white appear only inside the exposure mask,
where they are opacity, not pigment.

| ink             | hex       | what it does                                                                    |
| --------------- | --------- | ------------------------------------------------------------------------------- |
| prussian ground | `#0E2438` | the dark print's sheet; the ink of the light print's lines                      |
| exposed white   | `#EAF3F8` | the dark print's lines; the light print's paper                                 |
| mid wash        | `#7FB6D9` | the blurred plate behind the linework, the tonal drifts, the misregistered pass |
| shadow          | `#081826` | the darkest drift on the dark print, and the dense chemical flecks on both      |

The two variants are one negative and one print: **dark** is the bath (prussian sheet, lines lifted
out of it), **light** is the paper (exposed-white sheet, the same lines sunk in blue). They paint the
same paths in the same order; only the ink roles change, which is why they read as a pair.

## From a release's notes to an exposure

The notes are read, not illustrated. Three themes are counted (`hands`, `precision`, `wayfinding`,
keyword stems against the number of bullets, saturating so a long release cannot run away with the
score) and the bullet count gives a density. Those four numbers, plus the version's seed, set the
print:

| signal in the notes                                                        | measure      | what it does to the print                                                                                           |
| -------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------- |
| many hands: agents, shared tickets, lanes, delegation, reviews, decisions  | `hands`      | number of summits (4–16) and how much of the wash hangs on high ground; more hands, more small overlapping peaks    |
| the length of the release                                                  | `density`    | contour interval, exposure failures and bloom: a busy release packs more levels, eats more of them and glows harder |
| precision: focus rings, cache, safe area, sticky header, clock, retry, cap | `precision`  | one long crest off the middle, the stillest hand, the fewest failures, the least bleed                              |
| wayfinding: move, split, remove, menu, palette, rename, resume, settings   | `wayfinding` | a broad quiet corridor washed through the field, the most drift, and the most chemistry missing                     |
| the version                                                                | seed         | summit positions, aspect, rotation, warp phases, where the wash sat, the grain's turbulence seeds                   |

Nothing is random at render time. The seed is the FNV-1a hash of `retro-blueprint/<version>`, so the
same version and notes write the same bytes on every run, and the test regenerates the committed
pieces and compares them byte for byte.

## The three pieces

| release | what the notes asked for                                                                                                         | what the print did                                                                                                                          | what it reads as                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 0.2.2   | 165 bullets: agents, shared tickets, lanes, reviews, decision cards, a whole board growing at once                               | 16 summits, 20 intervals, 26 exposure failures, the strongest bloom, no crest and no corridor                                               | a crowded archipelago under a heavy wash: many small peaks, several half-eaten by the chemistry, the busiest sheet |
| 0.2.3   | 16 bullets: focus rings, phone safe area, websocket proxy, CI cache, stall clock, sticky header, capped lists                    | 9 summits with one long crest off the middle, 19 intervals (the tightest), 15 failures (the fewest), the stillest hand and the calmest wash | a held ridge under even pressure: close, parallel lines that keep their distance, a sheet that developed cleanly   |
| 0.2.4   | 14 bullets: Instructions split from Settings, Daily into the menu, command palette, preview in a window, the Resume card removed | 11 summits, 14 intervals (the widest spacing), 18 failures, the most drift, and one broad corridor washed through the middle                | open ground with a way through it: whole contour runs fade into the corridor and pick up again on its far side     |

The three are one family because they share the sheet, the four inks, the hand, the bloom, the fibre
and the 1600×900 frame; they differ in the terrain, where the chemistry sat, and what interrupts the
field.

## Why this works above a changelog

- **A four-ink ceiling.** Nothing in a piece can shout: every visible pixel is prussian, exposed
  white, mid wash or shadow. On the dark print the lightest line is exposed white at 30 % and the
  heaviest at 84 %, so the brightest thing in the frame is still a line and never a white field.
  There is no gradient anywhere; the only softness is the blurred plate, the wash drifts, the bloom
  and the grain.
- **Three weights, one subject.** Contours are drawn at 1.15, 2.05 and 3.3 px with opacity to match
  (0.30, 0.52, 0.84 on the dark print), and every fifth level is dug deeper. The field has depth and a
  centre of gravity without a focal object in the middle of the frame, so a heading beneath it has
  nothing to fight.
- **The interruption is chemistry, not composition.** Lines are not cut out: a mask softens them to
  nothing where the exposure failed (26 places on 0.2.2, 15 on 0.2.3), so a run of contour thins,
  greys and goes, and picks up again. On 0.2.4 that failure is organised into one wide corridor: the
  one gesture that says "a way through", made by the same mechanism as the small bites.
- **Bloom where the chemistry soaked.** The heaviest lines are printed twice: once crisp, once
  blurred at 2.6–4.2 px in the line colour. It is what makes the white contours glow like a
  developed print rather than sit like vector strokes, and it is what keeps them alive when the
  piece is small.
- **Misregistration, once.** A few of the heaviest runs are repeated 1.7 px right and 1.2 px up from
  their bed in mid wash at 12–18 %. It is the one clearly handmade gesture that is not a line, and it
  keeps the piece printed matter rather than a plot.
- **The sheet is uneven and the frame is not there.** Three broad drifts lie under the field, so no
  corner of the print is the same value, and both the border and the foot of the frame are bled out
  through a mask. The field looks washed onto paper and has no hard end to fight the card's edge.
- **Cheap and static.** 35–57 KB per piece, no external assets, no scripts, no text, no filters that
  depend on the theme. At 1600×900 it covers the card's top half at 16:9; the type below never sits
  on it.

## Reading it at a third

At 533×300 the heavy contour is 1.1 px, the medium 0.68 and the light 0.38. The light weight stops
being a line and becomes tooth, which is the correct behaviour for a print seen from across the room.
What carries the piece is everything that is bigger than a line:

- **the three tonal drifts**, with radii of 480–1000 px, are 160–330 px at a third: they survive as
  the composition, and they are what still says "a print" before any line is legible;
- **the corridor and the large exposure failures**, with radii of 70–240 px (the corridor runs more
  than 1000 px), stay 25–80 px holes with soft edges;
- **the heavy contour plus its bloom** is 1.1 px of ink inside a halo of roughly 1.4 px, so the
  structure stays continuous even where the medium and light lines merge;
- **the grain and the fibre do not survive as texture**, and should not: they average into an even
  paper tooth, which is exactly what a contact print looks like when it is small. No detail is lost
  that the piece relies on, because none of the structure is drawn at grain scale.

## Where this direction is worst

**0.2.2, plainly.** It is the busy release, and the theme mapping sends it to every ceiling: 16
summits, 20 intervals, 26 exposure failures and the strongest bloom. The cyanotype's tonal plate is
what makes this treatment work, and here the plate, the bloom and the many closely packed contours
all sit in the same midtone: the dark print's ground rises toward the value of its medium lines, and
the light print's light contours grey out into the wash. At a third of the size the many small rings
merge into a mesh and the strongest reading becomes "printed contour map" rather than "many hands
working together". The idea is carried by count alone — there is no single gesture that says
collaboration, which is exactly why it is the piece I would re-tune first: around 11 summits, three
fewer intervals, and let the corridor appear so the composition has a way through it.

## What was tried and rejected

- **Evenly exposed field, uniformly blue.** The first pass held the ground flat and put all the
  variation in the lines. It read as a blueprint tint rather than a print: no amount of grain made it
  feel developed. The three broad drifts and the uneven wash are what fixed it.
- **Cutting the lines out with hard-edged gaps.** It looked like a mask, not like a bad exposure: the
  eye read a shape in front of the field. Fading through a feathered mask lets the line thin and go.
- **A single dominant summit.** The fastest route to a mountain silhouette with a logo's symmetry.
  The summits stay off-centre, stretched and partly outside the frame, and the crest of a precise
  release runs off both edges instead of closing into a ring in the middle.

## The next release

A new release needs nothing but its notes:

```
gh release view v0.3.0 --json body --jq .body > scripts/release-art/notes/v0.3.0.md
node scripts/release-art/retro-blueprint.mjs
```

The first command records the notes exactly as GitHub published them; the second re-renders the whole
series, writes the new pair beside the old ones and updates `manifest.json` with the version, the
seed, the theme readings, the exposure it produced and the byte sizes. To try one release without
touching the series:

```
node scripts/release-art/retro-blueprint.mjs --version v0.3.0 --notes <file> --out /tmp/art
```

Wiring a piece into the card would be two lines: pick the file by version (`v<version>-dark.svg` or
`-light.svg`, from the manifest's `files`), and set it as the card's 16:9 top edge with
`object-fit: cover`. The generator needs no network and no dependency beyond Node itself.

## Files

- `scripts/release-art/retro-blueprint.mjs` — the generator.
- `scripts/release-art/retro-blueprint.test.mjs` — determinism, the committed bytes, the 16:9 frame,
  the palette, the size budget and a release it has never seen.
- `scripts/release-art/notes/` — the release bodies the pieces were read from.
- `src/assets/release-art/retro-blueprint/` — six SVGs and the manifest.
