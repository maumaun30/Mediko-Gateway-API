// Routes moved verbatim from index.js; registered at the same place in the middleware order.
const { requireAdmin } = require("../lib/auth");
const { db, queryAsync } = require("../lib/db");
const { log } = require("../lib/log");
const { notifyDecision, parseNotify } = require("../lib/notifications");
const { ORDER_TAGS, REFUND_TAG, addShopifyTag, listOrders, removeShopifyTag, untagCustomerIfUnused } = require("../lib/orderTagging");
const { adminName } = require("../lib/settings");
const { SHOPIFY_API_VERSION, shopifyConfigured, shopifyGraphQL } = require("../lib/shopifyAdmin");

module.exports = function register(app) {
  app.get("/api/submissions", requireAdmin, (req, res) => {

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
    const offset = (page - 1) * limit;

    const search = (req.query.search || "").trim();
    const dateFrom = (req.query.date_from || "").trim();
    const dateTo = (req.query.date_to || "").trim();

    const whereClauses = [];
    const whereParams = [];

    if (search) {
      whereClauses.push(
        "(full_name LIKE ? OR email_address LIKE ? OR id_number LIKE ?)",
      );
      const like = `%${search}%`;
      whereParams.push(like, like, like);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
      whereClauses.push("created_at >= ?");
      whereParams.push(`${dateFrom} 00:00:00`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      whereClauses.push("created_at <= ?");
      whereParams.push(`${dateTo} 23:59:59`);
    }
    if (["pending", "approved", "rejected", "resolved"].includes(req.query.status)) {
      whereClauses.push("status = ?");
      whereParams.push(req.query.status);
    }

    const whereSql = whereClauses.length
      ? ` WHERE ${whereClauses.join(" AND ")}`
      : "";

    db.query(
      `SELECT COUNT(*) AS total FROM applications${whereSql}`,
      whereParams,
      (countErr, countResult) => {
        if (countErr) {
          log("error", "db_count_failed", { message: countErr.message });
          return res.status(500).json({ error: countErr.message });
        }

        const totalItems = countResult[0].total;

        db.query(
          `SELECT * FROM applications${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          [...whereParams, limit, offset],
          (err, results) => {
            if (err) {
              log("error", "db_select_failed", { message: err.message });
              return res.status(500).json({ error: err.message });
            }

            log("info", "submissions_listed", {
              page,
              limit,
              totalItems,
              search: search || null,
              date_from: dateFrom || null,
              date_to: dateTo || null,
              ip: req.ip,
            });

            res.status(200).json({
              metadata: {
                total_items: totalItems,
                total_pages: Math.ceil(totalItems / limit),
                current_page: page,
              },
              data: results,
            });
          },
        );
      },
    );
  });

  app.patch("/api/submissions/:id/status", requireAdmin, async (req, res) => {

    const id = parseInt(req.params.id, 10);
    const { status, reason } = req.body || {};
    const notify = parseNotify(req.body);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: "Invalid id" });
    }
    if (!["pending", "approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const trimmedReason =
      typeof reason === "string" ? reason.trim().slice(0, 2000) : "";
    if (status === "rejected" && trimmedReason.length < 5) {
      return res
        .status(400)
        .json({ error: "A rejection reason of at least 5 characters is required." });
    }

    try {
      const rows = await queryAsync(
        "SELECT * FROM applications WHERE id = ?",
        [id],
      );
      if (!rows.length) {
        return res.status(404).json({ error: "Application not found" });
      }
      const applicant = rows[0];

      // Approving: status only. Shopify discount codes are discontinued, so
      // nothing is created in Shopify (old code columns are left as they are).
      if (status === "approved" && applicant.status !== "approved") {
        await queryAsync(
          "UPDATE applications SET status = 'approved', rejection_reason = NULL WHERE id = ?",
          [id],
        );
        log("info", "submission_approved", { id, ip: req.ip });
        const notified = await notifyDecision("application", "approved", applicant, "", notify);
        return res.json({ success: true, id, status: "approved", notified });
      }

      const wasRejected = applicant.status === "rejected";
      await queryAsync(
        "UPDATE applications SET status = ?, rejection_reason = ? WHERE id = ?",
        [status, status === "rejected" ? trimmedReason : null, id],
      );

      let notified = { email: false, sms: "off" };
      if (status === "rejected" && !wasRejected) {
        notified = await notifyDecision("application", "rejected", applicant, trimmedReason, notify);
      }

      log("info", "submission_status_updated", { id, status, notified, ip: req.ip });
      res.json({ success: true, id, status, notified });
    } catch (err) {
      log("error", "status_update_failed", {
        id,
        status,
        message: err.message,
      });
      res.status(500).json({ error: err.message });
    }
  });

  // Diagnostic: reports the scopes the configured Admin token actually carries.
  // A token keeps the grant it was minted with, so this is the way to tell an
  // out-of-date token apart from an app whose scopes were never updated.
  app.get("/api/shopify/scopes", requireAdmin, async (req, res) => {
    if (!shopifyConfigured()) {
      return res.status(503).json({
        error:
          "Shopify is not configured. Set SHOPIFY_SHOP_DOMAIN, plus either "
          + "SHOPIFY_ADMIN_TOKEN or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.",
      });
    }

    try {
      const data = await shopifyGraphQL(
        `query appScopes {
           currentAppInstallation {
             accessScopes { handle }
           }
         }`,
      );

      const granted = (data?.currentAppInstallation?.accessScopes || []).map(
        (s) => s.handle,
      );

      res.json({
        shop: process.env.SHOPIFY_SHOP_DOMAIN,
        api_version: SHOPIFY_API_VERSION,
        granted,
        has_read_orders: granted.includes("read_orders"),
        has_write_orders: granted.includes("write_orders"),
      });
    } catch (err) {
      log("error", "scope_check_failed", { message: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // Orders for the assign-order picker. Defaults to the applicant's own orders;
  // ?q= searches all orders instead, for a discount used on someone else's order.
  app.get("/api/submissions/:id/orders", requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: "Invalid id" });
    }
    if (!shopifyConfigured()) {
      return res.status(503).json({
        error:
          "Shopify is not configured. Set SHOPIFY_SHOP_DOMAIN, plus either "
          + "SHOPIFY_ADMIN_TOKEN or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.",
      });
    }

    try {
      const rows = await queryAsync(
        "SELECT email_address FROM applications WHERE id = ?",
        [id],
      );
      if (!rows.length) return res.status(404).json({ error: "Not found" });

      const email = rows[0].email_address;
      const search = typeof req.query.q === "string" ? req.query.q : "";
      const orders = await listOrders({ email, search });

      res.json({ email, search: search.trim(), orders });
    } catch (err) {
      log("error", "order_list_failed", { id, message: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // Assigns one Shopify order to an application and tags it PWD or SC.
  app.post("/api/submissions/:id/assign-order", requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const {
      order_gid: orderGid,
      order_name: orderName,
      customer_gid: rawCustomerGid,
      tag,
    } = req.body || {};

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: "Invalid id" });
    }
    if (typeof orderGid !== "string" || !orderGid.startsWith("gid://shopify/Order/")) {
      return res.status(400).json({ error: "Invalid order_gid" });
    }
    // Guest checkouts have no customer — the order still gets tagged, the
    // customer half is simply skipped.
    const customerGid =
      typeof rawCustomerGid === "string"
        && rawCustomerGid.startsWith("gid://shopify/Customer/")
        ? rawCustomerGid
        : null;
    if (rawCustomerGid && !customerGid) {
      return res.status(400).json({ error: "Invalid customer_gid" });
    }
    if (!ORDER_TAGS.includes(tag)) {
      return res.status(400).json({ error: `Tag must be one of: ${ORDER_TAGS.join(", ")}` });
    }
    if (!shopifyConfigured()) {
      return res.status(503).json({
        error:
          "Shopify is not configured. Set SHOPIFY_SHOP_DOMAIN, plus either "
          + "SHOPIFY_ADMIN_TOKEN or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.",
      });
    }

    try {
      const rows = await queryAsync(
        `SELECT assigned_order_gid, assigned_customer_gid, assigned_tag, refunded_at
           FROM applications WHERE id = ?`,
        [id],
      );
      if (!rows.length) return res.status(404).json({ error: "Not found" });

      const prev = rows[0];

      // Re-assigning: strip the old tag off the previous order first.
      const movedOrder =
        prev.assigned_order_gid && prev.assigned_order_gid !== orderGid;
      const changedTag =
        prev.assigned_order_gid === orderGid && prev.assigned_tag && prev.assigned_tag !== tag;

      if ((movedOrder || changedTag) && prev.assigned_tag) {
        try {
          await removeShopifyTag(prev.assigned_order_gid, prev.assigned_tag);
        } catch (e) {
          log("warn", "order_untag_failed", {
            id,
            orderGid: prev.assigned_order_gid,
            tag: prev.assigned_tag,
            message: e.message,
          });
        }
        await untagCustomerIfUnused(id, prev.assigned_customer_gid, prev.assigned_tag);
      }

      // A refund marker belongs to the order it was made against; moving to a
      // different order drops it.
      if (movedOrder && prev.refunded_at) {
        try {
          await removeShopifyTag(prev.assigned_order_gid, REFUND_TAG);
        } catch (e) {
          log("warn", "order_untag_failed", {
            id,
            orderGid: prev.assigned_order_gid,
            tag: REFUND_TAG,
            message: e.message,
          });
        }
      }

      await addShopifyTag(orderGid, tag);

      // The order tag is the record of truth; a failure to mirror it onto the
      // customer must not undo it.
      if (customerGid) {
        try {
          await addShopifyTag(customerGid, tag);
        } catch (e) {
          log("warn", "customer_tag_failed", { id, customerGid, tag, message: e.message });
        }
      } else {
        log("info", "customer_tag_skipped", { id, orderGid, tag });
      }

      await queryAsync(
        `UPDATE applications
           SET assigned_order_gid = ?, assigned_order_name = ?, assigned_customer_gid = ?,
               assigned_tag = ?
           WHERE id = ?`,
        [
          orderGid,
          typeof orderName === "string" ? orderName.slice(0, 64) : null,
          customerGid,
          tag,
          id,
        ],
      );

      if (movedOrder) {
        await queryAsync(
          "UPDATE applications SET refunded_at = NULL, refunded_by = NULL WHERE id = ?",
          [id],
        );
      }

      log("info", "order_assigned", { id, orderGid, customerGid, tag, ip: req.ip });
      res.json({
        success: true,
        id,
        order_gid: orderGid,
        order_name: orderName,
        customer_gid: customerGid,
        tag,
      });
    } catch (err) {
      log("error", "order_assign_failed", { id, orderGid, tag, message: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/submissions/:id/assign-order", requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: "Invalid id" });
    }

    try {
      const rows = await queryAsync(
        `SELECT assigned_order_gid, assigned_customer_gid, assigned_tag, refunded_at
           FROM applications WHERE id = ?`,
        [id],
      );
      if (!rows.length) return res.status(404).json({ error: "Not found" });

      const {
        assigned_order_gid: orderGid,
        assigned_customer_gid: customerGid,
        assigned_tag: tag,
        refunded_at: refundedAt,
      } = rows[0];

      if (orderGid && tag && shopifyConfigured()) {
        try {
          await removeShopifyTag(orderGid, tag);
        } catch (e) {
          log("warn", "order_untag_failed", { id, orderGid, tag, message: e.message });
        }
        await untagCustomerIfUnused(id, customerGid, tag);
      }

      // Don't leave a REFUNDED tag on an order this application no longer claims.
      if (orderGid && refundedAt && shopifyConfigured()) {
        try {
          await removeShopifyTag(orderGid, REFUND_TAG);
        } catch (e) {
          log("warn", "order_untag_failed", {
            id,
            orderGid,
            tag: REFUND_TAG,
            message: e.message,
          });
        }
      }

      await queryAsync(
        `UPDATE applications
           SET assigned_order_gid = NULL, assigned_order_name = NULL,
               assigned_customer_gid = NULL, assigned_tag = NULL,
               refunded_at = NULL, refunded_by = NULL
           WHERE id = ?`,
        [id],
      );

      log("info", "order_unassigned", { id, orderGid, tag, ip: req.ip });
      res.json({ success: true, id });
    } catch (err) {
      log("error", "order_unassign_failed", { id, message: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // Marks the assigned order as refunded. Management still issues the refund by
  // hand in Shopify — this only records that they did, on the order and locally.
  app.post("/api/submissions/:id/refund", requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: "Invalid id" });
    }
    if (!shopifyConfigured()) {
      return res.status(503).json({ error: "Shopify is not configured." });
    }

    try {
      const rows = await queryAsync(
        "SELECT assigned_order_gid, refunded_at FROM applications WHERE id = ?",
        [id],
      );
      if (!rows.length) return res.status(404).json({ error: "Not found" });

      const { assigned_order_gid: orderGid, refunded_at: refundedAt } = rows[0];
      if (!orderGid) {
        return res
          .status(409)
          .json({ error: "Assign an order before marking it refunded" });
      }
      if (refundedAt) {
        return res.json({ success: true, id, refunded_at: refundedAt });
      }

      await addShopifyTag(orderGid, REFUND_TAG);

      const by = adminName(req);
      await queryAsync(
        "UPDATE applications SET refunded_at = NOW(), refunded_by = ? WHERE id = ?",
        [by.slice(0, 120), id],
      );

      log("info", "order_refund_marked", { id, orderGid, by, ip: req.ip });
      res.json({ success: true, id, refunded_by: by });
    } catch (err) {
      log("error", "order_refund_failed", { id, message: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/submissions/:id/refund", requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: "Invalid id" });
    }

    try {
      const rows = await queryAsync(
        "SELECT assigned_order_gid FROM applications WHERE id = ?",
        [id],
      );
      if (!rows.length) return res.status(404).json({ error: "Not found" });

      const { assigned_order_gid: orderGid } = rows[0];

      if (orderGid && shopifyConfigured()) {
        try {
          await removeShopifyTag(orderGid, REFUND_TAG);
        } catch (e) {
          log("warn", "order_untag_failed", {
            id,
            orderGid,
            tag: REFUND_TAG,
            message: e.message,
          });
        }
      }

      await queryAsync(
        "UPDATE applications SET refunded_at = NULL, refunded_by = NULL WHERE id = ?",
        [id],
      );

      log("info", "order_refund_cleared", { id, orderGid, ip: req.ip });
      res.json({ success: true, id });
    } catch (err) {
      log("error", "order_refund_clear_failed", { id, message: err.message });
      res.status(500).json({ error: err.message });
    }
  });
};
