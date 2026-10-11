import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { History, Paperclip, Pencil } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'

import { Actor } from '#/components/Actor'
import { Attachments } from '#/components/Attachments'
import { Markdown } from '#/components/Markdown'
import { PendingFiles, useFileDrop } from '#/components/PendingFiles'
import { RichEditor } from '#/components/RichEditor'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Tip } from '#/components/ui/tooltip'
import {
  errorMessage,
  get,
  patch,
  post,
  upload,
  type ReportList,
  type ReportPeriod,
  type ReportSettings,
  type ReportView,
} from '#/lib/api'
import type { ReportCadence, ReportFormat } from '#/lib/constants'
import { stamp } from '#/lib/format'
import { WEEKDAYS, describeSchedule, type ReportStatus } from '#/lib/reports'
import { cn } from '#/lib/utils'

const CADENCES: Record<ReportCadence, string> = { off: 'Off', daily: 'Daily', weekly: 'Weekly' }
const FORMATS: Record<ReportFormat, string> = { text: 'Text', file: 'A file (e.g. a PDF)' }
const WEEKDAY_ITEMS = Object.fromEntries(WEEKDAYS.map((d, i) => [String(i + 1), d]))

const STATUS: Record<ReportStatus, { label: string; dot: string; text: string }> = {
  done: { label: 'done', dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-400' },
  missing: { label: 'missing', dot: 'bg-rose-500', text: 'text-rose-700 dark:text-rose-400' },
  upcoming: { label: 'upcoming', dot: 'bg-muted-foreground/30', text: 'text-muted-foreground' },
}

/**
 * The project's report: the prompt saying what it must contain and how, when it is due, and the
 * recent periods up to the day on show, green when reported, red when due without a report, grey
 * until due. A period opens its report (text, or the file in the gallery) and takes a new one.
 */
export function ReportPanel({ projectId, date }: { projectId: number; date: string }) {
  const qc = useQueryClient()
  const { data: settings } = useQuery({
    queryKey: ['report-settings', projectId],
    queryFn: () => get<ReportSettings>(`/api/projects/${projectId}/report-settings`),
  })
  const { data: list } = useQuery({
    queryKey: ['reports', projectId, date],
    queryFn: () => get<ReportList>(`/api/projects/${projectId}/reports?to=${date}`),
    enabled: Boolean(settings && settings.cadence !== 'off'),
    // A period turns red when its due time passes, without anyone posting.
    refetchInterval: 60_000,
  })
  const [editing, setEditing] = useState(false)
  // Which period is open, for the day on show; the newest one otherwise.
  const [pick, setPick] = useState<{ date: string; period: string } | null>(null)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['report-settings', projectId] })
    qc.invalidateQueries({ queryKey: ['reports', projectId] })
    qc.invalidateQueries({ queryKey: ['daily'] })
  }

  if (!settings) return null
  const periods = settings.cadence === 'off' ? [] : (list?.periods ?? [])
  const open = periods.find((p) => pick?.date === date && p.period === pick.period) ?? periods[0]
  const counts = { done: 0, missing: 0, upcoming: 0 }
  for (const p of periods) counts[p.status]++

  return (
    <section className="rounded-lg border p-4" aria-label="Report">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-medium">Report</h2>
        <span className="text-xs text-muted-foreground">{describeSchedule(settings)}</span>
        {!editing && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto"
            onClick={() => setEditing(true)}
          >
            <Pencil data-icon="inline-start" /> edit
          </Button>
        )}
      </div>

      {editing ? (
        <SettingsForm
          projectId={projectId}
          settings={settings}
          onDone={() => setEditing(false)}
          onSaved={refresh}
        />
      ) : settings.prompt ? (
        // Clicking the prompt edits it; a link inside still opens.
        <Tip content="Click to edit">
          <div
            role="button"
            tabIndex={0}
            className="cursor-text rounded-md hover:bg-muted/30"
            onClick={(e) => {
              if (!(e.target as HTMLElement).closest('a, img')) setEditing(true)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setEditing(true)
            }}
          >
            <Markdown>{settings.prompt}</Markdown>
          </div>
        </Tip>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          No report prompt yet. Click to say what the report must contain, how often, and whether it is a
          short text or a file.
        </button>
      )}

      {settings.cadence !== 'off' && (
        <div className="mt-4 border-t pt-4">
          <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
            {/* Oldest on the left, so the strip reads like a calendar. */}
            <ol className="flex flex-wrap items-end gap-1" aria-label="Report periods">
              {[...periods].reverse().map((p) => (
                <li key={p.period}>
                  <Tip content={`${p.label}: ${STATUS[p.status].label}, due ${stamp(p.due)}`}>
                    <button
                      type="button"
                      onClick={() => setPick({ date, period: p.period })}
                      aria-label={`${p.label}: ${STATUS[p.status].label}`}
                      aria-current={open?.period === p.period}
                      className={cn(
                        'flex min-w-8 flex-col items-center gap-1 rounded-md px-1 py-1 text-[10px] text-muted-foreground hover:bg-muted',
                        open?.period === p.period && 'bg-muted font-medium text-foreground',
                      )}
                    >
                      <span className={cn('h-4 w-6 rounded-sm', STATUS[p.status].dot)} />
                      {shortLabel(settings.cadence, p.period)}
                    </button>
                  </Tip>
                </li>
              ))}
            </ol>
            {periods.length > 0 && (
              <span className="ml-auto text-xs text-muted-foreground">
                {counts.done} done · {counts.missing} missing
              </span>
            )}
          </div>
          {list && !periods.length && (
            <p className="text-sm text-muted-foreground">No periods to show up to {date}.</p>
          )}
          {open && (
            <PeriodReport
              key={open.period}
              projectId={projectId}
              period={open}
              format={settings.format}
              onPosted={refresh}
            />
          )}
        </div>
      )}
    </section>
  )
}

/** "4" for a day, "Sep 28" for a week. */
function shortLabel(cadence: ReportCadence, period: string) {
  const d = new Date(`${period}T00:00:00`)
  return cadence === 'weekly'
    ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : String(d.getDate())
}

/** The prompt and the schedule, edited together; nothing is kept until Save. */
function SettingsForm({
  projectId,
  settings,
  onDone,
  onSaved,
}: {
  projectId: number
  settings: ReportSettings
  onDone: () => void
  onSaved: () => void
}) {
  const [prompt, setPrompt] = useState(settings.prompt)
  const [cadence, setCadence] = useState<ReportCadence>(settings.cadence)
  const [weekday, setWeekday] = useState(String(settings.weekday))
  const [dueTime, setDueTime] = useState(settings.dueTime ?? '')
  const [format, setFormat] = useState<ReportFormat>(settings.format)
  const save = useMutation({
    mutationFn: () =>
      patch(`/api/projects/${projectId}/report-settings`, {
        prompt,
        cadence,
        weekday: Number(weekday),
        dueTime: dueTime || null,
        format,
      }),
    onSuccess: () => {
      onSaved()
      onDone()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const submit = () => !save.isPending && save.mutate()

  return (
    <div className="space-y-3">
      <RichEditor
        value={prompt}
        onChange={setPrompt}
        onSubmit={submit}
        onCancel={onDone}
        autoFocus
        minHeight="min-h-40"
        label="Report prompt"
        placeholder="What the report must contain and how: by the hour or the day's highlights, sections, who reads it, tone, a two-line text or a PDF."
      />
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="report-cadence" className="text-xs">
            Due
          </Label>
          <Select value={cadence} onValueChange={(v) => setCadence(v as ReportCadence)} items={CADENCES}>
            <SelectTrigger id="report-cadence" size="sm" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(CADENCES).map(([k, v]) => (
                <SelectItem key={k} value={k}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {cadence === 'weekly' && (
          <div className="space-y-1">
            <Label htmlFor="report-weekday" className="text-xs">
              On
            </Label>
            <Select value={weekday} onValueChange={(v) => setWeekday(v as string)} items={WEEKDAY_ITEMS}>
              <SelectTrigger id="report-weekday" size="sm" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(WEEKDAY_ITEMS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {cadence !== 'off' && (
          <>
            <div className="space-y-1">
              <Label htmlFor="report-time" className="text-xs">
                By (empty: end of day)
              </Label>
              <Input
                id="report-time"
                type="time"
                value={dueTime}
                onChange={(e) => setDueTime(e.target.value)}
                className="h-7 w-32"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="report-format" className="text-xs">
                As
              </Label>
              <Select value={format} onValueChange={(v) => setFormat(v as ReportFormat)} items={FORMATS}>
                <SelectTrigger id="report-format" size="sm" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(FORMATS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        )}
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={submit} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** One period: its report (and the earlier versions on demand), and a form to post one. */
function PeriodReport({
  projectId,
  period,
  format,
  onPosted,
}: {
  projectId: number
  period: ReportPeriod
  format: ReportFormat
  onPosted: () => void
}) {
  const [writing, setWriting] = useState(false)
  const [history, setHistory] = useState(false)
  const { report } = period
  const { data: versions } = useQuery({
    queryKey: ['reports', projectId, 'versions', period.period],
    queryFn: () => get<ReportView[]>(`/api/projects/${projectId}/reports/${period.period}`),
    enabled: history,
  })

  return (
    <div className="mt-3 space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium">{period.label}</span>
        <span className={cn('text-xs', STATUS[period.status].text)}>{STATUS[period.status].label}</span>
        <span className="text-xs text-muted-foreground">due {stamp(period.due)}</span>
        {!writing && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto"
            onClick={() => setWriting(true)}
          >
            <Pencil data-icon="inline-start" /> {report ? 'replace' : 'post the report'}
          </Button>
        )}
      </div>
      {report ? (
        <ReportBody report={report} />
      ) : (
        !writing && <p className="text-sm text-muted-foreground">No report for {period.label} yet.</p>
      )}
      {period.versions > 1 && (
        <div>
          <Button type="button" variant="ghost" size="xs" onClick={() => setHistory(!history)}>
            <History data-icon="inline-start" />
            {history ? 'hide' : 'show'} {period.versions - 1} earlier version
            {period.versions === 2 ? '' : 's'}
          </Button>
          {history && (
            <div className="mt-2 space-y-4 border-l pl-3">
              {(versions ?? []).slice(1).map((v) => (
                <ReportBody key={v.id} report={v} />
              ))}
            </div>
          )}
        </div>
      )}
      {writing && (
        <PostReport
          projectId={projectId}
          period={period}
          format={format}
          onCancel={() => setWriting(false)}
          onPosted={() => {
            setWriting(false)
            onPosted()
          }}
        />
      )}
    </div>
  )
}

function ReportBody({ report }: { report: ReportView }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">
        <Actor name={report.author} /> · {stamp(report.createdAt)}
        {report.source === 'summary' && " · the day's summary"}
      </div>
      {report.body && <Markdown className="mt-1">{report.body}</Markdown>}
      <Attachments items={report.attachments} />
    </div>
  )
}

/** Text and/or files for a period; a file project needs a file. Posting again replaces the report. */
function PostReport({
  projectId,
  period,
  format,
  onCancel,
  onPosted,
}: {
  projectId: number
  period: ReportPeriod
  format: ReportFormat
  onCancel: () => void
  onPosted: () => void
}) {
  const [body, setBody] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const drop = useFileDrop((added) => setFiles((prev) => [...prev, ...added]))
  const send = useMutation({
    mutationFn: async () => {
      const attachmentIds = await Promise.all(files.map((f) => upload(f).then((a) => a.id)))
      return post(`/api/projects/${projectId}/reports`, { period: period.period, body, attachmentIds })
    },
    onSuccess: onPosted,
    onError: (err) => toast.error(errorMessage(err)),
  })
  const ready = format === 'file' ? files.length > 0 : Boolean(body.trim() || files.length)
  const submit = () => ready && !send.isPending && send.mutate()

  return (
    <form
      {...drop.props}
      className={cn('space-y-2 rounded-lg border p-3', drop.className)}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <RichEditor
        value={body}
        onChange={setBody}
        onFiles={(added) => setFiles((prev) => [...prev, ...added])}
        onSubmit={submit}
        onCancel={onCancel}
        autoFocus
        label={`Report for ${period.label}`}
        placeholder={
          format === 'file'
            ? 'Attach the report file; a line about it is optional.'
            : 'The report, as the prompt asks. Paste or drop files to attach them.'
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            setFiles([...files, ...Array.from(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
        <Button type="button" variant="ghost" size="sm" onClick={() => fileInput.current?.click()}>
          <Paperclip data-icon="inline-start" /> attach
        </Button>
        <PendingFiles files={files} onChange={setFiles} />
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          {/* On a wrapper: without the file the button is disabled, and its tooltip says why. */}
          <Tip content={format === 'file' && !files.length ? 'Attach the report file first' : undefined}>
            <span className="inline-flex">
              <Button type="submit" size="sm" disabled={!ready || send.isPending}>
                {send.isPending ? 'Posting…' : period.report ? 'Replace' : 'Post'}
              </Button>
            </span>
          </Tip>
        </div>
      </div>
    </form>
  )
}
