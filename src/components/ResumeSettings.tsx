import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { errorMessage, get, patch, put } from '#/lib/api'
import { stamp } from '#/lib/format'
import { useProject } from '#/lib/project'
import { RESUME_COMMAND_MAX, RESUME_PRESETS, RESUME_TIMEOUT, resumeCommandProblem } from '#/lib/resume'

/**
 * The project's resume: a template the board ships (an agent may pick it) or a free-text command only the
 * human writes. What the board runs on its own machine to continue a ticket once the human answers a decision
 * card or moves it from blocked or review back to an active stage. A free-text command wins over the template.
 * Its own section of the project's settings.
 */
export function ResumeSettings({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: p } = useProject(projectId)
  const { data: tools } = useQuery({
    queryKey: ['resume-tools'],
    queryFn: () => get<{ id: string; binary: string; found: boolean }[]>('/api/resume/tools'),
  })
  const { data: templates } = useQuery({
    queryKey: ['resume-templates'],
    queryFn: () => get<{ id: string; name: string; found: boolean }[]>('/api/resume/templates'),
  })
  const pickTemplate = useMutation({
    mutationFn: (template: string | null) =>
      put<{ resumeTemplate: string }>(`/api/projects/${projectId}/resume-template`, { template }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['project', projectId] })
      void qc.invalidateQueries({ queryKey: ['ticket-resume'] })
      toast.success(t('common.saved'))
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const [command, setCommand] = useState(p?.resumeCommand ?? '')
  const [minutesText, setMinutesText] = useState(String(p?.resumeTimeoutMinutes ?? RESUME_TIMEOUT.default))
  const minutes = Number(minutesText)
  const timeoutOk =
    Number.isInteger(minutes) && minutes >= RESUME_TIMEOUT.min && minutes <= RESUME_TIMEOUT.max
  const problem = resumeCommandProblem(command)
  const dirty =
    !!p && (command.trim() !== p.resumeCommand || (timeoutOk && minutes !== p.resumeTimeoutMinutes))
  const save = useMutation({
    mutationFn: () =>
      patch<{ resumeCommand: string; resumeTimeoutMinutes: number }>(`/api/projects/${projectId}`, {
        resumeCommand: command.trim(),
        resumeTimeoutMinutes: minutes,
      }),
    onSuccess: async (row) => {
      setCommand(row.resumeCommand)
      setMinutesText(String(row.resumeTimeoutMinutes))
      await qc.invalidateQueries({ queryKey: ['project', projectId] })
      void qc.invalidateQueries({ queryKey: ['ticket-resume'] })
      toast.success(t('common.saved'))
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  if (!p) return null
  return (
    <section id="resume" aria-label={t('resumeSettings.title')} className="max-w-3xl scroll-mt-16 space-y-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{t('resumeSettings.title')}</h2>
        <p className="text-sm text-muted-foreground">
          <Trans i18nKey="resumeSettings.intro" components={{ code: <code /> }} />
        </p>
      </div>
      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label={t('resumeSettings.presets')}
      >
        {RESUME_PRESETS.map((preset) => {
          const found = tools?.find((tool) => tool.id === preset.id)?.found
          return (
            <Button
              key={preset.id}
              type="button"
              variant={command.trim() === preset.command ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => setCommand(preset.command)}
            >
              {preset.name}
              {found !== undefined && (
                <Badge variant={found ? 'secondary' : 'outline'} className="ml-1">
                  {found ? t('resumeSettings.found') : t('resumeSettings.notFound')}
                </Badge>
              )}
            </Button>
          )
        })}
      </div>
      <form
        className="space-y-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          if (dirty && !problem && timeoutOk && !save.isPending) save.mutate()
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="resume-command">{t('resumeSettings.command')}</Label>
          <Input
            id="resume-command"
            className="font-mono"
            placeholder={t('resumeSettings.commandPlaceholder')}
            maxLength={RESUME_COMMAND_MAX}
            value={command}
            aria-invalid={!!problem}
            onChange={(e) => setCommand(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="resume-timeout">{t('resumeSettings.timeout')}</Label>
            <Input
              id="resume-timeout"
              type="number"
              inputMode="numeric"
              min={RESUME_TIMEOUT.min}
              max={RESUME_TIMEOUT.max}
              step={1}
              className="w-32"
              value={minutesText}
              aria-invalid={!timeoutOk}
              onChange={(e) => setMinutesText(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={!dirty || !!problem || !timeoutOk || save.isPending}>
            {save.isPending ? t('resumeSettings.saving') : t('resumeSettings.save')}
          </Button>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {problem ??
              (!timeoutOk
                ? t('resumeSettings.timeoutProblem', { min: RESUME_TIMEOUT.min, max: RESUME_TIMEOUT.max })
                : dirty
                  ? t('resumeSettings.unsaved')
                  : command.trim()
                    ? t('resumeSettings.noChanges')
                    : t('resumeSettings.off'))}
          </span>
        </div>
      </form>
      <div className="space-y-2 rounded-lg border p-3">
        <h3 className="text-sm font-medium">{t('resumeSettings.templateTitle')}</h3>
        <p className="text-xs text-muted-foreground">{t('resumeSettings.templateIntro')}</p>
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label={t('resumeSettings.templateTitle')}
        >
          {templates?.map((tpl) => (
            <Button
              key={tpl.id}
              type="button"
              variant={p.resumeTemplate === tpl.id ? 'secondary' : 'outline'}
              size="sm"
              aria-pressed={p.resumeTemplate === tpl.id}
              disabled={pickTemplate.isPending}
              onClick={() => pickTemplate.mutate(tpl.id)}
            >
              {tpl.name}
              <Badge variant={tpl.found ? 'secondary' : 'outline'} className="ml-1">
                {tpl.found ? t('resumeSettings.found') : t('resumeSettings.notFound')}
              </Badge>
            </Button>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!p.resumeTemplate || pickTemplate.isPending}
            onClick={() => pickTemplate.mutate(null)}
          >
            {t('resumeSettings.templateOff')}
          </Button>
        </div>
        <p className="text-xs" aria-live="polite">
          {p.resumeTemplate && templates?.some((tpl) => tpl.id === p.resumeTemplate)
            ? t('resumeSettings.templateActive', {
                name: templates.find((tpl) => tpl.id === p.resumeTemplate)?.name,
                by: p.resumeTemplateBy,
                at: stamp(p.resumeTemplateAt),
              })
            : t('resumeSettings.templateNone')}
          {p.resumeTemplate && p.resumeCommand.trim() && (
            <span className="block text-amber-700 dark:text-amber-400">
              {t('resumeSettings.templateCommandWins')}
            </span>
          )}
        </p>
      </div>
    </section>
  )
}
