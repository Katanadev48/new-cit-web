"use strict";

const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");

const ORDER_STATUSES = new Set([
  "Pending",
  "In Progress",
  "Completed",
  "Cancelled",
]);

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

class UserNotFoundError extends Error {
  constructor() {
    super("User not found");
    this.name = "UserNotFoundError";
  }
}

class InsufficientBalanceError extends Error {
  constructor() {
    super("Insufficient balance");
    this.name = "InsufficientBalanceError";
  }
}

class Database {
  constructor({ filename = "./app.sqlite", logger = console } = {}) {
    this.logger = logger;
    this.queue = Promise.resolve();
    this.closed = false;

    this.ready = new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(filename, (error) => {
        if (error) {
          this._logError("open_database", error);
          reject(error);
          return;
        }
        resolve();
      });
    }).then(() => this._initialize());
  }

  async _initialize() {
    await this._run("enable_foreign_keys", "PRAGMA foreign_keys = ON");
    await this._run("set_busy_timeout", "PRAGMA busy_timeout = 5000");
    await this._run("enable_wal", "PRAGMA journal_mode = WAL");
    await this._run(
      "create_users_table",
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
        balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
    );
    await this._run(
      "create_orders_table",
      `CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        service_name TEXT NOT NULL,
        link TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        price INTEGER NOT NULL CHECK (price >= 0),
        status TEXT NOT NULL DEFAULT 'Pending'
          CHECK (status IN ('Pending', 'In Progress', 'Completed', 'Cancelled')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
      )`
    );
    await this._run(
      "create_orders_user_index",
      "CREATE INDEX IF NOT EXISTS idx_orders_user_created_id ON orders(user_id, created_at DESC, id DESC)"
    );
  }

  _logError(operation, error) {
    this.logger.error(
      {
        event: "database_error",
        operation,
        code: error && error.code,
        message: error && error.message,
      },
      "SQLite operation failed"
    );
  }

  _run(operation, sql, params = []) {
    const database = this;
    return new Promise((resolve, reject) => {
      database.db.run(sql, params, function (error) {
        if (error) {
          database._logError(operation, error);
          reject(error);
          return;
        }
        resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  _get(operation, sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (error, row) => {
        if (error) {
          this._logError(operation, error);
          reject(error);
          return;
        }
        resolve(row);
      });
    });
  }

  _all(operation, sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (error, rows) => {
        if (error) {
          this._logError(operation, error);
          reject(error);
          return;
        }
        resolve(rows);
      });
    });
  }

  _enqueue(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async _withQueue(task) {
    await this.ready;
    if (this.closed) {
      throw new Error("Database is closed");
    }
    return this._enqueue(task);
  }

  async registerUser({ username, password }) {
    this._validateUsername(username);
    this._validatePassword(password);

    const passwordHash = await bcrypt.hash(password, 12);
    return this._withQueue(async () => {
      try {
        const result = await this._run(
          "register_user",
          "INSERT INTO users (username, password_hash) VALUES (?, ?)",
          [username, passwordHash]
        );
        return this._getPublicUserById(result.lastID);
      } catch (error) {
        if (error.code === "SQLITE_CONSTRAINT" || error.code === "SQLITE_CONSTRAINT_UNIQUE") {
          const duplicate = new Error("Username is already registered");
          duplicate.name = "DuplicateUsernameError";
          throw duplicate;
        }
        throw error;
      }
    });
  }

  async authenticateUser({ username, password }) {
    this._validateUsername(username);
    if (typeof password !== "string") {
      throw new ValidationError("Password must be a string");
    }

    const row = await this._withQueue(() =>
      this._get(
        "authenticate_user",
        "SELECT id, username, password_hash FROM users WHERE username = ? COLLATE NOCASE",
        [username]
      )
    );
    if (!row || !(await bcrypt.compare(password, row.password_hash))) {
      return null;
    }
    return this.getUserById(row.id);
  }

  async getUserById(userId) {
    this._validateId(userId, "userId");
    return this._withQueue(() => this._getPublicUserById(userId));
  }

  async getWalletBalance(userId) {
    this._validateId(userId, "userId");
    return this._withQueue(async () => {
      const row = await this._get(
        "get_wallet_balance",
        "SELECT balance FROM users WHERE id = ?",
        [userId]
      );
      if (!row) {
        throw new UserNotFoundError();
      }
      return row.balance;
    });
  }

  async createOrder({ userId, serviceName, link, quantity, price }) {
    this._validateId(userId, "userId");
    this._validateText(serviceName, "serviceName", 200);
    this._validateText(link, "link", 2048);
    this._validatePositiveInteger(quantity, "quantity");
    this._validateNonNegativeInteger(price, "price");

    return this._withQueue(async () => {
      await this._run("begin_order_transaction", "BEGIN IMMEDIATE");
      try {
        const debit = await this._run(
          "deduct_order_balance",
          "UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?",
          [price, userId, price]
        );

        if (debit.changes !== 1) {
          const user = await this._get(
            "check_order_user_exists",
            "SELECT id FROM users WHERE id = ?",
            [userId]
          );
          if (!user) {
            throw new UserNotFoundError();
          }
          throw new InsufficientBalanceError();
        }

        const inserted = await this._run(
          "insert_order",
          `INSERT INTO orders (user_id, service_name, link, quantity, price)
           VALUES (?, ?, ?, ?, ?)`,
          [userId, serviceName, link, quantity, price]
        );
        const order = await this._get(
          "get_created_order",
          "SELECT * FROM orders WHERE id = ?",
          [inserted.lastID]
        );
        const balance = await this._get(
          "get_balance_after_order",
          "SELECT balance FROM users WHERE id = ?",
          [userId]
        );

        await this._run("commit_order_transaction", "COMMIT");
        return { ...order, balance: balance.balance };
      } catch (error) {
        try {
          await this._run("rollback_order_transaction", "ROLLBACK");
        } catch (rollbackError) {
          this._logError("rollback_order_transaction", rollbackError);
        }
        throw error;
      }
    });
  }

  async getUserOrders(userId, { limit = 100, offset = 0 } = {}) {
    this._validateId(userId, "userId");
    this._validatePagination(limit, offset);
    return this._withQueue(() =>
      this._all(
        "get_user_orders",
        `SELECT id, user_id, service_name, link, quantity, price, status, created_at
         FROM orders WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [userId, limit, offset]
      )
    );
  }

  async getAllOrders({ limit = 100, offset = 0 } = {}) {
    this._validatePagination(limit, offset);
    return this._withQueue(() =>
      this._all(
        "get_all_orders",
        `SELECT o.id, o.user_id, u.username, o.service_name, o.link, o.quantity,
                o.price, o.status, o.created_at
         FROM orders o JOIN users u ON u.id = o.user_id
         ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`,
        [limit, offset]
      )
    );
  }

  async updateOrderStatus(orderId, status) {
    this._validateId(orderId, "orderId");
    if (!ORDER_STATUSES.has(status)) {
      throw new ValidationError("Unsupported order status");
    }

    return this._withQueue(async () => {
      const result = await this._run(
        "update_order_status",
        "UPDATE orders SET status = ? WHERE id = ?",
        [status, orderId]
      );
      if (result.changes === 0) {
        return null;
      }
      return this._get(
        "get_updated_order",
        `SELECT id, user_id, service_name, link, quantity, price, status, created_at
         FROM orders WHERE id = ?`,
        [orderId]
      );
    });
  }

  async _getPublicUserById(userId) {
    const user = await this._get(
      "get_user",
      "SELECT id, username, role, balance, created_at FROM users WHERE id = ?",
      [userId]
    );
    return user || null;
  }

  _validateUsername(username) {
    if (typeof username !== "string" || !/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
      throw new ValidationError("Username must be 3-32 letters, numbers, underscores, or hyphens");
    }
  }

  _validatePassword(password) {
    if (
      typeof password !== "string" ||
      Buffer.byteLength(password, "utf8") < 12 ||
      Buffer.byteLength(password, "utf8") > 72
    ) {
      throw new ValidationError("Password must be between 12 and 72 UTF-8 bytes");
    }
  }

  _validateText(value, field, maxLength) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
      throw new ValidationError(`${field} must be a non-empty string of at most ${maxLength} characters`);
    }
  }

  _validateId(value, field) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ValidationError(`${field} must be a positive safe integer`);
    }
  }

  _validatePositiveInteger(value, field) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ValidationError(`${field} must be a positive safe integer`);
    }
  }

  _validateNonNegativeInteger(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ValidationError(`${field} must be a non-negative safe integer`);
    }
  }

  _validatePagination(limit, offset) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new ValidationError("limit must be an integer between 1 and 500");
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ValidationError("offset must be a non-negative integer");
    }
  }

  async close() {
    await this.ready;
    if (this.closed) {
      return;
    }
    await this._enqueue(
      () =>
        new Promise((resolve, reject) => {
          this.db.close((error) => {
            if (error) {
              this._logError("close_database", error);
              reject(error);
              return;
            }
            this.closed = true;
            resolve();
          });
        })
    );
  }
}

module.exports = {
  Database,
  InsufficientBalanceError,
  UserNotFoundError,
  ValidationError,
};