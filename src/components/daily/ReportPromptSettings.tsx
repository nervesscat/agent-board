import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Markdown } from '#/components/Markdown'
import { RichEditor } from '#/components/RichEditor'
import { refreshReports } from '#/components/daily/refresh'
import { Button } from '#/components/ui/button'
import { Label } from '#/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { errorMessage, patch, type ReportSettingsView } from '#/lib/api'
import type { ReportFormat } from '#/lib/constants'

const FORMATS: Record<ReportFormat, string> = { text: 'Text', file: 'A file (e.g. a PDF)' }

/** What the report must say and how (the prompt), and whether it is a text or a file. */
export function ReportPromptSettings({
  projectId,
  settings,
}: {
  projectId: number
  settings: ReportSettingsView
}) {
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
        <div
          role="button"
          tabIndex={0}
          title="Click to edit"
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
