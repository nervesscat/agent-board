import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Every hover tooltip in the app goes through the one shadcn Tooltip (`Tip` in `ui/tooltip.tsx`), never
 * the browser's own `title` tooltip. These read the source: a `title=` on an element or on a component
 * that hands it to the DOM, or a second way to show a tooltip, fails here.
 */

const SRC = path.join(import.meta.dirname, '..')

const files = (readdirSync(SRC, { recursive: true }) as string[])
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => f.split(path.sep).join('/'))
  .sort()

const parse = (file: string) =>
  ts.createSourceFile(
    file,
    readFileSync(path.join(SRC, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )

/** Every JSX `title=` in a file: the element or component it is on, and where. */
function titles(file: string) {
  const source = parse(file)
  const found: { tag: string; attrs: string[]; line: number }[] = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'title') {
      const element = node.parent.parent as ts.JsxOpeningElement | ts.JsxSelfClosingElement
      found.push({
        tag: element.tagName.getText(source),
        attrs: element.attributes.properties.flatMap((p) =>
          ts.isJsxAttribute(p) ? [p.name.getText(source)] : [],
        ),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/**
 * The `title`s that stay. Native ones: the PDF viewer's and the preview window's frames are named by
 * their title, and a field with a `pattern` shows its title in the browser's "match the requested
 * format" message. The others are
 * component props that only print a heading, never a tooltip.
 */
const ALLOWED: Record<string, (t: { tag: string; attrs: string[] }) => boolean> = {
  'components/Gallery.tsx': (t) => t.tag === 'iframe',
  // An iframe's title is what names it to a screen reader, never a tooltip.
  'components/PreviewWindow.tsx': (t) => t.tag === 'iframe',
  'routes/projects.$id.agents.tsx': (t) =>
    (t.tag === 'Input' && t.attrs.includes('pattern')) || t.tag === 'AgentText',
  'components/Summary.tsx': (t) => ['Section', 'Row', 'TicketLink'].includes(t.tag),
}

const importsOf = (file: string) =>
  parse(file).statements.flatMap((s) =>
    ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) ? [s.moduleSpecifier.text] : [],
  )

describe('tooltips', () => {
  it('finds the source files', () => {
    expect(files).toContain('components/ui/tooltip.tsx')
    expect(files.length).toBeGreaterThan(50)
  })

  it('leaves no title tooltip outside the allowed ones', () => {
    const left = files.flatMap((file) =>
      titles(file)
        .filter((t) => !ALLOWED[file]?.(t))
        .map((t) => `${file}:${t.line} <${t.tag} title=…>`),
    )
    expect(left).toEqual([])
  })

  it('keeps the allowed titles where they are', () => {
    const kept = (file: string) => titles(file).map((t) => t.tag)
    expect(kept('components/Gallery.tsx')).toEqual(['iframe'])
    expect(kept('routes/projects.$id.agents.tsx')).toContain('Input')
  })

  it('shows tooltips only through the shared one', () => {
    const direct = files.filter(
      (file) =>
        file !== 'components/ui/tooltip.tsx' &&
        importsOf(file).some(
          (m) => m === '@base-ui/react/tooltip' || m.startsWith('@base-ui/react/tooltip/'),
        ),
    )
    expect(direct).toEqual([])
  })

  it('gives every component that had a title tooltip the shared one', () => {
    // These had a `title` (or a `tip`) tooltip; each now uses `Tip`, or ActionButton, which does.
    const had = [
      'components/Actor.tsx',
      'components/AgentPicker.tsx',
      'components/Attachments.tsx',
      'components/FolderPicker.tsx',
      'components/Gallery.tsx',
      'components/ListInput.tsx',
      'components/Markdown.tsx',
      'components/Needs.tsx',
      'components/PdfThumb.tsx',
      'components/PendingFiles.tsx',
      'components/Preview.tsx',
      'components/PostTools.tsx',
      'components/ProjectSwitcher.tsx',
      'components/PrState.tsx',
      'components/PushDot.tsx',
      'components/ReachBadge.tsx',
      'components/ReportDueBanner.tsx',
      'components/ReviewResult.tsx',
      'components/RichEditor.tsx',
      'components/StagesEditor.tsx',
      'components/Summary.tsx',
      'components/TagsInput.tsx',
      'components/Thread.tsx',
      'components/TicketBoard.tsx',
      'components/Verdict.tsx',
      'components/daily/GenerateReportButton.tsx',
      'components/daily/PushedToday.tsx',
      'components/daily/ReportCalendar.tsx',
      'components/daily/ReportCard.tsx',
      'components/daily/ReportPromptSettings.tsx',
      'components/daily/SettingsChangeDiff.tsx',
      'components/daily/SettingsChangeNotice.tsx',
      'components/daily/ShiftClock.tsx',
      'routes/__root.tsx',
      'routes/projects.$id.agents.tsx',
      'routes/projects.$id.cleanup.tsx',
      'routes/projects.$id.features.$ticketId.tsx',
      'routes/projects.$id.features.index.tsx',
      'routes/projects.$id.instructions.tsx',
      'routes/projects.$id.previews.tsx',
      'routes/projects.$id.prs.tsx',
      'routes/projects.$id.tsx',
    ]
    const without = had.filter((file) => {
      const source = readFileSync(path.join(SRC, file), 'utf8')
      const shared = importsOf(file).includes('#/components/ui/tooltip') && /<Tip\b/.test(source)
      const viaAction = importsOf(file).includes('#/components/PostTools') && /<ActionButton\b/.test(source)
      return !shared && !viaAction
    })
    expect(without).toEqual([])
  })
})
