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
