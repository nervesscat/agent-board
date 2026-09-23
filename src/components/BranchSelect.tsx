import { useQuery } from '@tanstack/react-query'

import { Input } from '#/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { get } from '#/lib/api'

const NONE = '__none__'

interface Props {
  value: string
  onChange: (branch: string) => void
  /** Either a repo id (branches of a registered repo) or a raw checkout path (new-repo dialog). */
  repoId?: string | number | null
  repoPath?: string
  id?: string
  /** Allow "no branch" as a choice (ticket branches); base branches never are. */
  optional?: boolean
  className?: string
}

/** The local branches of a checkout as a dropdown; a plain text box until the branches are known. */
export function BranchSelect({ value, onChange, repoId, repoPath, id, optional, className = '' }: Props) {
  const source = repoId
    ? `/api/repos/${repoId}/branches`
    : repoPath
      ? `/api/branches?path=${encodeURIComponent(repoPath)}`
      : null
  const { data: branches } = useQuery({
    queryKey: ['branches', source],
    queryFn: () => get<string[]>(source!),
    enabled: Boolean(source),
    staleTime: 30_000,
    retry: false,
  })
  if (!branches?.length) {
    return (
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`font-mono ${className}`}
        placeholder={source ? 'loading branches…' : 'main'}
      />
    )
  }
  // A branch the checkout does not have yet (an agent's plan) still shows, so the value is never silently dropped.
  const options = value && !branches.includes(value) ? [value, ...branches] : branches
  const items = Object.fromEntries([
    ...(optional ? [[NONE, '— none yet —']] : []),
    ...options.map((b) => [b, b]),
  ])
  return (
    <Select
      value={value || (optional ? NONE : '')}
      onValueChange={(v) => onChange(v === NONE ? '' : (v as string))}
      items={items}
    >
      <SelectTrigger id={id} className={`w-full font-mono ${className}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {optional && <SelectItem value={NONE}>— none yet —</SelectItem>}
        {options.map((b) => (
          <SelectItem key={b} value={b} className="font-mono">
            {b}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
