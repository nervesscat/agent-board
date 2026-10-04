import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Paperclip, Reply } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'

import { Actor } from '#/components/Actor'
import { Attachments } from '#/components/Attachments'
import { cn } from '#/lib/utils'
import { PendingFiles, useFileDrop } from '#/components/PendingFiles'
import { Markdown } from '#/components/Markdown'
import { Button } from '#/components/ui/button'
import { Textarea } from '#/components/ui/textarea'
import { errorMessage, get, post, upload, type CommentRow } from '#/lib/api'
import { ago } from '#/lib/format'
import { useProjectAgents } from '#/lib/project'

export type Parent = 'ticket' | 'update' | 'pr' | 'review'

/** The comments under one parent, all levels, refreshed every 10 s. */
export function useComments(parentType: Parent, parentId: number) {
  const key = ['comments', parentType, parentId]
  const { data: comments = [] } = useQuery({
    queryKey: key,
    queryFn: () => get<CommentRow[]>(`/api/comments?parentType=${parentType}&parentId=${parentId}`),
    refetchInterval: 10_000,
  })
  return { key, comments }
}

/**
 * A comment with its replies (from `comments`, the whole thread). `onReply` puts a reply button on
 * it; `hideTime` leaves its own time out, for when a timeline shows it already; `label` names its
 * kind next to the author.
 */
export function CommentItem({
  c,
  comments,
  onReply,
  hideTime = false,
  label,
  depth = 0,
}: {
  c: CommentRow
  comments: CommentRow[]
  onReply?: () => void
  hideTime?: boolean
  label?: string
  depth?: number
}) {
  return (
    <div className={depth ? 'ml-6 border-l pl-3' : ''}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Actor name={c.author} via={c.via} className="text-foreground" />
        {label && <span>{label}</span>}
        {!hideTime && <span>{ago(c.createdAt)}</span>}
        {depth === 0 && onReply && (
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 hover:text-foreground"
            onClick={onReply}
          >
            <Reply className="size-3" /> reply
          </button>
        )}
      </div>
      <Markdown className="mt-1">{c.body}</Markdown>
      <Attachments items={c.attachments} />
      {comments
        .filter((r) => r.replyTo === c.id)
        .map((r) => (
          <div key={r.id} className="mt-3">
            <CommentItem c={r} comments={comments} depth={depth + 1} />
          </div>
        ))}
    </div>
  )
}

/** A comment thread under anything: tickets, updates, PRs, review results. Replies nest one level. */
export function Thread({
  parentType,
  parentId,
  compact = false,
}: {
  parentType: Parent
  parentId: number
  compact?: boolean
}) {
  const qc = useQueryClient()
  const { key, comments } = useComments(parentType, parentId)
  const [replyTo, setReplyTo] = useState<number | null>(null)
  const [body, setBody] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const drop = useFileDrop((added) => setFiles((prev) => [...prev, ...added]))
  const agents = useProjectAgents()
  const ask = agents.length ? ` · @${agents[0]!.name} asks that agent` : ''

  const send = useMutation({
    mutationFn: async () => {
      const attachmentIds = await Promise.all(files.map((f) => upload(f).then((a) => a.id)))
      return post('/api/comments', { parentType, parentId, replyTo, body, attachmentIds })
    },
    onSuccess: () => {
      setBody('')
      setFiles([])
      setReplyTo(null)
      qc.invalidateQueries({ queryKey: key })
      qc.invalidateQueries({ queryKey: ['daily'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  const roots = comments.filter((c) => !c.replyTo)
  return (
    <div className="space-y-4">
      {roots.length === 0 && !compact && <p className="text-sm text-muted-foreground">No comments yet.</p>}
      {roots.map((c) => (
        <CommentItem key={c.id} c={c} comments={comments} onReply={() => setReplyTo(c.id)} />
      ))}
      <form
        {...drop.props}
        className={cn('space-y-2 rounded-md', drop.className)}
        onSubmit={(e) => {
          e.preventDefault()
          if (body.trim()) send.mutate()
        }}
      >
        {replyTo && (
          <div className="text-xs text-muted-foreground">
            replying to {comments.find((c) => c.id === replyTo)?.author} ·{' '}
            <button type="button" className="underline" onClick={() => setReplyTo(null)}>
              cancel
            </button>
          </div>
        )}
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={compact ? `Comment…${ask}` : `Leave a comment (markdown)${ask}`}
          rows={compact ? 2 : 3}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && body.trim()) send.mutate()
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              setFiles([...files, ...Array.from(e.target.files ?? [])])
              // Clear it, so picking a file that was just removed registers again.
              e.target.value = ''
            }}
          />
          <Button type="button" variant="ghost" size="sm" onClick={() => fileInput.current?.click()}>
            <Paperclip data-icon="inline-start" /> attach
          </Button>
          <PendingFiles files={files} onChange={setFiles} />
          <Button type="submit" size="sm" className="ml-auto" disabled={!body.trim() || send.isPending}>
            {send.isPending ? 'Sending…' : 'Comment'}
          </Button>
        </div>
      </form>
    </div>
  )
}
