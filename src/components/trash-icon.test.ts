import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Every delete button in the board shows the same trash icon, `TrashIcon`, and the icon itself carries
 * the hover/focus red and the lid motion (`styles.css`). These read the source: a delete button that
 * draws its own trash icon, or restyles the shared one, fails here.
 */

const SRC = path.join(import.meta.dirname, '..')
const SHARED = 'components/TrashIcon.tsx'

const files = (readdirSync(SRC, { recursive: true }) as string[])
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => f.split(path.sep).join('/'))
  .sort()

const read = (file: string) => readFileSync(path.join(SRC, file), 'utf8')

const parse = (file: string) =>
  ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

/** The files that show a trash button, and how many of them each holds. */
const TRIGGERS: Record<string, number> = {
  'components/PostTools.tsx': 1,
  'components/ProjectSwitcher.tsx': 1,
  'components/RunsSettings.tsx': 1,
  'components/StagesEditor.tsx': 1,
  'routes/projects.$id.agents.tsx': 1,
  'routes/projects.$id.cleanup.tsx': 2,
  'routes/projects.$id.features.$ticketId.tsx': 1,
}

const isTag = (node: ts.Node, tag: string) => {
  if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return false
  const opening = ts.isJsxElement(node) ? node.openingElement : node
  return opening.tagName.getText() === tag
}

/** The `className` values of every trigger element that holds a `TrashIcon`, its render prop included. */
function triggerClassNames(file: string) {
  const source = parse(file)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.children.some((child) => isTag(child, 'TrashIcon'))) {
      const collect = (n: ts.Node) => {
        if (ts.isJsxAttribute(n) && n.name.getText() === 'className') {
          const init = n.initializer
          if (init && ts.isStringLiteral(init)) found.push(init.text)
        }
        ts.forEachChild(n, collect)
      }
      collect(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** The text of the balanced `{…}` block that starts at `from`. */
function blockAt(css: string, from: number) {
  let depth = 0
  for (let i = from; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(from, i + 1)
  }
  return css.slice(from)
}

describe('the trash icon', () => {
  it("is drawn in one place, and no button imports lucide's Trash2 of its own", () => {
    const drew = files.filter((file) => file !== SHARED && /\bTrash2\b/.test(read(file)))
    expect(drew).toEqual([])
  })

  it('is what every delete button renders', () => {
    for (const [file, count] of Object.entries(TRIGGERS)) {
      const source = read(file)
      expect(source, file).toContain("from '#/components/TrashIcon'")
      expect(source.match(/<TrashIcon\b/g)?.length ?? 0, file).toBe(count)
    }
  })

  it('is not restyled or re-animated per button', () => {
    for (const file of Object.keys(TRIGGERS)) {
      expect(read(file), file).not.toMatch(/<TrashIcon\b[^>]*className=/)
      const red = triggerClassNames(file).filter((name) => /text-destructive/.test(name))
      expect(red, file).toEqual([])
    }
  })

  it('keeps the lid a part of its own, so only it can move', () => {
    const shared = read(SHARED)
    expect(shared).toContain('data-trash-part="lid"')
    expect(shared).toContain('data-trash-part="can"')
    const lid = shared.slice(shared.indexOf('data-trash-part="lid"'), shared.indexOf('data-trash-part="can"'))
    expect(lid).toContain('d="M3 6h18"')
    expect(lid).toContain('d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"')
  })

  it('turns red on hover or focus and opens only the lid, also with reduced motion', () => {
    const css = read('styles.css')
    // The red is on the button's state, not inside the motion block: no motion still keeps it.
    expect(css).toMatch(/button:hover:not\(:disabled\) \.trash-icon,[\s\S]*?color: var\(--destructive\);/)
    expect(css).toMatch(/button:focus-visible \.trash-icon \{\n  color: var\(--destructive\);/)
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{/g)]
      .map((m) => blockAt(css, m.index!))
      .filter((block) => block.includes('.trash-icon'))
    expect(reduced).toHaveLength(1)
    expect(reduced[0]).toContain('transition: none')
    expect(reduced[0]).toContain('transform: none')
    expect(reduced[0]).not.toContain('color: var(--destructive)')

    // The lid opens: one rule lifts it off the can's rim and swings it from its hinge, and it is the
    // only rule in the sheet that moves anything.
    const opens = [...css.matchAll(/transform: translate\(([^)]+)\) rotate\(([^)]+)\);/g)]
    expect(opens).toHaveLength(1)
    const [liftX, liftY] = opens[0]![1]!.split(',').map((v) => Number.parseFloat(v))
    const swing = Number.parseFloat(opens[0]![2]!)
    // A lift, not a tilt in place: it rises off the rim and turns a readable way.
    expect(liftY).toBeLessThanOrEqual(-2)
    expect(Math.abs(liftX)).toBeLessThanOrEqual(1)
    expect(swing).toBeLessThanOrEqual(-20)
    // The hinge is the lid's left end, and the raised lid is allowed to paint above the icon's box.
    expect(css).toContain('transform-origin: 3px 6px')
    expect(css).toMatch(/\.trash-icon \{[^}]*overflow: visible;/)
    // That one rule is the lid's, on the button's hover and focus; the icon root never moves.
    const at = css.indexOf('transform: translate(')
    const ruleStart = css.lastIndexOf('\n\n', css.lastIndexOf('{', at))
    expect(css.slice(ruleStart, css.lastIndexOf('{', at))).toContain('.trash-icon .trash-icon-lid')
    expect(css).not.toMatch(/\.trash-icon \{[^}]*transform:/)
  })
})
