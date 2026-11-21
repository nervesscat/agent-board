import type { PetState } from '#/lib/agentsAtWork'

/**
 * The pixel art of the Overview's pets: an original little robot-cat at an open laptop, drawn on a small
 * grid, one letter per pixel. The pet is the same body in every pose; what changes is a few pixels: the
 * paws, the eyes, an antenna light, and a "?" or "z" beside it. Each pose is two frames, flipped in turn
 * by CSS (styles.css, `.pet-frame-a` and `.pet-frame-b`), so it moves in steps like a sprite, never
 * smoothly. Pure data: `AgentPet` paints it as SVG with crisp edges, at a whole number of screen pixels
 * per art pixel.
 *
 *   K ink (the theme's foreground)   B body (muted foreground)   P face plate (the card)   M laptop lid (muted)
 */
export const PET_WIDTH = 20
export const PET_HEIGHT = 15

/** The paint of each letter: the theme's own colours, so the pet reads in light and dark. */
export const PET_COLORS = {
  K: 'var(--foreground)',
  B: 'var(--muted-foreground)',
  P: 'var(--card)',
  M: 'var(--muted)',
} as const
type Letter = keyof typeof PET_COLORS

/** Where the body sits on the canvas: room to its left for the "?" and to its right for a raised paw or "z". */
const BODY_X = 3

// One row per string, `.` is empty; the body is 15 wide and 15 tall: antenna, ears, head, laptop.
const ANTENNA = ['.......K.......', '.......B.......']
const ANTENNA_DIM = ['.......B.......', '.......B.......']
const EARS = ['..B.........B..', '..BB.......BB..', '..BBBBBBBBBBB..', '..BPPPPPPPPPB..']
const EYES_OPEN = ['..BPKPPPPPKPB..', '..BPKPPPPPKPB..', '..BPPPPPPPPPB..', '..BBBBBBBBBBB..']
const EYES_SHUT = ['..BPPPPPPPPPB..', '..BPKKPPPKKPB..', '..BPPPPPPPPPB..', '..BBBBBBBBBBB..']
// The laptop seen from behind: the lid (rows 10 to 12 of the canvas), the base and its shadow.
const LAPTOP = ['.KKKKKKKKKKKKK.', '.KMMMMMMMMMMMK.', '.KMMMMMMMMMMMK.', 'KKKKKKKKKKKKKKK', '.KKKKKKKKKKKKK.']
const QUESTION = ['KKK', '..K', '.KK', '...', '.K.']
const ZED = ['KKK', '.K.', 'KKK']

type Grid = string[][]
const blank = (): Grid => Array.from({ length: PET_HEIGHT }, () => Array<string>(PET_WIDTH).fill('.'))
const stamp = (grid: Grid, x: number, y: number, rows: readonly string[]) => {
  rows.forEach((row, dy) =>
    [...row].forEach((c, dx) => {
      if (c !== '.') grid[y + dy]![x + dx] = c
    }),
  )
}

const bodyOf = (eyes: readonly string[], antenna: readonly string[]): Grid => {
  const g = blank()
  stamp(g, BODY_X, 0, [...antenna, ...EARS, ...eyes, ...LAPTOP])
  return g
}

// A paw up rests on the lid's foot (row 12), down on the base (row 13).
const PAW_UP = 12
const PAW_DOWN = 13
const LEFT_PAW = BODY_X + 3
const RIGHT_PAW = BODY_X + 10
const ARM_X = BODY_X + 15
const paw = (g: Grid, x: number, y: number) => stamp(g, x, y, ['BB'])

const typing = (leftUp: boolean): Grid => {
  const g = bodyOf(EYES_OPEN, leftUp ? ANTENNA : ANTENNA_DIM)
  paw(g, LEFT_PAW, leftUp ? PAW_UP : PAW_DOWN)
  paw(g, RIGHT_PAW, leftUp ? PAW_DOWN : PAW_UP)
  return g
}
// Waiting: one paw rests, the other is raised and bobs by a pixel, and the "?" blinks.
const asking = (high: boolean): Grid => {
  const g = bodyOf(EYES_OPEN, high ? ANTENNA : ANTENNA_DIM)
  paw(g, LEFT_PAW, PAW_DOWN)
  for (let y = high ? 2 : 3; y <= PAW_UP; y++) paw(g, ARM_X, y)
  if (high) stamp(g, 0, 0, QUESTION)
  return g
}
// Asleep: eyes shut, paws down, a "z" and then two drifting up.
const sleeping = (second: boolean): Grid => {
  const g = bodyOf(EYES_SHUT, ANTENNA_DIM)
  paw(g, LEFT_PAW, PAW_DOWN)
  paw(g, RIGHT_PAW, PAW_DOWN)
  stamp(g, 17, 5, ZED)
  if (second) stamp(g, 17, 1, ZED)
  return g
}

const rowsOf = (g: Grid) => g.map((r) => r.join('')).join('\n')

/** Frame A is what a still pet shows (reduced motion); frame B is flipped in turn with it. */
export const PET_FRAMES: Record<PetState, readonly [string, string]> = {
  working: [rowsOf(typing(true)), rowsOf(typing(false))],
  waiting: [rowsOf(asking(true)), rowsOf(asking(false))],
  asleep: [rowsOf(sleeping(false)), rowsOf(sleeping(true))],
}

/** One frame as paths, one per colour: each run of one colour in a row is a one-pixel-tall rectangle. */
export function framePaths(frame: string): { letter: Letter; d: string }[] {
  const d = new Map<Letter, string>()
  frame.split('\n').forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const c = row[x]!
      let w = 1
      while (row[x + w] === c) w++
      if (c in PET_COLORS) d.set(c as Letter, `${d.get(c as Letter) ?? ''}M${x} ${y}h${w}v1h-${w}z`)
      x += w
    }
  })
  return [...d].map(([letter, path]) => ({ letter, d: path }))
}
