import { Link } from '@tanstack/react-router'
import { FileIcon, FileText, PlayIcon } from 'lucide-react'

import { galleryItem } from '#/components/Gallery'
import { Tip } from '#/components/ui/tooltip'
import type { GalleryFile } from '#/lib/api'
import { ago, fileSize, stamp } from '#/lib/format'

/**
 * The project's files as a grid of tiles. A click on a tile opens the file in the lightbox
 * (`#/components/Gallery`), whose arrows step through the tiles loaded so far, apart from any other
 * file on the page. Thumbnails cost little: an image loads once it nears the screen, a video only its
 * first frame, and a PDF or any other file is an icon until it is opened.
 */
const GROUP = 'project-files'

export function FileGrid({ projectId, files }: { projectId: string; files: GalleryFile[] }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {files.map((f) => (
        <FileTile key={f.id} projectId={projectId} file={f} />
      ))}
    </ul>
  )
}

function FileTile({ projectId, file: f }: { projectId: string; file: GalleryFile }) {
  const ticket = { id: projectId, ticketId: String(f.ticket.id) }
  const name = `#${f.ticket.id} ${f.ticket.title}`
  return (
    <li className="flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card" data-file={f.id}>
      <a
        href={f.url}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${f.name}`}
        className="relative block aspect-[4/3] overflow-hidden bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
        {...galleryItem({ src: f.url, name: f.name, mime: f.mime }, GROUP)}
      >
        <Thumb file={f} />
      </a>
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-2 text-xs">
        <Tip content={f.name}>
          <div data-slot="file-name" className="truncate text-sm font-medium">
            {f.name}
          </div>
        </Tip>
        <div className="flex min-w-0 flex-wrap gap-x-1.5 text-muted-foreground">
          <span>{fileSize(f.size)}</span>
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate">{f.uploadedBy}</span>
          <span aria-hidden>·</span>
          <Tip content={stamp(f.createdAt)}>
            <time dateTime={f.createdAt}>{ago(f.createdAt)}</time>
          </Tip>
        </div>
        <Tip content={f.ticket.parentId ? `${name}, a lane of #${f.ticket.parentId}` : name}>
          <div className="truncate">
            {name}
            {f.ticket.parentId !== null && (
              <span className="text-muted-foreground"> · lane of #{f.ticket.parentId}</span>
            )}
          </div>
        </Tip>
        <div className="mt-auto flex flex-wrap gap-x-3 pt-1">
          <Link
            to="/projects/$id/features/$ticketId"
            params={ticket}
            className="text-primary underline-offset-4 hover:underline"
          >
            Open ticket
          </Link>
          {f.anchor && (
            <Tip content={f.source.kind === 'reply' ? 'The reply it came with' : 'The post it came with'}>
              <Link
                to="/projects/$id/features/$ticketId"
                params={ticket}
                hash={f.anchor}
                className="text-primary underline-offset-4 hover:underline"
              >
                Open thread
              </Link>
            </Tip>
          )}
        </div>
      </div>
    </li>
  )
}

function Thumb({ file: f }: { file: GalleryFile }) {
  if (f.kind === 'image')
    return <img src={f.url} alt={f.name} loading="lazy" className="size-full object-cover" />
  if (f.kind === 'video')
    return (
      <>
        <video src={f.url} preload="metadata" muted playsInline className="size-full object-cover" />
        <span className="absolute inset-0 flex items-center justify-center bg-black/20">
          <span className="flex size-10 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/20">
            <PlayIcon className="size-4 translate-x-px fill-current" />
          </span>
        </span>
      </>
    )
  const Icon = f.kind === 'other' ? FileIcon : FileText
  const extension = f.name.includes('.') ? f.name.split('.').pop()!.toUpperCase() : ''
  return (
    <span className="flex size-full flex-col items-center justify-center gap-1 text-muted-foreground">
      <Icon className="size-8" />
      {extension && <span className="max-w-full truncate px-2 text-xs font-medium">{extension}</span>}
    </span>
  )
}
