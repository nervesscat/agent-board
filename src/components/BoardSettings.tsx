import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { AgentIdentities } from '#/components/AgentIdentities'
import { AgentPicker } from '#/components/AgentPicker'
import { Devices } from '#/components/Devices'
import { TailnetEntrance } from '#/components/TailnetEntrance'
import { PreviewLimitEditor } from '#/components/Preview'
import { Updates } from '#/components/Updates'
import { LANGUAGES, LANGUAGE_NAME, setLanguage, type Language } from '#/i18n'
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
            components={{ link: <Link to="/agents" className="underline hover:text-foreground" /> }}
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

/**
 * The language of the interface: kept on the board for the person (it follows them to every device) and
 * applied at once, with no reload. Until one is picked the browser's decides, and that is what shows here.
 */
function LanguagePicker() {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: (language: Language) => patch<{ language: Language }>('/api/me', { language }),
    onSuccess: ({ language }) => {
      qc.setQueryData<Me>(['me'], (me) => (me ? { ...me, language } : me))
      toast.success(t('common.saved'))
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const showing = i18n.language
  return (
    <section id="language" className="scroll-mt-16 space-y-2">
      <h2 className="text-sm font-medium">{t('settings.board.language.title')}</h2>
      <p className="text-sm text-muted-foreground">{t('settings.board.language.text')}</p>
      <Tabs
        value={showing}
        onValueChange={(value) => {
          const next = LANGUAGES.find((l) => l === value)
          if (!next) return
          setLanguage(next)
          save.mutate(next)
        }}
      >
        <TabsList aria-label={t('settings.board.language.title')}>
          {LANGUAGES.map((value) => (
            // Each language in its own words, whatever the page is in: findable by whoever cannot read it.
            <TabsTrigger key={value} value={value} lang={value}>
              {LANGUAGE_NAME[value]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </section>
  )
}
