# Burin: cross-hatched tone

Made by Claude Fable 5.2

## The direction

Tone is built the way an engraver builds it. A piece is two or three **passes** of straight,
hand-ruled hatch strokes: each pass is one ink, at one angle and one pitch. Where a pass wants more
tone it rules more of its lines (every fourth line first, then the lines between, then the rest),
where it wants less it leaves them out, and where two passes cross the tone deepens into cross-hatch.
Nothing else is on the sheet: no outline, no fill, no curve, no gradient. Every mark is a closed
sliver that starts at a point, swells to its weight and returns to a point.

The palette is paper, one graphite ink and two spot inks (sanguine and a blue-green). The dark piece
is the same plate printed in lifted inks on an ink ground. The grain is the plate's own: the taper
of each stroke, the breath where the hand lifts on a long line, lines that drift a little off their
pitch, a burr that bites the strokes' edges, the ground wearing through the ink, and a little dust.

It is not a contour field (there is no terrain, and no line bends), not a halftone and not a flow
field. It is calm beside text because it is tone, and tone made of one repeated mark.

## How a release becomes a plate

The notes are read line by line for three themes, and counted:

| what the notes say                 | what the plate does                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| many hands (agents, lanes, review) | a third pass in the third ink; the angles spread apart; the passes are pulled toward one meeting place, so they overlap                                                               |
| precision (keep, cap, cache, fix)  | tighter pitch, steadier ruling, short tapers; a straight edge, square to the first pass, holds the hatching: the tone is densest at the edge, with a narrow cross-hatched strip on it |
| wayfinding (move, split, remove)   | the plate is ruled lightly all over and one straight channel is left bare through it, opening as it goes; one flank is ruled in a spot ink                                            |
| volume (how many lines)            | how far the passes reach over the sheet                                                                                                                                               |

The themes act by degree, not as modes: a release that is a third precision gets a faint edge, not
none. The version seeds everything else: the base angle, where the passes meet, which spot ink
leads, each line's drift, each stroke's length.

## The four releases

| release | read as                                          | the plate                                                                                                                                              |
| ------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| v0.2.2  | many hands 45 %, wayfinding 37 %, 160 lines      | Three passes at three spread angles overlapping across most of the sheet, with the channel only half cut: the fullest, most worked plate.              |
| v0.2.3  | precision 80 %, 16 lines                         | Two passes at right angles, tight and steady. Half the sheet is bare; the other half ends on one straight edge, with a cross-hatched strip holding it. |
| v0.2.4  | wayfinding 56 %, many hands 31 %, 14 lines       | A lightly ruled field with one bare channel through it, widening downward; sanguine on one flank, blue-green on the other.                             |
| v0.2.5  | many hands 48 %, precision 30 %, wayfinding 22 % | Three passes that stay mostly apart around a bare middle, with a faint edge thinning the first pass: broad, airy, several things kept in view at once. |

## What it handles worst

**v0.2.2.** It is the largest release and the one with the most hands, so every dial that adds
strokes is turned up at once: three passes, wide reach, heavy overlap. It is the busiest piece of the
four and the least calm above text, and its half-strength channel is nearly lost in the hatching.
A big, mixed release will always come out as "a lot of cross-hatch", which is honest but is also
the least distinctive plate the direction makes. v0.2.2 and v0.2.5 are both hands-led, and they
differ mostly through their seeds and through v0.2.5's smaller volume, not through a different idea.

Second: the channel of v0.2.4 is the nearest this direction comes to something a viewer could name.
It was a bent band at first and read as a road; it is now one straight, tapering clearing.

## How the next release gets its piece

```
gh release view vX.Y.Z --json body --jq .body > scripts/release-art/notes/vX.Y.Z.md
node scripts/release-art/burin.mjs
```

That writes `vX.Y.Z-light.svg` and `vX.Y.Z-dark.svg` here and adds the release to `manifest.json`,
with the themes it read and the plan it drew from them. The existing pieces do not change: each is
seeded by its own version. `--version`, `--notes` and `--out` draw a single release somewhere else.

The test (`scripts/release-art/burin.test.mjs`) holds the rules: the same version gives the same
bytes, the committed files match the generator, every file is 16:9, under 150 KB, without text or
any external reference, in the declared palette, and made of straight strokes only.
