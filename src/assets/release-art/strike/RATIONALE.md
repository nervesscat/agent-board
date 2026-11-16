# Strike: plain blocks, struck in runs until the ink gives out

Made by Claude Fable 5.2.

A candidate direction for the artwork at the top of the update card. One piece per release, light
and dark, drawn by `scripts/release-art/strike.mjs` from the release's notes and seeded by its
version.

## What it is

A piece is printed from a few plain wooden blocks: a slab, a bar, a plank, a rule. Nothing is carved
on them. A block is inked once and struck again and again along a line. Each impression overlaps the
one before and comes out paler and saltier, until the ink gives out or the block is inked again.

So the form is never a shape. It is the run: how many strikes, how true the step, where it stops,
where it starts over. A release is not illustrated; it is printed with the press set the way the
release felt.

The grain is the press's own, and all of it is one field. The sheet has a tooth (fine grain crossed
by slow streaks where the roller ran thin), and a strike prints only where the tooth is lower than
its ink reaches. A fresh strike fills almost everything; a spent one leaves the streaks bare. Since
the tooth belongs to the sheet and not to the strike, a pit that one impression missed is still
there, smaller, under the next. Each block also has two or three nicks in its edges, and they come
back in every impression of its run: that is how the eye knows one block made them all.

Three inks on one ground. On paper they are petrol, ochre and madder, and they multiply where they
overlap, so two inks make a third. On the dark ground the same three hues are lifted and printed as
opaque ink on a black sheet. A piece never uses more than its ground and three inks.

## What each release felt like as form

| Release | Its notes read as                                           | The press                                                                                                                                                                           |
| ------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.2.2  | many hands (160 changes; agents, lanes, reviews, posts)     | A broad slab crosses the sheet in nine strikes. Three other blocks in the two other inks are struck outward from where they met it. Loose register, everything overprinted.         |
| v0.2.3  | precision (focus rings, safe area, caches, caps, the clock) | One narrow bar, sixteen strikes on an exact step, square to the sheet. A second colour on the same step, one strike in three. A rule struck flush under the foot of the run.        |
| v0.2.4  | wayfinding (split, moved, removed, a palette to find by)    | The run is broken off and set again on a new line past a clear gutter. Where the next strike would have fallen the block came down without ink and left its dent. One rule crosses. |
| v0.2.5  | momentum (progress jobs, retries, a faster pipeline)        | A plank climbs across the sheet in fourteen strikes and is inked again part way. Two more jobs run beside it on their own lines, started at other times.                            |

The same four releases, in the manifest's numbers: 24, 22, 12 and 22 strikes; trueness 0.32, 0.97,
0.30 and 0.35.

## Which release it handles worst

v0.2.3, the quiet one. Its strikes overlap so closely that the run closes into one rectangle, and
the roller streaks crossing the bar seams make a check that comes near to reading as cloth. It is
the calmest piece and the tidiest, which is right for the release, but it is the one where the
direction is closest to a thing with a name, and the one that says least about its release beyond
"exact". A release with even fewer notes would get nearly the same sheet with another seed.

The second weakness is shared: the lead theme picks the layout, so two releases with the same lead
(two "many hands" releases in a row) differ only in seed, strike counts and how many other blocks
join, not in silhouette.

## How the next release gets its piece

```
gh release view v0.2.6 --json body -q .body > scripts/release-art/notes/v0.2.6.md
node scripts/release-art/strike.mjs
```

The script reads the bullets of the notes (not the links or the authors), counts four families of
words (many hands, precision, wayfinding, momentum) and takes each as its share of the whole. The
leading theme chooses the primary block and the layout; the shares set how true the press is, how
far the run reaches and how many other blocks join; the version seeds the rest. The same version
always gives the same bytes, and `scripts/release-art/strike.test.mjs` holds the committed pieces
to that, to the size budget (each piece is about 10 to 13 KB against 150 KB), to the palette, and
to having no text and no reference outside the file.

`node scripts/release-art/strike.mjs --version v0.2.6 --notes <file> --out <dir>` tries one release
without touching the committed series.

## Decisions

- **Rectangles only.** A wedge was tried and dropped: a row of leaning blocks reads as something
  falling over. Plain upright blocks, always overlapping, stay a print and not a row of things.
- **Always overlapped.** A step is between half and two thirds of the block, so a run is never a
  row of separate tiles.
- **No stacked horizontal lanes for momentum.** They read as progress bars. The run climbs instead.
- **Filters for the tooth, not thousands of specks.** Two `feTurbulence` fields and a threshold per
  ink load keep a piece near 12 KB and keep the salt in the sheet. The cost is that the grain is
  rasterized by the browser; the file is still deterministic, and it uses nothing outside itself.
- **Dark is opaque ink, not light.** Screen blending looked like a display. Opaque lifted inks on a
  black sheet still look printed.
- **Bare sheet.** At least half of every piece is untouched ground, and the bottom edge, next to
  the card's text, is the emptiest.
