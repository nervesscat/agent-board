# Faceted tension: a release-art direction

A candidate direction for the update card's artwork: **hard-edged planes over a soft field, with
refracted light on a few edges**. The mass reads as structure that held: shards pressed together,
seams that stopped opening, a fracture you see as composition and not as a broken object.

It is abstract by construction. There is no shield, lock, crystal, node graph or mascot. If a
viewer can name the thing, the piece failed.

## What the release felt like, as form

The three pieces use the same generator, the same palette and the same cut language; the release's
notes choose how much of each.

**v0.2.2 — many hands (dense, splintered).** The largest release: agents, reviews, lanes, the queue,
tickets. That is the densest piece: forty-odd planes, cuts in several directions, a rust face on
several edges, the field's ruling close together. Many small decisions made at once, none of them
free-standing; the tension is distributed across the whole frame. It is the most active of the
three and the one that reads most like an organisation rather than an object.

**v0.2.3 — precision, things holding (few planes, tight seams).** Focus rings, a safe area, a
proxy, a cache, a clock, sticky nav: small, exact changes whose point is that nothing moves. The
generator reads that from the notes as `holding`: it cuts in fewer directions, keeps the planes
large, and quiets the seams and the grain. Two edges still catch light, but the composition is
mostly a set of wide, balanced faces. The release is allowed to be the calm one.

**v0.2.4 — wayfinding, less clutter (a cleared channel).** Instructions split, Daily moved into the
menu, a command palette, the Resume card removed. That is a release about what is no longer there,
so the mass is cut by a straight, empty channel with the same hard edges as the planes: two masses
with a path between them and more paper than either neighbour. The accent count stays low; the
composition does the reorganising, not the colour.

Same family: the palette, the refraction angle's families of cuts, the lit edges and the grain tile
are shared. Different pieces: plane count, cut spread, seam weight, the channel and the accent areas
all come from the release.

## Which release it handles worst

**v0.2.3.** The direction feeds on pressure: it needs planes pushing against each other and
something about to give. A release whose notes are all about holding still gives it little to push
against, so its piece has to underplay deliberately — fewer cuts, quieter seams, wider faces — and
it comes closest to reading as decoration rather than as a statement. It still belongs to the
family and it is still legible at card size, but if this direction is chosen, 0.2.3 is the release
where the artwork has the least to say and where the other directions will look most different from
it. The 0.2.4 piece is the second weakest in a different way: the cleared channel is a strong,
almost graphic device, and it risks reading as a layout choice rather than as the release's mood.

## Why this register fits an app card

- **Material, not interface.** Paper and ink, two muted hues (cool steel, warm rust), flat fills and
  hard edges. Nothing in it looks like a default gradient, a stock vector or a UI screenshot.
- **Quiet enough to sit above text.** The card's top half holds no type; the artwork's planes are
  large and its value range is compressed, so it does not compete with the changelog below it. The
  grain is at a few percent, visible when looked at, invisible as noise behind a headline.
- **16:9, no external assets, 30–42 KB per file.** The six files together are a few hundred KB,
  render crisply at any size, and need no font, raster or network request.
- **A little rough.** The hairlines are not perfectly even, the cuts are not on a grid, and the grain
  is deliberately off-register; the piece reads printed rather than rendered.
- **It survives a dull release.** The generator has no "hero" mode: every release goes through the
  same composition, and the signals decide whether that is dense, held or cleared. A release with
  nothing dramatic in it gets a calm piece, not a worse one.

## What the seed drives

The version seeds the PRNG; the release notes produce three signals:

- `density` (change count, log-scaled): plane count, cut directions, field and grain.
- `holding` (share of precision words): fewer and larger planes, fewer cut directions, tighter seams.
- `clearing` (share of wayfinding words): a straight channel cut through the mass and more negative
  space.

The seed also sets the refraction angle, which cells are deep ink or rust, which two edges catch
light, where the mass is cropped and how the field is ruled. Dark and light are the same geometry
in two palettes.

`scripts/release-art/README.md` has the exact rule, the commands and how the next release is made.
In short:

```sh
gh release view v0.2.5 --json body -q .body > scripts/release-art/releases/v0.2.5.md
node scripts/release-art/generate.mjs --version 0.2.5 --notes scripts/release-art/releases/v0.2.5.md
```

The two SVGs land in `src/assets/release-art/faceted-tension/`; the same input gives the same bytes,
and `--check` catches drift.

## How the winner would be wired into the card

The update card imports the piece for the release it announces (for example
`0.2.5-light.svg`) and the one for the current theme (`0.2.5-dark.svg`), straight from
`src/assets/release-art/faceted-tension/`. Vite hashes the asset, so the card gets a stable URL and
no runtime work. If the card needs the artwork to inherit the theme's colours instead of shipping
both files, the generator can inline the same paths for the two palettes; the geometry is shared,
so it is one composition, not two.

Nothing else in the app changes: the generator runs when a release is cut, and the release's files
are committed with it.

## Files

- `scripts/release-art/generate.mjs`: the generator (Node only, no dependencies).
- `scripts/release-art/releases/v0.2.2.md`, `v0.2.3.md`, `v0.2.4.md`: the release notes the
  pieces were generated from.
- `scripts/release-art/README.md`: the composition rule and the next-release commands.
- `src/assets/release-art/faceted-tension/0.2.2-light.svg` … `0.2.4-dark.svg`: the six pieces.
