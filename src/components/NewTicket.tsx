import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { AssigneeSelect } from '#/components/AssigneeSelect'
import { ComplexitySelect } from '#/components/Complexity'
import { PendingFiles, useFileDrop, useUploads } from '#/components/PendingFiles'
import { RichEditor } from '#/components/RichEditor'
import { StatusSelect } from '#/components/StatusSelect'
import { TagsInput, useTagChoices } from '#/components/TagsInput'
import { ListInput } from '#/components/ListInput'
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
import { DEFAULT_COMPLEXITY, type Complexity } from '#/lib/constants'
import { useProject } from '#/lib/project'
import { newTicketStage } from '#/lib/stages'
import { addTags, overTagLimits } from '#/lib/tags'
import { addTasks } from '#/lib/tasks'
import { ticketsKey } from '#/lib/tickets'
import { cn } from '#/lib/utils'

/**
 * A new top-level ticket, or with `parent` a new lane of that ticket. Files for the instructions
 * (attach, paste or drop anywhere on the dialog) upload as they are added and go with the ticket
 * when it is created. A ticket starts in the stage picked here, the first open one (Backlog) unless
 * another is picked, at the review level picked here (Mid unless changed); a lane has neither to pick,
 * so it starts where the server puts it (To do) at its parent's level.
 */
export function NewTicket({
  projectId,
  parent,
  open: externalOpen,
  onOpenChange,
  trigger = true,
}: {
  projectId: string
  parent?: TicketFull
  /** Its open state, when another control opens it (the command palette). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** False when another control draws the trigger. */
  trigger?: boolean
}) {
  const qc = useQueryClient()
  const [internalOpen, setInternalOpen] = useState(false)
  const open = externalOpen ?? internalOpen
  const setOpen = (next: boolean) => {
    setInternalOpen(next)
    onOpenChange?.(next)
  }
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tasks, setTasks] = useState<string[]>([])
  const [taskText, setTaskText] = useState('')
  const [assignee, setAssignee] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagText, setTagText] = useState('')
  const { data: project } = useProject(projectId)
  const [picked, setPicked] = useState('')
  const repos = project?.repos ?? []
  const repoId = picked || String(parent?.repoId ?? repos[0]?.id ?? '')
  const [stage, setStage] = useState('')
  const [complexity, setComplexity] = useState<Complexity>(DEFAULT_COMPLEXITY)
  // Sent as the stage's key: the kind `open` would resolve to To do. None until the stages have loaded.
  const status = parent ? undefined : stage || newTicketStage(project?.stages ?? [])?.key
  // A ticket waits for its stage, so that leaving it alone always means Backlog.
  const ready = Boolean(parent || status)
  // A top-level ticket starts with the project's default phases, the tasks typed here under the first.
  const phases = parent ? [] : (project?.defaultPhases ?? [])
  // Tags the server would refuse: the field says why, and Create waits until they are fixed.
  const over = overTagLimits(tags, tagText)
  const tagsOver = over.tooMany || over.tooLong
  const tagChoices = useTagChoices(projectId, tags)
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
        assignee,
        tags: addTags(tags, tagText),
        parentId: parent?.id,
        status,
        // A lane has no picker: it copies its parent's level on the server.
        complexity: parent ? undefined : complexity,
        repoId: repoId ? Number(repoId) : undefined,
        tasks: addTasks(tasks, taskText),
        attachmentIds: files.ids,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ticketsKey(projectId) })
      // Its tags are the project's used ones now, offered under the next ticket's field.
      qc.invalidateQueries({ queryKey: ['project', projectId] })
      // The projects' ticket counts: Getting started's last step ticks on the first one.
      qc.invalidateQueries({ queryKey: ['projects'] })
      if (parent) qc.invalidateQueries({ queryKey: ['ticket', String(parent.id)] })
      setOpen(false)
      setTitle('')
      setBody('')
      setTasks([])
      setTaskText('')
      setAssignee('')
      setTags([])
      setTagText('')
      setStage('')
      files.clear()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  // Mid each time it opens, after a create too; the other fields are kept as typed.
  useEffect(() => {
    if (open) setComplexity(DEFAULT_COMPLEXITY)
  }, [open])
  const noun = parent ? 'lane' : 'ticket'
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Mid each time it opens, after a create too; the other fields are kept as typed.
        if (next) setComplexity(DEFAULT_COMPLEXITY)
        setOpen(next)
      }}
    >
      {trigger && (
        <DialogTrigger
          render={<Button size={parent ? 'sm' : 'default'} variant={parent ? 'outline' : 'default'} />}
        >
          <Plus data-icon="inline-start" /> New {noun}
        </DialogTrigger>
      )}
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
            if (!files.uploading && ready && !tagsOver) create.mutate()
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
            {/* Not `tasks`: the ticket page's Tasks card has that id, and a lane is made on that page. */}
            <Label htmlFor="new-ticket-tasks">Initial tasks</Label>
            <ListInput
              id="new-ticket-tasks"
              value={tasks}
              onChange={setTasks}
              text={taskText}
              onTextChange={setTaskText}
            />
            {phases.length > 0 && (
              <p className="text-xs text-muted-foreground">
                It starts with the project&apos;s phases: {phases.join(', ')}. The tasks typed here go under{' '}
                {phases[0]}.
              </p>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {/* A top-level ticket's Stage and level share a row: Stage takes what the level leaves of the cell. */}
            {!parent && (
              <div className="flex gap-4">
                {status && (
                  <div className="min-w-0 flex-1 space-y-2">
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
                <div className="w-28 space-y-2">
                  <Label htmlFor="complexity">Complexity</Label>
                  <ComplexitySelect
                    id="complexity"
                    value={complexity}
                    onChange={setComplexity}
                    size="default"
                    className="w-full"
                  />
                </div>
              </div>
            )}
            {repos.length > 1 && (
              <div className="space-y-2">
                <Label htmlFor="repo">Repository</Label>
                <Select
                  value={repoId}
                  onValueChange={(v) => {
                    setPicked(v as string)
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
            {parent && (
              <div className="space-y-2">
                <Label htmlFor="assignee">Assignee (optional)</Label>
                <AssigneeSelect id="assignee" value={assignee} onChange={setAssignee} />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="tags">Tags (optional)</Label>
              <TagsInput
                id="tags"
                value={tags}
                onChange={setTags}
                text={tagText}
                onTextChange={setTagText}
                placeholder="High, Forms"
                choices={tagChoices}
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
            <Button type="submit" disabled={create.isPending || files.uploading || !ready || tagsOver}>
              {files.uploading ? 'Uploading…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
