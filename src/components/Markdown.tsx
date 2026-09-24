import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { galleryItem } from '#/components/Gallery'

/** Markdown as agents write it; images and links are the board's own uploads or external URLs. */
export function Markdown({ children, className = '' }: { children: string; className?: string }) {
  return (
    <div className={`prose prose-sm dark:prose-invert max-w-none break-words ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
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
        {children}
      </ReactMarkdown>
    </div>
  )
}
