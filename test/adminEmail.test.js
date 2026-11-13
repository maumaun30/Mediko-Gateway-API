const test = require('node:test')
const assert = require('node:assert/strict')
const { renderAdminEmail, gatewayLink, fmtPhone, applicationAdminMail, contactAdminMail, returnAdminMail } = require('../lib/adminEmail')

const meta = { ip: '1.2.3.4', origin: 'https://mediko.ph', user_agent: '<script>ua</script>', referer: null }

test('renderAdminEmail escapes every value and includes logo, preheader, CTA and a text version', () => {
  const m = renderAdminEmail({
    preheader: 'Pre <x>', eyebrow: 'Messages', title: 'Title <b>', intro: '**Juan <i>** sent a message.',
    rows: [{ label: 'Name', value: '<img src=x onerror=alert(1)>' }, { label: 'Email', value: 'j@x.ph', kind: 'email' }, { label: 'Mobile', value: '09171234567', kind: 'phone' }],
    blocks: [{ label: 'Message', text: 'line1\n<script>bad</script>' }],
    cta: { label: 'Open message', href: 'https://gw.test/admin-dashboard/requests/messages/1' }, meta,
  }, { logoUrl: 'https://gw.test/admin-dashboard/mediko-logo-email.png' })
  assert.ok(!/<img src=x|<script>|<b>|<i>|<x>/.test(m.html.replace(/<img src="https:\/\/gw\.test[^>]*>/, '')))
  assert.match(m.html, /<strong>Juan &lt;i&gt;<\/strong> sent a message\./)
  assert.match(m.html, /src="https:\/\/gw\.test\/admin-dashboard\/mediko-logo-email\.png"/)
  assert.match(m.html, /alt="Mediko\.ph"/)
  assert.match(m.html, /href="mailto:j@x\.ph"/)
  assert.match(m.html, /href="tel:\+639171234567"/)
  assert.match(m.html, /href="https:\/\/gw\.test\/admin-dashboard\/requests\/messages\/1"/)
  assert.match(m.html, /Pre &lt;x&gt;/)
  assert.match(m.text, /Name: <img src=x onerror=alert\(1\)>/)
  assert.match(m.text, /Open message: https:\/\/gw\.test/)
  assert.match(m.text, /IP address: 1\.2\.3\.4/)
})

test('gatewayLink and fmtPhone', () => {
  assert.equal(gatewayLink('applications/5', 'https://admin.shopify.com/store/m/apps/gw/'), 'https://admin.shopify.com/store/m/apps/gw/admin-dashboard/applications/5')
  assert.equal(gatewayLink('chats/x', 'https://a/admin-dashboard'), 'https://a/admin-dashboard/chats/x')
  assert.equal(fmtPhone('639171234567'), '0917 123 4567')
  assert.equal(fmtPhone('+63 917 123 4567'), '0917 123 4567')
  assert.equal(fmtPhone('12345'), '12345')
})

test('application admin mail: subject, escaped name (old bug), deep link, attachments', () => {
  const m = applicationAdminMail({ insertId: 2041, full_name: 'Maria <b>Santos</b>', birthday: '1958-03-14', contact_number: '09171234567', email_address: 'maria@x.ph', id_number: 'ID-1' }, meta, 1, { base: 'https://a/apps/gw', logoUrl: 'https://l/x.png' })
  assert.equal(m.subject, '[Mediko] New application #2041 — Maria <b>Santos</b>')
  assert.ok(!m.html.includes('<b>Santos</b>'))
  assert.match(m.html, /https:\/\/a\/apps\/gw\/admin-dashboard\/applications\/2041/)
  assert.match(m.html, /1 image \(ID photo\)/)
  assert.match(m.html, /March 14, 1958/)
})

test('contact and return admin mails', () => {
  const c = contactAdminMail({ id: 518, full_name: 'Juan', email_address: 'j@x.ph', contact_number: '09181112222', message: 'Hi po' }, meta, { base: 'https://a', logoUrl: 'https://l/x.png' })
  assert.equal(c.subject, '[Mediko] New contact message #518 — Juan')
  assert.match(c.html, /requests\/messages\/518/)
  assert.match(c.html, /Reply by email/)
  const r = returnAdminMail({ id: 77, full_name: 'Ana', email_address: 'a@x.ph', contact_number: '09195556666', order_number: '#1042', items_to_return: '1x A', reason: 'Broken' }, meta, 2, { base: 'https://a', logoUrl: 'https://l/x.png' })
  assert.equal(r.subject, '[Mediko] New return request #77 — Ana')
  assert.match(r.html, /requests\/returns\/77/)
  assert.match(r.html, /2 images/)
})
