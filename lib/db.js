// MySQL pool, column/table migrations used at boot, and queryAsync.
// Moved verbatim from index.js.
const mysql = require("mysql2");
const { log } = require("./log");

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

function ensureColumnFor(table, name, definition) {
  db.query(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [process.env.DB_NAME, table, name],
    (err, rows) => {
      if (err) {
        log("error", "migration_check_failed", { table, column: name, message: err.message });
        return;
      }
      if (rows[0].c > 0) return;
      db.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`, (alterErr) => {
        if (alterErr) {
          log("error", "migration_failed", { table, column: name, message: alterErr.message });
        } else {
          log("info", "migration_applied", { table, column: name });
        }
      });
    },
  );
}

function ensureColumn(name, definition) {
  ensureColumnFor("applications", name, definition);
}

function ensureStatusColumn() {
  ensureColumn("status", "ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending'");
  ensureColumn("discount_code", "VARCHAR(64) NULL");
  ensureColumn("discount_price_rule_id", "BIGINT NULL");
  ensureColumn("rejection_reason", "TEXT NULL");
  ensureColumn("discount_code_id", "BIGINT NULL");
  ensureColumn("discount_node_gid", "VARCHAR(255) NULL");
  ensureColumn("assigned_order_gid", "VARCHAR(255) NULL");
  ensureColumn("assigned_order_name", "VARCHAR(64) NULL");
  ensureColumn("assigned_tag", "VARCHAR(8) NULL");
  ensureColumn("assigned_customer_gid", "VARCHAR(255) NULL");
  ensureColumn("refunded_at", "DATETIME NULL");
  ensureColumn("refunded_by", "VARCHAR(120) NULL");
  // ensureColumnFor("return_requests", "rejection_reason", "TEXT NULL");
}

function ensureContactTable() {
  db.query(
    `CREATE TABLE IF NOT EXISTS contact_submissions (
       id INT AUTO_INCREMENT PRIMARY KEY,
       full_name VARCHAR(255) NOT NULL,
       email_address VARCHAR(255) NOT NULL,
       contact_number VARCHAR(32) NOT NULL,
       message TEXT NOT NULL,
       status ENUM('pending','resolved') NOT NULL DEFAULT 'pending',
       metadata TEXT,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_contact_email (email_address),
       INDEX idx_contact_created (created_at)
     )`,
    (err) => {
      if (err) log("error", "migration_contact_table_failed", { message: err.message });
      else log("info", "migration_contact_table_ready");
    },
  );
}

function ensureReturnsTable() {
  db.query(
    `CREATE TABLE IF NOT EXISTS return_requests (
       id INT AUTO_INCREMENT PRIMARY KEY,
       full_name VARCHAR(255) NOT NULL,
       email_address VARCHAR(255) NOT NULL,
       contact_number VARCHAR(32) NOT NULL,
       order_number VARCHAR(64) NOT NULL,
       items_to_return TEXT NOT NULL,
       reason TEXT NOT NULL,
       image_paths TEXT,
       status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
       rejection_reason TEXT NULL,
       metadata TEXT,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_returns_email (email_address),
       INDEX idx_returns_order (order_number),
       INDEX idx_returns_created (created_at)
     )`,
    (err) => {
      if (err) log("error", "migration_returns_table_failed", { message: err.message });
      else {
        log("info", "migration_returns_table_ready");
        ensureStatusColumn();
      }
    },
  );
}

// ── Helpers: queryAsync + requireAdmin ────────────────────────────────────────
const queryAsync = (sql, params) =>
  new Promise((resolve, reject) =>
    db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))),
  );

module.exports = { db, ensureColumnFor, ensureColumn, ensureStatusColumn, ensureContactTable, ensureReturnsTable, queryAsync };
