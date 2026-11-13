const test = require('node:test')
const assert = require('node:assert/strict')
const { templateHtml } = require('../lib/emailFormat')

test('templateHtml: paragraphs, bold, escaping', () => {
  const h = templateHtml('Hello **Ana** <b>x</b>\n\nLine 2')
  assert.match(h, /<p[^>]*>Hello <strong>Ana<\/strong> &lt;b&gt;x&lt;\/b&gt;<\/p><p[^>]*>Line 2<\/p>/)
})

test('templateHtml: https links become clickable (query kept, trailing punctuation outside)', () => {
  const h = templateHtml('Continue here: https://store.mediko.ph/pages/chat?mdk_chat=a.b.c&x=1.')
  assert.match(h, /<a href="https:\/\/store\.mediko\.ph\/pages\/chat\?mdk_chat=a\.b\.c&amp;x=1"[^>]*>https:\/\/store\.mediko\.ph\/pages\/chat\?mdk_chat=a\.b\.c&amp;x=1<\/a>\./)
})

test('templateHtml: no javascript: or http-only links, quotes cannot break out', () => {
  const h = templateHtml('javascript:alert(1) http://x.ph "https://evil.ph/"onmouseover=1')
  assert.ok(!/href="javascript|href="http:/.test(h))
  assert.ok(!/"onmouseover/.test(h))
})
