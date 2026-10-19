// The mod's mini-Markdown, rendered to HTML the way the viewer page's md() does: paragraphs with
// line breaks, "- " lists, "> " quotes, **bold**, *em*, _em_, `code` and [text](https://…) links.
// Ported here because @docent/core's `md` namespace holds text helpers (cut, mdEscape, codeSpan…),
// not a renderer. Everything that is not generated markup is escaped, so the result can be injected.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Text outside code spans: backslash escapes set aside, HTML escaped, then links and emphasis. */
function spans(text: string): string {
  const kept: string[] = []
  let s = text.replace(/\\([\\`*_[\]<>#|()!-])/g, (_, ch: string) => {
    kept.push(ch)
    return `\u0000${kept.length - 1}\u0000`
  })
  s = escapeHtml(s)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label: string, url: string) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1<em>$2</em>')
  s = s.replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, '$1<em>$2</em>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => escapeHtml(kept[Number(i)] ?? ''))
}

/** One line of Markdown as HTML. Code spans come first, so nothing inside them is touched. */
export function renderInline(raw: string): string {
  const code = /``([\s\S]+?)``|`([^`]+)`/g
  const out: string[] = []
  let last = 0
  for (let m = code.exec(raw); m !== null; m = code.exec(raw)) {
    out.push(spans(raw.slice(last, m.index)))
    out.push(`<code>${escapeHtml(m[1] !== undefined ? m[1].trim() : (m[2] ?? ''))}</code>`)
    last = code.lastIndex
  }
  out.push(spans(raw.slice(last)))
  return out.join('')
}

/** Markdown text as HTML: blocks split on blank lines, each a quote, a list or a paragraph. Odd input gives ''. */
export function renderMarkdown(text: unknown): string {
  if (typeof text !== 'string') return ''
  const out: string[] = []
  for (const block of text.split(/\n{2,}/)) {
    if (block.trim() === '') continue
    const lines = block.split('\n')
    if (lines.every(l => /^>\s?/.test(l))) out.push(`<blockquote>${renderMarkdown(lines.map(l => l.replace(/^>\s?/, '')).join('\n'))}</blockquote>`)
    else if (lines.every(l => /^[-*]\s+/.test(l))) out.push(`<ul>${lines.map(l => `<li>${renderInline(l.replace(/^[-*]\s+/, ''))}</li>`).join('')}</ul>`)
    else out.push(`<p>${lines.map(l => renderInline(l)).join('<br>')}</p>`)
  }
  return out.join('')
}
