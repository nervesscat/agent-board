import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Paperclip, Plus } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'

import { AssigneeSelect } from '#/components/AssigneeSelect'
import { BranchSelect } from '#/components/BranchSelect'
import { PendingFiles, useFileDrop, useUploads } from '#/components/PendingFiles'
import { RichEditor } from '#/components/RichEditor'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Textarea } from '#/components/ui/textarea'
import { errorMessage, post, type Ticket, type TicketFull } from '#/lib/api'
import { useProject } from '#/lib/project'
import { ticketsKey } from '#/lib/tickets'
import { cn } from '#/lib/utils'

/**
 * A new top-level ticket, or with `parent` a new lane of that ticket. Files for the instructions
 * (attach, paste or drop anywhere on the dialog) upload as they are added and go with the ticket
 * when it is created.
 */
export function NewTicket({ projectId, parent }: { projectId: string; parent?: TicketFull }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tasks, setTasks] = useState('')
  const [branch, setBranch] = useState('')
  const [assignee, setAssignee] = useState('')
  const [tags, setTags] = useState('')
  const { data: project } = useProject(projectId)
  const [picked, setPicked] = useState('')
  const repos = project?.repos ?? []
  const repoId = picked || String(parent?.repoId ?? repos[0]?.id ?? '')
  const files = useUploads()
  const fileInput = useRef<HTMLInputElement>(null)
  const drop = useFileDrop(files.add)
  const create = useMutation({
    mutationFn: () =>
      post<Ticket>(`/api/projects/${projectId}/tickets`, {
        title,
        body,
        branch,
        assignee,
        tags: tags
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        parentId: parent?.id,
        repoId: repoId ? Number(repoId) : undefined,
        tasks: tasks
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        attachmentIds: files.ids,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ticketsKey(projectId) })
      if (parent) qc.invalidateQueries({ queryKey: ['ticket', String(parent.id)] })
      setOpen(false)
      setTitle('')
      setBody('')
      setTasks('')
      setBranch('')
      setAssignee('')
      setTags('')
      files.clear()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const noun = parent ? 'lane' : 'ticket'
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button size={parent ? 'sm' : 'default'} variant={parent ? 'outline' : 'default'} />}
      >
        <Plus data-icon="inline-start" /> New {noun}
      </DialogTrigger>
      <DialogContent {...drop.props} className={cn('sm:max-w-xl', drop.className)}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (!files.uploading) create.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>New {noun}</DialogTitle>
            <DialogDescription>
              {parent ? (
                <>
                  A parallel piece of <span className="text-foreground">{parent.title}</span>, with its own
                  branch, assignee, tasks and updates.
                </>
              ) : (
                'Write it the way you would brief a colleague: agents read this before they start.'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="t">Title</Label>
            <Input id="t" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>Instructions</Label>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? [])
                  if (picked.length) files.add(picked)
                  // Clear it, so picking a file that was just removed registers again.
                  e.target.value = ''
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip data-icon="inline-start" /> attach
              </Button>
            </div>
            <RichEditor
              value={body}
              onChange={setBody}
              onFiles={files.add}
              minHeight="min-h-32"
              label="Instructions"
              placeholder="What to do, how to know it is done, what never to do. Paste or drop files to attach them."
            />
            {files.files.length > 0 && (
              <div className="flex flex-wrap items-end gap-3 pt-1">
                <PendingFiles
                  files={files.files}
                  onChange={files.setFiles}
                  uploading={files.isUploading}
                  thumbnails
                />
              </div>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="tasks">Initial tasks, one per line</Label>
            <Textarea id="tasks" value={tasks} onChange={(e) => setTasks(e.target.value)} rows={3} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {repos.length > 1 && (
              <div className="space-y-2">
                <Label htmlFor="repo">Repository</Label>
                <Select
                  value={repoId}
                  onValueChange={(v) => {
                    setPicked(v as string)
                    setBranch('')
                  }}
                  items={Object.fromEntries(repos.map((r) => [String(r.id), r.name]))}
                >
                  <SelectTrigger id="repo" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {repos.map((r) => (
                      <SelectItem key={r.id} value={String(r.id)}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="br">Branch (optional)</Label>
              <BranchSelect id="br" value={branch} onChange={setBranch} repoId={repoId} optional />
            </div>
            {parent && (
              <div className="space-y-2">
                <Label htmlFor="assignee">Assignee (optional)</Label>
                <AssigneeSelect id="assignee" value={assignee} onChange={setAssignee} />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="tags">Tags (optional)</Label>
              <Input
                id="tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="High, Forms"
              />
            </div>
          </div>
          {parent && (parent.branch || parent.baseBranch) && (
            <p className="text-xs text-muted-foreground">
              Branches off <span className="font-mono">{parent.branch || parent.baseBranch}</span> when it is
              in the same repo.
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={create.isPending || files.uploading}>
              {files.uploading ? 'Uploading…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
