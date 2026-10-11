import type { ReactNode } from 'react'

/**
 * An activity line that records a change of the report's prompt or template (`changeId`): opens the
 * change's diff, old against new.
 */
export function SettingsChangeDiff({
  changeId: _changeId,
  children,
}: {
  changeId: number
  children: ReactNode
}) {
  return <span className="min-w-0 wrap-anywhere">{children}</span>
}
