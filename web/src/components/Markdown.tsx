/**
 * Markdown rendering for assistant output: marked (GFM) → DOMPurify → HTML.
 * Sanitized even though the text comes from our own agent — tool results and
 * quoted web content flow through assistant messages, so treat it as untrusted.
 */
import { memo, useMemo } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.setOptions({
  gfm: true,
  breaks: true, // chat prose treats single newlines as line breaks
})

// Links out of assistant text open in a new tab, never navigate the app away.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false }) as string),
    [text],
  )
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
})
