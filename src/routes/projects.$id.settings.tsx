import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useBlocker } from '@tanstack/react-router'
import { FolderGit2, Pencil } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Markdown } from '#/components/Markdown'
import { RichEditor } from '#/components/RichEditor'
import { StagesEditor } from '#/components/StagesEditor'
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
import { errorMessage, patch } from '#/lib/api'
import { useProject } from '#/lib/project'

export const Route = createFileRoute('/projects/$id/settings')({ component: Settings })

function Settings() {
  const { id } = Route.useParams()
  const { data: p } = useProject(id)
  if (!p) return null
  return (
    <div className="space-y-10">
      <div className="max-w-3xl space-y-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Instructions</h1>
          <p className="text-sm text-muted-foreground">
            What every agent reads (via <code className="rounded bg-muted px-1">get_project</code>) before
            working here: conventions, how to run things, what never to do. They apply to all its repos.
          </p>
        </div>
        {/* A new editor per project: an edit never follows the page to another one. */}
        <Instructions key={id} projectId={id} saved={p.instructions} />
        <div className="space-y-1 text-right text-sm">
          <ul className="space-y-0.5">
            {p.repos.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-end gap-1.5 text-muted-foreground"
                title={r.repoPath}
              >
                <FolderGit2 className="size-3.5 shrink-0" />
                <span className="font-mono text-xs">{r.githubRepo ?? r.repoPath}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Repos:{' '}
            <Link to="/repositories" className="underline hover:text-foreground">
              Repositories page
            </Link>
            . Rename or delete the project: project menu → Manage projects.
          </p>
        </div>
      </div>
      <StagesEditor projectId={id} />
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
      // Back to reading once the saved text is the one shown.
      await qc.invalidateQueries({ queryKey: ['project', projectId] })
      setEditing(false)
      toast.success('Saved')
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
    <section aria-label="Project instructions" className="space-y-2">
      <div className="flex items-center gap-3">
        <Label>Project instructions</Label>
        {!editing && (
          <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={open}>
            <Pencil data-icon="inline-start" /> edit
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
            label="Project instructions"
            placeholder="How to run the repos, the conventions to follow, what never to do."
          />
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">
              {dirty ? 'Unsaved changes. Ctrl/⌘+Enter saves.' : 'No changes.'}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={cancel}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={submit} disabled={!dirty || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      ) : saved ? (
        // Clicking the text edits it; a link inside still opens.
        <div
          role="button"
          tabIndex={0}
          title="Click to edit"
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
      ) : (
        <button
          type="button"
          onClick={open}
          className="w-full rounded-md border border-dashed p-4 text-left text-sm text-muted-foreground hover:text-foreground"
        >
          No instructions yet. Click to write them.
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
            <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
            <AlertDialogDescription>
              The project instructions have unsaved changes. Agents keep reading the saved ones.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={discard}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
