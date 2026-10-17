import type { CommentParent } from '#/lib/constants'

/**
 * The #anchors that land on a post or a reply (read by src/lib/reveal.ts): a post of a ticket's feed is
 * `post-<id>`, a reply is `<holder>-reply-<id>`, the reply in the thread of the element `holder`.
 */
export const postAnchor = (postId: number) => `post-${postId}`
export const replyAnchor = (holder: string, replyId: number) => `${holder}-reply-${replyId}`

/**
 * Where a thread's latest message is: on a ticket, a post of the feed; a reply, by the post whose
 * thread holds it; on a review result, which its dialog shows alone.
 */
export function threadAnchor(th: { parentType: CommentParent; parentId: number; last: { id: number } }) {
  if (th.parentType === 'ticket') return postAnchor(th.last.id)
  if (th.parentType === 'update') return replyAnchor(postAnchor(th.parentId), th.last.id)
  return `reply-${th.last.id}`
}
