# Screen interference: a thematic per major version

Made by Claude Opus 5.5 (medium effort)

The style was approved for what the pieces look like; this round gives them meaning by version.
There are four levels, and only the lowest one changes with every release:

1. **Style**, for ever: halftone screens on paper, the moiré between them as the image, the print
   grain, the pitch, the three-ink discipline. Nothing below changes it.
2. **Thematic**, one per **major** version: what that phase of the product means, as a grammar
   (how the bands lie, how true the screens are, whether an edge is always held) and an accent ink.
3. **Variation**, one per **minor** version: a chapter, one step along an arc the thematic declares.
4. **Piece**, one per release: the notes steer the composition inside what the thematic and the
   chapter allow; the version seeds the rest.

Meaning is carried by form and by the names below, never by a symbol: there are still only dots,
bands of tone and the beats between them.

## The style (constant)

A piece is two or three halftone screens, one per ink, printed on one sheet. Nothing is drawn but
dots on a regular lattice, each sized by its screen's tone. Every screen prints broad bands of tone,
their long sides a halftone fade; how the bands lie is the thematic's. The image is what happens
where two bands overlap.
The two screens sit a few degrees and a fraction of a pitch apart, so their dots drift in and out of
phase and the overlap fills with slow moiré fringes. A fringe magnifies the smallest difference
between two lattices. A screen pushed a few pixels off true bends the fringes across the whole
overlap, and a straight, untouched screen gives straight, ruled fringes. So the feeling of a release
is carried by how true the screens are to one another, not by any shape.

The vocabulary is small: lattice, tone, angle, pitch, warp, and three gestures a release can earn:

- **A held edge** (precision): one screen stops dead on a straight line instead of fading.
- **A cleared lane** (wayfinding): a strip of bare paper runs through the sheet, and across it the
  later screens are moved half a dot, so the fringes break and pick up again somewhere else.
- **A ramp** (signals): one screen's tone climbs steadily across the sheet.

Print artifacts are part of the sheet, not a filter over it: each dot comes out a little heavier
or lighter than its tone (dot gain), its edge is pushed about by fine noise as ink spreads into
paper, the press lays some areas heavier than others (low-frequency mottle), and a paper tooth
speckles inks and ground alike.

Why this register suits an update card: it is calm (two or three broad bands and a lot of paper),
editorial (it looks printed, not rendered), and a little rough at full size while it stays one
clean read at a third. Nothing in it is an object: there are dots, and the beats between them.

## Palette

Three inks and a ground on every piece. Two inks belong to the style and print in every major:
indigo `#2C467C` (the key) and ochre `#C99A2E`. The third is the thematic's accent: vermilion
`#D9553B` for major 0, viridian `#2D6B57` for major 1, plum `#74406B` waiting for a later one.
Light prints them on paper `#F0EBE1` and multiplies them where they overlap. Dark prints lighter
pulls of the same inks (`#6F93D8`, `#D8B24E`, `#E8694D`, `#5DB396`, `#B784AE`) on blue-black
`#14161C` and screens them, so overlaps brighten instead of darkening. The grain is ink-brown on
paper and paper on black. A third ink prints lighter than the first two, so three inks stacked
stay inks and not mud.

## Major 0: Make-ready

_Before 1.0 the product is on the proofing press: every release is a trial pull while the plates are
moved toward register, and nothing is locked yet._

Make-ready is the printer's word for everything done on the press before the run: the trial sheets
pulled while the plates are nudged into line. That is what 0.x is: the product finding its shape,
each release a pull to see how it prints. As form: **bands lean on the diagonal and cross one
another**, the later screens are **warped** off true so the fringes bend and wander, and the accent
is **vermilion**, the warm ink. An edge is held only when a release earns it (precision).

## Major 1: The run

_From 1.0 the press is in register and the edition is printing: people take sheets off the pile and
rely on each one being like the last; what grows is the weight, not the doubt._

1.0 is the first version people rely on, so its thematic is the opposite of searching: the plates
are in register. As form: **bands stand upright and parallel** as columns, the screens are **never
warped** so every fringe is straight and ruled, **an edge is always held** (the outer side of a
column, cut dead), and the accent is **viridian**, paired with indigo, the cool inks. Releases still
differ (the notes set the gap, the screens, the lane, the ramp, a second held edge), but inside a
discipline that never bends.

Any 0.x piece and any 1.x piece are told apart at a glance, at full size and at a third: warm
diagonals that cross against cool upright columns. Both are plainly the same screens, grain and
paper.

## The variation rule: a minor is a chapter

Each thematic declares an **arc**: for each of its parameters, the value at its first chapter
(minor 1) and at its last (minor 3). The minor is the position along it: 0.1 at the start, 0.2
halfway, 0.3 at the end, x.0 half a step before the start. Minors after the third keep stepping
toward the next thematic by ever smaller amounts (`chapterOf` in the generator), so no two minors
of one major are ever the same chapter, and the chapters read in order. The parameters:

| parameter | what it does                                              | Make-ready 0.1 → 0.3     | The run 1.1 → 1.3           |
| --------- | --------------------------------------------------------- | ------------------------ | --------------------------- |
| gap       | degrees between the screens: wide is busy, small is slow  | 6.6° → 2.4°              | 2.6° → 1.5°                 |
| warp      | how far a later screen is pushed off true                 | 7 px → 1.2 px            | 0 (never)                   |
| lean      | degrees between the bands                                 | 26° → 4°                 | 0 (parallel)                |
| spread    | how far apart the bands' centres sit                      | 0.1 → 0.075 of the sheet | half a column               |
| reach     | band length; under 1 it stops inside the sheet            | 0.62 → 1.6               | 1.6 (runs off top and foot) |
| breadth   | how broad a band (or how much of its slot a column) fills | 0.22 → 0.25              | 0.5 → 0.62                  |
| beats     | bands per screen                                          | one                      | the minor: 1, 2, 3          |

So the chapters say:

- **0.1 First pull.** Two short, broad fragments that stop inside the sheet, crossing wide, the
  fringes busy and bent: most of the sheet is paper, the plates nowhere near register.
- **0.2 Finding register.** The bands run off the sheet and cross; the fringes still bend. This is
  the look that was approved, and the real 0.2.x releases sit here.
- **0.3 Near register.** Broad bands, nearly parallel and overlapping wide, a small gap and almost
  no warp: one long, slow fringe. The press is almost ready to run.
- **1.1 First sheets.** One upright pair of columns, overlapping in one straight beat; a lot of
  paper. **1.2 Long run.** Two beats. **1.3 Full stack.** Three beats. The register never changes;
  the count of beats is the weight the edition carries.

## How major 2 and later get their thematic

Without a redesign, by rule (`thematicFor`): the axis comes from a cycle of four (diagonal,
upright, level, steep) and the accent from a cycle of three (vermilion, viridian, plum), so no two
of the next twelve majors share both, and the arc is The run's, because a product past 1.0 stays in
register: major 2 prints level bands in plum with straight fringes and one beat per minor. The
generator marks such a thematic `derived` in the manifest; when that major starts, a person writes
its name and its sentence into `THEMATICS` (and may give it its own arc), and the pieces follow.

## How a release becomes a piece

As before: `scripts/release-art/screen-interference.mjs` reads the notes (only the change lines) for
four themes, **many hands**, **precision**, **wayfinding** and **signals**, and their volume. At
most two themes speak. Many hands in a large release bring a third screen (the remaining style ink);
precision closes the gap, straightens the warp and the lean, and holds an edge (in The run, a second
one); wayfinding clears a lane of paper and shifts the fringes half a dot across it (upright in The
run); signals ramp one screen's tone (across the bands in Make-ready, along the columns in The run).
The version seeds the base angle, the tilt, which style ink pairs with the accent in Make-ready, and
the positions. The same version and notes write the same bytes on every run.

## The pieces

| version | notes                                             | thematic, chapter            | what it produced                                                                                    |
| ------- | ------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| 0.1.0   | stand-in: a first board, tokens, posts            | Make-ready, First pull       | vermilion and ochre fragments crossing, ochre warped 4.9 px; most of the sheet paper                |
| 0.2.0   | real: 131 changes, agents, lanes, previews        | Make-ready, Finding register | three screens, bands crossing wide, a lane through them                                             |
| 0.3.0   | stand-in: leases, locks, caps, retries            | Make-ready, Near register    | vermilion over ochre nearly parallel, gap 1.1°, 0.2 px of warp, one slow fringe; held edge          |
| 1.1.0   | stand-in: data kept across upgrades, a held API   | The run, First sheets        | one pair of viridian and indigo columns, one straight beat, both outer edges held                   |
| 1.2.0   | stand-in: several projects' agents, lanes, tokens | The run, Long run            | two beats; one outer edge held                                                                      |
| 1.3.0   | stand-in: live work, progress, notices            | The run, Full stack          | three beats; two held edges (precision), indigo ramping along its columns (signals)                 |
| 0.2.2   | real: 159 changes; hands, wayfinding              | Make-ready, Finding register | three screens crossing wide, a lane, the fringes knotting where all three meet                      |
| 0.2.3   | real: 15 fixes; precision                         | Make-ready, Finding register | vermilion over ochre stacked, the ochre held on a straight edge: the quietest 0.2                   |
| 0.2.4   | real: 13 moves; wayfinding, hands                 | Make-ready, Finding register | indigo and vermilion, the most warp of the 0.2s (3.4 px), a lane with the fringes jumping across it |
| 0.2.5   | real: 31 changes; signals, hands                  | Make-ready, Finding register | three screens on a long diagonal, the ochre ramping in                                              |

**Stand-ins.** v0.1.0, v0.3.0, v1.1.0, v1.2.0 and v1.3.0 have no published release. Their notes in
`scripts/release-art/notes/` were written for this artwork, to fit that phase, and each opens with a
**Stand-in notes** line; the manifest marks them `standIn: true`. v0.2.0 is a real release and uses
its real notes. When a real release comes, its notes replace the stand-in and the piece is redrawn.

The real 0.2.x pieces changed from the approved round in two ways, both from the system: the accent
(vermilion) now prints in every one (0.2.3 was ochre and indigo, it is now vermilion and ochre), and
the bands' lean and spread come from the 0.2 chapter, so the precise release's bands stack closer.

## Where it is weakest

**The run, piece to piece.** Its discipline is the point (upright, parallel, never warped), but it
leaves the notes less to move: two 1.2 releases will differ in where the columns stand, the gap, a
lane or a ramp, not in the large gestures 0.x gets. And it prints ochre only when many hands bring a
third screen, so most 1.x pieces are two cool inks; that is what tells them from 0.x at a glance,
but they are less rich than the 0.x pieces. Its chapters are the clearest of all (count the beats);
its patches are the weakest.

**0.2.0 against 0.2.2.** Both are huge releases read as many hands and wayfinding, so both get three
crossing screens and a lane; only the seed tells them apart. They are different pieces, but they
are the closest pair in the series. The approved round's weakness still holds for 0.2.2: where all
three inks overlap in light the multiply goes dark brown.

A smaller one: the screens need to resolve. At a third the pitch is under six pixels and the fringes
still read (the one-third sheet shows it); the generator never lets the gap exceed 7°, so a fringe
always spans at least eight dots, and the test holds both.

## How the next release gets its piece

```
gh release view vX.Y.Z --json body --jq .body > scripts/release-art/notes/vX.Y.Z.md
pnpm exec prettier --write scripts/release-art/notes/vX.Y.Z.md
node scripts/release-art/screen-interference.mjs
```

The major picks the thematic, the minor the chapter, the notes the piece. To try a release out
without touching the series, pass `--version vX.Y.Z --notes <file> --out <dir>`. To look at the
series, `node scripts/release-art/screen-interference-sheets.mjs --out <dir>` writes the matrix,
the real 0.2.x row, the one-third matrix and the card mock as PNGs.

## Checks

`scripts/release-art/screen-interference.test.mjs`: the same version gives the same bytes; the
committed files match a fresh run; every piece is 16:9, under 150 KB, with a title and description,
no text element, no style, script, image, use or external reference, and only its own filter
references; only the declared palette's hexes appear; version parsing accepts `vMAJOR.MINOR.PATCH`
and refuses anything else, on the command line too; two majors (0 and 1, and any two of the next
twelve) differ in the thematic's declared form; two minors of one major (the first ten of majors 0,
1, 2 and 5) differ in the variation's parameters and step forward in order; each thematic keeps its
grammar whatever the notes say (Make-ready leans, The run stands upright, is never warped, always
holds an edge and has one beat per minor; the accent always prints); the stand-in notes are marked
in the file and in the manifest; the pitch and the fringe width stay legible at a third; and each
release gets its own screens.
