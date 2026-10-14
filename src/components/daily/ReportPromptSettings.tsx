import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Markdown } from '#/components/Markdown'
import { RichEditor } from '#/components/RichEditor'
import { refreshReports } from '#/components/daily/refresh'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Label } from '#/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Textarea } from '#/components/ui/textarea'
import { Tip } from '#/components/ui/tooltip'
import { errorMessage, patch, type ReportSettingsView } from '#/lib/api'
import type { ReportFormat } from '#/lib/constants'
import { DEFAULT_REPORT_TEMPLATE, templateHeadings } from '#/lib/reportTemplate'

const FORMATS: Record<ReportFormat, string> = { text: 'Text', file: 'A file (e.g. a PDF)' }

/**
 * What the report must say and how (the prompt), whether it is a text or a file, and the shape a
 * generated one takes (the template). The prompt and the template are edited and saved each on its own.
 */
export function ReportPromptSettings({
  projectId,
  settings,
}: {
  projectId: number
  settings: ReportSettingsView
}) {
  return (
    <div className="space-y-6">
      <PromptSettings projectId={projectId} settings={settings} />
      <TemplateSettings projectId={projectId} settings={settings} />
    </div>
  )
}

function PromptSettings({ projectId, settings }: { projectId: number; settings: ReportSettingsView }) {
  const [editing, setEditing] = useState(false)

  return (
    <div role="group" aria-label="Prompt" className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Prompt</h3>
        <span className="text-xs text-muted-foreground">
          {settings.format === 'file' ? 'a file' : 'text'}
        </span>
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
        <PromptForm projectId={projectId} settings={settings} onDone={() => setEditing(false)} />
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
          className="text-left text-sm text-muted-foreground hover:text-foreground"
        >
          No report prompt yet. Click to say what the report must contain and how, and whether it is a short
          text or a file.
        </button>
      )}
    </div>
  )
}

/** The prompt and the format, edited together; nothing is kept until Save. */
function PromptForm({
  projectId,
  settings,
  onDone,
}: {
  projectId: number
  settings: ReportSettingsView
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [prompt, setPrompt] = useState(settings.prompt)
  const [format, setFormat] = useState<ReportFormat>(settings.format)
  const save = useMutation({
    mutationFn: () => patch(`/api/projects/${projectId}/report-settings`, { prompt, format }),
    onSuccess: () => {
      refreshReports(qc, projectId)
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
        placeholder="What the report must say and how: who reads it, the tone, what to stress, a short text or a PDF."
      />
      <div className="flex flex-wrap items-end gap-3">
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

/** The sections a template asks for, as a line under it. */
function Sections({ template }: { template: string }) {
  const headings = templateHeadings(template)
  return (
    <p className="text-xs wrap-anywhere text-muted-foreground">
      {headings.length
        ? `A generated report has these sections, in this order: ${headings.map((h) => h.text).join(' · ')}.`
        : 'No headings: a generated report is not checked against it.'}
    </p>
  )
}

/** The markdown skeleton a generated report must fill: its headings, in order, are the sections. */
function TemplateSettings({ projectId, settings }: { projectId: number; settings: ReportSettingsView }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (template: string) => patch(`/api/projects/${projectId}/report-settings`, { template }),
    onSuccess: () => {
      refreshReports(qc, projectId)
      setDraft(null)
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  return (
    <div role="group" aria-label="Template" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Template</h3>
        {settings.templateIsDefault && <Badge variant="secondary">the default</Badge>}
        {draft === null && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto"
            onClick={() => setDraft(settings.template)}
          >
            <Pencil data-icon="inline-start" /> edit
          </Button>
        )}
      </div>
      {draft === null ? (
        <>
          <pre className="max-h-64 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap wrap-anywhere">
            {settings.template}
          </pre>
          <Sections template={settings.template} />
        </>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!save.isPending) save.mutate(draft)
          }}
        >
          <Textarea
            aria-label="Report template"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setDraft(null)
            }}
            autoFocus
            spellCheck={false}
            className="min-h-40 font-mono text-xs md:text-xs"
          />
          <Sections template={draft} />
          <div className="flex flex-wrap gap-2">
            {draft !== DEFAULT_REPORT_TEMPLATE && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setDraft(DEFAULT_REPORT_TEMPLATE)}
              >
                Use the default
              </Button>
            )}
            <div className="ml-auto flex gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </form>
      )}
    </div>
  )
}
