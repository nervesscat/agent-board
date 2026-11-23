import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { errorMessage, get, patch } from '#/lib/api'
import { useProject } from '#/lib/project'
import { RESUME_COMMAND_MAX, RESUME_PRESETS, RESUME_TIMEOUT, resumeCommandProblem } from '#/lib/resume'

/**
 * The project's resume command: what the board runs on its own machine to continue a ticket once the
 * human answers a decision card or moves it from blocked or review back to an active stage. Empty is off.
 * It runs with the board user's rights, so only the signed-in human writes it. Its own section of the
 * project's settings.
 */
export function ResumeSettings({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const { data: p } = useProject(projectId)
  const { data: tools } = useQuery({
    queryKey: ['resume-tools'],
    queryFn: () => get<{ id: string; binary: string; found: boolean }[]>('/api/resume/tools'),
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
      toast.success('Saved')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  if (!p) return null
  return (
    <section id="resume" aria-label="Resume" className="max-w-3xl scroll-mt-16 space-y-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Resume</h2>
        <p className="text-sm text-muted-foreground">
          An agent that asks a question ends its turn. With a command here, the board continues the work
          itself when you answer a decision card on the board, or move a ticket from a blocked or review stage
          back to an active one: it runs the command on this machine, in the ticket&apos;s worktree, with the
          question and your answer (or your latest words) on its standard input and in the file named by{' '}
          <code>BOARD_RESUME_PROMPT_FILE</code>; <code>BOARD_URL</code>, <code>BOARD_PROJECT_ID</code>,{' '}
          <code>BOARD_TICKET_ID</code> and <code>BOARD_AGENT_NAME</code> are set. Nothing is started for a
          ticket with a live agent or one already resuming. It runs with the board user&apos;s rights, and
          only you can set it. Empty is off.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Presets">
        {RESUME_PRESETS.map((preset) => {
          const found = tools?.find((t) => t.id === preset.id)?.found
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
                  {found ? 'found' : 'not found'}
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
          <Label htmlFor="resume-command">Resume command</Label>
          <Input
            id="resume-command"
            className="font-mono"
            placeholder="claude -p (empty: off)"
            maxLength={RESUME_COMMAND_MAX}
            value={command}
            aria-invalid={!!problem}
            onChange={(e) => setCommand(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="resume-timeout">Stop it after (minutes)</Label>
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
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {problem ??
              (!timeoutOk
                ? `A whole number from ${RESUME_TIMEOUT.min} to ${RESUME_TIMEOUT.max}.`
                : dirty
                  ? 'Unsaved changes.'
                  : command.trim()
                    ? 'No changes.'
                    : 'Resuming is off.')}
          </span>
        </div>
      </form>
    </section>
  )
}
