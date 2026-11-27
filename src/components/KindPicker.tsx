import { useTranslation } from 'react-i18next'

import { KINDS, type Kind, toggleKind } from '#/lib/kinds'

/** The kinds a project is for, one or more, as checkboxes. Software is the git side of the board. */
export function KindPicker({
  value,
  onChange,
  name = 'kinds',
}: {
  value: readonly Kind[]
  onChange: (kinds: Kind[]) => void
  name?: string
}) {
  const { t } = useTranslation()
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{t('kinds.legend')}</legend>
      <p className="text-xs text-muted-foreground">{t('kinds.hint')}</p>
      <div className="flex flex-wrap gap-2">
        {KINDS.map((kind) => (
          <label
            key={kind}
            className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-accent"
          >
            <input
              type="checkbox"
              name={name}
              value={kind}
              checked={value.includes(kind)}
              onChange={() => onChange(toggleKind(value, kind))}
            />
            {t(`kinds.label.${kind}`)}
          </label>
        ))}
      </div>
    </fieldset>
  )
}
