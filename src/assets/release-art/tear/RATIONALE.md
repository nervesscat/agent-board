# Tear

Made by Claude Fable 5.2

A hand-torn paper collage. A few large sheets of dyed paper are torn by hand and laid over one
another on a paper ground (light) or an ink ground (dark). The colour is flat and opaque: no
gradient, no drawn line, no contour. Everything the piece says, it says with where a sheet ends.

## The register

- **Two kinds of edge.** A cut edge is the side of the sheet as it came: straight. A torn edge
  wanders. Every piece sets the two against each other, which is what keeps it from reading as
  vector shapes.
- **The artifact is the tear.** Along stretches of a torn edge the dye layer has peeled back and
  the sheet's pale core shows as a feathered fringe. Two pieces torn from one another keep the same
  edge, so they still fit, and only one of them carries the fringe, as with real paper.
- **Grain.** Each sheet casts a thin shadow, loose fibres lie over everything, and a coarse grain
  and a slow mottle sit on top. None of it is a blur.
- **Palette.** Plum and celadon for the sheets, one saffron scrap as the accent, on bone paper or
  plum-black ink. In the dark piece the plum is lit and the celadon deepened so both stand off the
  ink. The core's off-white is the only other tone.
- **Calm.** Large flat areas, one small accent, nothing finer than a torn edge: it sits above the
  card's text without competing with it, and at a third of the size the sheets and the accent
  still read (the fringe thins to a pale line).

## What a version means

The style above never changes. Below it a version is read on three levels: the major picks the
thematic, the minor a variation of it, and the release's notes the piece.

### Thematic: one per major

| major | name    | what that phase means                                                                                                                                    | how it shows                                                                                                 | dyes          |
| ----- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------- |
| 0.x   | Loose   | Before 1.0 the product is still finding its shape. Nothing is fixed: the sheets lie loose on the table, at any angle, and the table shows between them.  | sheets come in from any side at any angle, overlap or are pulled apart; a good part of the ground stays bare | plum, celadon |
| 1.x   | Coursed | The first version people rely on. The sheets have found their places: all follow one axis and lie in courses, edge over edge, and the ground is covered. | every sheet runs along one leaning axis, in parallel courses; the ground shows only as one seam or one bay   | madder, slate |

Both are the same paper, the same tear, the same grain and the same saffron accent; what differs
is the grammar of laying and the two dyes. The four lays keep their meaning in both thematics. In
Coursed they are restated along the axis: _gather_ lays extra courses over the others from the two
ends in turn, _hold_ fits three courses along two even seams, _clear_ lifts one course out and
leaves its bay bare, _run_ tears one narrow course across into pieces that drift apart.

### Variation: one per minor

Two stated shifts, the same rule in every thematic:

- **Bath.** The pale dye is dyed one bath deeper each minor: x.1 is pale, x.2 is the reference
  shade, x.3 is deeper, down a ladder of six rungs (minors 0 to 5) and then back up. The deep dye
  never moves: it anchors the thematic.
- **Bearing.** The lay turns one fixed step each minor. In Loose the whole lay turns about the
  centre of the canvas, 7 degrees a step (x.1 is -7, x.2 is 0, x.3 is +7). In Coursed the axis
  leans 7 degrees further from the vertical each step (x.1 is 19, x.2 is 26, x.3 is 33). The
  bearing runs over five steps and starts again.

So the minors of one major read in order, pale and leaning back to deep and leaning on, and ten
minors pass before one pair of bath and bearing comes back. Minor 2 of major 0 is the reference
point of the whole system: bath 2, nothing turned. That is why the four real releases, all 0.2.x,
come out byte for byte as they were approved; the test holds their hashes.

### The six versions

| version | thematic, minor | notes    | lay    | what it produced                                                                                |
| ------- | --------------- | -------- | ------ | ----------------------------------------------------------------------------------------------- |
| v0.1.0  | Loose 1         | stand-in | gather | five slabs piled off-centre, turned back 7 degrees, the celadon pale                            |
| v0.2.0  | Loose 2         | real     | gather | seven slabs from every side, the reference celadon, nothing turned                              |
| v0.3.0  | Loose 3         | stand-in | clear  | one sheet torn and opened like a hinge, turned on 7 degrees, the celadon a bath deeper          |
| v1.1.0  | Coursed 1       | stand-in | run    | a narrow course torn into pieces along the bay, the last saffron; pale slate, the axis at 19    |
| v1.2.0  | Coursed 2       | stand-in | gather | three courses and three more laid over them from both ends; the reference slate, the axis at 26 |
| v1.3.0  | Coursed 3       | stand-in | hold   | three courses fitted along two even seams, the tab across one; deep slate, the axis at 33       |

**Stand-ins.** Only 0.2 has real releases (v0.2.0 and v0.2.2 to v0.2.5 are rendered from their
published notes). v0.1.0, v0.3.0, v1.1.0, v1.2.0 and v1.3.0 were never released: their notes in
`scripts/release-art/notes/` are short stand-ins written for this series, each marked in its first
line, and `manifest.json` marks them `standIn: true`. When one of those versions is really
released, its notes replace the stand-in and the piece is made again.

### Later majors

The grammars (Loose, Coursed) and the dye shelf (plum and celadon, madder and slate, indigo and
shell) are two ordered lists in the generator. Major N takes grammar N mod 2 and dyes N mod 3, so
majors 0 to 5 are six different thematics with no redesign: major 2 is Loose in indigo and shell,
major 3 is Coursed in plum and celadon. Read as meaning: an even major opens the shape again, an
odd major sets it. A major gets its name and sentence by one entry in `MEANINGS`; until then it
is named after its grammar and dyes. A new grammar or a new pair of dyes is one entry appended to
its list, which lengthens the cycle.

### What is weakest

**The variation in Loose, and of the six pieces v0.1.0 against v0.2.0.** The bearing is plain to
see where a lay has straight seams (hold, and all of Coursed, where the axis is the whole piece),
but _gather_ in Loose has sheets at every angle already, so turning it 7 degrees shows nothing:
there the minor is carried by the bath alone, and one bath is a difference seen side by side, not
one remembered from last month. Coursed has the opposite fault: its lays are closer to each other
than the Loose ones (everything is a course), so v1.3.0 (_hold_) is the plainest piece of the six.
Two more limits: on the palest rungs the pale dye comes close to the bone ground in the light piece
(shell at minor 0 and 1 most of all, in major 2), and the cycles are finite (ten minors, six
majors) before a pairing returns.

## How a release becomes a piece

The generator reads the release's notes line by line for four themes and the strongest one picks
the lay. The other themes and the version's seed set the rest: how many sheets, how rough the
tear (a precise release tears cleanly, a release of many hands tears rough), the tilt, and where
the accent lies.

| theme      | lay    | what is laid                                                           |
| ---------- | ------ | ---------------------------------------------------------------------- |
| many hands | gather | slabs come in from the four sides and pile up off-centre               |
| precision  | hold   | three sheets fitted along even seams, a tab across the joint           |
| wayfinding | clear  | one sheet torn in two and opened like a hinge, the ground left bare    |
| pulse      | run    | one strip torn into pieces that drift apart along a line, the last lit |

## The four releases of 0.2

Loose, minor 2: the reference shade and no turn, so these are the approved pieces unchanged.

- **v0.2.2** (project agents, agent tools, lane verdicts, shared tickets; 160 lines of notes):
  _gather_. Seven slabs from every side, none aimed at the same point, overlapping in a pile; the
  roughest tear of the series. Many hands on one table.
- **v0.2.3** (focus rings, safe area, proxy, cache, stall clock): _hold_. Three sheets, nearly
  square to each other, a seam of even width between them, the cleanest tear, and the saffron tab
  laid across the joint. Things holding.
- **v0.2.4** (Instructions split, Daily into the menu, the palette, Resume card removed): _clear_.
  One sheet torn across and opened, a sliver of the sheet under it, and the accent alone in the
  ground that was cleared. Less on the table.
- **v0.2.5** (progress jobs, notifications, work states, tracked requests, a faster pipeline, and
  thirty other things): _run_. A strip torn into six pieces that drift further apart as they go,
  the last one saffron, over one large sheet and a second from the corner because the release is
  crowded. Work in motion, reported step by step.
- **v0.2.6** (the Approved stage, protected branches, the sidebar that shrinks to icons, the update
  card, the intent check, one Settings page, and a dozen smaller fixes; 21 lines of notes, twenty
  pull requests): _gather_. Seven slabs piled from every side over a bare corner of the ground,
  the accent laid in the middle of the heap, the tear rough. Many hands again, and a crowded table.

## What it handles worst

**v0.2.3, the quiet release, and every release like it.** _Hold_ has the least freedom of the four
lays: three sheets and a joint. Two precision releases in a row differ only in where the joint and
the shelf fall and which way the whole tilts, so they look like the same piece moved a little.
The same is true, less sharply, of any two releases that share a lay: the direction has four
compositions, and the seed varies each one without inventing a fifth.

Two further limits. The reading of the notes is a word list tuned on this project's vocabulary;
a release written in other words falls back on whichever theme scores first. And a messy release
is shown as one lay with small signs of the rest (v0.2.5 gets its second slab), not as a mixture:
the piece stays calm at the cost of saying less about the mess.

## The next release

```
gh release view vX.Y.Z --json body --jq .body > scripts/release-art/notes/vX.Y.Z.md
node scripts/release-art/tear.mjs
```

That writes `vX.Y.Z-light.svg` and `vX.Y.Z-dark.svg` here and adds the release to
`manifest.json`. The version's major picks the thematic and its minor the variation; nothing else
is needed for a new minor or a new major. The same version and notes always write the same bytes;
`scripts/release-art/tear.test.mjs` checks that, the size budget (150 KB; the pieces are 15 to
29 KB), the palette, that a piece holds no text and no outside reference, how a version is parsed,
that two majors differ in their thematic's declared parameters and two minors of a major in their
variation's, and that the approved 0.2.x pieces have not changed.
`node scripts/release-art/tear.sheets.mjs src/assets/release-art/tear <out dir>` rasterizes the
matrix, the real releases and the card mock into review sheets.
