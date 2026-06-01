/**
 * Unified database adapter.
 *
 * When DATABASE_URL is set the server uses PostgreSQL (via the `pg` package).
 * Otherwise it falls back to the embedded SQLite database (better-sqlite3).
 *
 * Both adapters expose the same async interface so the rest of the codebase
 * is database-agnostic:
 *
 *   db.query(sql, params?)     → Promise<row[]>
 *   db.queryOne(sql, params?)  → Promise<row | null>
 *   db.run(sql, params?)       → Promise<void>
 *   db.exec(sql)               → Promise<void>   (DDL / multi-statement)
 *   db.transaction(fn)         → Promise<T>      (fn receives a tx adapter)
 *   db.dialect                 → 'sqlite' | 'postgres'
 *   db.rawDb                   → Database | null (SQLite only; for session store)
 *   db._pool                   → Pool | null     (PG only; for session store)
 */

import fs from "node:fs";
import path from "node:path";

let adapter = null;

// Convert SQLite-style ? placeholders to PostgreSQL $1, $2, … notation.
function pgify(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// ── SQLite adapter ────────────────────────────────────────────────────────

function makeSqliteAdapter(raw) {
  const self = {
    dialect: "sqlite",
    rawDb: raw,
    _pool: null,

    query(sql, params = []) {
      return Promise.resolve(params.length ? raw.prepare(sql).all(params) : raw.prepare(sql).all());
    },
    queryOne(sql, params = []) {
      const row = params.length ? raw.prepare(sql).get(params) : raw.prepare(sql).get();
      return Promise.resolve(row ?? null);
    },
    run(sql, params = []) {
      if (params.length) raw.prepare(sql).run(params);
      else raw.prepare(sql).run();
      return Promise.resolve();
    },
    exec(sql) {
      raw.exec(sql);
      return Promise.resolve();
    },
    // BEGIN/COMMIT work here because all SQLite ops inside fn are synchronous
    // (wrapped in Promise.resolve) — no actual I/O occurs between the two
    // statements in a single-threaded Node.js process.
    async transaction(fn) {
      raw.exec("BEGIN");
      try {
        const result = await fn(self);
        raw.exec("COMMIT");
        return result;
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
    },
    close() {
      raw.close();
      return Promise.resolve();
    },
  };
  return self;
}

// ── PostgreSQL adapter ────────────────────────────────────────────────────

function makePgTxAdapter(client) {
  const tx = {
    dialect: "postgres",
    rawDb: null,
    _pool: null,

    async query(sql, params = []) {
      const { rows } = await client.query(pgify(sql), params);
      return rows;
    },
    async queryOne(sql, params = []) {
      const { rows } = await client.query(pgify(sql), params);
      return rows[0] ?? null;
    },
    async run(sql, params = []) {
      await client.query(pgify(sql), params);
    },
    async exec(sql) {
      await client.query(sql);
    },
    // Nested calls reuse the same client (savepoints not needed for our usage).
    async transaction(fn) {
      return fn(tx);
    },
  };
  return tx;
}

async function makePgAdapter(connectionString) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString, max: 10 });

  // Fail fast on bad connection strings.
  const probe = await pool.connect();
  probe.release();

  const self = {
    dialect: "postgres",
    rawDb: null,
    _pool: pool,

    async query(sql, params = []) {
      const { rows } = await pool.query(pgify(sql), params);
      return rows;
    },
    async queryOne(sql, params = []) {
      const { rows } = await pool.query(pgify(sql), params);
      return rows[0] ?? null;
    },
    async run(sql, params = []) {
      await pool.query(pgify(sql), params);
    },
    async exec(sql) {
      // Run multi-statement DDL statement by statement. pg handles individual
      // statements just fine; splitting avoids "multiple commands" parse errors.
      const stmts = sql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of stmts) {
        await pool.query(stmt);
      }
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(makePgTxAdapter(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
  return self;
}

// ── Public API ────────────────────────────────────────────────────────────

export async function initDb(dataDir) {
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    console.log("[db] connecting to PostgreSQL…");
    adapter = await makePgAdapter(dbUrl);
    console.log("[db] PostgreSQL ready");
  } else {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "app.sqlite");
    // Ensure the directory that will hold the DB file exists.
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    const { default: Database } = await import("better-sqlite3");
    const raw = new Database(dbPath);

    // SQLite must live on real local disk (never on a FUSE mount): WAL and
    // rollback journals require POSIX semantics that GCSFuse / s3fs cannot
    // provide. For durability across container restarts, replicate the file
    // to object storage with Litestream. PostgreSQL via DATABASE_URL is the
    // alternative for multi-replica deployments.
    raw.pragma("journal_mode = WAL");
    raw.pragma("synchronous = NORMAL");
    raw.pragma("busy_timeout = 10000");

    adapter = makeSqliteAdapter(raw);
    console.log(`[db] SQLite ready at ${dbPath}`);
  }
  return adapter;
}

export function getDb() {
  if (!adapter) throw new Error("DB not initialised — call initDb() first");
  return adapter;
}
