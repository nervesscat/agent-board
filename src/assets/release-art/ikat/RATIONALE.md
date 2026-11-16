# Ikat: release artwork as a resist-dyed warp

Made by Claude Fable 5.2

## The direction

Every piece is one cloth seen flat: 200 vertical warp threads on a 1600 × 900 field. Before weaving,
groups of threads (courses) are bound and dyed; on the loom each bundle of threads slips a little
along its length, so every block of colour ends in the stepped, feathered edge that warp ikat is
known by. Colour is carried by threads only. Nothing is outlined, nothing curves, nothing is drawn
on top of the cloth: the only event in a piece is where the colour of a thread changes.

- **Palette.** Undyed cotton, an indigo vat, madder, and a little weld. In light the cloth is cotton
  and the bands are indigo; in dark the cloth is vat-dyed and the bands are the cotton the ties kept
  white. Madder is the second hue in both, weld is kept to a tie line or one over-dyed core.
- **Grain.** It is the cloth's own, not a filter laid over a drawing: threads of three widths and four
  shades, bundles of three to seven threads that slip together, a stray thread now and then that
  slipped much further, dye that wicks thinner past the end of a block, slubs, a plain-weave weft
  tick, and a slow mottle along the warp. Two small turbulence filters add the mottle and a tooth;
  everything else is strokes.
- **Why it suits the card.** A cloth is calm by construction: one direction of line, flat colour,
  soft edges, wide bare margins. It is rough close up and reads as two or three flat bands at a third
  of the size. No part of it is a picture of something.

## How the notes become a binding

`readThemes` counts the changelog items and the share of them that speak of each theme;
`planPiece` turns that into the binding, and the version seeds every remaining choice.

| what the notes say                            | what the binder does                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| how many items                                | more courses, a wider field, up to three bands                                           |
| many hands (agents, reviews, queues)          | stagger: neighbouring courses pushed up and down; a run of courses dyed in the other hue |
| wayfinding (moved, split, renamed, found)     | drift: the courses step one way across the cloth                                         |
| things holding (kept, capped, fixed in place) | less stagger and drift, tighter slip, narrow tie lines above and below                   |
| repairs, and sheer size                       | slip: how far the bundles slid, so how soft the edges are                                |
| things removed                                | a course bound but barely dyed: a pale wash in the band                                  |

## What each release felt like as form

- **v0.2.2** (155 items; agents, reviews, the PR queue, everything at once). Many hands: sixteen
  courses, three bands running off both edges of the cloth, staggered against each other, with runs
  dyed in the other hue and four courses held back. The busiest piece, and the loosest edges.
- **v0.2.3** (15 items; focus rings, safe area, caps, sticky things). Things holding: one level band,
  no stagger and no drift, the tightest slip of the four, three narrow tie lines above and below it,
  one core held inside. The quietest piece.
- **v0.2.4** (13 items; Instructions split, Daily moved, a palette, a card removed). A route: one
  narrow band stepping down across the cloth, one stretch of it held back to a wash where things were
  taken away, a core carried through the last steps.
- **v0.2.5** (31 items; four releases merged, jobs and notices, retries, a broken import). A mixed
  release after repairs: two bands with little drift, eleven courses, edges almost as loose as
  v0.2.2's, one tie line under it.

## Which release it handles worst

**v0.2.3.** A release that is all quiet polish gives the binder nothing to stagger and nothing to
step, so the piece is one level band with tie lines. It is honest and it is calm, but it is the
closest of the four to a plain rectangle, and at a third of the size its feathered edge, which is
all of its character, is nearly gone. The direction needs some movement in the notes to show what it
can do; a dull release gets a dull cloth.

The second weakness is the reverse: v0.2.2 is busy. It is the only piece that fills the field, and
beside small text it is the least calm of the four.

## How the next release gets its piece

```
gh release view vX.Y.Z --json body --jq .body > scripts/release-art/notes/vX.Y.Z.md
node scripts/release-art/ikat.mjs
```

That writes `vX.Y.Z-light.svg` and `vX.Y.Z-dark.svg` here and adds the release to `manifest.json`.
Nothing is drawn by hand and no earlier piece changes: each is seeded by its own version.
`--version` with `--notes` and `--out` renders one release somewhere else without touching the
manifest. `scripts/release-art/ikat.test.mjs` holds the rules: the same bytes on every run, the
committed files equal to a fresh run, every file under 150 KB, no text, no external reference, only
the five palette colours.

## Decisions

- Courses touch. An early pass left bare threads between courses and gave every block its own hue;
  the blocks read as a row of separate things. A band is now one piece with a stepped edge.
- A removed thing is a pale wash, not a hole. A bare gap cut a band into two rectangles.
- Every band follows the same steps, so the bare cloth between two bands steps with them.
- Bytes are spent on strokes grouped by hue, dye take and thread width: 20 to 82 KB per piece.
