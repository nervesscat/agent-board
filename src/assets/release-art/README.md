# Release artwork: ink diffusion in still water

Two inks dropped into still, empty water. The drop lands as one small dense mark; around it the
pigment blooms outward and thins, keeps going in a few soft wisps, and settles into granulation where
the wet edge stopped. A large part of the sheet is left untouched on purpose: the quiet is what makes
the bloom read as a bloom.

One piece per release, dark and light, each seeded by that release's version, so the series is one
family and no two pieces are the same.

## Files

```
v0.2.2-light.svg  v0.2.2-dark.svg
v0.2.3-light.svg  v0.2.3-dark.svg
v0.2.4-light.svg  v0.2.4-dark.svg
```

Every file is 1600×900 (16:9), a plain SVG with no external asset, no text and no script, under the
150 KB budget. The light piece is ink on paper: one warm ground with two inks multiplied into it. The
dark piece is the same pigment in dark water: the ink is seen by transmitted light, so it glows from a
near-black ground instead of darkening a pale one.

## How a release becomes form

The version seeds the composition; the release notes tilt it. Nothing is drawn by hand, and nothing is
random: the same version and notes always write the same bytes.

Three readings come out of the notes:

- **many** — how much moved at once, from the size of the notes. Many hands leave many marks.
- **precision** — how much of it is small, exact, holding (focus rings, clocks, caches, caps): the
  drops pull into one tight cluster and the edges calm down.
- **wayfinding** — how much of it is moving things around (splits, menus, removals, renames): fewer
  drops, further apart, with more paper left empty.

The plan they produce: how many drops (2 to 5), where they land along one current, how large each one
blooms, how tight the cluster is, how turbulent the edges are, and which quarter of the frame stays
empty. The version's hash decides the rest — the current's angle, each drop's silhouette, the drift of
the bloom, the grain's seed.

| release | notes in form                                                                                                                                                                                   |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.2.2   | Five drops strung along one current that runs out of the bottom-left corner, blue running into magenta, edges turbulent. A release of agents, shared tickets and lanes: many hands, one stream. |
| 0.2.3   | Three drops held in one small, calm cluster, high and slightly right, with a large quiet field around it. Precision and quiet polish: nothing spreads further than it must.                     |
| 0.2.4   | Two drops, big and far apart, most of the sheet empty. Wayfinding and less clutter: two things moved to where they belong, and the room that left.                                              |

## Why this register fits an update card

The card shows the artwork edge to edge above the changelog, so the piece has to carry the release's
mood without competing with the text under it. This direction is built for that: the ink keeps to one
part of the frame, the rest is paper, and the darkest point is small. It reads at a glance from 720 px
up, survives being cropped at the sides, and has no line, letter or icon that could be mistaken for UI.
The grain and the uneven wet edges stop it from reading as a stock gradient; the palette is two inks
and a ground, so it sits under the app's neutral chrome and the brand's violet without clashing.

## Where the direction is weakest

**The dark variants, and 0.2.4 among them.** Ink is a darkening medium: on paper the stacking does the
work, but in the dark variant the same wash has to be rendered as light, so it is a translation of the
direction rather than the direction itself. It reads as ink in water lit from behind, and it is quieter
than the light piece. 0.2.4 has only two drops and the least overprint, so it is the sparsest piece in
the series: the empty quarter is close to becoming the whole frame. If the direction is picked, those
two are where it would need the most attention — the dark piece wants a brighter rim to hold its shape,
and a release with very little in it wants a minimum weight for the one drop it gets.

## Making the next release's piece

The generator is `scripts/release-art.mjs`; the notes it draws from are cached in
`scripts/release-art/releases.json` (written by `gh release view`, so the pieces can be rebuilt without
a network).

```bash
# refresh the cache with a release's real notes, then draw every release in it
node scripts/release-art.mjs --capture --versions 0.2.5
node scripts/release-art.mjs

# draw one release from notes on disk instead
node scripts/release-art.mjs --version 0.2.5 --notes notes/v0.2.5.md

# fail when a committed piece no longer matches its release and notes
node scripts/release-art.mjs --check
```

A new release gets its piece the moment its notes are captured: nothing has to be drawn, and the piece
is stable from then on. The tests in `scripts/release-art.test.mjs` keep the committed files equal to
what the generator writes, and hold each piece to 16:9, the size budget, two inks over one ground, and
no text or external asset.

## Wiring it into the card

The card asks for one image per version and picks a theme. This folder is the shape for that: the file
name is `v<version>-<light|dark>.svg`, so the card needs only the version and the theme to name its
source. Import each piece with Vite's `?url` (or list them in one map) and give the `<img>` an empty
`alt` and a 16:9 box; the piece is decorative and the changelog beside it is the content. The two themes
are separate files rather than one themable SVG on purpose: the dark piece is not a recolour of the
light one, and a single file would have to pick one of the two grounds.
