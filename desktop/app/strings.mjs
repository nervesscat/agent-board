// The desktop app's own texts, English and Spanish. This file is packaged with the app and cannot import
// from src/, so it has its own small copy of the idea (src/i18n, docs/translating.md: same glossary and
// same {{placeholders}}). Texts from the board's pages come from the board; these are the tray, the window's
// menu, the dialogs, the notifications and the page shown while a remote board is away.
//
// The language is the board's: its page sets the `lang` cookie in the window's session (main.mjs reads
// it), and the system's locale decides until there is one.

export const LANGUAGES = ['en', 'es']
export const DEFAULT_LANGUAGE = 'en'

/** @type {Record<string, Record<string, string>>} */
export const STRINGS = {
  en: {
    open: 'Open',
    openInBrowser: 'Open in browser',
    retryNow: 'Retry now',
    startAtLogin: 'Start at login',
    quit: 'Quit',
    openSettings: 'Open the settings file',
    openLogs: 'Open the logs folder',
    openHome: 'Open the app folder',
    startAtLoginFailed: 'Start at login could not be changed.',
    cannotStart: 'The board cannot start.',
    settingsInvalid: 'The board’s settings are not valid.',
    homeUnusable:
      "The app's folder {{home}} cannot be used: {{error}}\n\nSet AGENT_BOARD_HOME to a folder that can be written, or remove it to use the default.",
    homeLine: "{{error}}\n\nThe app's folder: {{home}}",
    dataFolderUnusable:
      'Its data folder {{dir}} cannot be used: {{error}}\n\nSet another DATA_DIR in {{file}}, or in the environment, and start the app again.',
    logsLine: '{{detail}}\n\nLogs: {{logs}}',
    stopped: 'The board stopped.',
    restartedTimes_one: ' It was started again {{count}} time.',
    restartedTimes_other: ' It was started again {{count}} times.',
    noOutput: '(no output)',
    exitedSignal: 'It was killed by {{signal}} at {{time}}.',
    exitedCode: 'It exited with code {{code}} at {{time}}.',
    exited: 'It exited at {{time}}.',
    reasonCode: 'exit code {{code}}',
    reasonSignal: 'signal {{signal}}',
    reasonNone: 'no exit code',
    tipRestarting: '{{name}}: restarting the board ({{reason}})',
    tipRestarted: '{{name}}: {{url}} (restarted at {{time}} after {{reason}})',
    notifyRestarted: 'The board restarted ({{reason}}).',
    didNotStart: 'The board did not start.',
    didNotAnswer: 'It did not answer on {{url}} within a minute.',
    unreachableHeading: 'The board at <code>{{address}}</code> cannot be reached.',
    unreachableBody:
      'The board runs on another machine: check that this one is online and that the board is running there. The app tries again by itself, and {{retry}} tries at once.',
  },
  es: {
    open: 'Abrir',
    openInBrowser: 'Abrir en el navegador',
    retryNow: 'Reintentar ahora',
    startAtLogin: 'Iniciar con el sistema',
    quit: 'Salir',
    openSettings: 'Abrir el archivo de ajustes',
    openLogs: 'Abrir la carpeta de registros',
    openHome: 'Abrir la carpeta de la app',
    startAtLoginFailed: 'No se pudo cambiar el inicio con el sistema.',
    cannotStart: 'El tablero no puede iniciarse.',
    settingsInvalid: 'Los ajustes del tablero no son válidos.',
    homeUnusable:
      'La carpeta de la app {{home}} no se puede usar: {{error}}\n\nEstablece AGENT_BOARD_HOME en una carpeta donde se pueda escribir, o quítalo para usar la predeterminada.',
    homeLine: '{{error}}\n\nLa carpeta de la app: {{home}}',
    dataFolderUnusable:
      'Su carpeta de datos {{dir}} no se puede usar: {{error}}\n\nEstablece otro DATA_DIR en {{file}}, o en el entorno, y vuelve a iniciar la app.',
    logsLine: '{{detail}}\n\nRegistros: {{logs}}',
    stopped: 'El tablero se detuvo.',
    restartedTimes_one: ' Se inició de nuevo {{count}} vez.',
    restartedTimes_other: ' Se inició de nuevo {{count}} veces.',
    noOutput: '(sin salida)',
    exitedSignal: 'Lo terminó la señal {{signal}} a las {{time}}.',
    exitedCode: 'Terminó con el código {{code}} a las {{time}}.',
    exited: 'Terminó a las {{time}}.',
    reasonCode: 'código de salida {{code}}',
    reasonSignal: 'señal {{signal}}',
    reasonNone: 'sin código de salida',
    tipRestarting: '{{name}}: reiniciando el tablero ({{reason}})',
    tipRestarted: '{{name}}: {{url}} (reiniciado a las {{time}} tras {{reason}})',
    notifyRestarted: 'El tablero se reinició ({{reason}}).',
    didNotStart: 'El tablero no se inició.',
    didNotAnswer: 'No respondió en {{url}} en un minuto.',
    unreachableHeading: 'No se puede llegar al tablero en <code>{{address}}</code>.',
    unreachableBody:
      'El tablero se ejecuta en otra máquina: comprueba que esta tenga conexión y que el tablero esté en marcha allí. La app lo reintenta sola, y {{retry}} lo intenta al instante.',
  },
}

/**
 * The supported language a tag or locale asks for (`es-MX`, `es_ES` and `es` are Spanish), if any.
 * @param {string | null | undefined} tag
 */
export function languageOfTag(tag) {
  const primary = String(tag ?? '')
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0]
  return LANGUAGES.find((l) => l === primary)
}

/**
 * The language to show: the board's (its `lang` cookie) when it is one we have, else the system's locale,
 * else English.
 * @param {string | null | undefined} cookie
 * @param {string | null | undefined} locale
 */
export const resolveLanguage = (cookie, locale) =>
  (LANGUAGES.includes(String(cookie)) ? String(cookie) : undefined) ??
  languageOfTag(locale) ??
  DEFAULT_LANGUAGE

/**
 * The text of `key` in `language` (English when that language lacks it), its {{placeholders}} filled from
 * `params`. A `count` picks `key_one` or `key_other` by the language's plural rules.
 * @param {string} language
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 */
export function t(language, key, params = {}) {
  const table = STRINGS[language] ?? STRINGS[DEFAULT_LANGUAGE]
  const english = /** @type {Record<string, string>} */ (STRINGS[DEFAULT_LANGUAGE])
  let name = key
  if (typeof params.count === 'number') {
    const form = `${key}_${new Intl.PluralRules(language in STRINGS ? language : DEFAULT_LANGUAGE).select(params.count)}`
    if (form in (table ?? {}) || form in english) name = form
  }
  const text = table?.[name] ?? english[name] ?? key
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, p) => (p in params ? String(params[p]) : ''))
}
