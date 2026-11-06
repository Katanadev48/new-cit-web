"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const sqlite3 = require("sqlite3").verbose();

const databasePath = process.env.DB_PATH || "./app.sqlite";
const migrationPath = path.join(__dirname, "..", "migrations", "002_indexes.sql");
let database;
const databaseReady = new Promise((resolve, reject) => {
  database = new sqlite3.Database(databasePath, (error) => {
    if (error) reject(error);
    else resolve();
  });
});

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    database.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function exec(sql) {
  return new Promise((resolve, reject) => {
    database.exec(sql, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function close() {
  return new Promise((resolve, reject) => {
    database.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function main() {
  await databaseReady;
  const ordersTable = await get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orders'"
  );
  if (!ordersTable) {
    throw new Error("Database schema is missing. Start the app once before applying migrations.");
  }

  const migration = await fs.readFile(migrationPath, "utf8");
  await exec(migration);
  console.log("Database indexes migrated successfully.");
}

main()
  .catch((error) => {
    console.error("Database migration failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await close();
    } catch (error) {
      console.error("Could not close the migration database:", error.message);
      process.exitCode = 1;
    }
  });