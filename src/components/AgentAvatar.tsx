import type { ProjectAgent } from '#/lib/api'

const TINTS = ['bg-sky-600', 'bg-violet-600', 'bg-emerald-600', 'bg-amber-600', 'bg-rose-600', 'bg-teal-600']

/** Same name, same colour, so an agent without a picture is still recognisable at a glance. */
const tint = (name: string) => TINTS[[...name].reduce((h, c) => h + c.charCodeAt(0), 0) % TINTS.length]

/** A project agent's picture, or its initial on a colour when it has none. */
export function AgentAvatar({
  agent,
  className = 'size-4',
}: {
  agent: Pick<ProjectAgent, 'name' | 'avatarUrl'>
  className?: string
}) {
  if (agent.avatarUrl)
    return <img src={agent.avatarUrl} alt="" className={`shrink-0 rounded-full object-cover ${className}`} />
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full text-[0.6em] font-semibold text-white uppercase ${tint(agent.name)} ${className}`}
    >
      {agent.name[0]}
    </span>
  )
}
