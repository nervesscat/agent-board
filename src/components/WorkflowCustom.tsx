import { Pencil, Plus } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

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
import { TrashIcon } from '#/components/TrashIcon'
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
import { CUSTOM_NAME_MAX, WORKFLOW_STEPS, type WorkflowStepId } from '#/lib/workflow'

/** A workflow to start from, as the dialog lists it. */
export interface WorkflowChoice {
  id: string
  label: string
}

/**
 * The form of a workflow's name: a field and the reason the board gave when it refused the name. `onSubmit`
 * answers null once the name was kept, or the reason it was not (which stays under the field).
 */
function NameForm({
  initial,
  submit,
  onSubmit,
  children,
}: {
  initial: string
  submit: string
  onSubmit: (name: string) => Promise<string | null>
  children?: ReactNode
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <form
      className="grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        const reason = await onSubmit(name)
        setBusy(false)
        setError(reason)
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="workflow-name">{t('workflowCustom.name')}</Label>
        <Input
          id="workflow-name"
          value={name}
          maxLength={CUSTOM_NAME_MAX}
          required
          autoFocus
          autoComplete="off"
          aria-invalid={error !== null || undefined}
          aria-describedby={error ? 'workflow-name-error' : undefined}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
        />
        {error && (
          <p id="workflow-name-error" role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      {children}
      <DialogFooter>
        <Button type="submit" disabled={busy || !name.trim()}>
          {submit}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** "New workflow": a name and the workflow to copy; the copy is made on its own, whatever it is copied from. */
export function NewWorkflowDialog({
  choices,
  from,
  onCreate,
}: {
  choices: readonly WorkflowChoice[]
  /** The workflow offered to copy first: the one shown. */
  from: string
  onCreate: (name: string, from: string) => Promise<string | null>
}) {
  const [open, setOpen] = useState(false)
  const { t } = useTranslation()
  const [source, setSource] = useState(from)
  const items = Object.fromEntries(choices.map((c) => [c.id, c.label]))
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setSource(choices.some((c) => c.id === from) ? from : (choices[0]?.id ?? from))
      }}
    >
      <DialogTrigger render={<Button type="button" variant="outline" size="sm" data-new-workflow />}>
        <Plus data-icon="inline-start" /> {t('workflowCustom.new')}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('workflowCustom.new')}</DialogTitle>
          <DialogDescription>{t('workflowCustom.newDescription')}</DialogDescription>
        </DialogHeader>
        <NameForm
          initial=""
          submit={t('workflowCustom.create')}
          onSubmit={async (name) => {
            const reason = await onCreate(name, source)
            if (reason === null) setOpen(false)
            return reason
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="workflow-from">{t('workflowCustom.startFrom')}</Label>
            <Select value={source} items={items} onValueChange={(v) => v && setSource(v)}>
              <SelectTrigger id="workflow-from" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {choices.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </NameForm>
      </DialogContent>
    </Dialog>
  )
}

/** Rename one of the project's own workflows. */
export function RenameWorkflowDialog({
  name,
  onRename,
}: {
  name: string
  onRename: (name: string) => Promise<string | null>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" variant="outline" size="sm" data-rename-workflow />}>
        <Pencil data-icon="inline-start" /> {t('workflowCustom.rename')}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('workflowCustom.renameTitle')}</DialogTitle>
          <DialogDescription>{t('workflowCustom.renameDescription')}</DialogDescription>
        </DialogHeader>
        <NameForm
          // A fresh form each time it opens: nothing typed before stays.
          key={String(open)}
          initial={name}
          submit={t('workflowCustom.rename')}
          onSubmit={async (next) => {
            const reason = await onRename(next)
            if (reason === null) setOpen(false)
            return reason
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

/** Delete one of the project's own workflows, after a confirmation that says what follows instead. */
export function DeleteWorkflowButton({ name, onDelete }: { name: string; onDelete: () => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button type="button" variant="outline" size="sm" data-delete-workflow />}>
        <TrashIcon data-icon="inline-start" /> {t('common.delete')}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">
            {t('workflowCustom.deleteTitle', { name })}
          </AlertDialogTitle>
          <AlertDialogDescription className="wrap-anywhere">
            {t('workflowCustom.deleteDescription', { standard: t('workflowPresets.standard.label') })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
          >
            {t('workflowCustom.deleteWorkflow')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** The kinds of step the workflow lacks, to add one (the board puts it where its order allows). */
export function AddStepSelect({
  kinds,
  onAdd,
}: {
  kinds: readonly WorkflowStepId[]
  onAdd: (id: WorkflowStepId) => void
}) {
  const { t } = useTranslation()
  const items = Object.fromEntries(kinds.map((id) => [id, WORKFLOW_STEPS[id].label]))
  return (
    <Select
      // Always empty: a pick is an action, and the list shows only what is still missing.
      value={null}
      items={items}
      disabled={kinds.length === 0}
      onValueChange={(v) => v && onAdd(v as WorkflowStepId)}
    >
      <SelectTrigger aria-label={t('workflowCustom.addStep')} data-add-step className="w-full sm:w-52">
        <Plus className="size-3.5" aria-hidden />
        <SelectValue placeholder={kinds.length ? t('workflowCustom.addStep') : t('workflowCustom.allIn')} />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {kinds.map((id) => (
          <SelectItem key={id} value={id}>
            {WORKFLOW_STEPS[id].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
