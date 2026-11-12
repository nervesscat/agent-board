# Retro riso

A contour field printed on a two-drum risograph. The approved register is kept whole: an implied
terrain seen from straight above, iso-lines at an interval the release's notes choose, three line
weights, one deliberate interruption, no labels, no axes, no frame. What changes is the press: two
inks, a sheet that slipped 1–2 px between drums, halftone dots in the wide bands, a drum whose ink
density is uneven, paper fibre, and the ink plate printed a second time off its bed and gone soft.

Six pieces sit beside this file — v0.2.2, v0.2.3, v0.2.4, each light and dark. `manifest.json`
records, per release, the seed, the theme scores, the field and the print settings that produced it.
`scripts/release-art/retro-riso.mjs` draws them with Node alone: no new dependencies, no external
assets, no runtime filter.

## Palette (fixed, nothing else on the sheet)

| hex       | name   | what it does in the light piece         | what it does in the dark piece            |
| --------- | ------ | --------------------------------------- | ----------------------------------------- |
| `#F4EFE6` | paper  | the sheet; sits under every plate       | the ink on the ink plate's lines and dots |
| `#1F2A44` | ink    | contour lines, ink screen, fibre, grain | the sheet; the ground of the whole piece  |
| `#FF5A3C` | spot   | every third contour, the spot screen    | the same, unchanged                       |
| `#DCD3C4` | shadow | the soft haze under one band            | the soft haze, lower still                |

The dark piece swaps paper and ink and leaves the spot alone, so the series reads as one press run
with the lights off. True black appears only inside the drum-miss mask, where it is a hole in the
plate and never a colour on the sheet.

## From the notes to the piece

The notes are read, not illustrated. Three themes are counted (`hands`, `precision`, `wayfinding`,
saturating so a 160-bullet release cannot run away with the score); the bullet count gives a density.
Those four numbers plus the version's seed set the terrain and the press:

| signal in the notes                                                        | measure      | what it does to the print                                                                               |
| -------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| many hands: agents, shared tickets, lanes, delegation, reviews             | `hands`      | 4–15 summits; more summits means small overlapping rings — an archipelago, not one crest                |
| the length of the release                                                  | `density`    | contour interval, nicks, drum mottle strength, and whether the bands use one or two long contours       |
| precision: focus rings, cache, safe area, sticky header, clock, retry, cap | `precision`  | one long ridge through the middle, the stillest hand, the fewest tears                                  |
| wayfinding: move, split, remove, menu, palette, rename, resume, settings   | `wayfinding` | a wide cleared way through the field, the most wobble, the most interruption                            |
| the version                                                                | seed         | summits' places, warp phases, registration error (1.2–2 px), drum-mottle phase, spot split phase, fibre |

Nothing else is random at render time. The seed is the FNV-1a hash of `retro-riso/<version>`; the
same version and notes write the same bytes on every run, and the test regenerates the committed
files and compares them byte for byte.

## The press

- **Two drums, split contours.** Every third level is printed only in spot, deliberately as a heavy
  2.8 px line so it survives a downscale; the rest is ink. Every fourth ink level also takes a spot
  pass 1.2–2 px off its bed. The overlap never blends to a third colour, so the sheet stays two ink
  hues and paper.
- **Halftone bands, not filled elevation.** The wide bands are 34–48 px strokes laid along a measured
  contour and painted with a 9 px dot screen — ink dots on one, spot dots on another, at different
  screen angles. They follow the ground the way a printed band would, and they break wherever the
  sheet tore.
- **The soft plate.** The ink plate is drawn again 2.2 px off, with a 2.8 px Gaussian blur on the
  plate layer alone at 15–22 % opacity. That is the halo around the lines. There is no blur on the
  finished image.
- **Uneven drum density.** Each plate sits under its own `feTurbulence` mask at 0.003–0.012 cycles/px:
  broad patches where the drum took more or less ink. This is the vintage part that survives being
  shrunk, because its wavelength is measured in centimetres.
- **One torn miss.** Every piece has one stretch of sheet the ink drum never touched: an irregular
  masked hole 190–300 × 16–31 px with a smaller companion tear. It is the direction's deliberate
  interruption, and it is a hole in the plate, not a polite gap cut into each line.
- **Paper, then grain.** 150 seeded fibres at 5 % under a fine `feTurbulence` overlay (multiply on
  paper, screen on ink). The grain is the first thing to disappear at card size, which is the point:
  it never reaches the typography below.

## The three releases

| release | what the notes asked for                                                               | what the press did                                                                                              | what it reads as                                                                         |
| ------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 0.2.2   | agents, shared tickets, lanes, reviews — 160 bullets, 0.89 hands, 0.96 density         | 15 summits, 17 levels, the strongest mottle (0.33), no ridge, no corridor, 78 line runs                         | a crowded archipelago, over-inked: many small measured rings and the busiest dot screen  |
| 0.2.3   | focus rings, cache, phone safe area, proxy, sticky header — 16 bullets, 0.56 precision | 9 summits plus one long ridge, 17 levels, the stillest hand (1.46), the mildest mottle (0.27), 40 line runs     | a held ridge under even pressure: lines stay parallel and close, and the sheet is quiet  |
| 0.2.4   | split Instructions, move Daily, remove the Resume card, command palette — 14 bullets   | 12 summits, 11 levels (the widest spacing, the most open sheet), 1.9 wobble, one cleared corridor, 53 line runs | open ground with a way through it: whole lines and bands stop at the corridor and resume |

They are one family because they share the paper, the two inks, the screen, the fibre, the frame
and the hand. They differ in the terrain, the density of the press and what interrupts the sheet.

## Why this register fits an app card

- **Paper and two inks, no gradient anywhere.** The only softness is a plate-level blur and a
  low-frequency density mask. At rest the piece reads as a printed object, not as a stock gradient.
- **Mid-value by construction.** No large dark flood, no pure black on the sheet, only thin lines and
  dotted bands. A heading above it and a changelog below it have nothing to fight: the top and bottom
  edges are held at the same value, and the busiest mark is a 3 px line.
- **The artifacts are on the sheet, not on the text.** Grain and fibre die at card size; the screen,
  mottle and tear stay. That ordering is deliberate.
- **Cheap and static.** 27–48 KB per piece, no external assets, no filter that depends on the theme.
  At 1600×900 it covers the card's top half with `object-fit: cover`.

## Where this direction is worst

**0.2.2.** It is the busy release and the theme mapping sends it to every ceiling: 15 summits,
17 levels, 78 line runs, the strongest drum mottle. The idea of "many hands" is carried by count
alone, so the strongest reading at card size is "a dense contour map with a heavy screen", not
"collaboration". The spot split also bites hardest here: with so many levels, every third one in
spot turns the busiest regions into orange mesh, and the mottle then drops patches of it. 0.2.2 is
the piece I would tune first if this direction wins: 11 summits, two or three fewer levels, and the
spot split at every fourth level, so the field has air and the screen has somewhere quiet to sit.

0.2.3 is handled best — the ridge gives the quiet release a spine, and the 1.3 px registration plus
the dot bands read clearly as a press. 0.2.4 is the most open sheet; at card size the corridor is
the first thing the eye finds, which is exactly the release's subject, but it relies on the tear and
one heavy spot contour to stay a composition rather than an empty sheet.

## How the degradation survives a third of the size

At the card's top half a piece is about 533 × 300 px, one third of the drawing:

- **Heavy ink 3 px → 1 px; spot contours 2.8 px → 0.93 px.** Both stay above a device pixel, so the
  field keeps hard edges and the orange split still reads as a second plate.
- **The dot screen: 9 px pitch / 2.4 px dots → 3 px / 0.8 px.** It reads as a visible coarse dither,
  not as a grey wash.
- **Drum mottle: wavelengths of 83–333 px → 28–111 px.** The patches survive intact, which is why the
  sheet still looks unevenly inked at card size rather than flatly filled.
- **The torn miss: 190–300 × 16–31 px → 63–100 × 5–10 px.** It stays a clear breach in the field,
  and it is the one gesture that reads instantly at any size.
- **The 1.2–2 px registration error → 0.4–0.7 px.** This is the one artifact that deliberately does
  not survive: below a device pixel it stops being a mistake and becomes colour separation. Making
  it larger to "survive" would turn the piece into fringing mush behind the card's text, so the print
  feel at 1/3 is carried by the screen, the mottle and the tear instead.
- **Fine grain and 150 fibres vanish**, which is desirable: they are what would muddy the type.

What does suffer at 1/3 is 0.2.2's small rings: the heavy lines hold, but the 15 summits merge into
a pattern. That is the same weakness named above, seen at card size.

## What was tried and rejected

- **Blurring the finished sheet.** The obvious way to make a print look soft, and it destroys the
  line edges and the text ceiling. The blur stays on the plate layer.
- **A photograph-like paper texture.** Raster, heavy, and it fights theming. Seeded fibre plus a
  turbulence overlay is smaller, deterministic and theme-aware.
- **Multiplying the two inks everywhere.** It makes a third, muddy colour and stops reading as riso.
  The plates overlap only in the 1–2 px registration band.
- **A registration mark or crop marks.** Too literal: it would turn the piece into a print mockup.
  The misregistration is the artifact; it needs no diagram of itself.

## The next release

```
gh release view vX.Y.Z --json body --jq .body > scripts/release-art/notes/vX.Y.Z.md
node scripts/release-art/retro-riso.mjs
```

That writes `vX.Y.Z-light.svg`, `vX.Y.Z-dark.svg` and updates `manifest.json` for a release nobody
has drawn. To try one release without touching the series:

```
node scripts/release-art/retro-riso.mjs --version vX.Y.Z --notes notes/vX.Y.Z.md --out /tmp/art
```

When the direction is wired into the update card, read `manifest.json` rather than a filename: it
maps the version to its two files, its seed, its theme scores and its print settings, and the sheet
is a plain `<img>`, dark or light by the board's theme.
