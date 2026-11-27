import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, LogOut, Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import { shared } from '#/i18n'
import { ago, stamp } from '#/lib/format'
import type { EnrolLink, PasskeyRow, SessionRow } from '#/server/passkeys'

const where = (rpId: string) => (rpId === 'localhost' ? shared.t('devices.thisMachine') : rpId)

/**
 * The devices section of Settings: the passkeys that sign in to the board and the sessions they opened,
 * each revocable, and "Add a device", which makes the one-time link another device enrols its passkey
 * with (README: "Signing in"). Revoking a passkey ends its sessions; the board keeps the last passkey of
 * this machine.
 */
export function Devices() {
  const { t } = useTranslation()
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
          {t('devices.title')}
        </h2>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => addDevice.mutate()}
            disabled={addDevice.isPending}
          >
            <Plus /> {t('devices.add')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
            <LogOut /> {t('devices.signOut')}
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{t('devices.text')}</p>

      {link && (
        <div className="space-y-2 rounded-md border p-3 text-sm" role="status">
          <p>{t('devices.link', { until: stamp(link.expiresAt) })}</p>
          {link.links.map((l) => (
            <div key={l.where} className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs text-muted-foreground">{l.where}</span>
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5 text-xs">{l.url}</code>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('devices.copyLinkAria', { where: l.where })}
                onClick={() =>
                  navigator.clipboard.writeText(l.url).then(
                    () => toast.success(t('connect.copied')),
                    () => toast.error(t('connect.couldNotCopy')),
                  )
                }
              >
                <Copy />
              </Button>
            </div>
          ))}
        </div>
      )}

      <ul className="divide-y rounded-md border text-sm" aria-label={t('devices.passkeys')}>
        {passkeys.data?.map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-3 py-2">
            <KeyRound className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{p.name}</div>
              <div className="text-xs text-muted-foreground">
                {p.sessions
                  ? t('devices.passkeyMetaSessions', {
                      count: p.sessions,
                      where: where(p.rpId),
                      added: ago(p.createdAt),
                      used: ago(p.lastUsedAt ?? p.createdAt),
                    })
                  : t('devices.passkeyMeta', {
                      where: where(p.rpId),
                      added: ago(p.createdAt),
                      used: ago(p.lastUsedAt ?? p.createdAt),
                    })}
              </div>
            </div>
            {p.rpId === 'localhost' && localKeys <= 1 ? (
              <span className="text-xs text-muted-foreground">{t('devices.lastLocal')}</span>
            ) : (
              <AlertDialog>
                <AlertDialogTrigger
                  render={
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t('devices.revokeAria', { name: p.name })}
                    />
                  }
                >
                  {t('connect.revoke')}
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('devices.revokeTitle', { name: p.name })}</AlertDialogTitle>
                    <AlertDialogDescription>{t('devices.revokeText')}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('connect.keep')}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => revokePasskey.mutate(p.id)}>
                      {t('connect.revoke')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </li>
        ))}
      </ul>

      <h3 className="pt-2 text-sm font-medium">{t('devices.signedIn')}</h3>
      <ul className="divide-y rounded-md border text-sm" aria-label={t('devices.sessions')}>
        {sessions.data?.map((s) => (
          <li key={s.id} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {s.passkey}
                {s.current && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {t('devices.thisBrowser')}
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {t('devices.sessionMeta', {
                  where: where(s.rpId),
                  signedIn: ago(s.createdAt),
                  seen: ago(s.lastSeenAt),
                  until: stamp(s.expiresAt),
                })}
              </div>
            </div>
            {!s.current && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('devices.signOutAria', { name: s.passkey, when: ago(s.createdAt) })}
                onClick={() => endSession.mutate(s.id)}
              >
                {t('devices.signOut')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
