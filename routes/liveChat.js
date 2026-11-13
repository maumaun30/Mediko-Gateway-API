// Routes moved verbatim from index.js; registered at the same place in the middleware order.
const jwt = require("jsonwebtoken");
const { requireAdmin } = require("../lib/auth");
const { productHandleFromUrl, productToPreview } = require("../lib/chat");
const { chatSecretOk, fetchOrderNodes, linkPreviewHosts, panelOrder } = require("../lib/liveChat");
const { log } = require("../lib/log");
const { sanitizeSearchTerm } = require("../lib/orderTagging");
const { normalizeOrderNumber, orderFromNode, orderNameQuery, pickOrder, publicOrderStatus } = require("../lib/orders");
const { EMAIL_LIST_RE } = require("../lib/settings");
const { verifyAppProxy } = require("../lib/shopify");
const { shopifyGraphQL } = require("../lib/shopifyAdmin");

module.exports = function register(app) {
  app.post("/api/chat/agent-token", requireAdmin, (req, res) => {
    if (!chatSecretOk() || !process.env.CHAT_API_URL) {
      return res.status(503).json({ error: "Chat service not configured" });
    }
    if (!req.admin || req.admin.sub == null || req.admin.sub === "") {
      log("error", "chat_agent_token_no_sub");
      return res.status(500).json({ error: "Your Shopify session has no staff id. Reload the app." });
    }
    try {
      const token = jwt.sign({}, process.env.CHAT_AGENT_SECRET, {
        algorithm: "HS256",
        issuer: "mediko-gateway",
        audience: "mediko-chat",
        subject: String(req.admin.sub),
        expiresIn: 300,
      });
      res.json({
        token,
        expiresAt: new Date(Date.now() + 300 * 1000).toISOString(),
        apiUrl: process.env.CHAT_API_URL,
      });
    } catch (err) {
      log("error", "chat_agent_token_failed", { message: err.message });
      res.status(500).json({ error: "Could not issue token" });
    }
  });

  app.get("/api/chat/customer", requireAdmin, async (req, res) => {
    const email = typeof req.query.email === "string" ? req.query.email.trim() : "";
    if (!email || email.length > 254 || !EMAIL_LIST_RE.test(email)) {
      return res.status(400).json({ error: "Valid email required" });
    }
    if (!process.env.SHOPIFY_SHOP_DOMAIN) {
      return res.status(503).json({ error: "Shopify not configured" });
    }
    try {
      const data = await shopifyGraphQL(
        `query($q: String!) {
           customers(first: 1, query: $q) {
             nodes { id numberOfOrders lastOrder { name } }
           }
         }`,
        { q: `email:"${email.replace(/["\\]/g, "")}"` },
      );
      const c = data && data.customers && data.customers.nodes && data.customers.nodes[0];
      if (!c) return res.json({ customer: null });
      const numericId = String(c.id).split("/").pop();
      res.json({
        customer: {
          id: c.id,
          adminUrl: `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/customers/${numericId}`,
          ordersCount: Number(c.numberOfOrders) || 0,
          lastOrderName: (c.lastOrder && c.lastOrder.name) || null,
        },
      });
    } catch (err) {
      log("error", "chat_customer_lookup_failed", { message: err.message });
      res.status(500).json({ error: "Customer lookup failed" });
    }
  });

  // Agent panel: the chat customer's recent orders (by email).
  app.get("/api/chat/orders", requireAdmin, async (req, res) => {
    const email = typeof req.query.email === "string" ? req.query.email.trim() : "";
    if (!email || email.length > 254 || !EMAIL_LIST_RE.test(email)) return res.status(400).json({ error: "Valid email required" });
    if (!process.env.SHOPIFY_SHOP_DOMAIN) return res.status(503).json({ error: "Shopify not configured" });
    try {
      const nodes = await fetchOrderNodes(`email:"${sanitizeSearchTerm(email)}"`, 5);
      res.json({ orders: nodes.map(panelOrder).filter(Boolean) });
    } catch (err) {
      log("error", "chat_orders_failed", { message: err.message });
      res.status(500).json({ error: "Order lookup failed" });
    }
  });

  // Agent panel: an order number the customer mentioned (may not be theirs).
  app.get("/api/chat/order", requireAdmin, async (req, res) => {
    const num = normalizeOrderNumber(req.query.number);
    if (!num) return res.status(400).json({ error: "Order number required" });
    if (!process.env.SHOPIFY_SHOP_DOMAIN) return res.status(503).json({ error: "Shopify not configured" });
    try {
      const node = pickOrder(await fetchOrderNodes(orderNameQuery(num), 5), num);
      res.json({ order: node ? panelOrder(node) : null });
    } catch (err) {
      log("error", "chat_order_failed", { message: err.message });
      res.status(500).json({ error: "Order lookup failed" });
    }
  });

  app.get("/api/chat/link-preview", requireAdmin, async (req, res) => {
    const url = typeof req.query.url === "string" ? req.query.url.trim().slice(0, 2000) : "";
    const handle = productHandleFromUrl(url, linkPreviewHosts());
    if (!handle) {
      log("info", "chat_link_preview_miss", { reason: "not_store_product_link", host: (() => { try { return new URL(url).host; } catch { return null; } })() });
      return res.status(400).json({ error: "Only product links from the store get a preview" });
    }
    if (!process.env.SHOPIFY_SHOP_DOMAIN) return res.status(503).json({ error: "Shopify not configured" });
    try {
      const data = await shopifyGraphQL(
        `query ChatLinkPreview($identifier: ProductIdentifierInput!) {
           product: productByIdentifier(identifier: $identifier) {
             title
             description(truncateAt: 200)
             status
             featuredMedia { preview { image { url(transform: { maxWidth: 400 }) } } }
             priceRangeV2 { minVariantPrice { amount currencyCode } }
           }
         }`,
        { identifier: { handle } },
      );
      const preview = productToPreview(data && data.product, url);
      if (!preview) {
        log("info", "chat_link_preview_miss", { reason: data && data.product ? `status_${data.product.status}` : "not_found", handle });
        return res.status(404).json({ error: "Product not found or not published" });
      }
      log("info", "chat_link_preview_ok", { handle });
      res.json({ preview });
    } catch (err) {
      log("error", "chat_link_preview_failed", { message: err.message });
      const scope = /access|scope|read_products/i.test(err.message || "");
      res.status(500).json({ error: scope ? "Approve the read_products permission for MedikoPH Gateway in Shopify admin" : "Preview lookup failed" });
    }
  });

  // "Track my order" for logged-in customers, through the Shopify app proxy:
  // the widget calls store.mediko.ph/apps/mediko/orders, Shopify adds
  // logged_in_customer_id and signs the query (shopify.app.toml [app_proxy]).
  // Only state/dates/carrier/tracking are returned.
  app.get("/proxy/orders", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const v = verifyAppProxy(req.query, process.env.SHOPIFY_CLIENT_SECRET);
    const shopOk = v.ok && v.shop.toLowerCase() === String(process.env.SHOPIFY_SHOP_DOMAIN || "").toLowerCase();
    if (!shopOk) {
      log("warn", "app_proxy_rejected", { ip: req.ip });
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!v.customerId) return res.json({ loggedIn: false, orders: [] });
    try {
      const nodes = await fetchOrderNodes(`customer_id:${v.customerId}`, 10);
      const orders = nodes.map(orderFromNode).filter(Boolean).map(publicOrderStatus);
      log("info", "app_proxy_orders", { count: orders.length });
      res.json({ loggedIn: true, orders });
    } catch (err) {
      log("error", "app_proxy_orders_failed", { message: err.message });
      res.status(500).json({ error: "Order lookup failed" });
    }
  });
};
