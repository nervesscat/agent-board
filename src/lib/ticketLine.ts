import { shared } from '#/i18n'
import { stamp } from '#/lib/format'

/** What the author's mark on the ticket's line says in full: who opened it, in which role, and when. */
export const openedByText = (name: string, role: string, iso: string) =>
  shared.t('ticketLine.openedBy', { name, role, when: stamp(iso) })

/** What the updated time on the ticket's line says in full. */
export const updatedText = (iso: string) => shared.t('ticketLine.updated', { when: stamp(iso) })

/** What the opened time on the ticket's line says in full. */
export const openedText = (iso: string) => shared.t('ticketLine.opened', { when: stamp(iso) })
