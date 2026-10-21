import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, LogOut, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

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
import { del, errorMessage, get, post } from '#/lib/api'
import { ago, stamp } from '#/lib/format'
import type { EnrolLink, PasskeyRow, SessionRow } from '#/server/passkeys'

const where = (rpId: string) => (rpId === 'localhost' ? 'this machine' : rpId)

/**
 * The devices section of Settings: the passkeys that sign in to the board and the sessions they opened,
 * each revocable, and "Add a device", which makes the one-time link another device enrols its passkey
 * with (README: "Signing in"). Revoking a passkey ends its sessions; the board keeps the last passkey of
 * this machine.
 */
export function Devices() {
  const qc = useQueryClient()
  const passkeys = useQuery({
    queryKey: ['passkeys'],
    queryFn: () => get<PasskeyRow[]>('/api/auth/passkeys'),
  })
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => get<SessionRow[]>('/api/auth/sessions'),
  })
  const [link, setLink] = useState<EnrolLink | null>(null)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['passkeys'] })
    qc.invalidateQueries({ queryKey: ['sessions'] })
  }
  const addDevice = useMutation({
    mutationFn: () => post<EnrolLink>('/api/auth/enrol-links'),
    onSuccess: setLink,
    onError: (err) => toast.error(errorMessage(err)),
  })
  const revokePasskey = useMutation({
    mutationFn: (id: number) => del(`/api/auth/passkeys/${id}`),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err)),
  })
  const endSession = useMutation({
    mutationFn: (id: number) => del(`/api/auth/sessions/${id}`),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err)),
  })
  const signOut = useMutation({
    mutationFn: () => post('/api/auth/logout'),
    onSuccess: () => window.location.assign('/login'),
    onError: (err) => toast.error(errorMessage(err)),
  })
  const localKeys = passkeys.data?.filter((p) => p.rpId === 'localhost').length ?? 0

  return (
    <section className="space-y-3" aria-labelledby="devices-title">
      <div className="flex items-center justify-between gap-2">
        <h2 id="devices-title" className="text-sm font-medium">
          Devices
        </h2>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => addDevice.mutate()}
            disabled={addDevice.isPending}
          >
            <Plus /> Add a device
          </Button>
          <Button size="sm" variant="ghost" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
            <LogOut /> Sign out
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        The passkeys that sign in to the board. A passkey works on the address it was made on: this machine
        (localhost), or the board&apos;s tailnet name for your other devices.
      </p>

      {link && (
        <div className="space-y-2 rounded-md border p-3 text-sm" role="status">
          <p>
            Open this link on the new device and create a passkey there. It works once, until{' '}
            {stamp(link.expiresAt)}.
          </p>
          {link.links.map((l) => (
            <div key={l.where} className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs text-muted-foreground">{l.where}</span>
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5 text-xs">{l.url}</code>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Copy the ${l.where} link`}
                onClick={() =>
                  navigator.clipboard.writeText(l.url).then(
                    () => toast.success('Copied'),
                    () => toast.error('Could not copy'),
                  )
                }
              >
                <Copy />
              </Button>
            </div>
          ))}
        </div>
      )}

      <ul className="divide-y rounded-md border text-sm" aria-label="Passkeys">
        {passkeys.data?.map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-3 py-2">
            <KeyRound className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{p.name}</div>
              <div className="text-xs text-muted-foreground">
                {where(p.rpId)} · added {ago(p.createdAt)} · last used {ago(p.lastUsedAt ?? p.createdAt)}
                {p.sessions ? ` · ${p.sessions} session${p.sessions === 1 ? '' : 's'}` : ''}
              </div>
            </div>
            {p.rpId === 'localhost' && localKeys <= 1 ? (
              <span className="text-xs text-muted-foreground">last on this machine</span>
            ) : (
              <AlertDialog>
                <AlertDialogTrigger
                  render={<Button size="sm" variant="ghost" aria-label={`Revoke ${p.name}`} />}
                >
                  Revoke
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Revoke {p.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The passkey signs in no more, and the browsers signed in with it are signed out.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep</AlertDialogCancel>
                    <AlertDialogAction onClick={() => revokePasskey.mutate(p.id)}>Revoke</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </li>
        ))}
      </ul>

      <h3 className="pt-2 text-sm font-medium">Signed in</h3>
      <ul className="divide-y rounded-md border text-sm" aria-label="Sessions">
        {sessions.data?.map((s) => (
          <li key={s.id} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {s.passkey}
                {s.current && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">this browser</span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {where(s.rpId)} · signed in {ago(s.createdAt)} · seen {ago(s.lastSeenAt)} · until{' '}
                {stamp(s.expiresAt)}
              </div>
            </div>
            {!s.current && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Sign out ${s.passkey}, signed in ${ago(s.createdAt)}`}
                onClick={() => endSession.mutate(s.id)}
              >
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
