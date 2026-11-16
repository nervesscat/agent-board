# Torn paper

Made by Claude Opus 5.5 (medium effort)

Each release is a collage: flat, matte papers torn by hand and laid on a paper ground (a
black card in dark mode). The fields are hard and flat. Every torn edge frays into the
pale core of the paper, and the pieces sit on the ground with a short soft shadow. The
notes don't decide what the collage shows, because it shows nothing. They decide how
the paper was handled: how many scraps, torn or cut, overlapping or butted, laid or
lifted, mended. A release reads as a gesture of the hand, never as a picture.

## Why this register for the update card

- **Calm by construction.** Three papers, and two of them are quiet: ink, a dark
  blue-black, and fog, a pale grey-blue. The third, persimmon, is an accent and the
  generator holds it to one to three scraps. Paper never covers more than 60% of the sheet,
  and the bottom band next to the card's text stays open.
- **Rough without noise.** The grain is the paper's: a fine two-tone speck and a slow
  mottle over everything, fibres along every tear (a displacement filter, so the paths
  stay small), and a hairline of pale core where the coloured layer gives way. Nothing
  in it is a gradient.
- **Abstract.** No piece stands for anything. Two early versions failed this test and
  were thrown out: a grid of scraps that read as a brick wall, and left-aligned strips
  of different lengths that read as a bar chart. That is why the pieces are now torn
  quadrilaterals with slanted ends, and why "holding" is a matched tear rather than a
  stack of bars.

## What each release felt like, as form

| release | notes                                                                                      | lead theme (share)            | handling                                                                                                                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.2.2  | 159 lines: agents, lanes, the PR queue, reviews, cards, desktop                            | many hands (0.48)             | 15 scraps in four loose courses, torn on most sides, each at its own angle (up to ±5°), overlapping; ink leads, three persimmon scraps (one of them the piece that was moved); one piece lifted                                              |
| v0.2.3  | 16 lines: focus rings, safe area, proxy, CI cache, stall clock, sticky nav                 | holding (0.68)                | one trimmed ink sheet torn twice and laid back so each tear's two sides still match, 7 px apart; the persimmon shows only through one seam and just below the edge                                                                           |
| v0.2.4  | 14 lines: Instructions split, Daily into the menu, palette, preview window, Resume removed | less clutter (0.50)           | a small cluster on one side and a wide open field; two pieces lifted away leave pale torn ghosts, one moved out toward the field and turned persimmon; fog leads                                                                             |
| v0.2.5  | 36 lines: release merges, progress jobs, retries, locks, stalls, notes, live work          | hands (0.38) + mending (0.32) | long fog-led courses with one persimmon scrap; four pieces torn in two and laid back with a ragged pale seam, slightly out of true (the retries and fixes); three older pale sheets showing underneath (the four earlier releases merged in) |

The family is held by the paper itself: the same three papers, the same pale rim, grain
and shadow, and the same band of the sheet. What changes from one release to the next is
the hand.

## How the notes become handling

`readThemes` counts, for each line of the notes, which of four stem lists it touches
(once per list per line), and normalises the counts into shares:

- **agency** (agent, project, share, queue, review, delegate, lane, verdict, decision…)
  gives more scraps (`splits`), more rotation, more overlap, and the ink lead.
- **precision** (focus, cache, clock, safe, proxy, cap, sticky, keep…): above 0.3 the
  sheet becomes one trimmed sheet with matched tears (`matched`). Below that it still
  raises the share of cut edges and damps rotation.
- **wayfinding** (move, split, remove, menu, palette, fold, drop, sidebar…) lowers
  coverage, pushes the courses to one side, and lifts pieces (`lift`). Lifted pieces
  are removed or moved alternately, and the moved one takes the accent.
- **mending** (retry, fix, restart, settle, stall, lock, flaky, stop…) tears pieces in
  two and lays them back (`mends`).
- Lines that are a release or version merged in from earlier work (not the release's
  own release line) are counted as `carried` and lie underneath as older pale sheets.
- The number of lines sets the volume: more lines give more courses and more scraps.

The seed is a hash of `torn-paper:<version>`, and every random choice comes from it. The
light and dark variants tear identically, because both renders restart the same stream.

## The release it handles worst

**v0.2.2.** At 159 lines it is three releases in one, and the hands theme dominates by
volume. The direction answers with its busiest sheet: 15 scraps in a full-width band. It
is still calm beside text, because the band sits high and the lower third is empty. But
it is the one piece where the eye has to work, and in dark mode the lifted ghosts and
the under-sheet read only as faint grey patches. A bigger release would get more scraps
in the same band, not a bigger band (coverage is capped at 0.6). That keeps the card
calm, but past about 200 lines the scraps would start to read as confetti.

v0.2.3 is the opposite risk. A release with almost nothing in it gives a single dark
sheet, which is heavy for the light card. It is the most striking piece of the four, but
it rests on two hairlines and a glimpse of persimmon.

## How the next release gets its piece

```
gh release view v0.2.6 --json body -q .body > scripts/release-art/notes/v0.2.6.md
node scripts/release-art/torn-paper.mjs
```

This rewrites the series and `manifest.json` (the committed pieces don't change: the
same notes and version give the same bytes). To render only the new release, somewhere
else and without a manifest:

```
node scripts/release-art/torn-paper.mjs --version v0.2.6 --notes notes.md --out /tmp/art
```

## Hard rules, checked by `torn-paper.test.mjs`

- The same version gives the same bytes, twice in a row and against the committed files.
- Every SVG is 1600×900, under 150 KB (the largest is 33 KB), with no `<text>`, no
  `<image>`, `<use>`, `<style>`, script, link or external URL, and only the declared
  palette.
- Each tear's two sides match within the 7 px gap, so the "holding" gesture is exact.
- The pale rim stays at least 2 px wide at one-third size, and the mottle's scale
  survives the downscale.
- A release it has never seen gets its pair of pieces, and different releases get
  different handling.
