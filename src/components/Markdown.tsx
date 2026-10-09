import { useRouter } from '@tanstack/react-router'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { AgentAvatar } from '#/components/AgentAvatar'
import { galleryItem } from '#/components/Gallery'
import type { ProjectAgent } from '#/lib/api'
import { useProjectAgents } from '#/lib/project'

const MENTION = '#agent:'

/**
 * `@name` of one of the project's agents becomes a link the renderer turns into a chip. Code (fenced or
 * inline) is left alone, and so is anything that is not one of the project's agents.
 */
function linkMentions(md: string, agents: ProjectAgent[]): string {
  if (!agents.length) return md
  const byName = new Map(agents.map((a) => [a.name.toLowerCase(), a.name]))
  return md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/(?<![\w@[])@([A-Za-z0-9][A-Za-z0-9_-]*)/g, (whole, name: string) => {
            const agent = byName.get(name.toLowerCase())
            return agent ? `[@${agent}](${MENTION}${agent})` : whole
          }),
    )
    .join('')
}

/** Markdown as agents write it; images and links are the board's own uploads or external URLs. */
export function Markdown({ children, className = '' }: { children: string; className?: string }) {
  const agents = useProjectAgents()
  const router = useRouter()
  return (
    <div className={`prose prose-sm dark:prose-invert max-w-none break-words ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _n, ...props }) => {
            const agent =
              props.href?.startsWith(MENTION) &&
              agents.find((a) => a.name === props.href!.slice(MENTION.length))
            if (agent)
              return (
                <span
                  className="inline-flex items-center gap-1 rounded bg-muted px-1 align-baseline font-medium not-prose"
                  title={`${agent.name}, one of the project's agents`}
                >
                  <AgentAvatar agent={agent} className="size-3.5" />@{agent.name}
                </span>
              )
            // A #link is to something on the same page (a post, a reply): it lands there, in this tab,
            // as a step of the router's history, so Back and Forward return to where the reader was.
            const hash = props.href?.startsWith('#') && !props.href.startsWith(MENTION) ? props.href : null
            if (hash)
              return (
                <a
                  {...props}
                  onClick={(e) => {
                    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
                    e.preventDefault()
                    const { pathname, search } = window.location
                    router.history.push(`${pathname}${search}${hash}`)
                  }}
                />
              )
            return <a {...props} target="_blank" rel="noreferrer" />
          },
          img: ({ node: _n, ...props }) => (
            <img
              {...props}
              {...(typeof props.src === 'string' &&
                galleryItem({ src: props.src, name: props.alt || props.src, mime: 'image/*' }))}
              className="cursor-zoom-in rounded-md border"
              loading="lazy"
            />
          ),
        }}
      >
        {linkMentions(children, agents)}
      </ReactMarkdown>
    </div>
  )
}
