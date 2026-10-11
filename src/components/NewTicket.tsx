import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'

import { AssigneeSelect } from '#/components/AssigneeSelect'
import { BranchSelect } from '#/components/BranchSelect'
import { PendingFiles, useFileDrop, useUploads } from '#/components/PendingFiles'
import { RichEditor } from '#/components/RichEditor'
import { StatusSelect } from '#/components/StatusSelect'
import { TasksInput } from '#/components/TasksInput'
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
import { errorMessage, post, type Ticket, type TicketFull } from '#/lib/api'
import { useProject } from '#/lib/project'
import { newTicketStage } from '#/lib/stages'
import { addTasks } from '#/lib/tasks'
import { ticketsKey } from '#/lib/tickets'
import { cn } from '#/lib/utils'

/**
 * A new top-level ticket, or with `parent` a new lane of that ticket. Files for the instructions
 * (attach, paste or drop anywhere on the dialog) upload as they are added and go with the ticket
 * when it is created. A ticket starts in the stage picked here, the first open one (Backlog) unless
 * another is picked; a lane has none to pick and starts where the server puts it (To do).
 */
export function NewTicket({ projectId, parent }: { projectId: string; parent?: TicketFull }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tasks, setTasks] = useState<string[]>([])
  const [taskText, setTaskText] = useState('')
  const [branch, setBranch] = useState('')
  const [assignee, setAssignee] = useState('')
  const [tags, setTags] = useState('')
  const { data: project } = useProject(projectId)
  const [picked, setPicked] = useState('')
  const repos = project?.repos ?? []
  const repoId = picked || String(parent?.repoId ?? repos[0]?.id ?? '')
  const [stage, setStage] = useState('')
  // Sent as the stage's key: the kind `open` would resolve to To do. None until the stages have loaded.
  const status = parent ? undefined : stage || newTicketStage(project?.stages ?? [])?.key
  // A ticket waits for its stage, so that leaving it alone always means Backlog.
  const ready = Boolean(parent || status)
  const files = useUploads()
  const fileInput = useRef<HTMLInputElement>(null)
  const drop = useFileDrop(files.add)
  // The heading's height: a new lane's names its parent, whose title can wrap over many lines.
  const [headHeight, setHeadHeight] = useState(0)
  const measureHead = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const measure = () => setHeadHeight(el.offsetHeight)
    measure()
    const resized = new ResizeObserver(measure)
    resized.observe(el)
    return () => resized.disconnect()
  }, [])
  // Room kept around the caret: a gap below the heading, and above the one-button footer (65px) with
  // a gap. The browser keeps it as the fields' scroll padding, the instructions editor as its own.
  const caretRoom = { top: headHeight + 16, bottom: 96 }
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
        status,
        repoId: repoId ? Number(repoId) : undefined,
        tasks: addTasks(tasks, taskText),
        attachmentIds: files.ids,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ticketsKey(projectId) })
      if (parent) qc.invalidateQueries({ queryKey: ['ticket', String(parent.id)] })
      setOpen(false)
      setTitle('')
      setBody('')
      setTasks([])
      setTaskText('')
      setBranch('')
      setAssignee('')
      setTags('')
      setStage('')
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
      {/* Long instructions, tasks or files scroll the form, which never outgrows the screen; the
          heading and the footer stick to its ends, so Create and the close button stay in reach. The
          caret is kept clear of them: below the heading as tall as it is, above the one-button footer. */}
      <DialogContent
        {...drop.props}
        className={cn('p-0 *:data-[slot=dialog-close]:z-20 sm:max-w-xl', drop.className)}
      >
        <form
          className="max-h-[calc(100dvh-2rem)] space-y-4 overflow-y-auto p-4"
          style={{ scrollPaddingTop: caretRoom.top, scrollPaddingBottom: caretRoom.bottom }}
          onSubmit={(e) => {
            e.preventDefault()
            if (!files.uploading && ready) create.mutate()
          }}
        >
          <DialogHeader
            ref={measureHead}
            className="sticky -top-4 z-10 -mx-4 -mt-4 mb-0 rounded-t-xl bg-popover p-4"
          >
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
            <RichEditor
              value={body}
              onChange={setBody}
              onFiles={files.add}
              onAttach={() => fileInput.current?.click()}
              minHeight="min-h-32"
              caretRoom={caretRoom}
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
            <Label htmlFor="tasks">Initial tasks</Label>
            <TasksInput
              id="tasks"
              value={tasks}
              onChange={setTasks}
              text={taskText}
              onTextChange={setTaskText}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {status && (
              <div className="space-y-2">
                <Label htmlFor="stage">Stage</Label>
                <StatusSelect
                  id="stage"
                  stages={project?.stages ?? []}
                  value={status}
                  onChange={setStage}
                  size="default"
                  className="w-full"
                />
              </div>
            )}
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
          <DialogFooter className="sticky -bottom-4 z-10 bg-popover bg-linear-to-b from-muted/50 to-muted/50">
            <Button type="submit" disabled={create.isPending || files.uploading || !ready}>
              {files.uploading ? 'Uploading…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
