import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { AgentIdentities } from '#/components/AgentIdentities'
import { AgentPicker } from '#/components/AgentPicker'
import { Devices } from '#/components/Devices'
import { TailnetEntrance } from '#/components/TailnetEntrance'
import { PreviewLimitEditor } from '#/components/Preview'
import { Updates } from '#/components/Updates'
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxScroller,
  ComboboxTrigger,
  ComboboxValue,
} from '#/components/ui/combobox'
import { LANGUAGES, LANGUAGE_ENGLISH_NAME, LANGUAGE_NAME, setLanguage, shared, type Language } from '#/i18n'
import { loadTranslation } from '#/i18n/locales'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { errorMessage, get, type Me, patch } from '#/lib/api'
import { useAnchor, useReveal } from '#/lib/reveal'
import { THEMES, readTheme, setTheme, type Theme } from '#/lib/theme'
import type { Settings } from '#/server/agents'

/** Board-wide preferences: the Board tab of the Settings page. */
export function BoardSettings() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => get<Settings>('/api/settings') })
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/api/me'), staleTime: Infinity })
  // A link into a section (#theme, #previews …) lands on it on an in-app navigation too.
  useReveal(useAnchor(), { ready: data !== undefined && me !== undefined })
  const save = useMutation({
    mutationFn: (p: Partial<Settings>) => patch<Settings>('/api/settings', p),
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s)
      qc.invalidateQueries({ queryKey: ['agent-setup'] })
      toast.success(t('common.saved'))
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  if (!data) return null
  return (
    <div className="max-w-3xl space-y-6">
      <section id="default-agent" className="scroll-mt-16 space-y-2">
        <h2 className="text-sm font-medium">{t('settings.board.defaultAgent.title')}</h2>
        <p className="text-sm text-muted-foreground">
          <Trans
            i18nKey="settings.board.defaultAgent.text"
            components={{ goto: <Link to="/agents" className="underline hover:text-foreground" /> }}
          />
        </p>
        <AgentPicker value={data.defaultAgent} onChange={(defaultAgent) => save.mutate({ defaultAgent })} />
      </section>
      <Theme />
      <LanguagePicker />
      <section id="previews" className="scroll-mt-16 space-y-2">
        <h2 className="text-sm font-medium">{t('settings.board.previews.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings.board.previews.text')}</p>
        <PreviewLimitEditor key={data.previewLimit} id="settings-preview-limit" limit={data.previewLimit} />
      </section>
      {/* The app's updates are the human's: an agent never sees them here, and their routes refuse one. */}
      {me && !me.agent && <Updates />}
      {/* The agents' roles are the human's call: an agent never sees them here. */}
      {me && !me.agent && (
        <div id="agent-roles" className="scroll-mt-16">
          <AgentIdentities />
        </div>
      )}
      {/* The tailnet entrance is the human's; with sign-in off it shows why it cannot be saved there. */}
      {me && !me.agent && (
        <div id="tailnet" className="scroll-mt-16">
          <TailnetEntrance />
        </div>
      )}
      {/* With sign-in off (test mode, AUTH=off) there are no passkeys to show. */}
      {me && !me.authOff && !me.agent && (
        <div id="devices" className="scroll-mt-16">
          <Devices />
        </div>
      )}
    </div>
  )
}

/**
 * The board's colour scheme: the system's unless this browser picked light or dark. It follows the
 * system's changes while the system's is picked (src/lib/theme.ts).
 */
function Theme() {
  const { t } = useTranslation()
  const [theme, pick] = useState<Theme>('system')
  useEffect(() => {
    const saved = readTheme()
    pick(saved)
    setTheme(saved)
  }, [])
  return (
    <section id="theme" className="scroll-mt-16 space-y-2">
      <h2 className="text-sm font-medium">{t('settings.board.theme.title')}</h2>
      <p className="text-sm text-muted-foreground">{t('settings.board.theme.text')}</p>
      <Tabs
        value={theme}
        onValueChange={(value) => {
          const next = THEMES.find((t) => t === value) ?? 'system'
          pick(next)
          setTheme(next)
        }}
      >
        <TabsList aria-label={t('settings.board.theme.title')}>
          {THEMES.map((value) => (
            <TabsTrigger key={value} value={value}>
              {t(`settings.board.theme.${value}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </section>
  )
}

/** The file of the language picked could not be fetched (as opposed to a failure to keep the choice on the board). */
class LanguageLoadError extends Error {}

/**
 * The language of the interface: kept on the board for the person (it follows them to every device) and
 * applied at once, with no reload. Until one is picked the browser's decides, and that is what shows here.
 */
function LanguagePicker() {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  // The language asked for last: an answer to an earlier ask arriving late (its file was slow) is not the person's choice.
  const asked = useRef<Language>(undefined)
  const save = useMutation({
    // Switched at once, kept on the board meanwhile; the confirmation waits for both, so it is in the new language.
    mutationFn: async (language: Language) => {
      asked.current = language
      // First the language's file: when it cannot come (offline), nothing changes and nothing is saved.
      await loadTranslation(language).catch(() => {
        throw new LanguageLoadError()
      })
      // A later pick took over while it loaded: only the last one is applied and kept.
      if (asked.current !== language) return { language }
      const [saved] = await Promise.all([
        patch<{ language: Language }>('/api/me', { language }),
        setLanguage(language),
      ])
      return saved
    },
    onSuccess: ({ language }) => {
      if (language !== asked.current) return
      qc.setQueryData<Me>(['me'], (me) => (me ? { ...me, language } : me))
      // The page was drawn again in the new language: this render's `t` is the old one.
      toast.success(shared.t('common.saved'))
    },
    onError: (err) => {
      // The pick did not happen: the dropdown goes back to the language on screen.
      setPicked(i18n.language as Language)
      toast.error(
        err instanceof LanguageLoadError ? shared.t('settings.board.language.failed') : errorMessage(err),
      )
    },
  })
  const showing = i18n.language as Language
  // The last language picked, which can be one whose file is still loading (`showing` is the one on screen): the
  // dropdown shows the pick at once, and picking the language still on screen again is a new pick.
  const [picked, setPicked] = useState(showing)
  useEffect(() => {
    setPicked(showing)
  }, [showing])
  const [query, setQuery] = useState('')
  const shown = LANGUAGES.filter((code) => languageMatches(code, query))
  return (
    <section id="language" className="scroll-mt-16 space-y-2">
      <h2 className="text-sm font-medium">{t('settings.board.language.title')}</h2>
      <p className="text-sm text-muted-foreground">{t('settings.board.language.text')}</p>
      <Combobox<Language>
        value={picked}
        onValueChange={(next) => {
          if (!next || next === picked) return
          setPicked(next)
          save.mutate(next)
        }}
        items={LANGUAGES}
        filteredItems={shown}
        inputValue={query}
        onInputValueChange={setQuery}
        // Closed, the search goes.
        onOpenChangeComplete={(isOpen) => {
          if (!isOpen) setQuery('')
        }}
        itemToStringLabel={(code) => LANGUAGE_NAME[code]}
        itemToStringValue={(code) => code}
      >
        <ComboboxTrigger
          id="language-select"
          aria-label={t('settings.board.language.title')}
          className="w-60 max-w-full"
        >
          <ComboboxValue>
            {/* Each language in its own words, whatever the page is in: findable by whoever cannot read it. */}
            {(code: Language) => <span lang={code}>{LANGUAGE_NAME[code]}</span>}
          </ComboboxValue>
        </ComboboxTrigger>
        <ComboboxContent aria-label={t('settings.board.language.title')}>
          <ComboboxInput
            placeholder={t('settings.board.language.search')}
            aria-label={t('settings.board.language.search')}
          />
          <ComboboxScroller>
            <ComboboxList>
              {shown.map((code) => (
                <ComboboxItem key={code} value={code} lang={code}>
                  {LANGUAGE_NAME[code]}
                </ComboboxItem>
              ))}
            </ComboboxList>
            {shown.length === 0 && (
              <p className="px-1.5 py-1 text-sm text-muted-foreground">{t('settings.board.language.none')}</p>
            )}
          </ComboboxScroller>
        </ComboboxContent>
      </Combobox>
    </section>
  )
}

const plain = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** Whether a language answers a search: by its own name, its English name or its code ("deutsch", "german", "de"). */
export function languageMatches(code: Language, query: string): boolean {
  const q = plain(query.trim())
  if (!q) return true
  return [LANGUAGE_NAME[code], LANGUAGE_ENGLISH_NAME[code], code].some((name) => plain(name).includes(q))
}
