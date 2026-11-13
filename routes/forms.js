// Routes moved verbatim from index.js; registered at the same place in the middleware order.
const express = require("express");
const { TESTING_MODE } = require("../lib/config");
const { db, queryAsync } = require("../lib/db");
const { submitLimiter } = require("../lib/limits");
const { log } = require("../lib/log");
const { sendApplicationEmails, sendContactEmails, sendReturnEmails } = require("../lib/notifications");
const { optimizeImage, returnsUpload, upload } = require("../lib/uploads");
const path = require("path");

module.exports = function register(app) {
  app.post(
    "/api/apply",
    submitLimiter,
    upload.array("id_photos", 2),
    (req, res) => {
      // Capture metadata
      const metadata = JSON.stringify({
        ip: req.ip,
        user_agent: req.get("User-Agent"),
        referer: req.get("Referer") || "Direct",
        origin: req.get("Origin") || "Unknown",
        language: req.get("Accept-Language"),
      });

      const { full_name, birthday, contact_number, email_address, id_number } =
        req.body;

      const now = Date.now();
      const formLoadedAt = parseInt(req.body.form_loaded_at, 10);

      log("info", "apply_attempt", { email: email_address, ip: req.ip });

      // 1. Validation
      if (!full_name || full_name.trim().length < 3) {
        log("warn", "validation_failed", { field: "full_name", ip: req.ip });
        return res.status(400).json({ error: "Invalid full name." });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email_address)) {
        log("warn", "validation_failed", { field: "email_address", ip: req.ip });
        return res.status(400).json({ error: "Invalid email address." });
      }
      if (!/^(\+639|09)\d{9}$/.test(contact_number.replace(/[\s\-]/g, ""))) {
        log("warn", "validation_failed", { field: "contact_number", ip: req.ip });
        return res
          .status(400)
          .json({ error: "Invalid Philippine contact number." });
      }
      if (!id_number || id_number.trim().length < 6) {
        log("warn", "validation_failed", { field: "id_number", ip: req.ip });
        return res.status(400).json({ error: "Invalid ID number." });
      }
      if (!req.files || req.files.length === 0) {
        log("warn", "validation_failed", { field: "id_photos", ip: req.ip });
        return res.status(400).json({ error: "ID photo(s) are required." });
      }

      // 2. Time trap
      if (!TESTING_MODE && (!formLoadedAt || now - formLoadedAt < 3000)) {
        log("warn", "time_trap_triggered", { ip: req.ip });
        return res.status(200).json({ success: true }); // Silent reject
      }

      // 3. Honeypot
      const dynamicHp = Object.keys(req.body).find((k) => k.startsWith("hp_"));
      if (dynamicHp && req.body[dynamicHp]) {
        log("warn", "honeypot_triggered", { ip: req.ip, field: dynamicHp });
        return res.status(200).json({ success: true }); // Silent reject
      }

      // 4. Cooldown — prevent duplicate submissions from same email
      const cooldownSql = `
        SELECT id FROM applications
        WHERE email_address = ?
          AND id_number = ?
          AND created_at > DATE_SUB(NOW(), INTERVAL 2 MINUTE)
        LIMIT 1
      `;
      const cooldownParams = [email_address, id_number];
      const runCooldown = (cb) =>
        TESTING_MODE ? cb(null, []) : db.query(cooldownSql, cooldownParams, cb);

      runCooldown((err, rows) => {
        if (err) {
          log("error", "db_cooldown_check_failed", { message: err.message });
          return res.status(500).json({ error: "Database error." });
        }

        if (rows.length > 0) {
          log("info", "duplicate_ignored", { email: email_address });
          return res.status(200).json({
            success: true,
            message:
              "We already received this application. No need to submit again!",
          });
        }

        // 5. Insert
        const photoPaths = req.files
          ? req.files.map((f) => f.path).join(",")
          : "";

        const insertSql = `
        INSERT INTO applications 
          (full_name, birthday, contact_number, email_address, id_number, id_photo_path, metadata) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `;

        db.query(
          insertSql,
          [
            full_name,
            birthday,
            contact_number,
            email_address,
            id_number,
            photoPaths,
            metadata,
          ],
          (err, result) => {
            if (err) {
              log("error", "db_insert_failed", {
                message: err.message,
                email: email_address,
              });
              return res
                .status(500)
                .json({ error: "Failed to save application." });
            }

            log("info", "application_saved", {
              appId: result.insertId,
              email: email_address,
              ip: req.ip,
              photoCount: req.files.length,
            });

            // Respond immediately — don't wait for email
            res.json({
              success: true,
              message:
                "Application submitted successfully! Please check your email for confirmation.",
              id: result.insertId,
            });

            // Send emails (originals attached), then optimize on disk and update
            // the row's path. Email goes out before originals are deleted.
            (async () => {
              await sendApplicationEmails(
                {
                  full_name,
                  email_address,
                  id_number,
                  birthday,
                  contact_number,
                  insertId: result.insertId,
                },
                req.files,
                metadata,
              );

              const finalPaths = [];
              for (const f of req.files) {
                try {
                  finalPaths.push(await optimizeImage(f.path));
                } catch (err) {
                  log("error", "apply_optimize_failed", {
                    appId: result.insertId,
                    file: f.path,
                    message: err.message,
                  });
                  finalPaths.push(f.path);
                }
              }

              try {
                await queryAsync(
                  "UPDATE applications SET id_photo_path = ? WHERE id = ?",
                  [finalPaths.join(","), result.insertId],
                );
              } catch (err) {
                log("error", "apply_path_update_failed", {
                  appId: result.insertId,
                  message: err.message,
                });
              }
            })();
          },
        );
      });
    },
  );

  app.post("/api/contact", submitLimiter, express.json(), async (req, res) => {
    const metadata = JSON.stringify({
      ip: req.ip,
      user_agent: req.get("User-Agent"),
      referer: req.get("Referer") || "Direct",
      origin: req.get("Origin") || "Unknown",
      language: req.get("Accept-Language"),
    });

    const { full_name, email_address, contact_number, message } = req.body;
    const now = Date.now();
    const formLoadedAt = parseInt(req.body.form_loaded_at, 10);

    log("info", "contact_attempt", { email: email_address, ip: req.ip });

    if (!full_name || full_name.trim().length < 3) {
      return res.status(400).json({ error: "Invalid full name." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email_address || "")) {
      return res.status(400).json({ error: "Invalid email address." });
    }
    if (!/^(\+639|09)\d{9}$/.test((contact_number || "").replace(/[\s\-]/g, ""))) {
      return res.status(400).json({ error: "Invalid Philippine contact number." });
    }
    if (!message || message.trim().length < 10) {
      return res.status(400).json({ error: "Message must be at least 10 characters." });
    }
    if (message.length > 5000) {
      return res.status(400).json({ error: "Message is too long (max 5000 characters)." });
    }

    if (!TESTING_MODE && (!formLoadedAt || now - formLoadedAt < 3000)) {
      log("warn", "time_trap_triggered", { ip: req.ip, route: "contact" });
      return res.status(200).json({ success: true });
    }

    const dynamicHp = Object.keys(req.body).find((k) => k.startsWith("hp_"));
    if (dynamicHp && req.body[dynamicHp]) {
      log("warn", "honeypot_triggered", { ip: req.ip, route: "contact" });
      return res.status(200).json({ success: true });
    }

    try {
      if (!TESTING_MODE) {
        const dup = await queryAsync(
          `SELECT id FROM contact_submissions
             WHERE email_address = ?
               AND created_at > DATE_SUB(NOW(), INTERVAL 2 MINUTE)
             LIMIT 1`,
          [email_address],
        );
        if (dup.length) {
          log("info", "contact_duplicate_ignored", { email: email_address });
          return res.status(200).json({
            success: true,
            message: "We already received your message. We'll be in touch soon!",
          });
        }
      }

      const result = await queryAsync(
        `INSERT INTO contact_submissions
           (full_name, email_address, contact_number, message, metadata)
         VALUES (?, ?, ?, ?, ?)`,
        [full_name, email_address, contact_number, message, metadata],
      );

      log("info", "contact_saved", {
        id: result.insertId,
        email: email_address,
        ip: req.ip,
      });

      res.json({
        success: true,
        message: "Message sent! Please check your email for confirmation.",
        id: result.insertId,
      });

      sendContactEmails(
        {
          id: result.insertId,
          full_name,
          email_address,
          contact_number,
          message,
        },
        metadata,
      );
    } catch (err) {
      log("error", "contact_insert_failed", {
        message: err.message,
        email: email_address,
      });
      res.status(500).json({ error: "Failed to save message." });
    }
  });

  app.post(
    "/api/returns",
    submitLimiter,
    returnsUpload.array("attachments", 5),
    async (req, res) => {
      const metadata = JSON.stringify({
        ip: req.ip,
        user_agent: req.get("User-Agent"),
        referer: req.get("Referer") || "Direct",
        origin: req.get("Origin") || "Unknown",
        language: req.get("Accept-Language"),
      });

      const {
        full_name,
        email_address,
        contact_number,
        order_number,
        items_to_return,
        reason,
      } = req.body;

      const now = Date.now();
      const formLoadedAt = parseInt(req.body.form_loaded_at, 10);

      log("info", "return_attempt", { email: email_address, ip: req.ip });

      if (!full_name || full_name.trim().length < 3) {
        return res.status(400).json({ error: "Invalid full name." });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email_address || "")) {
        return res.status(400).json({ error: "Invalid email address." });
      }
      if (!/^(\+639|09)\d{9}$/.test((contact_number || "").replace(/[\s\-]/g, ""))) {
        return res.status(400).json({ error: "Invalid Philippine contact number." });
      }
      if (!order_number || order_number.trim().length < 3) {
        return res.status(400).json({ error: "Invalid order number." });
      }
      if (!items_to_return || items_to_return.trim().length < 2) {
        return res.status(400).json({ error: "Please list the items to return." });
      }
      if (!reason || reason.trim().length < 5) {
        return res.status(400).json({ error: "Please provide a reason." });
      }
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "At least one image attachment is required." });
      }

      if (!TESTING_MODE && (!formLoadedAt || now - formLoadedAt < 3000)) {
        log("warn", "time_trap_triggered", { ip: req.ip, route: "returns" });
        return res.status(200).json({ success: true });
      }

      const dynamicHp = Object.keys(req.body).find((k) => k.startsWith("hp_"));
      if (dynamicHp && req.body[dynamicHp]) {
        log("warn", "honeypot_triggered", { ip: req.ip, route: "returns" });
        return res.status(200).json({ success: true });
      }

      try {
        if (!TESTING_MODE) {
          const dup = await queryAsync(
            `SELECT id FROM return_requests
               WHERE email_address = ?
                 AND order_number = ?
                 AND created_at > DATE_SUB(NOW(), INTERVAL 2 MINUTE)
               LIMIT 1`,
            [email_address, order_number],
          );
          if (dup.length) {
            log("info", "return_duplicate_ignored", { email: email_address });
            return res.status(200).json({
              success: true,
              message: "We already received this request. No need to submit again!",
            });
          }
        }

        const imagePaths = req.files.map((f) => f.path).join(",");

        const result = await queryAsync(
          `INSERT INTO return_requests
             (full_name, email_address, contact_number, order_number, items_to_return, reason, image_paths, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            full_name,
            email_address,
            contact_number,
            order_number,
            items_to_return,
            reason,
            imagePaths,
            metadata,
          ],
        );

        log("info", "return_saved", {
          id: result.insertId,
          email: email_address,
          ip: req.ip,
          attachmentCount: req.files.length,
        });

        res.json({
          success: true,
          message: "Return request submitted! Please check your email for confirmation.",
          id: result.insertId,
        });

        (async () => {
          await sendReturnEmails(
            {
              id: result.insertId,
              full_name,
              email_address,
              contact_number,
              order_number,
              items_to_return,
              reason,
            },
            req.files,
            metadata,
          );

          const finalPaths = [];
          for (const f of req.files) {
            try {
              finalPaths.push(await optimizeImage(f.path));
            } catch (err) {
              log("error", "return_optimize_failed", {
                returnId: result.insertId,
                file: f.path,
                message: err.message,
              });
              finalPaths.push(f.path);
            }
          }

          try {
            await queryAsync(
              "UPDATE return_requests SET image_paths = ? WHERE id = ?",
              [finalPaths.join(","), result.insertId],
            );
          } catch (err) {
            log("error", "return_path_update_failed", {
              returnId: result.insertId,
              message: err.message,
            });
          }
        })();
      } catch (err) {
        log("error", "return_insert_failed", {
          message: err.message,
          email: email_address,
        });
        res.status(500).json({ error: "Failed to save return request." });
      }
    },
  );
};
