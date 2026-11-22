// The interface's translation checks, run by `pnpm check:i18n` and by the unit tests (CI):
//
//   1. Every key of the English file (the model) is in every other language, and nothing else is: no
//      missing Spanish text, no leftover key, no empty text, the same {{placeholders}} and <tags>.
//   2. No English left hard-coded in a component: text between JSX tags, a text attribute (title,
//      aria-label, placeholder, alt, label, content …) and a toast's message must go through `t(...)`.
//      The files not extracted yet are listed in scripts/i18n-pending.txt, which only shrinks: a pending
//      file that is clean is an error, so it comes off the list.
//
// A literal that is not language (a brand, a code) is marked with `// i18n-ignore` on its line or the one
// above, with the reason.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const LOCALES_DIR = path.join(root, 'src/i18n/locales')
export const PENDING_FILE = path.join(root, 'scripts/i18n-pending.txt')

const PLURAL = /_(zero|one|two|few|many|other)$/
const TEXT_ATTRIBUTES = new Set([
  'title',
  'aria-label',
  'aria-description',
  'placeholder',
  'alt',
  'label',
  'content',
  'description',
  'emptyText',
])
// Words, not a brand name (CrossBoard) or a colour (#0a0a0a).
// Properties of an object literal that hold text shown to the human (a label table, a tooltip map).
const TEXT_PROPERTIES = new Set([
  'label',
  'title',
  'tip',
  'hint',
  'description',
  'text',
  'message',
  'placeholder',
  'empty',
  'tooltip',
  'caption',
  'heading',
])
// A constant named like a text table (COMPLEXITY_LABEL, SELECT_HINT, EMPTY_TEXT …) holds interface text.
const TEXT_CONSTANT = /(LABEL|HINT|TIP|TITLE|TEXT|MESSAGE|DESCRIPTION|COPY|NAME)S?$/i
const HAS_WORDS = {
  // A key (`shell.connect`) is not a text.
  test: (text) =>
    !/^[a-z]\w*(\.\w+)+$/.test(text) &&
    !/^\.\w+$/.test(text) &&
    // a list of CSS classes (text-[10px] font-semibold), not a sentence
    !(/^[a-z0-9:[\]/.%-]+(\s+[a-z0-9:[\]/.%-]+)*$/.test(text) && /[-:[]/.test(text)) &&
    /\p{L}{2,}/u.test(text.replace(/CrossBoard/g, ' ').replace(/#[0-9a-f]{3,8}\b/gi, ' ')),
}

/** The leaves of a nested translation file: `{ a: { b: 'x' } }` is `{ 'a.b': 'x' }`. */
export function flatten(tree, prefix = '') {
  const out = {}
  for (const [key, value] of Object.entries(tree)) {
    const at = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object') Object.assign(out, flatten(value, at))
    else out[at] = value
  }
  return out
}

// An HTML void element (<link>, <br>, <input> …) cannot hold text: the parser drops what is between its tags,
// so a sentence's tag is never one of these (use <goto>, <strong>, <code> …).
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

const FORMS = ['zero', 'one', 'two', 'few', 'many', 'other']
const base = (key) => key.replace(PLURAL, '')

/**
 * The plural forms a language writes: `required` are the ones a whole number up to a thousand falls in
 * (Russian: one, few, many, other; Japanese: other; Spanish: one, other), `allowed` all the ones the
 * language has (Spanish also has `many`, for millions, which a count here never reaches).
 */
export function pluralForms(language) {
  const rules = new Intl.PluralRules(language)
  const seen = new Set(['other'])
  for (let n = 0; n <= 1000; n++) seen.add(rules.select(n))
  const inOrder = (forms) => new Set(FORMS.filter((f) => forms.has(f)))
  return { required: inOrder(seen), allowed: inOrder(new Set(rules.resolvedOptions().pluralCategories)) }
}
const placeholders = (text) =>
  [...String(text).matchAll(/\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g)].map((m) => m[1]).sort()
const tags = (text) => [...String(text).matchAll(/<\/?(\w+)\s*\/?>/g)].map((m) => m[1]).sort()

/** The problems of `other` against the model `en`, as readable lines; none when they agree. */
export function compareLocales(en, other, name, language = name) {
  const problems = []
  const a = flatten(en)
  const b = flatten(other)
  const bases = (flat) => new Set(Object.keys(flat).map(base))
  const aBases = bases(a)
  const bBases = bases(b)
  for (const k of aBases) if (!bBases.has(k)) problems.push(`${name}: missing key ${k}`)
  for (const k of bBases) if (!aBases.has(k)) problems.push(`${name}: key ${k} is not in the English file`)
  for (const [key, text] of Object.entries(b)) {
    if (typeof text !== 'string' || text.trim() === '') problems.push(`${name}: ${key} is empty`)
    // A backslash and an n written as two characters (an escaped "\\n" in the JSON): a line break that was not one.
    else if (text.includes('\\n') && !String(a[key] ?? '').includes('\\n'))
      problems.push(`${name}: ${key} has a literal backslash-n, not a line break`)
  }
  for (const [lang, flat] of [
    ['en', a],
    [name, b],
  ])
    for (const [key, text] of Object.entries(flat))
      for (const tag of new Set(tags(text)))
        if (VOID_TAGS.has(tag))
          problems.push(
            `${lang}: ${key} uses <${tag}>, an HTML void element that loses its text: pick another tag name`,
          )
  const { required, allowed } = pluralForms(language)
  for (const k of aBases) {
    const pluralOf = (flat) => Object.keys(flat).filter((x) => base(x) === k && PLURAL.test(x))
    const model = pluralOf(a)
    const forms = pluralOf(b).map((x) => x.match(PLURAL)[1])
    if (!bBases.has(k)) continue
    if (!model.length) {
      // English says the same for every count ("{{count}} blocked"): a language that inflects it has its forms.
      if (!forms.length) continue
      if (!placeholders(a[k] ?? '').includes('count'))
        problems.push(`${name}: ${k} is plural here but has no {{count}} in the English file`)
    } else if (!forms.length) {
      problems.push(`${name}: ${k} has no plural forms (it needs ${[...required].join(', ')})`)
      continue
    }
    for (const form of required)
      if (!forms.includes(form)) problems.push(`${name}: ${k} has no _${form} form, which ${language} needs`)
    for (const form of forms)
      if (!allowed.has(form)) problems.push(`${name}: ${k}_${form} is a form ${language} does not have`)
  }
  for (const [key, text] of Object.entries(b)) {
    const model = a[key] ?? a[`${base(key)}_other`] ?? a[base(key)]
    if (model === undefined || typeof text !== 'string' || text.trim() === '') continue
    // A plural form may show the number its English text leaves out ("decision needed"): Russian's `one` is also 21.
    const extra = placeholders(text).filter((x) => !placeholders(model).includes(x))
    const countOnly = PLURAL.test(key) && extra.length > 0 && extra.every((x) => x === 'count')
    const without = (list) => (countOnly ? list.filter((x) => x !== 'count') : list)
    if (without(placeholders(model)).join() !== without(placeholders(text)).join())
      problems.push(`${name}: ${key} uses other {{placeholders}} than the English text`)
    if (tags(model).join() !== tags(text).join())
      problems.push(`${name}: ${key} uses other <tags> than the English text`)
  }
  return problems
}

export function readLocales() {
  const out = {}
  for (const f of fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json')))
    out[path.basename(f, '.json')] = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, f), 'utf8'))
  return out
}

/** The desktop app's own table (desktop/app/strings.mjs, plain ESM that cannot read the JSON files). */
export const DESKTOP_STRINGS = path.join(root, 'desktop/app/strings.mjs')

export async function checkDesktopStrings(file = DESKTOP_STRINGS) {
  const { STRINGS } = await import(pathToFileURL(file).href)
  const { en, ...rest } = STRINGS
  return Object.entries(rest).flatMap(([name, table]) => compareLocales(en, table, `desktop ${name}`, name))
}

export function checkLocales(locales = readLocales()) {
  const { en, ...rest } = locales
  if (!en) return ['the English file (en.json) is missing']
  return Object.entries(rest).flatMap(([name, tree]) => compareLocales(en, tree, name, name))
}

/** The hard-coded texts of one component's source: `[{ line, text }]`. */
export function findHardcoded(source, fileName = 'file.tsx') {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const lines = source.split('\n')
  const found = []
  const ignored = (line) => /i18n-ignore/.test(lines[line] ?? '') || /i18n-ignore/.test(lines[line - 1] ?? '')
  const report = (node, text) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
    if (!ignored(line)) found.push({ line: line + 1, text: text.trim().replace(/\s+/g, ' ').slice(0, 60) })
  }
  const literal = (node) =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      ? node.text
      : ts.isTemplateExpression(node)
        ? [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ')
        : undefined
  // The texts a JSX expression can show: a literal, either branch of a ternary, the right of && / ||.
  const shown = (node) => {
    if (ts.isParenthesizedExpression(node)) return shown(node.expression)
    if (ts.isConditionalExpression(node)) return [...shown(node.whenTrue), ...shown(node.whenFalse)]
    if (ts.isBinaryExpression(node) && ['&&', '||', '??'].includes(node.operatorToken.getText(sf)))
      return [...(node.operatorToken.getText(sf) === '&&' ? [] : shown(node.left)), ...shown(node.right)]
    const text = literal(node)
    return text === undefined ? [] : [{ node, text }]
  }
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const text = node.text.replace(/&\w+;|&#\d+;/g, ' ')
      if (HAS_WORDS.test(text)) report(node, node.text)
    } else if (ts.isJsxAttribute(node) && TEXT_ATTRIBUTES.has(node.name.getText(sf)) && node.initializer) {
      const init = node.initializer
      const texts = ts.isStringLiteral(init)
        ? [{ node, text: init.text }]
        : ts.isJsxExpression(init) && init.expression
          ? shown(init.expression)
          : []
      for (const shownText of texts)
        if (HAS_WORDS.test(shownText.text)) report(shownText.node, shownText.text)
    } else if (
      ts.isJsxExpression(node) &&
      node.expression &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      for (const shownText of shown(node.expression))
        if (HAS_WORDS.test(shownText.text)) report(shownText.node, shownText.text)
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.name) &&
      TEXT_CONSTANT.test(node.name.text)
    ) {
      const walkLiterals = (n) => {
        for (const shownText of shown(n))
          if (HAS_WORDS.test(shownText.text)) report(shownText.node, shownText.text)
        if (ts.isObjectLiteralExpression(n))
          for (const p of n.properties) if (ts.isPropertyAssignment(p)) walkLiterals(p.initializer)
        if (ts.isArrayLiteralExpression(n)) n.elements.forEach(walkLiterals)
        if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) walkLiterals(n.expression)
      }
      walkLiterals(node.initializer)
    } else if (ts.isPropertyAssignment(node) && TEXT_PROPERTIES.has(node.name.getText(sf))) {
      for (const shownText of shown(node.initializer))
        if (HAS_WORDS.test(shownText.text)) report(shownText.node, shownText.text)
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf)
      if (/^toast(\.(success|error|info|warning|message|loading))?$/.test(callee) && node.arguments[0]) {
        const text = literal(node.arguments[0])
        if (text !== undefined && HAS_WORDS.test(text)) report(node, text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

export const pendingFiles = () =>
  fs
    .readFileSync(PENDING_FILE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : p.endsWith('.tsx') ? [p] : []
  })
}

/** The components with English in them that are not listed as pending, and pending ones that are clean. */
export function checkComponents() {
  const pending = new Set(pendingFiles())
  const problems = []
  const seen = new Set()
  for (const file of walk(path.join(root, 'src'))) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    seen.add(rel)
    const found = findHardcoded(fs.readFileSync(file, 'utf8'), rel)
    if (pending.has(rel)) {
      if (found.length === 0)
        problems.push(`${rel} has no hard-coded text left: remove it from scripts/i18n-pending.txt`)
    } else {
      for (const f of found)
        problems.push(`${rel}:${f.line} hard-coded text "${f.text}": use t('…') (or mark it // i18n-ignore)`)
    }
  }
  for (const p of pending)
    if (!seen.has(p)) problems.push(`scripts/i18n-pending.txt lists ${p}, which does not exist`)
  return problems
}

/** Every file with English in it, for building the pending list. */
export function allHardcoded() {
  return walk(path.join(root, 'src'))
    .map((f) => path.relative(root, f).split(path.sep).join('/'))
    .filter((rel) => findHardcoded(fs.readFileSync(path.join(root, rel), 'utf8'), rel).length > 0)
    .sort()
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `--lang <code>`: only that language's file and its desktop table, for whoever is writing one.
  const at = process.argv.indexOf('--lang')
  const only = at > 0 ? process.argv[at + 1] : undefined
  const keep = (problem) => !only || problem.startsWith(`${only}:`) || problem.startsWith(`desktop ${only}:`)
  const problems = [
    ...checkLocales(),
    ...(await checkDesktopStrings()),
    ...(only ? [] : checkComponents()),
  ].filter(keep)
  if (problems.length) {
    console.error(problems.join('\n'))
    console.error(`\n${problems.length} translation problem(s).`)
    process.exit(1)
  }
  console.log(
    only
      ? `i18n: ${only} agrees with en (keys, placeholders, tags, plural forms), desktop table too.`
      : `i18n: ${Object.keys(readLocales()).join(', ')} agree; ${pendingFiles().length} component file(s) pending.`,
  )
}
