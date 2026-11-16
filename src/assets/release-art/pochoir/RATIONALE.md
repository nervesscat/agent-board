# Pochoir: pigment sprayed past cut stencil edges

Made by Claude Opus 5.5 (medium effort)

## The direction

Every mark is one pass of an airbrush along the edge of a cut card. The side that lay against the
card is razor-sharp; the far side falls away into a speckle of loose droplets. Nothing else is
drawn: no closed shapes, no outlines, no hatching, no gradients. The only events are the cut edges
(long straight cuts, and now and then a very shallow arc) and the spray drifting off them.

- **Two inks on a ground.** Light: verdigris `#1E4F4A` and minium red `#C8532D` on paper `#EEE8DC`,
  overprinting by multiply. Dark: celadon `#8CC2B2` and coral `#E8845C` on soot `#16191A`, laid by
  screen. Red is always held back as the accent: never the first pass, rarely more than a third.
- **The grain is the medium itself.** The spray is solid ink broken into droplets: droplet noise is
  thresholded against the pigment's falloff, so density, never opacity, carries the tone. The knife's
  edge wobbles by two pixels. The ground carries sparse round flecks and a faint, slow mottle.
- **Calm by construction.** A third of the card (the calm side) never takes an anchor, the spray
  always fades into bare ground, and every cut leans the same way (14 to 30 degrees, never level, so
  no edge reads as a horizon).

Why it is the right register for the update card: it is print, like the directions the human kept
(the contour field, risograph, thermal), but it is not a field at all, and not another treatment of
one. It is quiet at a distance (a few soft-edged bands of colour), rough up close (every pixel is a
droplet or bare paper), and it never fights type: there is no line, letterform or texture at text
scale.

## How a release becomes passes

The generator reads every line of the release notes and counts four themes by their words:
**agency** (agents, reviews, PRs, lanes, tokens, sessions), **precision** (keep, cache, retry,
clock, focus, proxy, fix), **wayfinding** (move, split, menu, palette, remove, fold, page) and
**signal** (show, notice, progress, state, live, icon, job). From their shares:

| notes say                            | the passes                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| many hands (agency, and a long list) | more passes, some in the second ink, some drifting back the other way; a set share of them cross the others along a counter-lean |
| precision                            | fewer passes, all parallel, short and hard falloff, no crossings, no arcs                                                        |
| wayfinding                           | the card is stepped along a path: passes in a staircase, same lean, more bare ground, one shallow arc where the way turns        |
| signal                               | echoes: the card slid on and sprayed again, each time lighter                                                                    |

The version seeds everything else (the lean, the calm side, positions, lengths, noise), so the same
version always gives the same bytes.

Two rules came from looking at the renders. Early seeds drew a sailboat, a roof and an arrow, so:
cuts never stand near vertical (the free angle is gone: a pass takes the lean or the counter-lean,
plus a few degrees), and two cuts may cross in an X but never meet near an end in a V, L or T
(`meetsAtEnd`, tested; a pass that would is drawn again). A fibre grain aliased into scanlines when
the card scaled the piece down, so the grain is round.

## The four releases

| release    | items | read as                      | what it produced                                                                                                                          |
| ---------- | ----- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **v0.2.2** | 160   | agency 0.35, wayfinding 0.33 | eight passes, four of them crossing: a loose lattice of hands in the upper left, one red pass through it, one shallow arc under it        |
| **v0.2.3** | 16    | precision 0.50               | four short, hard, parallel cuts, one of them red, in a lot of bare paper: the quietest piece                                              |
| **v0.2.4** | 14    | wayfinding 0.39, agency 0.35 | six passes stepped down the card as a staircase, three of them sprayed twice, one shallow red arc at the foot; the right third left clear |
| **v0.2.5** | 36    | agency 0.31, signal 0.29     | six passes on the right, two red, two crossing, each sprayed again once or twice: dense, layered, still one lean                          |

They hold as one family (the same lean, two inks, the same droplet, the calm third) and differ in
what the release did: crossing, holding, stepping, repeating.

## The release it handles worst

**v0.2.2.** It is ten times longer than the others (160 lines, a release that carried the board's
early history), and the direction can only say "many" up to about eight passes before the card turns
to mud, so its size barely shows. It is the only piece where the calm third is not quite calm:
the lattice is the busiest thing in the series. Its one arc, under the crossings, reads faintly as a
soft hill. A lower cap on passes would calm it, and make it look like v0.2.5; I kept the cap.

v0.2.3, the dull one, is the opposite risk: four thin bands could read as unfinished. At a third of
the size it still holds, because each band keeps at least 20 pixels of falloff on the scaled card.

## How the next release gets its piece

```
gh release view v0.2.6 --json body -q .body > scripts/release-art/notes/v0.2.6.md
node scripts/release-art/pochoir.mjs
```

That regenerates the whole series and the manifest (the old pieces do not change: the same version
and notes give the same bytes). To make one piece without touching the series:
`node scripts/release-art/pochoir.mjs --version v0.2.6 --notes <file> --out <dir>`.

A release whose words the generator does not know still gets a piece: with no theme to read, it
gets the plainest one, a few parallel cuts (four for a ten-line release) with no crossings, echoes or
staircase. The word lists live at the top of the generator; a new kind of release is a new stem
there.
