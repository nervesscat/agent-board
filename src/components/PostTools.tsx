import { useState } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '#/components/ui/alert-dialog'
import { Button } from '#/components/ui/button'
import { Textarea } from '#/components/ui/textarea'
import { stamp } from '#/lib/format'

/** The text of a post or reply, being edited in place: Ctrl/⌘+Enter saves, Esc cancels. */
export function EditBox({
  value,
  onSave,
  onCancel,
  pending,
}: {
  value: string
  onSave: (body: string) => void
  onCancel: () => void
  pending: boolean
}) {
  const [body, setBody] = useState(value)
  const save = () => body.trim() && !pending && onSave(body)
  return (
    <div className="mt-2 space-y-2">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={Math.min(14, Math.max(3, body.split('\n').length + 1))}
        autoFocus
        aria-label="Edit text"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save()
          if (e.key === 'Escape') onCancel()
        }}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={save} disabled={!body.trim() || pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

/** "edited", with when on hover. */
export function Edited({ at }: { at: string | null }) {
  if (!at) return null
  return (
    <span title={`edited ${stamp(at)}`} className="italic">
      edited
    </span>
  )
}

/** Edit and delete for a post or reply; they show when the row is hovered or focused. */
export function PostActions({
  what,
  onEdit,
  onDelete,
  children,
}: {
  /** What is deleted, for the confirmation: "this post", "this reply". */
  what: string
  onEdit: () => void
  onDelete: () => void
  /** More actions, before edit. */
  children?: React.ReactNode
}) {
  return (
    <span className="inline-flex items-center gap-2 opacity-0 transition-opacity group-hover/post:opacity-100 focus-within:opacity-100">
      {children}
      <button type="button" className="hover:text-foreground" onClick={onEdit}>
        edit
      </button>
      <AlertDialog>
        <AlertDialogTrigger render={<button type="button" className="hover:text-destructive" />}>
          delete
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {what}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its replies and files go with it. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </span>
  )
}
