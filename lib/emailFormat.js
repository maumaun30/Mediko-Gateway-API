// Customer template emails (TEMPLATES / message_templates): plain text → simple HTML.

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// https URLs in already-escaped text → anchors. Escaped quotes (&quot;) and
// angle brackets end a URL, so nothing can break out of the href.
const URL_RE = /https:\/\/[^\s<>"]+?(?=&quot;|&lt;|&gt;|[.,!?;:)]*(?:\s|$))/g

function linkify(escaped) {
  return escaped.replace(URL_RE, (u) => `<a href="${u}" style="color:#187adc;">${u}</a>`)
}

/** Plain-text template → HTML: paragraphs, **bold**, clickable https links. */
function templateHtml(text) {
  const paras = linkify(escapeHtml(String(text ?? '').trim()))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .split(/\n{2,}/)
    .map((p) => `<p style="margin: 0 0 16px 0;">${p.trim().replace(/\n/g, '<br>')}</p>`)
    .join('')
  return `<div style="font-family: sans-serif; line-height: 1.6; color: #333; max-width: 600px;">${paras}</div>`
}

module.exports = { templateHtml, escapeHtml }
