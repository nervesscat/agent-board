# Loom

Made by Claude Opus 5.5 (medium effort)

## The direction

A release is woven, not drawn. Pale warp threads run top to bottom and the release's notes are
carried across them as weft. Most of the cloth is undyed, a quiet balanced weave; where the notes
put weight, dyed weft is laid in as blocks, in three dyes (indigo, madder, weld yellow) on an undyed
ground in light and on an ink-dark warp in dark mode. Like a Bauhaus tapestry, the only image is the
interlacing itself: there is no motif, no symbol and nothing drawn over the cloth, so no object can
be named in it. Up close it is threads, and from across the room it is a few fields of colour.

The grain comes from the loom, not from a filter laid over a picture:

- **the beat** — picks sit a little unevenly, more so when the release was loose;
- **abrash** — each dyed pick takes the dye slightly differently, so a block is never one flat colour;
- **the hand** — a slow displacement bends the threads the way tension does on a hand loom, with a
  fibre fuzz on every edge;
- **faults** — a broken warp, or a weft that floats over too many threads.

Dyed blocks are weft-faced, as in a tapestry. The pick covers the warp, which shows only as faint
ribs where it crosses over, so a block reads as a solid field at a third of the size and as weave
structure at full size. The structure carries meaning:

- **plain weave** — things holding;
- **twill** — direction;
- **a twill that turns** (its diagonal flips at a column) — reorganizing;
- **satin** — long smooth floats, for a release that is mostly about signals.

## How the notes become cloth

Every item of the notes is read as one of four themes, by its stems and, more strongly, by the
verb it opens with. Version bumps are dropped. Each theme has its own way of laying weft in, and a
theme that is less than a fifth of the release lays nothing:

| theme      | read from                                      | laid in as                                                                                                                                                                            |
| ---------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agency     | agents, delegation, reviews, lanes, sharing    | many small inlays in every dye, abutting with slits: many hands on one cloth                                                                                                          |
| precision  | focus, cache, clock, proxy, sticky, keep, fix  | a few bands squared to one shared edge and run off the cloth, one broad, a hairline of madder holding them; a tighter, more even beat everywhere                                      |
| wayfinding | move, split, remove, fold, menu, palette       | a few big blocks pushed to the far side, woven in a twill that turns; a **bare window** where a block was taken out (no weft laid, only warp); fewer blocks overall, more empty cloth |
| signal     | stall, alive, progress, notifications, restart | one row of small equal inlays across the cloth at a steady interval, a pulse; it stalls (beats missing), then catches up with one long beat                                           |

The theme with the most items sets the ground weave: plain for agency and precision, twill for
wayfinding, satin for signal. The version, hashed, seeds every other choice: the side the
composition leans to, the sizes and places of the blocks, the beat, the abrash, the faults and the
noise of the hand. The same version and notes give the same bytes, which the test checks.

## The four releases

| release | read as                                      | what the cloth does                                                                                                                                                                                                                                                               |
| ------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.2.2  | agency 0.47, wayfinding 0.25, precision 0.20 | The busiest cloth: sixteen small inlays in all three dyes crowd under two indigo bands, abutting and overlapping in turn: many hands on one cloth. A bare window below the cluster is the Reviews page and the Resume notes taken out. Plain ground.                              |
| v0.2.3  | precision 0.91                               | The quietest: five indigo bands squared to one edge and run off the right of the cloth, one broad, with a madder hairline under it. Nothing else is laid in; the beat is tight and even, and the faults are fewest. Precision, quiet polish, things holding.                      |
| v0.2.4  | wayfinding 0.58, agency 0.42                 | The ground itself turns to twill. Three big blocks are pushed to the right, each in a twill whose diagonal turns (herringbone); a few small inlays are left between them, and a bare window marks the Resume card removed. Much of the cloth is left empty: less clutter.         |
| v0.2.5  | signal 0.48, agency 0.24, precision 0.20     | A satin ground. Two indigo bands come in from the left edge, a small cluster of inlays sits under them, and along the bottom runs the pulse: equal weld-yellow beats that stall for a few beats, then catch up with one long one. Liveness, stalls, and the backlog brought back. |

## Which release it handles worst

**v0.2.3**, the dull one. With precision alone, the cloth is a stack of plain stripes squared to one
edge. That is the meaning (things holding, nothing out of place), but it comes close to an
ordinary striped utility cloth, the most familiar thing this direction can make. It is still
abstract, and calm next to the card's text, but it has the least to look at. The release with the
most items (v0.2.2) is handled by capping the blocks at about a third of the field, so it reads as
busy, not as noise.

## How the next release gets its piece

```
gh release view vX.Y.Z --json body -q .body > scripts/release-art/notes/vX.Y.Z.md
node scripts/release-art/loom.mjs --version vX.Y.Z --notes scripts/release-art/notes/vX.Y.Z.md --out <dir>
```

No hand work. Add the version to `SERIES` in the generator to make it part of the committed
series and the manifest. A release with a new kind of change still gets a piece. Items that match no
theme only add faults, so an unreadable release gives a mostly undyed cloth, never an empty
one.

## Hard rules, checked by `scripts/release-art/loom.test.mjs`

- the same version writes the same bytes, and the committed files match a fresh run;
- every piece is 16:9 (1600×900), under 150 KB (the largest is about 28 KB), with no text element,
  no script, image, `use`, style or link, and no reference outside the file;
- only the declared palette's hexes are used, three dyes per mode;
- threads stay more than 3 px wide at a third of the size.
