import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { History, Paperclip, Pencil } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'

import { Actor } from '#/components/Actor'
import { Attachments } from '#/components/Attachments'
import { Markdown } from '#/components/Markdown'
import { PendingFiles, useFileDrop } from '#/components/PendingFiles'
import { RichEditor } from '#/components/RichEditor'
import { GenerateReportButton } from '#/components/daily/GenerateReportButton'
import { refreshReports } from '#/components/daily/refresh'
import { REPORT_STATUS } from '#/components/daily/status'
import { Button } from '#/components/ui/button'
import {
  errorMessage,
  get,
  post,
  upload,
  type ReportList,
  type ReportPeriod,
  type ReportSettingsView,
  type ReportView,
} from '#/lib/api'
import type { ReportFormat } from '#/lib/constants'
import { stamp } from '#/lib/format'
import { describeSchedule } from '#/lib/reports'
import { cn } from '#/lib/utils'

/**
 * The report of the period holding the day on show: its latest version (text, or the file in the
 * gallery), the earlier ones on demand, and a form to post a new one; claude can write it too.
 */
export function ReportCard({ projectId, date }: { projectId: number; date: string }) {
  const { data: settings } = useQuery({
    queryKey: ['report-settings', projectId],
    queryFn: () => get<ReportSettingsView>(`/api/projects/${projectId}/report-settings`),
  })
  const { data: list } = useQuery({
    queryKey: ['reports', projectId, 'card', date],
    queryFn: () => get<ReportList>(`/api/projects/${projectId}/reports?from=${date}&to=${date}`),
    // A period turns red when its due time passes, without anyone posting; while claude writes the
    // report, its arrival is waited for closely.
    refetchInterval: (q) => (q.state.data?.generating ? 2_000 : 60_000),
  })

  if (!settings) return null
  const tracked = settings.cadence !== 'off'
  const period = tracked ? (list?.periods[0] ?? null) : null

  return (
    <section className="min-w-0 rounded-lg border p-4" aria-label="Report">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-medium">Report</h2>
        <span className="text-xs text-muted-foreground">{describeSchedule(settings)}</span>
        <div className="ml-auto">
          <GenerateReportButton projectId={projectId} period={period?.period ?? null} list={list} />
        </div>
      </div>
      {!tracked ? (
        <p className="text-sm text-muted-foreground">
          Reports are off for this project: choose how often one is due in the report settings.
        </p>
      ) : !list ? null : period ? (
        <PeriodReport key={period.period} projectId={projectId} period={period} format={settings.format} />
      ) : (
        <p className="text-sm text-muted-foreground">No report is asked for on {date}.</p>
      )}
    </section>
  )
}

/** One period: its report (and the earlier versions on demand), and a form to post one. */
function PeriodReport({
  projectId,
  period,
  format,
}: {
  projectId: number
  period: ReportPeriod
  format: ReportFormat
}) {
  const qc = useQueryClient()
  const [writing, setWriting] = useState(false)
  const [history, setHistory] = useState(false)
  const { report } = period
  const { data: versions } = useQuery({
    queryKey: ['reports', projectId, 'versions', period.period],
    queryFn: () => get<ReportView[]>(`/api/projects/${projectId}/reports/${period.period}`),
    enabled: history,
  })
  const status = REPORT_STATUS[period.status]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium">{period.label}</span>
        <span className={cn('text-xs', status.text)}>{status.label}</span>
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
      {period.versions > 0 && (
        <div className="text-xs text-muted-foreground">
          {period.versions} version{period.versions === 1 ? '' : 's'}
        </div>
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
            refreshReports(qc, projectId)
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
      </div>
      {report.body && <Markdown className="mt-1">{report.body}</Markdown>}
      <Attachments items={report.attachments} />
    </div>
  )
}

/** Text and/or files for a period; a file project needs a file. Posting again adds a newer version. */
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
          <Button
            type="submit"
            size="sm"
            disabled={!ready || send.isPending}
            title={format === 'file' && !files.length ? 'Attach the report file first' : undefined}
          >
            {send.isPending ? 'Posting…' : period.report ? 'Replace' : 'Post'}
          </Button>
        </div>
      </div>
    </form>
  )
}
