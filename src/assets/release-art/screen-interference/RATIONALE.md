# Screen interference

Made by Claude Opus 5.5 (medium effort)

## The direction

A piece is two or three halftone screens, one per ink, printed on one sheet. Nothing is drawn but
dots on a regular lattice, each sized by its screen's tone. Every screen prints one broad band that
runs off the sheet, its long sides a halftone fade. The image is what happens where two bands cross.
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

Three inks and a ground, fixed for the series. Light prints indigo `#2C467C`, vermilion `#D9553B`
and ochre `#C99A2E` on paper `#F0EBE1` and multiplies them where they overlap. Dark prints lighter
pulls of the same inks (`#6F93D8`, `#E8694D`, `#D8B24E`) on blue-black `#14161C` and screens them,
so overlaps brighten instead of darkening. The grain is ink-brown on paper and paper on black.
A third ink prints lighter than the first two, so three inks stacked stay inks and not mud.

## How a release becomes a piece

`scripts/release-art/screen-interference.mjs` reads the release notes (only the change lines, not
the links, authors or the release PR) for four themes and their volume: **many hands** (agents,
tools, lanes, reviews, tokens, sessions), **precision** (focus, cache, retry, keep, cap, clock,
proxy, lock), **wayfinding** (move, split, remove, menu, fold, rename, into) and **signals**
(progress, jobs, notices, state, live, stall, icons). Volume is the number of changes on a log
scale.

A theme speaks when it is at least 0.5 and within 0.15 of the strongest, and at most two speak, so
a sprawling release does not get every gesture at once. Then:

- **Screens:** three when many hands speak in a large release, otherwise two.
- **Angle gap** between screens: 5.5° for a loose release down to 1.4° for a precise one. A small
  gap is one long, slow fringe; a wider one packs them tight.
- **Warp** of the later screens: up to 6 px for many hands in a large release, almost none for
  precision. It is the only thing that makes the fringes bend.
- **Bands:** nearly parallel and stacked for precision, crossing wide (24–36°) for many hands,
  between otherwise; narrower when wayfinding speaks, so more paper shows.
- **Gestures:** the held edge, the lane and the ramp, as above.

The version seeds every other choice (base angle, tilt, ink order, band positions, mottle), so the
same version and notes write the same bytes every run.

## The four releases

| release | what it felt like                                                   | what speaks       | as form                                                                                                                                                                              |
| ------- | ------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0.2.2   | 159 changes: agents, lanes, reviews, cards. Many hands, and a mess. | hands, wayfinding | Three screens, bands crossing wide, the warped screens' fringes knotting where all three meet; a lane cut through the middle, the fringes picking up out of phase on the other side. |
| 0.2.3   | 15 small fixes: focus rings, caches, clocks, sticky headers.        | precision         | Two screens 1.4° apart, nearly no warp: one long straight fringe. The ochre band stops on a hard vertical edge. The quietest piece, most of it paper.                                |
| 0.2.4   | 13 changes that move things: Instructions split, Daily moved.       | wayfinding, hands | Two narrower bands, a lane of paper through them; across it the blue screen is half a dot over, so the fringes jump. More paper than any other piece but 0.2.3.                      |
| 0.2.5   | 31 changes: progress jobs, notices, work states, live work, notes.  | signals, hands    | Three screens crossing on a diagonal; the ochre screen ramps up from nothing across the sheet, so the third ink arrives gradually, and the warped fringes swell where it does.       |

## Where it is weakest

**0.2.2.** It is the release with the most in it, and every theme in it is strong, so the reading
has to throw most of it away: only two themes may speak, and its precision and signals are lost.
Three screens crossing wide and a lane is the busiest piece in the series; in light, where indigo,
vermilion and ochre all overlap, the multiply goes dark brown and the fringes there read as a
smudge rather than a beat. It is still calm next to text, but it is the piece where moiré turns
into texture. The dull release (0.2.3) holds up better than expected: one slow fringe and a hard
edge is enough.

A second, smaller weakness: moiré depends on the screens resolving. At a third of the size the
pitch is under six pixels and the fringes still read (the series sheet at one-third shows it),
but a much smaller thumbnail would alias into a plain tint. The test keeps the pitch and the
fringe width above that floor.

## How the next release gets its piece

```
gh release view vX.Y.Z --json body --jq .body > scripts/release-art/notes/vX.Y.Z.md
pnpm exec prettier --write scripts/release-art/notes/vX.Y.Z.md
node scripts/release-art/screen-interference.mjs
```

That writes `vX.Y.Z-light.svg` and `vX.Y.Z-dark.svg` beside the others and rewrites
`manifest.json`, which records the themes read, what spoke, each screen's ink, angle, pitch and
warp, and the gestures. To try a release out without touching the series, pass
`--version vX.Y.Z --notes <file> --out <dir>`. No hand-drawing: the notes and the version are the
whole input.

## Checks

`scripts/release-art/screen-interference.test.mjs`: the same version gives the same bytes; the
committed files match a fresh run; every piece is 16:9, under 150 KB, has a title and description,
no text element, no style, script, image, use or external reference, and only its own filter
references; only the declared palette's hexes appear; the themes steer the plan (a precise release
gets a held edge and a smaller gap, a moving one a lane); the pitch and the fringe width stay
legible at a third; and each release gets its own screens.
