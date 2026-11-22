import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useBlocker } from '@tanstack/react-router'
import { FolderGit2, Pencil } from 'lucide-react'
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { InstructionsHistory, instructionChangesKey } from '#/components/InstructionsHistory'
import { DelayedLoading, SkeletonText } from '#/components/Loading'
import { Markdown } from '#/components/Markdown'
import { RichEditor } from '#/components/RichEditor'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '#/components/ui/alert-dialog'
import { Button } from '#/components/ui/button'
import { Label } from '#/components/ui/label'
import { Tip } from '#/components/ui/tooltip'
import { errorMessage, patch } from '#/lib/api'
import { useProject } from '#/lib/project'
import { useAnchor, useReveal } from '#/lib/reveal'

export const Route = createFileRoute('/projects/$id/instructions')({ component: InstructionsPage })

function InstructionsPage() {
  const { t } = useTranslation()
  const { id } = Route.useParams()
  const { data: p, error } = useProject(id)
  // A link into the history (#instructions-history) lands on it on an in-app navigation too.
  useReveal(useAnchor(), { page: id, ready: p !== undefined })
  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('instructions.pageTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('instructions.pageDescription')}</p>
      </div>
      {/* A new editor per project: an edit never follows the page to another one. */}
      {p ? (
        <Instructions key={id} projectId={id} saved={p.instructions} />
      ) : (
        !error && (
          <DelayedLoading label={t('loading.instructions')} className="space-y-2">
            <div className="h-5" />
            <div className="rounded-md border p-4">
              <SkeletonText lines={8} />
            </div>
          </DelayedLoading>
        )
      )}
      <div className="space-y-1 text-right text-sm">
        <ul className="space-y-0.5">
          {p?.repos.map((r) => (
            <Tip key={r.id} content={r.repoPath}>
              <li className="flex items-center justify-end gap-1.5 text-muted-foreground">
                <FolderGit2 className="size-3.5 shrink-0" />
                <span className="font-mono text-xs">{r.githubRepo ?? r.repoPath}</span>
              </li>
            </Tip>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          <Trans
            i18nKey="instructions.reposLine"
            components={{
              goto: (
                <Link
                  to="/projects/$id/repositories"
                  params={{ id }}
                  className="underline hover:text-foreground"
                />
              ),
            }}
          />
        </p>
      </div>
      <InstructionsHistory key={`history-${id}`} projectId={id} />
    </div>
  )
}

const always = () => true

/**
 * The project's instructions, edited in place like a ticket's: they read as rendered markdown, and
 * the editor stores markdown, which is what agents get. Unsaved changes are not lost by accident:
 * Cancel, Esc, leaving the page or closing the tab ask first.
 */
function Instructions({ projectId, saved }: { projectId: string; saved: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(saved)
  const [asking, setAsking] = useState(false)
  const dirty = editing && body !== saved
  const blocker = useBlocker({
    shouldBlockFn: always,
    disabled: !dirty,
    enableBeforeUnload: true,
    withResolver: true,
  })
  const save = useMutation({
    mutationFn: (instructions: string) => patch(`/api/projects/${projectId}`, { instructions }),
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      qc.invalidateQueries({ queryKey: instructionChangesKey(projectId) })
      // Back to reading once the saved text is the one shown.
      await qc.invalidateQueries({ queryKey: ['project', projectId] })
      setEditing(false)
      toast.success(t('common.saved'))
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const open = () => {
    setBody(saved)
    setEditing(true)
  }
  const submit = () => {
    if (save.isPending) return
    if (body === saved) setEditing(false)
    else save.mutate(body)
  }
  const cancel = () => {
    if (dirty) setAsking(true)
    else setEditing(false)
  }
  const stay = () => {
    setAsking(false)
    blocker.reset?.()
  }
  const discard = () => {
    setAsking(false)
    setEditing(false)
    blocker.proceed?.()
  }
  return (
    <section aria-label={t('instructions.sectionLabel')} className="space-y-2">
      <div className="flex items-center gap-3">
        <Label>{t('instructions.sectionLabel')}</Label>
        {!editing && (
          <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={open}>
            <Pencil data-icon="inline-start" /> {t('instructions.edit')}
          </Button>
        )}
      </div>
      {editing ? (
        <div className="space-y-2">
          <RichEditor
            value={body}
            onChange={setBody}
            onSubmit={submit}
            onCancel={cancel}
            autoFocus
            minHeight="min-h-64"
            label={t('instructions.sectionLabel')}
            placeholder={t('instructions.placeholder')}
          />
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">
              {dirty ? t('instructions.unsavedHint') : t('instructions.noChangesHint')}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={cancel}>
              {t('instructions.cancel')}
            </Button>
            <Button type="button" size="sm" onClick={submit} disabled={!dirty || save.isPending}>
              {save.isPending ? t('instructions.saving') : t('instructions.save')}
            </Button>
          </div>
        </div>
      ) : saved ? (
        // Clicking the text edits it; a link inside still opens.
        <Tip content={t('instructions.clickToEdit')}>
          <div
            role="button"
            tabIndex={0}
            className="cursor-text rounded-md border p-4 hover:bg-muted/30"
            onClick={(e) => {
              if (!(e.target as HTMLElement).closest('a, img')) open()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') open()
            }}
          >
            <Markdown>{saved}</Markdown>
          </div>
        </Tip>
      ) : (
        <button
          type="button"
          onClick={open}
          className="w-full rounded-md border border-dashed p-4 text-left text-sm text-muted-foreground hover:text-foreground"
        >
          {t('instructions.empty')}
        </button>
      )}
      <AlertDialog
        open={asking || blocker.status === 'blocked'}
        onOpenChange={(isOpen) => {
          if (!isOpen) stay()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('instructions.discardTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('instructions.discardDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('instructions.keepEditing')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={discard}>
              {t('instructions.discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
