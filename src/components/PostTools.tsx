import { Pencil, Trash2 } from 'lucide-react'
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
import { Tip } from '#/components/ui/tooltip'
import { RichEditor } from '#/components/RichEditor'
import { stamp } from '#/lib/format'
import { cn } from '#/lib/utils'

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
      <RichEditor
        value={body}
        onChange={setBody}
        onSubmit={save}
        onCancel={onCancel}
        autoFocus
        label="Edit text"
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
    <Tip content={`edited ${stamp(at)}`}>
      <span className="italic">edited</span>
    </Tip>
  )
}

/**
 * One action in the row under a post or reply: an icon, named for screen readers by `label` (its words
 * as they were when the actions were text), with `tip` as its tooltip.
 */
export function ActionButton({
  label,
  tip,
  className,
  ...props
}: React.ComponentProps<typeof Button> & { label: string; tip: string }) {
  return (
    <Tip content={tip}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        className={cn('text-muted-foreground [&_svg]:size-3.5', className)}
        {...props}
      />
    </Tip>
  )
}

/**
 * Edit and delete for a post or reply, as icons; they show when its `group` (`group/post`, the post
 * without its thread, or `group/comment`, the reply without its own replies) is hovered, or one of them
 * is focused.
 */
export function PostActions({
  what,
  group,
  onEdit,
  onDelete,
  children,
}: {
  /** What is deleted, for the confirmation: "this post", "this reply". */
  what: string
  group: 'post' | 'comment'
  onEdit: () => void
  onDelete: () => void
  /** More actions, before edit. */
  children?: React.ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100',
        group === 'post' ? 'group-hover/post:opacity-100' : 'group-hover/comment:opacity-100',
      )}
    >
      {children}
      <ActionButton label="edit" tip="Edit" onClick={onEdit}>
        <Pencil />
      </ActionButton>
      <AlertDialog>
        <AlertDialogTrigger
          render={<ActionButton label="delete" tip="Delete" className="hover:text-destructive" />}
        >
          <Trash2 />
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
