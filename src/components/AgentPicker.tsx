import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { AgentIcon } from '#/components/AgentIcon'
import { Button } from '#/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { Tip } from '#/components/ui/tooltip'
import { AGENTS } from '#/lib/agents'
import { AGENT_CLIENTS, type AgentClient } from '#/lib/constants'

/** One icon per agent CLI; only the picked one's setup shows. */
export function AgentPicker({ value, onChange }: { value: AgentClient; onChange: (c: AgentClient) => void }) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as AgentClient)}>
      <TabsList>
        {AGENT_CLIENTS.map((c) => (
          <Tip key={c} content={AGENTS[c].label}>
            <TabsTrigger value={c} aria-label={AGENTS[c].label}>
              <AgentIcon client={c} /> {AGENTS[c].label}
            </TabsTrigger>
          </Tip>
        ))}
      </TabsList>
    </Tabs>
  )
}

export async function copyText(text: string, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(what)
    return true
  } catch {
    toast.error('The browser did not allow copying; select the text instead')
    return false
  }
}

/** A command or config snippet with a copy button. */
export function CopyBlock({
  text,
  label = 'Copy',
  onCopy,
}: {
  text: string
  label?: string
  /** What to copy instead of `text`, when it is not there yet (a line that carries a token minted on the
   *  first copy): the text, or null when it could not be had and nothing is copied. */
  onCopy?: () => Promise<string | null>
}) {
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <div className="space-y-1">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={async () => {
            if (busy) return
            setBusy(true)
            try {
              const toCopy = onCopy ? await onCopy() : text
              if (toCopy === null) return
              if (await copyText(toCopy)) {
                setDone(true)
                setTimeout(() => setDone(false), 1500)
              }
            } finally {
              setBusy(false)
            }
          }}
        >
          {done ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />} {label}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed whitespace-pre">
        {text}
      </pre>
    </div>
  )
}
