# Tracks

Made by Claude Fable 5.2.

## The direction

A plate that recorded what passed through it. Nothing is drawn but paths, and every path is a row
of beads. There is no field of lines, no tone, no filled shape: a few dozen open trails on a grainy
ground, and most of the plate left empty.

One rule moves every trail. It turns at a rate set by how much momentum it has left, and it loses
momentum as it goes. So a trail with plenty crosses the plate almost straight, one with less bends
into a long arc, and one with little winds into a coil and stops. The beads get heavier as the
trail slows. Which way a trail bends decides its ink: the two colours are the two signs, and the
neutral is for what does not bend. Colour is never a decoration here, it is a reading.

The grain is the plate's own: fine emulsion specks, slow uneven exposure, a few stray beads that
belong to no trail, a few hairline scratches, and a small displacement that puts every bead a
little off its place, so that no line looks ruled by a vector tool.

Palette: a bone paper or a blue-black ink ground, one neutral, a teal and an amber. Four colours
in a piece, each set chosen for its ground.

## How a release becomes a plate

The notes are read line by line for four themes (word stems, listed in the generator), and each
theme is one way of loading the plate:

| theme   | the notes talk about                      | on the plate                                             |
| ------- | ----------------------------------------- | -------------------------------------------------------- |
| hands   | agents, lanes, reviews, delegation, posts | forks: one trail arrives, several leave, some fork again |
| holding | keep, cache, cap, focus, sticky, proxy    | orbits that keep their radius, and passes at one pitch   |
| route   | split, move, remove, menu, palette, fold  | one tight bundle that the field sorts into lanes         |
| flight  | progress, jobs, speed, remote, run, state | a beam of fast passes, each shedding small hooks         |

The strongest theme loads the plate. The second one adds a few trails of its own on the other
side, smaller. The number of lines in the notes raises the count a little, on a logarithm, so a
long release is fuller but never crowded. The version seeds everything else: where the weight
sits, each heading, each momentum, the grain.

## What each release felt like as form

- **v0.2.2** (154 lines: project agents, lanes, verdicts, the PR queue). Forks. Straight arrivals
  come in from the edges and each one breaks into two to four trails of both signs; the fast ones
  leave as arcs and fork once more, the slow ones wind down nearby. Many hands is many departures
  from shared points, in both inks, crossing each other's paths.
- **v0.2.3** (15 lines: focus rings, the safe area, the proxy, caps, the clock). Orbits. Three
  trails that go round and keep most of their radius, stopped while they are still rings, and
  three passes at one even pitch across the top. The emptiest plate of the four, on purpose:
  things holding.
- **v0.2.4** (13 lines: Instructions split, Daily moved, the palette, a card removed). A bundle.
  Nine trails enter as one tight band, and the field sorts them by momentum into nine lanes that
  open across the plate. What was cleared away leaves early, in the other ink, and winds down
  above the band.
- **v0.2.5** (31 lines: progress jobs, remote mode, work states, a faster pipeline). A beam.
  Parallel fast passes on a diagonal, in loose groups, some starting or stopping on the plate,
  with small hooks shed along them, and one fork beside it from its second theme.

## Which release it handles worst

**v0.2.2.** Two reasons. First, scale: it is ten times the size of the others and the plate shows
only one more fork than a small release would get, because the direction caps its own density to
stay calm above the card's text. The piece says "many hands", it does not say "enormous". Second,
it is the plate with the most full coils, and a coil that winds all the way in is the form closest
to something a viewer could name (a scroll, a shell). The field's drift and the early stops keep
most of them hooks and open turns, but v0.2.2 is where that risk is highest.

A smaller weakness is shared by all four: the theme lists are a reading of this project's
vocabulary. A release whose notes use none of the words falls back to an even reading and gets
forks. The lists are short and in one place, and adding a word is the intended way to tune it.

## How the next release gets its piece

```
gh release view vX.Y.Z --json body --jq .body > scripts/release-art/notes/vX.Y.Z.md
node scripts/release-art/tracks.mjs
```

That regenerates the series with the new release in it, dark and light, and rewrites
`manifest.json`, which records for each release its theme reading, its plan and the size of its
files. One release on its own, anywhere:

```
node scripts/release-art/tracks.mjs --version vX.Y.Z --notes path/to/notes.md --out /tmp/art
```

The same version and notes give the same bytes on every run: `scripts/release-art/tracks.test.mjs`
checks that, the size budget (the pieces are 12 to 16 KB against 150 KB), that no piece holds a
text element or an outside reference, and that the committed files are what the generator writes.
