import { useTranslation } from 'react-i18next'

import { isWorkflowPreset } from '#/lib/workflow'

/**
 * The project's tag map, read only: each tag to the workflow a ticket with that tag, and no workflow of its
 * own, follows. Agents set it (the set_workflow_tags tool); the Workflow page shows what is set, and says how
 * to set it when nothing is.
 */
export function TagMap({
  tags,
  presets,
}: {
  tags: Readonly<Record<string, string>>
  presets: readonly { id: string; label: string }[]
}) {
  const { t } = useTranslation()
  const rows = Object.entries(tags)
  return (
    <section aria-label={t('workflowTags.title')} className="space-y-2">
      <h2 className="text-sm font-medium">{t('workflowTags.title')}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-tag-map-empty>
          {t('workflowTags.empty')}
        </p>
      ) : (
        <table className="w-full max-w-md text-sm" data-tag-map>
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1 pr-3 font-medium">{t('workflowTags.tag')}</th>
              <th className="py-1 font-medium">{t('workflowTags.workflow')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([tag, id]) => (
              <tr key={tag} data-tag-row={tag} className="border-b last:border-0">
                <td className="py-1 pr-3 wrap-anywhere">{tag}</td>
                <td className="py-1 wrap-anywhere">
                  {isWorkflowPreset(id)
                    ? t(`workflowPresets.${id}.label`)
                    : (presets.find((p) => p.id === id)?.label ?? t('workflowTags.notOne'))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
