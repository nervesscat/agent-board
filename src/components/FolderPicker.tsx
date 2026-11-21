import { useQuery } from '@tanstack/react-query'
import { ArrowUp, Folder, FolderGit2, Home } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Tip } from '#/components/ui/tooltip'
import { errorMessage, get, type DirListing } from '#/lib/api'

/**
 * Browse folders on the board's machine and pick one. Git checkouts are marked; double-click one
 * to take it straight away.
 */
export function FolderPicker({
  open,
  onOpenChange,
  start,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  start?: string
  onPick: (path: string) => void
}) {
  const { t } = useTranslation()
  const [dir, setDir] = useState('')
  const [typed, setTyped] = useState('')
  useEffect(() => {
    if (open) setDir(start ?? '')
  }, [open, start])
  const { data, error, isFetching } = useQuery({
    queryKey: ['fs-dirs', dir],
    queryFn: () => get<DirListing>(`/api/fs/dirs?path=${encodeURIComponent(dir)}`),
    enabled: open,
    retry: false,
    placeholderData: (prev) => prev,
  })
  useEffect(() => {
    if (data) setTyped(data.path)
  }, [data])
  const pick = (p: string) => {
    onPick(p)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('folderPicker.title')}</DialogTitle>
          <DialogDescription>
            <Trans
              i18nKey="folderPicker.description"
              components={{ repo: <FolderGit2 className="inline size-3.5" /> }}
            />
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            setDir(typed)
          }}
        >
          {/* On a wrapper: at the top folder the button is disabled, and a disabled button gets no hover. */}
          <Tip content={t('folderPicker.up')}>
            <span className="inline-flex">
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={t('folderPicker.up')}
                disabled={!data?.parent}
                onClick={() => data?.parent && setDir(data.parent)}
              >
                <ArrowUp />
              </Button>
            </span>
          </Tip>
          <Tip content={t('folderPicker.home')}>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={t('folderPicker.home')}
              onClick={() => setDir('')}
            >
              <Home />
            </Button>
          </Tip>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="h-7 flex-1 font-mono text-xs"
            aria-label={t('folderPicker.path')}
          />
        </form>
        {error && <p className="text-sm text-destructive">{errorMessage(error)}</p>}
        <ul
          className={`h-72 overflow-y-auto rounded-md border p-1 ${isFetching ? 'opacity-60' : ''}`}
          aria-label={t('folderPicker.folders')}
        >
          {data?.entries.length === 0 && (
            <li className="p-2 text-sm text-muted-foreground">{t('folderPicker.none')}</li>
          )}
          {data?.entries.map((e) => (
            <li key={e.path}>
              <button
                type="button"
                onClick={() => setDir(e.path)}
                onDoubleClick={() => e.isRepo && pick(e.path)}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
              >
                {e.isRepo ? (
                  <FolderGit2 className="size-4 shrink-0 text-primary" />
                ) : (
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{e.name}</span>
                {e.isRepo && (
                  <span className="ml-auto text-xs text-muted-foreground">{t('folderPicker.git')}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
        <DialogFooter className="items-center">
          <span className="mr-auto text-xs text-muted-foreground">
            {data && (data.isRepo ? t('folderPicker.isRepo') : t('folderPicker.notRepo'))}
          </span>
          <Button type="button" disabled={!data?.isRepo} onClick={() => data && pick(data.path)}>
            {t('folderPicker.use')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
