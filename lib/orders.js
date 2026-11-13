// Order status for live chat: the agent's order panel and the customer's
// "Track my order". Pure helpers; the Admin API call lives in index.js.

const ORDER_NUM_RE = /^\s*(?:order\s*)?(?:no\.?\s*)?#?\s*(\d{3,10})\s*$/i

/** "#1042", "1042", "Order #1042" → "1042"; anything else → null. */
function normalizeOrderNumber(raw) {
  const m = ORDER_NUM_RE.exec(String(raw == null ? '' : raw))
  return m ? m[1] : null
}

// The Admin API query, shared by the agent panel (by customer email) and the
// public lookup (by order name). Only what the helpers below read.
const ORDER_FIELDS = `
  name createdAt cancelledAt email phone
  displayFinancialStatus displayFulfillmentStatus statusPageUrl
  customer { defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
  shippingAddress { phone }
  billingAddress { phone }
  fulfillments(first: 5) { createdAt deliveredAt status displayStatus trackingInfo(first: 3) { company number url } }
`

const httpsOrNull = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null)

/** Admin API order node → panel order (status, dates, tracking; no contact data). */
function orderFromNode(n) {
  if (!n || !n.name) return null
  const tracking = []
  for (const f of n.fulfillments || []) {
    for (const t of f.trackingInfo || []) {
      tracking.push({ company: t.company || null, number: t.number || null, url: t.url || null, shippedAt: f.createdAt || null, status: f.displayStatus || null })
    }
    if (!(f.trackingInfo || []).length) {
      tracking.push({ company: null, number: null, url: null, shippedAt: f.createdAt || null, status: f.displayStatus || null })
    }
  }
  const fs = n.fulfillments || []
  const delivered = fs.length > 0 && fs.every((f) => f.displayStatus === 'DELIVERED')
  const deliveredAt = delivered ? fs.map((f) => f.deliveredAt).filter(Boolean).sort().pop() || null : null
  return {
    name: n.name,
    delivered,
    deliveredAt,
    createdAt: n.createdAt || null,
    cancelledAt: n.cancelledAt || null,
    financialStatus: n.displayFinancialStatus || null,
    fulfillmentStatus: n.displayFulfillmentStatus || null,
    statusPageUrl: httpsOrNull(n.statusPageUrl),
    tracking,
  }
}

function phMobile(raw) {
  let d = String(raw || '').replace(/\D/g, '')
  if (d.startsWith('0')) d = '63' + d.slice(1)
  else if (d.length === 10 && d.startsWith('9')) d = '63' + d
  return /^639\d{9}$/.test(d) ? d : null
}

/** Does the email or mobile the customer typed belong to this order? */
function contactMatches(n, contact) {
  const c = String(contact || '').trim()
  if (!n || !c) return false
  if (c.includes('@')) {
    const want = c.toLowerCase()
    const emails = [n.email, n.customer && n.customer.defaultEmailAddress && n.customer.defaultEmailAddress.emailAddress]
    return emails.some((e) => typeof e === 'string' && e.trim().toLowerCase() === want)
  }
  const want = phMobile(c)
  if (!want) return false
  const phones = [n.phone, n.customer && n.customer.defaultPhoneNumber && n.customer.defaultPhoneNumber.phoneNumber,
    n.shippingAddress && n.shippingAddress.phone, n.billingAddress && n.billingAddress.phone]
  return phones.some((p) => phMobile(p) === want)
}

function stateOf(o) {
  if (o.cancelledAt) return 'cancelled'
  if (o.fulfillmentStatus === 'FULFILLED') return o.delivered ? 'delivered' : 'shipped'
  if (o.fulfillmentStatus === 'PARTIALLY_FULFILLED') return 'partially_shipped'
  return 'processing'
}

/** What a verified customer may see: state, dates, carrier, tracking. Nothing else. */
function publicOrderStatus(o) {
  const t = (o.tracking || []).find((x) => x.number || x.url) || (o.tracking || [])[0] || null
  return {
    order: o.name,
    state: stateOf(o),
    placedAt: o.createdAt,
    shippedAt: t ? t.shippedAt : null,
    deliveredAt: o.deliveredAt || null,
    carrier: t ? t.company : null,
    trackingNumber: t ? t.number : null,
    trackingUrl: t ? httpsOrNull(t.url) : null,
  }
}

const PH_DATE = (iso) => {
  const d = iso ? new Date(iso) : null
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'Asia/Manila' })
    : ''
}

/** Draft reply (Tagalog, like other agent replies) for the "Insert status" button. */
function statusReply(o) {
  const p = publicOrderStatus(o)
  const track = p.trackingUrl ? ` I-track po dito: ${p.trackingUrl}` : p.trackingNumber ? ` Tracking number: ${p.trackingNumber}.` : ''
  const via = p.carrier ? ` via ${p.carrier}` : ''
  const when = p.shippedAt ? ` noong ${PH_DATE(p.shippedAt)}` : ''
  switch (p.state) {
    case 'cancelled': return `Na-cancel po ang order ${p.order} noong ${PH_DATE(o.cancelledAt)}.`
    case 'delivered': return `Na-deliver na po ang order ${p.order}${p.deliveredAt ? ` noong ${PH_DATE(p.deliveredAt)}` : ''}.`
    case 'shipped': return `Naipadala na po ang order ${p.order}${via}${when}.${track}`
    case 'partially_shipped': return `Naipadala na po ang bahagi ng order ${p.order}${via}${when}; susunod po ang natitira.${track}`
    default: return `Ang order ${p.order} ay inihahanda pa po para maipadala. Aabisuhan namin kayo kapag naipadala na.`
  }
}

/**
 * "Track my order": the status only when the email/mobile matches the order.
 * Missing order and wrong contact give the same answer, so order numbers can't be probed.
 */
function orderStatusResult(nodes, contact, num) {
  const n = num ? pickOrder(nodes, num) : (nodes || [])[0]
  if (!n || !contactMatches(n, contact)) return { found: false }
  return { found: true, status: publicOrderStatus(orderFromNode(n)) }
}

/**
 * Admin API search for an order number. Shopify's docs show the name filter
 * without "#" (name:1001) while names are stored as "#1001", so ask for both and
 * let pickOrder keep only an exact match.
 */
function orderNameQuery(num) {
  return `name:"#${num}" OR name:"${num}"`
}

/** The node whose name is exactly that number ("#1002" for "1002"), or null. */
function pickOrder(nodes, num) {
  return (nodes || []).find((n) => n && String(n.name).replace(/^#/, '') === String(num)) || null
}

module.exports = { orderNameQuery, pickOrder, orderStatusResult, ORDER_FIELDS, normalizeOrderNumber, orderFromNode, contactMatches, publicOrderStatus, statusReply }
