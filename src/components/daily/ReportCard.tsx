import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { History, Paperclip, Pencil } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Actor } from '#/components/Actor'
import { Attachments } from '#/components/Attachments'
import { Markdown } from '#/components/Markdown'
import { PendingFiles, useFileDrop } from '#/components/PendingFiles'
import { RichEditor } from '#/components/RichEditor'
import { GenerateReportButton } from '#/components/daily/GenerateReportButton'
import { refreshReports } from '#/components/daily/refresh'
import { REPORT_STATUS, statusLabel } from '#/components/daily/status'
import { Button } from '#/components/ui/button'
import { Tip } from '#/components/ui/tooltip'
import {
  errorMessage,
  get,
  post,
  uploadAll,
  type ReportList,
  type ReportPeriod,
  type ReportSettingsView,
  type ReportView,
} from '#/lib/api'
import type { ReportFormat } from '#/lib/constants'
import { stamp } from '#/lib/format'
import { describeSchedule, periodLabel, type TrackedCadence } from '#/lib/reports'
import { cn } from '#/lib/utils'

/**
 * The report of the period holding the day on show: its latest version (text, or the file in the
 * gallery), the earlier ones on demand, and a form to post a new one; claude can write it too.
 */
export function ReportCard({ projectId, date }: { projectId: number; date: string }) {
  const { t } = useTranslation()
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
  const cadence = settings.cadence === 'off' ? null : settings.cadence
  const period = cadence ? (list?.periods[0] ?? null) : null

  return (
    <section className="relative min-w-0 rounded-lg border p-4" aria-label={t('reportCard.region')}>
      {/* pr-9 keeps the header's line clear of the history button, floating in the card's top-right. */}
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 pr-9">
        <h2 className="text-sm font-medium">{t('reportCard.title')}</h2>
        <span className="text-xs text-muted-foreground">{describeSchedule(settings, t)}</span>
        <div className="ml-auto">
          <GenerateReportButton projectId={projectId} period={period?.period ?? null} list={list} />
        </div>
      </div>
      {!cadence ? (
        <p className="text-sm text-muted-foreground">{t('reportCard.off')}</p>
      ) : !list ? null : period ? (
        <PeriodReport
          key={period.period}
          projectId={projectId}
          period={period}
          cadence={cadence}
          format={settings.format}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t('reportCard.notAsked', { date })}</p>
      )}
    </section>
  )
}

/** One period: its report (and the earlier versions on demand), and a form to post one. */
function PeriodReport({
  projectId,
  period,
  cadence,
  format,
}: {
  projectId: number
  period: ReportPeriod
  cadence: TrackedCadence
  format: ReportFormat
}) {
  const { t } = useTranslation()
  const label = periodLabel(cadence, period.period, t)
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
        <span className="font-medium">{label}</span>
        <span className={cn('text-xs', status.text)}>{statusLabel(period.status, t)}</span>
        <span className="text-xs text-muted-foreground">
          {t('reportCard.due', { date: stamp(period.due) })}
        </span>
        {!writing && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto"
            onClick={() => setWriting(true)}
          >
            <Pencil data-icon="inline-start" /> {report ? t('reportCard.replace') : t('reportCard.post')}
          </Button>
        )}
      </div>
      {report ? (
        <ReportBody report={report} note={t('reportCard.versions', { count: period.versions })} />
      ) : (
        !writing && <p className="text-sm text-muted-foreground">{t('reportCard.none', { label })}</p>
      )}
      {period.versions > 1 && (
        <div>
          {/* The card's section is the positioned ancestor: it floats in the card's top-right. */}
          <Tip content={t('reportCard.history', { count: period.versions - 1 })}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="absolute top-2 right-2 text-muted-foreground"
              aria-expanded={history}
              aria-label={t('reportCard.history', { count: period.versions - 1 })}
              onClick={() => setHistory(!history)}
            >
              <History />
            </Button>
          </Tip>
          {history && (
            <ol className="mt-2 space-y-4 border-l pl-3" aria-label={t('reportCard.earlier')}>
              {(versions ?? []).slice(1).map((v, i, earlier) => (
                <li key={v.id}>
                  <ReportBody report={v} note={t('reportCard.version', { n: earlier.length - i })} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {writing && (
        <PostReport
          projectId={projectId}
          period={period}
          label={label}
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

/** One version: who wrote it and when (and `note`, e.g. how many versions there are), then the report. */
function ReportBody({ report, note }: { report: ReportView; note?: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">
        <Actor name={report.author} /> · {stamp(report.createdAt)}
        {note && ` · ${note}`}
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
  label,
  format,
  onCancel,
  onPosted,
}: {
  projectId: number
  period: ReportPeriod
  label: string
  format: ReportFormat
  onCancel: () => void
  onPosted: () => void
}) {
  const { t } = useTranslation()
  const [body, setBody] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const drop = useFileDrop((added) => setFiles((prev) => [...prev, ...added]))
  const send = useMutation({
    mutationFn: async () => {
      const attachmentIds = await uploadAll(files)
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
        label={t('reportCard.forLabel', { label })}
        placeholder={format === 'file' ? t('reportCard.placeholderFile') : t('reportCard.placeholderText')}
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
          <Paperclip data-icon="inline-start" /> {t('reportCard.attach')}
        </Button>
        <PendingFiles files={files} onChange={setFiles} />
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {t('reportCard.cancel')}
          </Button>
          {/* On a wrapper: without the file the button is disabled, and its tooltip says why. */}
          <Tip content={format === 'file' && !files.length ? t('reportCard.attachFirst') : undefined}>
            <span className="inline-flex">
              <Button type="submit" size="sm" disabled={!ready || send.isPending}>
                {send.isPending
                  ? t('reportCard.posting')
                  : period.report
                    ? t('reportCard.replaceButton')
                    : t('reportCard.postButton')}
              </Button>
            </span>
          </Tip>
        </div>
      </div>
    </form>
  )
}
