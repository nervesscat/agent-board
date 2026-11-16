# Palimpsest

Made by Claude Opus 5.5 (medium effort)

## The direction

Each piece is a sheet drawn with the flat side of a conté stick: a few broad, blunt-ended swaths
whose pigment catches only on the paper's tooth. The pigment is heavier where the hand pressed and
streaked the way the stick was dragged. Under them sits the **previous release's piece, rubbed
out**: the same swaths, as a pale smudged ghost, with the cleaner ground the eraser left.

So the series remembers itself. A release is what was drawn over the one before, and the amount
of the old sheet still showing is part of what the release says. Nothing in a piece is an object:
there are only marks, the tooth and what is left of earlier marks.

Two conté colours (a blue-black and a burnt orange) on a warm paper ground; in dark, pale sticks
on a black paper with the same roles. The grain is not laid on top: it is the threshold where
pressure meets the paper's tooth (`feTurbulence` read against each swath's pressure gradient),
plus the drag streaks along each stroke and the paper's own fibre on the bare ground.

## Why this register fits the card

- **Calm.** Three to eight marks and wide bare ground. There are no lines to vibrate and no
  gradients that read as UI chrome. The swaths' tone is broken by the tooth, so text beside the
  art never competes with a flat colour block.
- **A little rough.** Dry media on paper: ragged edges, lifted ends, a smudge where the eraser
  dragged graphite.
- **A series, not a set.** Because every piece holds its predecessor, the update card shows
  continuity: the user sees the last release fading under the new one.

## The four releases as form

| release | reading of its notes                                                                                                                                  | what it became                                                                                                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| v0.2.2  | 160 items, many hands (53 %): project agents, lane verdicts, PR queue, shared tickets                                                                 | 8 swaths at many angles (44° spread), 3 in the orange, crossing in a knot low left. Little erased: a first, lightly used sheet shows faintly under it.                                                 |
| v0.2.3  | precision (81 %): focus rings, safe area, proxy, stall clock, caps                                                                                    | 4 parallel swaths, evenly spaced, even pressure, ends nearly registered (spread 1°). One orange. Under them, v0.2.2's knot is a soft grey smudge.                                                      |
| v0.2.4  | wayfinding and clearing: split, move, leave, remove, fold (46 % of items take something away or move it)                                              | the eraser goes hard over v0.2.3's parallel bands (7 strokes, 82 % erased): they survive as two pale grey ghosts, and 4 new swaths sit at the top, staggered, with most of the sheet cleared.          |
| v0.2.5  | the messy one: 36 items, no theme leads (hands, precision and wayfinding at about a third each), and 5 of its lines are older releases folded back in | two hands at once: 6 swaths in two directions across each other's grain. Almost nothing erased (8 %) and the ghost is drawn heavier than usual, so v0.2.4's staggered marks still show across the top. |

## How the notes are read

`readThemes` counts the words of each item (the `* ... by @user` lines) against three lists: many
hands, precision, wayfinding. It returns their shares, plus:

- **volume**: how much the release says (log of its own items);
- **clearing**: the share of items whose verb removes or moves something (`move`, `split`,
  `remove`, `leave`, `fold`, ...);
- **carry**: the share of items that are earlier releases merged back in (`Release ...` lines).

`planPiece` turns those into the hand:

- **many hands** → more swaths, a wider spread of angles, more of them in the orange, varied
  pressure and width;
- **precision** → swaths parallel, evenly spaced and evenly pressed, with aligned ends;
- **wayfinding** → swaths staggered along their direction and pushed to one side of the sheet;
- **clearing** → fewer swaths and a harder eraser over the previous release's marks;
- **mix** (no theme leads) → a second hand, at 34–46° across the first;
- **carry** → the old sheet barely erased and its ghost drawn heavier.

The version's hash seeds every remaining choice (main angle, positions, pressure, the tooth's
noise seeds). The same version and notes always write the same bytes.

## Which release it handles worst

**v0.2.2**, the first in the folder. The palimpsest needs a sheet before it, and v0.2.2 has none
with notes, so its ghost is drawn from `v0.2.1` with neutral themes: a faint, generic under-layer
that says nothing about the real history. Its many-hands reading also scatters the swaths, which
leaves the right third of the sheet empty for no reason the notes give. From v0.2.3 on, the
direction is at its best, because every piece has a real predecessor to draw over.

A smaller weakness, in dark: where several pale swaths cross, `screen` blending pushes the
overlap toward white (the knot in v0.2.2 dark). It is capped, so the tooth still shows, but it is
the brightest point of the dark series.

## How the next release gets its piece

```
gh release view vX.Y.Z --json body --jq .body > scripts/release-art/notes/vX.Y.Z.md
node scripts/release-art/palimpsest.mjs
```

The generator sorts the notes folder by version. The new release is planned from its own notes
and seeded by its version, and its ghost is the previous release in the folder, drawn from that
release's own notes. The eraser rubs along the ghost's actual swaths. Nothing is drawn by hand.
The earlier pieces do not change, because each depends only on its own notes and its
predecessor's. `palimpsest.test.mjs` checks that the same version gives the same bytes, that each
piece is under 150 KB, 16:9, with no text element and no external reference, and that it uses
only the palette. It also checks that each ghost is exactly the previous piece's swaths, and that
an unseen release renders from its notes alone.

## Files

- `scripts/release-art/palimpsest.mjs`: the generator.
- `scripts/release-art/palimpsest.test.mjs`: its test.
- `scripts/release-art/notes/v0.2.2.md` … `v0.2.5.md`: the real release notes it reads.
- `v0.2.2-light.svg` … `v0.2.5-dark.svg`: eight pieces, 16–21 KB each.
- `manifest.json`: per release, its seed, its themes, what the plan made of them, and which
  release it is drawn over.
