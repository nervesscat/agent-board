# Translating the interface

The interface's texts live in `src/i18n/locales/<language>.json`, one file per language. `en.json` is the
model. README: "Language" says what is translated and what is not; this page is how to write it.

## Moving a text out of a component

```tsx
const { t } = useTranslation()
<Button title={t('tickets.board.newTicket')}>{t('tickets.board.new')}</Button>
toast.success(t('common.saved'))
```

- Keys are `area.section.name` in camelCase, grouped by the page or component (`settings.board.theme.title`).
  Texts several areas share (Save, Cancel, Close, Delete…) are `common.*`.
- Interpolation: `t('time.hoursAgo', { count: 2 })` with `"hace {{count}} h"`. Never build a sentence by
  joining pieces: put the whole sentence in the file, so a language can order it its own way.
- Plurals: `key_one` and `key_other` (add `_many` only where a language needs it), picked by `count`.
- A sentence with a link or emphasis inside: `<Trans i18nKey="…" components={{ goto: <Link … /> }} />` with
  `"Open <goto>Connect</goto>."`; the same tags in every language.
- Outside a component (a helper returning text while it renders): `shared.t(...)` from `#/i18n`, as
  `src/lib/format.ts` does. A constant that held labels holds keys instead, translated where it is drawn.
- Dates, times, durations and numbers go through `src/lib/format.ts` (`Intl` with the current language), never
  `toLocaleString()` without a locale and never a hard-coded `en-US`.
- Not translated: what people and agents write (titles, posts, comments, summaries, run reports, tags, stage and
  agent names), text the server returns (error messages, logs), the MCP tools and skills, code, file names, the
  brand, and product terms below that are kept in English.
- A literal that is not language (a command, a file name, an id) is marked `// i18n-ignore: why` on its line or the
  one above. `pnpm check:i18n` checks every language has every key and no English is left in a component.

## Every language, and what a new text needs

There are twenty languages (`src/i18n/languages.ts`); `en.json` is the model and every other file has exactly its
keys, placeholders, `<tags>` and the plural forms its language writes (`pnpm check:i18n`, also in `pnpm test`).
No language falls back to English for a key it lacks. A new text goes into all twenty files, and the desktop app's
into `desktop/app/strings/<code>.mjs`. Plural forms by language (`Intl.PluralRules`): Chinese, Japanese, Korean,
Vietnamese and Indonesian have `_other` only; English, Spanish, French, Portuguese, Italian, German, Hindi, Bengali,
Marathi, Telugu, Tamil and Turkish `_one` and `_other`; Russian, Ukrainian and Polish `_one`, `_few`, `_many`,
`_other`. A text English says the same for every count (`{{count}} blocked`) may become plural forms in a
language whose grammar changes with the number. Each language's glossary (the terms it keeps in English, the
register it uses, the words it chose) is `docs/translations/<code>.md`: read it before adding a text, and keep
to it. The Spanish one is below. Add a language: a file in `src/i18n/locales/`, its code, own name, English name
and `Intl` locale in `languages.ts`, a table in `desktop/app/strings/` and its line in `desktop/app/strings.mjs`,
and a glossary; the dropdown, the browser's detection and the checks follow from the list.

Right-to-left languages (Arabic, Hebrew, Persian, Urdu) are not offered: the layout is not mirrored yet.

## Spanish: how it is written

Natural Spanish for a software tool, addressed informally (tú, imperative: "Guarda", "Elige"), neutral between
Spain and Latin America. Sentence case in titles and buttons, like the English. Short: a button is a verb.

Kept in English, as Spanish-speaking developers say them: **ticket**, **lane**, **PR**, **preview**, **commit**,
**branch**, **merge** (the noun; the verb is "fusionar"), **worktree**, **workspace**, **checkout**, **token**, **webhook**, **CLI**, **skill**,
**passkey**, **tailnet**, **Funnel**, **Overview** only where it is a product name (the page is "Resumen").

Translated, always the same word:

| English                 | Spanish                                                                       |
| ----------------------- | ----------------------------------------------------------------------------- |
| board                   | tablero                                                                       |
| project                 | proyecto                                                                      |
| agent                   | agente                                                                        |
| orchestrator            | orquestador                                                                   |
| worker                  | trabajador                                                                    |
| stage                   | etapa                                                                         |
| task, subtask           | tarea, subtarea                                                               |
| post, update            | publicación, novedad                                                          |
| comment, reply          | comentario, respuesta                                                         |
| summary                 | resumen                                                                       |
| review (noun)           | revisión                                                                      |
| report                  | informe                                                                       |
| settings                | ajustes                                                                       |
| sign in / sign out      | iniciar / cerrar sesión                                                       |
| device                  | dispositivo                                                                   |
| repository              | repositorio                                                                   |
| attachment              | adjunto                                                                       |
| notification            | notificación                                                                  |
| search                  | buscar, búsqueda                                                              |
| save, cancel            | guardar, cancelar                                                             |
| delete, remove          | eliminar, quitar                                                              |
| needs you               | te necesita                                                                   |
| in progress             | en curso                                                                      |
| blocked                 | bloqueado                                                                     |
| done                    | hecho                                                                         |
| run (a started process) | ejecución; "en ejecución" for running, "arrancar" to start, "detener" to stop |
| keep (do not delete)    | conservar                                                                     |
| clear (a filter)        | quitar                                                                        |
| push (verb), unpushed   | subir, sin subir                                                              |
| build (a preview)       | compilar                                                                      |
| needs (a ticket)        | necesita; dependencia (noun)                                                  |
| on hold                 | en pausa, pausar                                                              |
| assigned to             | asignado a                                                                    |
| this computer           | este equipo                                                                   |
| runs, previews          | "el preview", "los previews" (masculine); PR is invariable ("los PR")         |

Times are written without "a las" (`vence: {{time}}`, `desde {{time}}`), so any hour reads right. Tooltips are
imperative like the English ("Detén el preview"); buttons are infinitive ("Guardar").
