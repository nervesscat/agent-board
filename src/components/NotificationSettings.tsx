import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Switch } from '#/components/ui/switch'
import { ALERT_GROUPS } from '#/lib/alerts'
import { alertGroupLabel } from '#/lib/alertText'
import { type AlertTypeView, del, errorMessage, get, put } from '#/lib/api'

/**
 * The alerts this board can raise, by group, each with a switch for whether this project shows it in
 * its notification center. Turning one off only hides it here: the board still checks, and other
 * projects keep theirs. A group with no alert types says so.
 */
export function NotificationSettings({ projectId }: { projectId: string }) {
  const { t: tr } = useTranslation()
  const qc = useQueryClient()
  const key = ['alert-types', projectId] as const
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => get<AlertTypeView[]>(`/api/projects/${projectId}/alert-types`),
  })
  const toggle = useMutation({
    mutationFn: ({ type, muted }: { type: string; muted: boolean }) =>
      muted
        ? put(`/api/projects/${projectId}/alert-mutes/${type}`)
        : del(`/api/projects/${projectId}/alert-mutes/${type}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: key })
      await qc.invalidateQueries({ queryKey: ['notifications', projectId] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const types = (data ?? []).filter((t) => t.applies)
  return (
    <section
      id="notifications"
      aria-label={tr('notificationSettings.title')}
      className="max-w-3xl scroll-mt-16 space-y-3"
    >
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{tr('notificationSettings.title')}</h2>
        <p className="text-sm text-muted-foreground">{tr('notificationSettings.intro')}</p>
      </div>
      {data === undefined ? null : (
        <div className="space-y-4">
          {ALERT_GROUPS.map((group) => {
            const inGroup = types.filter((t) => t.group === group)
            return (
              <div key={group} role="group" aria-label={alertGroupLabel(group)} className="space-y-1">
                <h3 className="text-sm font-medium">{alertGroupLabel(group)}</h3>
                {inGroup.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{tr('notificationSettings.none')}</p>
                ) : (
                  <div className="divide-y rounded-md border">
                    {inGroup.map((t) => (
                      <label key={t.type} className="flex items-center gap-3 px-3 py-2">
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium">{t.label}</span>
                          <span className="block text-xs text-muted-foreground">{t.description}</span>
                        </span>
                        <Switch
                          checked={!t.muted}
                          disabled={toggle.isPending}
                          aria-label={tr('notificationSettings.show', { label: t.label })}
                          onCheckedChange={(on) => toggle.mutate({ type: t.type, muted: !on })}
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
