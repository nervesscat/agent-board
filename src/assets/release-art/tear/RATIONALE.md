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

## The four releases

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
`manifest.json`. The same version and notes always write the same bytes;
`scripts/release-art/tear.test.mjs` checks that, the size budget (150 KB; the pieces are 15 to
29 KB), the palette, and that a piece holds no text and no outside reference.
`node scripts/release-art/tear.sheets.mjs src/assets/release-art/tear <out dir>` rasterizes the
series into review sheets.
