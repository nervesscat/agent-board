# Release artwork: long exposure

One abstract piece per release, dark and light, 16:9, pure SVG (24–33 KB each, no external assets,
no fonts). The piece is what motion looks like when the shutter stays open: no object in the frame
survives, only the direction it went.

```
v0.2.2  ▸ public/release-art/v0.2.2-{dark,light}.svg
v0.2.3  ▸ public/release-art/v0.2.3-{dark,light}.svg
v0.2.4  ▸ public/release-art/v0.2.4-{dark,light}.svg
notes   ▸ scripts/release-art/notes/<version>.md      (the real release notes, committed)
```

## The grammar

Five things, and nothing else:

- **Haze** — the widest, faintest marks: air moving.
- **Smears** — light with no edge left in it. The field's mass.
- **Filaments** — the few marks bright enough to keep a core while everything round them smeared. A
  short crisp line inside its own glow.
- **One still edge** — a crease in the ground that did not move: the tone steps across it and only
  the middle of it catches light. At most one.
- **Grain** — a noise layer for film tooth and a dust of seeded motes, so nothing reads as a stock
  gradient or a vector gradient.

Palette: a paper, an ink and **one** pigment. Light print on `#f3efe5` paper in `#191b1f` ink; dark
print on `#0b0d10` ground in `#e9e4d7` ink. The pigment (rust, indigo, verdigris, plum, ochre) bleeds
in as a hairline thread along the vector, one wash and a few strokes — it is the only colour in the
frame, and it never covers more than a corner's worth.

Composition: the dense band sits off centre, the crease cuts at an angle to the vector, one corner is
kept quiet by a veil of the ground colour. Nothing is centered, nothing is a symbol, nothing is
labelled.

## How a release becomes a piece

```
planRelease({ version, notes })   → every number: the vector, the field, the crease, the thread
renderSVG(plan, 'light' | 'dark')  → one file
```

The seed is `FNV-1a(version + notes)` fed to a mulberry32 PRNG: no dependency, the same on every
machine. The theme only maps ink, paper and print exposure (the dark print runs at 0.78 of the light
field's strength), so **the two variants are one drawing, not two**.

The notes are read by line — one line of `## What's Changed` is one change that shipped — with URLs
and authors stripped first:

| reading of the notes                                                  | what it becomes                                                                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `changes`: how many lines                                             | density: 18–64 marks, from the square root, so 160 changes is busy but 16 is not empty               |
| `collab`: share of lines about agents, tickets, lanes, reviews, posts | 1–4 bundles the field breaks into, how far the strokes fan apart, extra doubled exposures and flecks |
| `precision`: share about focus, polish, keeping, capping, fixing      | thinner and straighter strokes, fewer motes, and a stronger still thread                             |
| `wayfinding`: share about moving, splitting, menus, palettes, rows    | 1–4 bands, and the step each band's strokes start at                                                 |

The version alone chooses what the notes cannot say: the vector (7–20°, either diagonal), the pigment
(hash of the version, so two releases of the same size still differ), the crease's side and position,
where the washes fall, and which corner stays quiet.

The generator prints that reading when it writes a piece, so a picture can be checked back against
its notes:

```
v0.2.4: 30 strokes, 2 bundles; 2 bands, vector -13.1°, plum; notes: 14 changes,
        collab 0.43, precision 0.00, wayfinding 0.57
```

## The series

| release   | notes read as                                             | the piece                                                                                                                                                                                                                                                    |
| --------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **0.2.2** | 160 changes; collab 0.50, precision 0.17, wayfinding 0.33 | 58 marks in three bundles, 19.3°, ochre. The densest of the three: bundles cross at slightly different angles, 24% of its filaments are doubled (the shutter opened twice), and flecks catch where they overlap. Many hands, and none of them the same hand. |
| **0.2.3** | 16 changes; collab 0.13, precision 0.69, wayfinding 0.25  | 31 marks, one bundle, −11.1°, rust. Almost every stroke parallel and thin, motes at their fewest, and the still thread at full strength: the quietest piece, and the one where the crease is the subject. A single pass, held.                               |
| **0.2.4** | 14 changes; collab 0.43, precision 0.00, wayfinding 0.57  | 30 marks, two bundles, two bands, −13.1°, plum. The bands start at different places along the vector, so the field is stepped — the same strokes re-laid-out in two rows, the top one running past the bottom one. The plum bleeds in on the right.          |

Same paper, same grain, same vocabulary of marks and the same `width/height` — that is the family.
Vector, density, accent, crease and banding are what make them three pieces rather than three tints.

## The next release

Nothing is drawn by hand, so a release nobody has seen gets its own piece:

```sh
gh release view v0.3.0 --json name,body -q '.name + "\n" + .body' > scripts/release-art/notes/v0.3.0.md
node scripts/release-art.mjs --release v0.3.0
```

That writes `public/release-art/v0.3.0-{dark,light}.svg`. `--notes` reads another file, `--out`
writes elsewhere, `--themes dark` writes one variant. The notes are read, never fetched, so
regeneration is offline and byte for byte the same file. The assets are committed rather than built
because a release asset must not change between builds; the note files are committed beside the
generator for the same reason.

## Wiring it into the update card

- Serve the committed file as it is: `<img src="/release-art/v0.3.0-light.svg" alt="">` (decorative;
  the release name is the heading) or `dark` by theme, via `<picture>` with `prefers-color-scheme` or
  the board's theme class.
- Give it the card's full width in a 16:9 box with `object-fit: cover`. The art is edge to edge and
  carries no inner frame, so the card's own radius is the only one.
- The text area under it should use the piece's own ground — `#f3efe5` under the light print,
  `#0b0d10` under the dark one — or the seam between art and card shows as a line.
- Put it above the changelog and outside the text column: it must not sit behind type. Its range is
  compressed on purpose (the darkest ink in a piece is about half opacity), so the heading below it
  still wins.
- Nothing to draw per release: add the notes and run the one command.

## Where this direction is worst

**0.2.3, the quiet release.** The whole vocabulary here is motion — smear, exposure, throughput — and
a release of focus rings and safe areas has almost nothing that moved. The generator renders that
honestly: a field small enough to count, one pass, a lot of empty paper. That can read as _unfinished_
where the release meant _restrained_; the crease and the thread are what save it, by giving the frame
a subject that isn't quantity. It survives, but it is the piece where this direction has least to
say, and the one where a stiller direction (contour, ink, facet) has the better argument. 0.2.2 is
its best fit — its notes are literally a lot of movement — and 0.2.4 lands in between, with the
banding doing real work.

## Checks

```sh
pnpm exec vitest run scripts/release-art.test.mjs
pnpm exec prettier --check --end-of-line auto scripts/release-art.mjs scripts/release-art.test.mjs \
  scripts/release-art/README.md
```

The test holds the series to what this file claims: the same input makes the same bytes, the
committed SVGs equal what the generator makes, dark and light share one drawing, each piece stays
under 150 KB with no text and no external references, a release with notes but no art still renders,
and the notes really do read as busy/quiet/reorganized.
