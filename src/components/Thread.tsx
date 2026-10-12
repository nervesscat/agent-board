import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Reply } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'

import { Actor } from '#/components/Actor'
import { Attachments } from '#/components/Attachments'
import { cn } from '#/lib/utils'
import { PendingFiles, useFileDrop } from '#/components/PendingFiles'
import { Markdown } from '#/components/Markdown'
import { ActionButton, EditBox, Edited, PostActions } from '#/components/PostTools'
import { RichEditor } from '#/components/RichEditor'
import { Button } from '#/components/ui/button'
import { del, errorMessage, get, patch, post, upload, type CommentRow } from '#/lib/api'
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
 * A comment with its replies (from `comments`, the whole thread), its actions in a row under its own
 * text, before its replies. `onReply` puts a reply button there; `hideTime` leaves its own time out, for
 * when a timeline shows it already; `label` names its kind next to the author. Edit and delete refresh
 * the thread under `threadKey`.
 */
export function CommentItem({
  c,
  comments,
  threadKey,
  onReply,
  hideTime = false,
  label,
  depth = 0,
}: {
  c: CommentRow
  comments: CommentRow[]
  threadKey: unknown[]
  onReply?: () => void
  hideTime?: boolean
  label?: string
  depth?: number
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: threadKey })
    // Reply counts on the ticket page.
    qc.invalidateQueries({ queryKey: ['ticket'] })
    qc.invalidateQueries({ queryKey: ['daily'] })
  }
  const onError = (err: unknown) => toast.error(errorMessage(err))
  const edit = useMutation({
    mutationFn: (body: string) => patch(`/api/comments/${c.id}`, { body }),
    onSuccess: () => {
      setEditing(false)
      refresh()
    },
    onError,
  })
  const remove = useMutation({ mutationFn: () => del(`/api/comments/${c.id}`), onSuccess: refresh, onError })
  return (
    <div className={depth ? 'ml-6 border-l pl-3' : ''}>
      {/* The comment without its replies: hovering it shows its own edit and delete, not theirs. A link
            lands on it as #reply-<id> (src/lib/reveal.ts), below the ticket page's stuck header. */}
      <div
        id={`reply-${c.id}`}
        className="group/comment scroll-mt-[calc(var(--ticket-header,4rem)+1rem)] rounded-md"
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Actor name={c.author} via={c.via} className="text-foreground" />
          {label && <span>{label}</span>}
          {!hideTime && <span>{ago(c.createdAt)}</span>}
          <Edited at={c.editedAt} />
        </div>
        {editing ? (
          <EditBox
            value={c.body}
            pending={edit.isPending}
            onSave={(body) => edit.mutate(body)}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <Markdown className="mt-1">{c.body}</Markdown>
        )}
        <Attachments items={c.attachments} />
        <div role="group" aria-label="Reply actions" className="mt-1 flex items-center gap-0.5">
          {depth === 0 && onReply && (
            <ActionButton label="reply" tip="Reply" onClick={onReply}>
              <Reply />
            </ActionButton>
          )}
          <PostActions
            what="this reply"
            group="comment"
            onEdit={() => setEditing(true)}
            onDelete={() => remove.mutate()}
          />
        </div>
      </div>
      {comments
        .filter((r) => r.replyTo === c.id)
        .map((r) => (
          <div key={r.id} className="mt-3">
            <CommentItem c={r} comments={comments} threadKey={threadKey} depth={depth + 1} />
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
        <CommentItem key={c.id} c={c} comments={comments} threadKey={key} onReply={() => setReplyTo(c.id)} />
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
        <RichEditor
          value={body}
          onChange={setBody}
          onFiles={(added) => setFiles((prev) => [...prev, ...added])}
          onAttach={() => fileInput.current?.click()}
          onSubmit={() => body.trim() && !send.isPending && send.mutate()}
          minHeight={compact ? 'min-h-12' : 'min-h-20'}
          label="Reply"
          placeholder={compact ? `Reply…${ask}` : `Leave a reply${ask}`}
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
          <PendingFiles files={files} onChange={setFiles} />
          <Button type="submit" size="sm" className="ml-auto" disabled={!body.trim() || send.isPending}>
            {send.isPending ? 'Sending…' : 'Reply'}
          </Button>
        </div>
      </form>
    </div>
  )
}
