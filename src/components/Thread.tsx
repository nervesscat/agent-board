import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Paperclip, Reply } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'

import { Actor } from '#/components/Actor'
import { Attachments } from '#/components/Attachments'
import { PendingFiles } from '#/components/PendingFiles'
import { Markdown } from '#/components/Markdown'
import { Button } from '#/components/ui/button'
import { Textarea } from '#/components/ui/textarea'
import { errorMessage, get, post, upload, type CommentRow } from '#/lib/api'
import { ago } from '#/lib/format'

type Parent = 'ticket' | 'update' | 'pr' | 'review'

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
  const key = ['comments', parentType, parentId]
  const { data: comments = [] } = useQuery({
    queryKey: key,
    queryFn: () => get<CommentRow[]>(`/api/comments?parentType=${parentType}&parentId=${parentId}`),
    refetchInterval: 10_000,
  })
  const [replyTo, setReplyTo] = useState<number | null>(null)
  const [body, setBody] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const fileInput = useRef<HTMLInputElement>(null)

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
  const replies = (id: number) => comments.filter((c) => c.replyTo === id)

  const Item = ({ c, depth }: { c: CommentRow; depth: number }) => (
    <div className={depth ? 'ml-6 border-l pl-3' : ''}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Actor name={c.author} className="text-foreground" />
        <span>{ago(c.createdAt)}</span>
        {depth === 0 && (
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 hover:text-foreground"
            onClick={() => setReplyTo(c.id)}
          >
            <Reply className="size-3" /> reply
          </button>
        )}
      </div>
      <Markdown className="mt-1">{c.body}</Markdown>
      <Attachments items={c.attachments} />
      {replies(c.id).map((r) => (
        <div key={r.id} className="mt-3">
          <Item c={r} depth={depth + 1} />
        </div>
      ))}
    </div>
  )

  return (
    <div className="space-y-4">
      {roots.length === 0 && !compact && <p className="text-sm text-muted-foreground">No comments yet.</p>}
      {roots.map((c) => (
        <Item key={c.id} c={c} depth={0} />
      ))}
      <form
        className="space-y-2"
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
          placeholder={compact ? 'Comment…' : 'Leave a comment (markdown)'}
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
