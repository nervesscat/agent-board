import { Clock, Pencil } from 'lucide-react'
import type { ReactNode } from 'react'

import { Actor, useWho } from '#/components/Actor'
import { Tip } from '#/components/ui/tooltip'
import { ago } from '#/lib/format'
import { ROLE_LABEL } from '#/lib/roles'
import { openedByText, openedText, updatedText } from '#/lib/ticketLine'

/**
 * A fact on the ticket's line: an icon and its short value, with the full text in a tooltip (`Tip`, unless
 * the child brings its own) and for a screen reader: the visible value is hidden from it, so it hears the
 * full text once.
 */
function Fact({
  icon,
  text,
  ownTip,
  children,
}: {
  icon?: ReactNode
  text: string
  ownTip?: boolean
  children: ReactNode
}) {
  const fact = (
    <span data-fact className="inline-flex items-center gap-1">
      <span className="sr-only">{text}</span>
      <span aria-hidden className="inline-flex items-center gap-1">
        {icon}
        {children}
      </span>
    </span>
  )
  return ownTip ? fact : <Tip content={text}>{fact}</Tip>
}

/**
 * The line under the ticket's title: who opened it, when, and when it last changed, each as an icon and a
 * short value (the author's role is in the tooltip, not a badge). The tags go after it as `children`.
 */
export function TicketLine({
  createdBy,
  createdAt,
  updatedAt,
  children,
}: {
  createdBy: string
  createdAt: string
  updatedAt: string
  children?: ReactNode
}) {
  const who = useWho()
  const opened = openedByText(createdBy, ROLE_LABEL[who(createdBy).role], createdAt)
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <Fact text={opened} ownTip>
        <Actor name={createdBy} short bare tip={opened} />
      </Fact>
      <Fact icon={<Clock className="size-3.5" />} text={openedText(createdAt)}>
        {ago(createdAt)}
      </Fact>
      <Fact icon={<Pencil className="size-3.5" />} text={updatedText(updatedAt)}>
        {ago(updatedAt)}
      </Fact>
      {children}
    </div>
  )
}
