import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { CheckCircle2, Copy, RefreshCw, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'

import { BackToModule } from '#/components/BackToModule'
import { AgentPicker, CopyBlock, copyText } from '#/components/AgentPicker'
import { AgentTokenList, GenerateCommands } from '#/components/AgentTokens'
import { SkillInstallButton, useSkillToken } from '#/components/SkillInstall'
import { Button } from '#/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { ReviewSkills, useShell, useSkillsStatus } from '#/components/ReviewSkills'
import { AGENTS, SHELLS, type Shell, mcpSetup, sessionSkillInstall, skillInstall } from '#/lib/agents'
import { errorMessage, get, post } from '#/lib/api'
import type { AgentClient } from '#/lib/constants'
import { stamp } from '#/lib/format'
import { useAnchor, useReveal } from '#/lib/reveal'
import type { Settings } from '#/server/agents'
import type { OpencodeConfig } from '#/server/opencodeConfig'
import type { NewAgentToken } from '#/server/tokens'

// ?shell= is the shell the install lines are for (none: the one this browser remembers, else bash).
export const Route = createFileRoute('/agents')({
  component: ConnectAgents,
  validateSearch: z.object({ shell: z.enum(SHELLS).optional().catch(undefined) }),
})

type Setup = { boardUrl: string; settings: Settings; opencode: OpencodeConfig }

function ConnectAgents() {
  const { t } = useTranslation()
  const { data: setup } = useQuery({
    queryKey: ['agent-setup'],
    queryFn: () => get<Setup>('/api/agent-setup'),
  })
  const [client, setClient] = useState<AgentClient | null>(null)
  const [shell, pickShell] = useShell()
  // The token "Generate commands" made: shown once, in the MCP setup line on this page, never stored here.
  const [made, setMade] = useState<NewAgentToken | null>(null)
  const token = made?.token ?? ''
  // The install lines' own credential: short-lived, minted by the first copy, carried by every line after.
  const { made: skillToken, copyLine } = useSkillToken()
  const skillTokenValue = skillToken?.token ?? ''
  const reviewStatus = useSkillsStatus()
  const reviewInstalled =
    reviewStatus.data?.global.status === 'current' || reviewStatus.data?.global.status === 'outdated'
  useEffect(() => {
    if (setup && !client) setClient(setup.settings.defaultAgent)
  }, [setup, client])
  const skill = useQuery({
    queryKey: ['agent-skill', client],
    queryFn: async () => {
      const r = await fetch(`/api/agent-setup/skill?client=${client}`)
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      return r.text()
    },
    enabled: Boolean(client),
  })
  // A link into a section (#agent-tokens, #review-skills) lands on it on an in-app navigation too.
  useReveal(useAnchor(), { ready: setup !== undefined && client !== null })
  if (!setup || !client) return null
  const agent = AGENTS[client]
  const mcp = mcpSetup(client, setup.boardUrl, token)
  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <BackToModule />
        <h1 className="text-xl font-semibold tracking-tight">{t('connect.title')}</h1>
        <p className="text-sm text-muted-foreground">
          <Trans
            i18nKey="connect.intro"
            components={{
              strong: <strong />,
              goto: <Link to="/settings" className="underline hover:text-foreground" />,
            }}
          />
        </p>
      </div>

      <AgentPicker
        value={client}
        onChange={(c) => {
          // A token is one agent's: another CLI starts again from its own name, with no token.
          setClient(c)
          setMade(null)
        }}
      />

      {client === 'opencode' && <OpencodeDelegation config={setup.opencode} />}

      {/* Keyed by the CLI: another CLI's field is a new one, and a press of the old one hands over nothing. */}
      <GenerateCommands key={client} defaultName={client} token={made} onToken={setMade} />

      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t('connect.step1.title')}</h2>
        <p className="text-xs text-muted-foreground">
          {mcp.kind === 'command' ? (
            t('connect.step1.command')
          ) : (
            <Trans
              i18nKey={client === 'opencode' ? 'connect.step1.configOpencode' : 'connect.step1.config'}
              values={{ file: agent.mcpFile }}
              components={{ code: <code className="rounded bg-muted px-1" /> }}
            />
          )}
        </p>
        <CopyBlock text={mcp.text} />
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">{t('connect.step2.title')}</h2>
          <Tabs value={shell} onValueChange={(v) => pickShell(v as Shell)}>
            <TabsList>
              {/* i18n-ignore: shell names */}
              <TabsTrigger value="bash">bash / zsh</TabsTrigger>
              {/* i18n-ignore: shell name */}
              <TabsTrigger value="powershell">PowerShell</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <p className="text-xs text-muted-foreground">
          <Trans
            i18nKey={
              client === 'codex'
                ? 'connect.step2.textCodex'
                : client === 'opencode'
                  ? 'connect.step2.textOpencode'
                  : 'connect.step2.text'
            }
            values={{
              path: `${shell === 'bash' ? agent.skillDir.unix : agent.skillDir.windows}/SKILL.md`,
              agent: agent.label,
            }}
            components={{ code: <code className="rounded bg-muted px-1" /> }}
          />
        </p>
        <CopyBlock
          text={skillInstall(client, shell, setup.boardUrl, skillTokenValue)}
          onCopy={() => copyLine((tok) => skillInstall(client, shell, setup.boardUrl, tok))}
        />
        {skillToken && (
          <p role="status" className="text-xs text-muted-foreground">
            <Trans
              i18nKey="connect.step2.tokenNote"
              values={{ at: stamp(skillToken.expiresAt) }}
              components={{ time: <time dateTime={skillToken.expiresAt} /> }}
            />
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <SkillInstallButton kind="skill" client={client} />
          <Button
            variant="outline"
            size="sm"
            disabled={!skill.data}
            onClick={() => skill.data && copyText(skill.data, t('connect.step2.skillCopied'))}
          >
            <Copy data-icon="inline-start" /> {t('connect.step2.copySkill')}
          </Button>
          {skill.error && <span className="text-xs text-destructive">{errorMessage(skill.error)}</span>}
        </div>
        {skill.data && (
          <details className="rounded-md border">
            <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
              {t('connect.step2.previewSkill')}
            </summary>
            <pre className="max-h-96 overflow-auto border-t p-3 font-mono text-xs whitespace-pre-wrap">
              {skill.data}
            </pre>
          </details>
        )}
        <p className="text-xs text-muted-foreground">
          <Trans
            i18nKey="connect.step2.session"
            components={{ code: <code className="rounded bg-muted px-1" /> }}
          />
        </p>
        <CopyBlock
          text={sessionSkillInstall(client, shell, setup.boardUrl, skillTokenValue)}
          onCopy={() => copyLine((tok) => sessionSkillInstall(client, shell, setup.boardUrl, tok))}
        />
      </section>

      <section id="review-skills" className="scroll-mt-16 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">{t('connect.step3.title')}</h2>
          <SkillInstallButton kind="review-skills" installed={reviewInstalled} />
        </div>
        <ReviewSkills
          boardUrl={setup.boardUrl}
          token={skillTokenValue}
          copyLine={copyLine}
          shell={shell}
          onShellChange={pickShell}
        />
      </section>

      <AgentTokenList />
    </div>
  )
}

/**
 * Whether OpenCode can run a subagent from inside a subagent, read from its config on the board's machine:
 * off (the default) with the snippet that turns it on and the file it read, on with the depth and where it
 * came from, or a file that could not be read. "Check again" re-reads it after the human edits the file;
 * the board never writes it.
 */
function OpencodeDelegation({ config }: { config: OpencodeConfig }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const check = useMutation({
    mutationFn: () => post<OpencodeConfig>('/api/agent-setup/opencode-check'),
    onSuccess: (opencode) =>
      queryClient.setQueryData<Setup>(['agent-setup'], (old) => (old ? { ...old, opencode } : old)),
    onError: (err) => toast.error(errorMessage(err)),
  })
  const again = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={t('connect.opencode.checkAria')}
      disabled={check.isPending}
      onClick={() => check.mutate()}
    >
      <RefreshCw data-icon="inline-start" className={check.isPending ? 'animate-spin' : ''} />{' '}
      {t('connect.checkAgain')}
    </Button>
  )

  if (config.error && !config.set)
    return (
      <section
        aria-label={t('connect.opencode.section')}
        className="flex items-start gap-2 rounded-md border border-rose-300/60 bg-rose-50 p-3 text-rose-950 dark:border-rose-400/20 dark:bg-rose-950/40 dark:text-rose-100"
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm font-medium">{t('connect.opencode.readFailed')}</p>
          <p className="text-xs [overflow-wrap:anywhere]">{config.error}</p>
          <p className="text-xs">{t('connect.opencode.readFailedText')}</p>
          {config.ignoredDeprecated && <IgnoredDeprecated source={config.ignoredDeprecated} />}
          {again}
        </div>
      </section>
    )

  if (config.set)
    return (
      <section
        aria-label={t('connect.opencode.section')}
        className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
      >
        <div className="min-w-0 space-y-1">
          <p className="flex items-center gap-1.5 text-sm">
            <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            <span>{t('connect.opencode.on', { depth: config.depth })}</span>
          </p>
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            <Trans
              i18nKey="connect.opencode.readFrom"
              values={{ source: config.source }}
              components={{ code: <code className="rounded bg-muted px-1" /> }}
            />
          </p>
          {config.error && (
            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{config.error}</p>
          )}
          {config.ignoredDeprecated && (
            <IgnoredDeprecated source={config.ignoredDeprecated} className="text-muted-foreground" />
          )}
        </div>
        {again}
      </section>
    )

  return (
    <section
      aria-label={t('connect.opencode.section')}
      className="rounded-md border border-amber-300/60 bg-amber-50 p-3 text-amber-950 dark:border-amber-400/20 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm font-medium">{t('connect.opencode.off')}</p>
          <p className="text-xs [overflow-wrap:anywhere]">
            <Trans
              i18nKey="connect.opencode.offText"
              values={{ source: config.source }}
              components={{ code: <code className="rounded bg-black/10 px-1 dark:bg-white/10" /> }}
            />
          </p>
          {config.ignoredDeprecated && <IgnoredDeprecated source={config.ignoredDeprecated} />}
          <CopyBlock
            text={'"experimental": { "subagent_depth": 2 }'}
            label={t('connect.opencode.copySnippet')}
          />
          {again}
        </div>
      </div>
    </section>
  )
}

/**
 * OpenCode v2.2.5 drops the top-level `subagent_depth` as an unsupported legacy setting: a document that
 * still has it looks configured but does nothing. Say where it is, so the human moves it into the
 * `experimental` block the card reads.
 */
function IgnoredDeprecated({ source, className = '' }: { source: string; className?: string }) {
  return (
    <p className={`text-xs [overflow-wrap:anywhere] ${className}`}>
      <Trans
        i18nKey="connect.opencode.deprecated"
        values={{ source }}
        components={{ code: <code className="rounded bg-black/10 px-1 font-mono dark:bg-white/10" /> }}
      />
    </p>
  )
}
