// The board's .env as its scripts read it (pnpm start, pnpm tailnet): the same values, the same port.
import fs from 'node:fs'
import { parseEnv } from 'node:util'

/**
 * The values in `file` (.env in the current folder: the board's checkout, as pnpm runs these scripts), as
 * the board reads them with Vite's loadEnv (vite.config.ts): parsed by node:util's parseEnv, so an inline
 * `# comment` is not part of a value, then `${NAME}` and `$NAME` expanded with dotenv-expand's rules, from the file's other
 * values (above or below) and from the environment; a name defined in neither is empty. Where the shell also
 * sets a name .env defines, .env's value stands: `pnpm start` runs the board on .env's PORT, whatever the
 * shell says.
 */
export function readDotenv(file = '.env') {
  if (!fs.existsSync(file)) return {}
  const values = parseEnv(fs.readFileSync(file, 'utf8'))
  const shell = Object.fromEntries(Object.entries(process.env).filter(([key]) => !Object.hasOwn(values, key)))
  for (const key in values) values[key] = expandValue(values[key], shell, values).replace(/\\\$/g, '$')
  return values
}

/**
 * One value with its references expanded, step for step as dotenv-expand does in Vite's loadEnv, defaults
 * (`${NAME:-default}` and its kin) included: `values` are the file's, those above this one already expanded.
 * Names are looked up on an object of their own, so `${constructor}` is a name like any other.
 */
function expandValue(value, shell, values) {
  const env = Object.assign(Object.create(null), values, shell)
  const reference = /(?<!\\)\$\{([^{}]+)\}|(?<!\\)\$([A-Za-z_]\w*)/g
  const seen = new Set()
  let result = value
  let match
  while ((match = reference.exec(result)) !== null) {
    seen.add(result)
    const [template, braced, bare] = match
    const expression = braced || bare
    const operator = expression.match(/(:\+|\+|:-|-)/)?.[0] ?? null
    const [key, ...rest] = expression.split(operator)
    const alternate = operator === ':+' || operator === '+'
    const fallback = alternate && !env[key] ? '' : rest.join(operator)
    const found = alternate ? null : env[key]
    result = result.replace(template, found && !seen.has(found) ? found : fallback)
    if (result === values[key]) break
    reference.lastIndex = 0
  }
  return result
}

/**
 * Where the board listens, from these values: PORT (47100) and HOST (127.0.0.1), unset or empty taking
 * the default. `pnpm start` runs the board there, and `pnpm tailnet` serves that port.
 */
export function boardAddress(values = readDotenv()) {
  return { port: Number(values.PORT || '47100'), host: values.HOST || '127.0.0.1' }
}
