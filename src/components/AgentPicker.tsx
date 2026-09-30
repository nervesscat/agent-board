import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { AgentIcon } from '#/components/AgentIcon'
import { Button } from '#/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { AGENTS } from '#/lib/agents'
import { AGENT_CLIENTS, type AgentClient } from '#/lib/constants'

/** One icon per agent CLI; only the picked one's setup shows. */
export function AgentPicker({ value, onChange }: { value: AgentClient; onChange: (c: AgentClient) => void }) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as AgentClient)}>
      <TabsList>
        {AGENT_CLIENTS.map((c) => (
          <TabsTrigger key={c} value={c} aria-label={AGENTS[c].label} title={AGENTS[c].label}>
            <AgentIcon client={c} /> {AGENTS[c].label}
          </TabsTrigger>
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
export function CopyBlock({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 pr-24 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
        {text}
      </pre>
      <Button
        variant="outline"
        size="sm"
        className="absolute top-2 right-2"
        onClick={async () => {
          if (await copyText(text)) {
            setDone(true)
            setTimeout(() => setDone(false), 1500)
          }
        }}
      >
        {done ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />} {label}
      </Button>
    </div>
  )
}
