import { eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { isLanguage, type Language } from '#/i18n/languages'

/**
 * The language of the interface a person picked in Settings: kept on the board under their name, so it
 * follows them to every device they sign in from (README: "Language"). It is the human's alone: an agent
 * has no interface, and its calls read none. Null while they have not picked one: the browser's decides.
 * One row per person in `settings`, the key `language:<name>`.
 */
const keyOf = (actor: string) => `language:${actor}`

export function getLanguage(actor: string): Language | null {
  const row = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, keyOf(actor)))
    .get()
  // A stored value that is not a language (an old build, a hand edit) reads as none picked.
  return isLanguage(row?.value) ? row.value : null
}

/** Keeps `language` for `actor`; null forgets the choice, and the browser's decides again. */
export function setLanguage(actor: string, language: Language | null): Language | null {
  if (language === null)
    db.delete(schema.settings)
      .where(eq(schema.settings.key, keyOf(actor)))
      .run()
  else
    db.insert(schema.settings)
      .values({ key: keyOf(actor), value: language })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: language } })
      .run()
  return language
}
