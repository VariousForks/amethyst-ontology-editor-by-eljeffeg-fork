import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuid } from "uuid";
import { getDb, initDb } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, "..", "..", "..", "data");

// Directory holding the SQLite files (app.sqlite, sessions.sqlite).
// Must be on real local disk — never on a FUSE mount. Defaults to DATA_DIR
// for local development; production overrides via ENV SQLITE_DIR.
export const SQLITE_DIR = process.env.SQLITE_DIR || DATA_DIR;

// ── Schema helpers ────────────────────────────────────────────────────────

async function columnExists(db, table, column) {
  if (db.dialect === "sqlite") {
    const cols = await db.query(`PRAGMA table_info(${table})`);
    return cols.some((c) => c.name === column);
  }
  const row = await db.queryOne(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`,
    [table, column],
  );
  return !!row;
}

async function ensureColumn(db, table, col, sqliteType, pgType) {
  const exists = await columnExists(db, table, col);
  if (!exists) {
    const typeDecl = db.dialect === "postgres" ? pgType : sqliteType;
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${typeDecl}`);
    console.log(`[authDb] migrated: added ${table}.${col}`);
  }
}

async function tableExists(db, name) {
  if (db.dialect === "sqlite") {
    const row = await db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [
      name,
    ]);
    return !!row;
  }
  const row = await db.queryOne(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=?",
    [name],
  );
  return !!row;
}

// ── Initialisation ────────────────────────────────────────────────────────

export async function initAuthDb() {
  const db = await initDb(SQLITE_DIR);
  const isPg = db.dialect === "postgres";

  // SQLite uses INTEGER PRIMARY KEY AUTOINCREMENT; PG uses BIGSERIAL.
  const autoId = isPg ? "BIGSERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";

  // 1. Create tables (idempotent).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      username     TEXT UNIQUE NOT NULL,
      email        TEXT UNIQUE,
      password     TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'editor',
      created_at   ${isPg ? "BIGINT" : "INTEGER"} NOT NULL,
      invited_by   TEXT
    );

    CREATE TABLE IF NOT EXISTS projects (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT,
      created_at    ${isPg ? "BIGINT" : "INTEGER"} NOT NULL,
      created_by    TEXT,
      updated_at    ${isPg ? "BIGINT" : "INTEGER"} NOT NULL,
      updated_by    TEXT
    );

    CREATE TABLE IF NOT EXISTS ontologies (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      iri           TEXT,
      description   TEXT,
      project_id    TEXT,
      created_at    ${isPg ? "BIGINT" : "INTEGER"} NOT NULL,
      created_by    TEXT,
      updated_at    ${isPg ? "BIGINT" : "INTEGER"} NOT NULL,
      updated_by    TEXT
    );

    CREATE TABLE IF NOT EXISTS invites (
      token         TEXT PRIMARY KEY,
      email         TEXT,
      invited_by    TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'editor',
      created_at    ${isPg ? "BIGINT" : "INTEGER"} NOT NULL,
      expires_at    ${isPg ? "BIGINT" : "INTEGER"} NOT NULL,
      accepted_at   ${isPg ? "BIGINT" : "INTEGER"},
      accepted_by   TEXT,
      email_sent    ${isPg ? "SMALLINT" : "INTEGER"} NOT NULL DEFAULT 0,
      email_error   TEXT
    );

    CREATE TABLE IF NOT EXISTS comments (
      id            ${autoId},
      ontology_id   TEXT NOT NULL,
      target_iri    TEXT,
      parent_id     ${isPg ? "BIGINT" : "INTEGER"},
      user_id       TEXT,
      body          TEXT NOT NULL,
      resolved      ${isPg ? "SMALLINT" : "INTEGER"} NOT NULL DEFAULT 0,
      created_at    ${isPg ? "BIGINT" : "INTEGER"} NOT NULL,
      updated_at    ${isPg ? "BIGINT" : "INTEGER"} NOT NULL
    );

    CREATE TABLE IF NOT EXISTS changes (
      id            ${autoId},
      user_id       TEXT,
      ontology_id   TEXT,
      action        TEXT NOT NULL,
      details       TEXT,
      created_at    ${isPg ? "BIGINT" : "INTEGER"} NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key           TEXT PRIMARY KEY,
      value         TEXT,
      updated_at    ${isPg ? "BIGINT" : "INTEGER"} NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_members (
      project_id    TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'viewer',
      created_at    ${isPg ? "BIGINT" : "INTEGER"} NOT NULL,
      PRIMARY KEY (project_id, user_id)
    );
  `);

  // 2. Forward-migrate: add columns missing from older schemas.
  await ensureColumn(db, "users", "invited_by", "TEXT", "TEXT");
  await ensureColumn(db, "users", "google_id", "TEXT", "TEXT");
  await ensureColumn(db, "users", "oauth_provider", "TEXT", "TEXT");
  await ensureColumn(db, "users", "last_active_at", "INTEGER", "BIGINT");
  await ensureColumn(db, "changes", "ontology_id", "TEXT", "TEXT");
  await ensureColumn(db, "changes", "note", "TEXT", "TEXT");
  await ensureColumn(db, "changes", "project_id", "TEXT", "TEXT");
  await ensureColumn(
    db,
    "invites",
    "email_sent",
    "INTEGER NOT NULL DEFAULT 0",
    "SMALLINT NOT NULL DEFAULT 0",
  );
  await ensureColumn(db, "invites", "email_error", "TEXT", "TEXT");
  await ensureColumn(db, "ontologies", "project_id", "TEXT", "TEXT");
  // Branch tracking: parent ontology id and timestamp of branching.
  await ensureColumn(db, "ontologies", "branch_of", "TEXT", "TEXT");
  await ensureColumn(db, "ontologies", "branched_at", "INTEGER", "BIGINT");
  // Snapshot of the parent's updated_at when the branch was created — used to
  // detect if the parent was modified after the branch was taken.
  await ensureColumn(db, "ontologies", "branched_from_version", "INTEGER", "BIGINT");
  // User-defined sort order for ontologies within a project.
  await ensureColumn(db, "ontologies", "sort_order", "INTEGER", "INTEGER");
  // Add project_id to invites for per-project invite scoping.
  await ensureColumn(db, "invites", "project_id", "TEXT", "TEXT");
  // Add project role label to invites (manager/editor/viewer).
  await ensureColumn(db, "invites", "project_role", "TEXT", "TEXT");
  // Make invites.email nullable (older schema had TEXT NOT NULL).
  if (db.dialect === "sqlite") {
    const cols = await db.query("PRAGMA table_info(invites)");
    const emailCol = cols.find((c) => c.name === "email");
    if (emailCol && emailCol.notnull === 1) {
      await db.exec(
        "CREATE TABLE invites_new (token TEXT PRIMARY KEY, email TEXT, invited_by TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, accepted_at INTEGER, accepted_by TEXT, email_sent INTEGER NOT NULL DEFAULT 0, email_error TEXT, project_id TEXT, project_role TEXT)",
      );
      await db.exec(
        "INSERT INTO invites_new SELECT token, email, invited_by, role, created_at, expires_at, accepted_at, accepted_by, email_sent, email_error, project_id, project_role FROM invites",
      );
      await db.exec("DROP TABLE invites");
      await db.exec("ALTER TABLE invites_new RENAME TO invites");
      console.log("[authDb] migrated: invites.email is now nullable");
    }
  } else {
    const emailNullable = await db.queryOne(
      `SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='invites' AND column_name='email'`,
    );
    if (emailNullable && emailNullable.is_nullable === "NO") {
      await db.exec("ALTER TABLE invites ALTER COLUMN email DROP NOT NULL");
      console.log("[authDb] migrated: invites.email is now nullable");
    }
  }
  // GitHub account connection (per-user token for repo/discussions/AI access).
  await ensureColumn(db, "users", "github_id", "TEXT", "TEXT");
  await ensureColumn(db, "users", "github_token", "TEXT", "TEXT");
  await ensureColumn(db, "users", "github_login", "TEXT", "TEXT");
  await ensureColumn(db, "users", "github_token_scope", "TEXT", "TEXT");
  // GitHub App user token expiry + refresh token (null for PATs, which don't expire).
  await ensureColumn(db, "users", "github_token_expires_at", "INTEGER", "BIGINT");
  await ensureColumn(db, "users", "github_refresh_token", "TEXT", "TEXT");
  // GitHub-backed projects.
  await ensureColumn(db, "projects", "github_repo", "TEXT", "TEXT");
  await ensureColumn(db, "projects", "github_branch", "TEXT", "TEXT");
  // GitHub-tracked ontology files.
  await ensureColumn(db, "ontologies", "github_path", "TEXT", "TEXT");
  await ensureColumn(db, "ontologies", "github_sha", "TEXT", "TEXT");
  await ensureColumn(db, "ontologies", "github_pr_url", "TEXT", "TEXT");
  // GitHub branch name for in-app branch ontologies backed by a GitHub branch.
  await ensureColumn(db, "ontologies", "github_branch_name", "TEXT", "TEXT");
  // Pulled in via owl:imports from another synced ontology — read-only, cannot be write target.
  await ensureColumn(db, "ontologies", "is_imported", "INTEGER", "INTEGER");
  // GitHub Discussions sync tracking on comments.
  await ensureColumn(db, "comments", "github_discussion_id", "TEXT", "TEXT");
  await ensureColumn(db, "comments", "github_comment_id", "TEXT", "TEXT");
  await ensureColumn(db, "comments", "github_synced_at", "INTEGER", "BIGINT");

  // 2b-extra. Backfill sort_order for ontologies that don't have one yet.
  //   Seed from created_at order within each project so existing projects get a
  //   deterministic initial ordering before the user first drags anything.
  {
    const needOrder = await db.query(
      `SELECT DISTINCT project_id FROM ontologies
       WHERE sort_order IS NULL AND project_id IS NOT NULL`,
    );
    for (const { project_id } of needOrder) {
      const rows = await db.query(
        "SELECT id FROM ontologies WHERE project_id = ? ORDER BY created_at ASC",
        [project_id],
      );
      for (let i = 0; i < rows.length; i++) {
        await db.run("UPDATE ontologies SET sort_order = ? WHERE id = ?", [i, rows[i].id]);
      }
    }
  }

  // 2b. Role migrations:
  //   • users.role: 'editor'|'viewer' → 'user'  (server roles: admin | user only)
  //   • project_members.role: 'admin' → 'manager'  (project roles: manager | editor | viewer)
  await db.exec("UPDATE users SET role = 'user' WHERE role IN ('editor', 'viewer')");
  await db.exec("UPDATE project_members SET role = 'manager' WHERE role = 'admin'");
  // Invites: old invite role used server-role names; migrate to project-role names.
  await db.exec("UPDATE invites SET role = 'manager' WHERE role = 'admin'");
  await db.exec(
    "UPDATE invites SET role = 'user' WHERE role IN ('editor', 'viewer') AND project_id IS NULL",
  );

  // 2c. Safety net: ensure at least one admin user always exists.
  //     If the role migration above demoted every user (e.g. the only account had
  //     role='editor' before this deploy), promote the earliest-created user back
  //     to admin so the instance is never locked out.
  {
    const adminCount = await db.queryOne("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'");
    if (Number(adminCount?.c ?? 0) === 0) {
      const firstUser = await db.queryOne(
        "SELECT id, username FROM users ORDER BY created_at ASC LIMIT 1",
      );
      if (firstUser) {
        await db.run("UPDATE users SET role = 'admin' WHERE id = ?", [firstUser.id]);
        console.log(
          `[authDb] migrated: no admin found — promoted "${firstUser.username}" to admin`,
        );
      }
    }
  }

  // 3. Indexes.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_comments_ontology_target
      ON comments(ontology_id, target_iri);
    CREATE INDEX IF NOT EXISTS idx_comments_parent
      ON comments(parent_id);
    CREATE INDEX IF NOT EXISTS idx_changes_ontology
      ON changes(ontology_id);
    CREATE INDEX IF NOT EXISTS idx_changes_project
      ON changes(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_members_user
      ON project_members(user_id);
  `);

  // 4. Migrate old ontology_meta table if present (SQLite installs only).
  if (db.dialect === "sqlite" && (await tableExists(db, "ontology_meta"))) {
    const old = await db.query("SELECT * FROM ontology_meta");
    for (const row of old) {
      const exists = await db.queryOne("SELECT id FROM ontologies WHERE id = ?", [row.id]);
      if (!exists) {
        await db.run(
          `INSERT INTO ontologies
             (id, name, iri, description, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            row.name,
            row.iri,
            row.description,
            row.updated_at,
            row.updated_by,
            row.updated_at,
            row.updated_by,
          ],
        );
      }
    }
  }

  // 5. Wrap orphan ontologies into their own project.
  const orphans = await db.query("SELECT * FROM ontologies WHERE project_id IS NULL");
  if (orphans.length) {
    await db.transaction(async (tx) => {
      for (const o of orphans) {
        const pid = uuid();
        await tx.run(
          `INSERT INTO projects
             (id, name, description, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            pid,
            o.name,
            o.description || null,
            o.created_at,
            o.created_by,
            o.updated_at,
            o.updated_by,
          ],
        );
        await tx.run("UPDATE ontologies SET project_id = ? WHERE id = ?", [pid, o.id]);
      }
    });
    console.log(
      `[authDb] migrated ${orphans.length} ontolog${orphans.length === 1 ? "y" : "ies"} into individual projects`,
    );
  }

  // 6. Backfill project_members.
  //    • Every project's created_by → manager of that project.
  //    • Every non-admin with zero memberships → viewer of all projects
  //      (fixes accounts created before invite-accept membership grant).
  // Idempotent — ON CONFLICT DO NOTHING.
  await db.transaction(async (tx) => {
    const now = Date.now();
    const allProjects = await tx.query("SELECT id, created_by FROM projects");

    for (const p of allProjects) {
      if (p.created_by) {
        await tx.run(
          `INSERT INTO project_members (project_id, user_id, role, created_at)
           VALUES (?, ?, 'manager', ?)
           ON CONFLICT(project_id, user_id) DO NOTHING`,
          [p.id, p.created_by, now],
        );
      }
    }

    const unassigned = await tx.query(
      `SELECT id FROM users
       WHERE role != 'admin'
         AND id NOT IN (SELECT DISTINCT user_id FROM project_members)`,
    );
    for (const u of unassigned) {
      for (const p of allProjects) {
        await tx.run(
          `INSERT INTO project_members (project_id, user_id, role, created_at)
           VALUES (?, ?, 'viewer', ?)
           ON CONFLICT(project_id, user_id) DO NOTHING`,
          [p.id, u.id, now],
        );
      }
    }
  });

  console.log(`[authDb] ready (${db.dialect})`);
}

// ── Re-export getDb so route files can still import it from authDb ────────
export { getDb };

// ── Settings ──────────────────────────────────────────────────────────────

export async function getSetting(key, fallback = null) {
  const db = getDb();
  const row = await db.queryOne("SELECT value FROM settings WHERE key = ?", [key]);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  const db = getDb();
  await db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value == null ? null : String(value), Date.now()],
  );
}

export async function getBoolSetting(key, fallback = false) {
  const v = await getSetting(key, null);
  if (v === null || v === undefined) return fallback;
  return v === "true" || v === "1";
}

export async function setBoolSetting(key, value) {
  return setSetting(key, value ? "true" : "false");
}

// ── Audit log ─────────────────────────────────────────────────────────────

export async function logChange(userId, ontologyId, action, details) {
  const db = getDb();
  // Automatically surface project_id for project-level events (e.g. member add)
  // that carry no ontology_id but include projectId in their details payload.
  const projectId = ontologyId ? null : details?.projectId || null;
  await db.run(
    "INSERT INTO changes (user_id, ontology_id, project_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [
      userId || null,
      ontologyId || null,
      projectId,
      action,
      JSON.stringify(details || {}),
      Date.now(),
    ],
  );
}

export async function getAuditLog({ userId, ontologyId, action, limit = 100 } = {}) {
  const db = getDb();
  const cap = Math.min(500, Math.max(1, limit));
  const where = [];
  const params = [];
  if (userId) {
    where.push("c.user_id = ?");
    params.push(userId);
  }
  if (ontologyId) {
    where.push("c.ontology_id = ?");
    params.push(ontologyId);
  }
  if (action) {
    where.push("c.action = ?");
    params.push(action);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(cap);
  return db.query(
    `SELECT c.id, c.user_id, u.username, c.ontology_id, o.name AS ontology_name,
            c.action, c.details, c.note, c.created_at
     FROM changes c
     LEFT JOIN users u      ON u.id = c.user_id
     LEFT JOIN ontologies o ON o.id = c.ontology_id
     ${whereSql}
     ORDER BY c.id DESC
     LIMIT ?`,
    params,
  );
}

export async function getChangeById(id) {
  return getDb().queryOne("SELECT * FROM changes WHERE id = ?", [id]);
}

export async function updateChangeNote(id, note) {
  await getDb().run("UPDATE changes SET note = ? WHERE id = ?", [note || null, id]);
}

// ── System stats (admin dashboard) ────────────────────────────────────────

export async function getSystemCounts() {
  const db = getDb();
  const [users, ontologies, invites, comments, changes] = await Promise.all([
    db.queryOne("SELECT COUNT(*) AS c FROM users"),
    db.queryOne("SELECT COUNT(*) AS c FROM ontologies"),
    db.queryOne("SELECT COUNT(*) AS c FROM invites WHERE accepted_at IS NULL"),
    db.queryOne("SELECT COUNT(*) AS c FROM comments"),
    db.queryOne("SELECT COUNT(*) AS c FROM changes"),
  ]);
  return {
    users: Number(users.c),
    ontologies: Number(ontologies.c),
    invites: Number(invites.c),
    comments: Number(comments.c),
    changes: Number(changes.c),
  };
}

export async function vacuumDb() {
  const db = getDb();
  // Both SQLite and PG support VACUUM; for PG we also run ANALYZE.
  if (db.dialect === "postgres") {
    await db.exec("VACUUM ANALYZE");
  } else {
    await db.exec("VACUUM");
  }
}

// ── Users ─────────────────────────────────────────────────────────────────

export async function getUserByUsername(username) {
  return getDb().queryOne("SELECT * FROM users WHERE username = ?", [username]);
}

export async function getUserByEmail(email) {
  return getDb().queryOne("SELECT * FROM users WHERE email = ?", [email]);
}

export async function getUserById(id) {
  return getDb().queryOne(
    "SELECT id, username, email, role, created_at, oauth_provider FROM users WHERE id = ?",
    [id],
  );
}

export async function getUserByGoogleId(googleId) {
  return getDb().queryOne("SELECT * FROM users WHERE google_id = ?", [googleId]);
}

export async function getTotalUserCount() {
  const row = await getDb().queryOne("SELECT COUNT(*) AS c FROM users");
  return Number(row.c);
}

export async function getUserCountForRole(role) {
  const row = await getDb().queryOne("SELECT COUNT(*) AS c FROM users WHERE role = ?", [role]);
  return Number(row.c);
}

export async function createUserRecord({ id, username, email, hash, role, now, invitedBy = null }) {
  await getDb().run(
    `INSERT INTO users (id, username, email, password, role, created_at, invited_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, username, email || null, hash, role, now, invitedBy],
  );
}

export async function createOAuthUser({ id, username, email, role, now, googleId, oauthProvider }) {
  await getDb().run(
    `INSERT INTO users
       (id, username, email, password, role, created_at, google_id, oauth_provider)
     VALUES (?, ?, ?, 'OAUTH_ONLY', ?, ?, ?, ?)`,
    [id, username, email, role, now, googleId, oauthProvider],
  );
}

export async function linkGoogleIdToUser(id, googleId) {
  await getDb().run(
    "UPDATE users SET google_id = ?, oauth_provider = COALESCE(oauth_provider, 'google') WHERE id = ?",
    [googleId, id],
  );
}

export async function updateUserEmail(id, email) {
  await getDb().run("UPDATE users SET email = ? WHERE id = ?", [email || null, id]);
}

export async function getUserPasswordRecord(id) {
  return getDb().queryOne("SELECT id, password FROM users WHERE id = ?", [id]);
}

export async function updateUserPassword(id, hash) {
  await getDb().run("UPDATE users SET password = ? WHERE id = ?", [hash, id]);
}

export async function updateUserRole(id, role) {
  await getDb().run("UPDATE users SET role = ? WHERE id = ?", [role, id]);
}

export async function deleteUserRecord(id) {
  await getDb().run("DELETE FROM users WHERE id = ?", [id]);
}

export async function listUsers() {
  return getDb().query(
    "SELECT id, username, email, role, created_at, last_active_at FROM users ORDER BY created_at ASC",
  );
}

export async function touchLastActive(userId) {
  if (!userId) return;
  await getDb().run("UPDATE users SET last_active_at = ? WHERE id = ?", [Date.now(), userId]);
}

// ── GitHub connection ─────────────────────────────────────────────────────

export async function getUserByGitHubId(githubId) {
  return getDb().queryOne("SELECT * FROM users WHERE github_id = ?", [githubId]);
}

export async function updateGitHubConnection(
  userId,
  { githubId, githubLogin, githubToken, scope, expiresAt = null, refreshToken = null },
) {
  await getDb().run(
    "UPDATE users SET github_id = ?, github_login = ?, github_token = ?, github_token_scope = ?, github_token_expires_at = ?, github_refresh_token = ? WHERE id = ?",
    [
      String(githubId),
      githubLogin,
      githubToken,
      scope || null,
      expiresAt ?? null,
      refreshToken ?? null,
      userId,
    ],
  );
}

// Update only the token fields after a refresh — does not touch github_id / login.
export async function updateGitHubToken(
  userId,
  { token, scope, expiresAt = null, refreshToken = null },
) {
  await getDb().run(
    "UPDATE users SET github_token = ?, github_token_scope = ?, github_token_expires_at = ?, github_refresh_token = ? WHERE id = ?",
    [token, scope || null, expiresAt ?? null, refreshToken ?? null, userId],
  );
}

export async function getUserGitHubToken(userId) {
  const row = await getDb().queryOne(
    "SELECT github_token, github_login, github_token_scope, github_token_expires_at, github_refresh_token FROM users WHERE id = ?",
    [userId],
  );
  if (!row?.github_token) return null;
  return {
    token: row.github_token,
    login: row.github_login,
    scope: row.github_token_scope,
    expiresAt: row.github_token_expires_at ?? null,
    refreshToken: row.github_refresh_token ?? null,
  };
}

export async function clearGitHubConnection(userId) {
  await getDb().run(
    "UPDATE users SET github_id = NULL, github_login = NULL, github_token = NULL, github_token_scope = NULL, github_token_expires_at = NULL, github_refresh_token = NULL WHERE id = ?",
    [userId],
  );
}

// ── Ontologies ────────────────────────────────────────────────────────────

export async function listOntologies() {
  return getDb().query(
    "SELECT * FROM ontologies ORDER BY project_id, COALESCE(sort_order, 999999) ASC, created_at ASC",
  );
}

export async function getOntology(id) {
  return getDb().queryOne("SELECT * FROM ontologies WHERE id = ?", [id]);
}

export async function listOntologiesForProject(projectId) {
  return getDb().query(
    "SELECT * FROM ontologies WHERE project_id = ? ORDER BY COALESCE(sort_order, 999999) ASC, created_at ASC",
    [projectId],
  );
}

export async function insertOntologyRecord({ id, name, iri, description, projectId, now, userId }) {
  await getDb().run(
    `INSERT INTO ontologies
       (id, name, iri, description, project_id, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, iri || null, description || null, projectId, now, userId, now, userId],
  );
}

export async function updateOntologyRecord(id, { name, iri, description, now, userId }) {
  await getDb().run(
    `UPDATE ontologies SET
       name        = COALESCE(?, name),
       iri         = COALESCE(?, iri),
       description = COALESCE(?, description),
       updated_at  = COALESCE(?, updated_at),
       updated_by  = ?
     WHERE id = ?`,
    [name ?? null, iri ?? null, description ?? null, now ?? null, userId, id],
  );
}

export async function deleteOntologyRecord(id) {
  await getDb().run("DELETE FROM ontologies WHERE id = ?", [id]);
}

export async function updateOntologyGitHubSync(id, { githubPath, githubSha, now }) {
  await getDb().run(
    "UPDATE ontologies SET github_path = ?, github_sha = ?, updated_at = ? WHERE id = ?",
    [githubPath, githubSha, now, id],
  );
}

export async function updateOntologyPrUrl(id, prUrl) {
  await getDb().run("UPDATE ontologies SET github_pr_url = ? WHERE id = ?", [prUrl || null, id]);
}

// Set branch lineage + GitHub branch name in one shot after a GitHub-backed branch is created.
export async function setOntologyBranchLineage(
  id,
  { branchOf, branchedAt, branchedFromVersion, githubPath, githubBranchName },
) {
  await getDb().run(
    `UPDATE ontologies
       SET branch_of = ?, branched_at = ?, branched_from_version = ?,
           github_path = ?, github_branch_name = ?
     WHERE id = ?`,
    [branchOf, branchedAt, branchedFromVersion, githubPath || null, githubBranchName || null, id],
  );
}

export async function setOntologyImported(id, isImported) {
  await getDb().run("UPDATE ontologies SET is_imported = ? WHERE id = ?", [isImported ? 1 : 0, id]);
}

// Persist a user-defined sort order for root ontologies within a project.
// orderedIds contains ALL root-level ontology IDs for the project, in the
// desired display order.  Branches are untouched — they always render under
// their parent regardless of sort_order.
export async function reorderOntologiesForProject(projectId, orderedIds) {
  if (!Array.isArray(orderedIds) || orderedIds.length > 500)
    throw new Error("orderedIds exceeds maximum length");
  const db = getDb();
  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx.run("UPDATE ontologies SET sort_order = ? WHERE id = ? AND project_id = ?", [
        i,
        orderedIds[i],
        projectId,
      ]);
    }
  });
}

export async function getFirstEditableProject(userId) {
  return getDb().queryOne(
    `SELECT p.id FROM projects p
     JOIN project_members m ON m.project_id = p.id
     WHERE m.user_id = ? AND m.role IN ('manager','editor')
     ORDER BY p.created_at ASC
     LIMIT 1`,
    [userId],
  );
}

// ── Projects ──────────────────────────────────────────────────────────────

export async function listProjects() {
  return getDb().query("SELECT * FROM projects ORDER BY created_at ASC");
}

export async function getProject(id) {
  return getDb().queryOne("SELECT * FROM projects WHERE id = ?", [id]);
}

export async function insertProjectRecord({ id, name, description, now, userId }) {
  await getDb().run(
    `INSERT INTO projects
       (id, name, description, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, name, description || null, now, userId, now, userId],
  );
}

export async function updateProjectRecord(id, { name, description, now, userId }) {
  await getDb().run(
    `UPDATE projects SET
       name        = COALESCE(?, name),
       description = COALESCE(?, description),
       updated_at  = ?,
       updated_by  = ?
     WHERE id = ?`,
    [name ?? null, description ?? null, now, userId, id],
  );
}

export async function updateProjectGitHub(id, { githubRepo, githubBranch, now, userId }) {
  await getDb().run(
    `UPDATE projects SET github_repo = ?, github_branch = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
    [githubRepo ?? null, githubBranch ?? null, now, userId, id],
  );
}

export async function deleteProjectWithOntologies(projectId, ontologyIds) {
  const db = getDb();
  await db.transaction(async (tx) => {
    for (const id of ontologyIds) {
      await tx.run("DELETE FROM ontologies WHERE id = ?", [id]);
    }
    await tx.run("DELETE FROM project_members WHERE project_id = ?", [projectId]);
    await tx.run("DELETE FROM projects WHERE id = ?", [projectId]);
  });
}

export async function listProjectsWithOntologies() {
  const [projects, onts] = await Promise.all([listProjects(), listOntologies()]);
  const byProject = new Map();
  for (const o of onts) {
    if (!o.project_id) continue;
    if (!byProject.has(o.project_id)) byProject.set(o.project_id, []);
    byProject.get(o.project_id).push(o);
  }
  return projects.map((p) => ({ ...p, ontologies: byProject.get(p.id) || [] }));
}

// ── Project membership ────────────────────────────────────────────────────

// Project-level roles: manager (3) > editor (2) > viewer (1)
const ROLE_RANK = { manager: 3, editor: 2, viewer: 1 };

export async function getProjectRoleFor(userId, projectId, globalRole) {
  if (!userId || !projectId) return null;
  // Global admins are always project managers.
  if (globalRole === "admin") return "manager";
  const row = await getDb().queryOne(
    "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
    [projectId, userId],
  );
  return row?.role || null;
}

export function projectRoleMeets(role, required) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[required] || 0);
}

export async function listProjectIdsForUser(userId) {
  const rows = await getDb().query("SELECT project_id FROM project_members WHERE user_id = ?", [
    userId,
  ]);
  return rows.map((r) => r.project_id);
}

export async function listProjectsWithOntologiesForUser(userId) {
  const projects = await listProjectsWithOntologies();
  const ids = new Set(await listProjectIdsForUser(userId));
  return projects.filter((p) => ids.has(p.id));
}

export async function addProjectMember(projectId, userId, role = "viewer") {
  if (!projectId || !userId) return;
  await getDb().run(
    `INSERT INTO project_members (project_id, user_id, role, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`,
    [projectId, userId, role, Date.now()],
  );
}

export async function removeProjectMember(projectId, userId) {
  if (!projectId || !userId) return;
  await getDb().run("DELETE FROM project_members WHERE project_id = ? AND user_id = ?", [
    projectId,
    userId,
  ]);
}

export async function removeAllMembershipsForUser(userId) {
  if (!userId) return;
  await getDb().run("DELETE FROM project_members WHERE user_id = ?", [userId]);
}

// ── Invites ───────────────────────────────────────────────────────────────

export async function insertInviteRecord({
  token,
  email,
  invitedBy,
  role,
  projectId = null,
  projectRole = null,
  now,
  expires,
}) {
  await getDb().run(
    `INSERT INTO invites
       (token, email, invited_by, role, project_id, project_role, created_at, expires_at, email_sent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [token, email, invitedBy, role, projectId, projectRole, now, expires],
  );
}

export async function updateInviteEmailStatus(token, sent, error) {
  await getDb().run("UPDATE invites SET email_sent = ?, email_error = ? WHERE token = ?", [
    sent ? 1 : 0,
    sent ? null : error || "unknown",
    token,
  ]);
}

export async function getInviteByToken(token) {
  return getDb().queryOne("SELECT * FROM invites WHERE token = ?", [token]);
}

export async function getInvitesList() {
  return getDb().query(
    `SELECT i.token, i.email, i.role, i.created_at, i.expires_at,
            i.accepted_at, i.accepted_by, i.email_sent, i.email_error,
            u.username AS invited_by_username
     FROM invites i LEFT JOIN users u ON u.id = i.invited_by
     ORDER BY i.created_at DESC LIMIT 200`,
  );
}

export async function getInvitesForProject(projectId) {
  return getDb().query(
    `SELECT i.token, i.email, i.role, i.project_id, i.project_role,
            i.created_at, i.expires_at, i.accepted_at, i.accepted_by,
            i.email_sent, i.email_error, u.username AS invited_by_username
     FROM invites i LEFT JOIN users u ON u.id = i.invited_by
     WHERE i.project_id = ?
     ORDER BY i.created_at DESC LIMIT 200`,
    [projectId],
  );
}

export async function deleteInviteRecord(token) {
  await getDb().run("DELETE FROM invites WHERE token = ?", [token]);
}

export async function acceptInviteRecord(token, userId, now) {
  await getDb().run("UPDATE invites SET accepted_at = ?, accepted_by = ? WHERE token = ?", [
    now,
    userId,
    token,
  ]);
}

// ── Comments ──────────────────────────────────────────────────────────────

const COMMENT_SELECT = `
  SELECT c.id, c.ontology_id, c.target_iri, c.parent_id, c.user_id,
         u.username, c.body, c.resolved, c.created_at, c.updated_at
  FROM comments c LEFT JOIN users u ON u.id = c.user_id`;

export async function getCommentsList({ ontologyIds, iri }) {
  if (!ontologyIds?.length) return [];
  const db = getDb();
  const placeholders = ontologyIds.map(() => "?").join(", ");
  const params = [...ontologyIds];
  let where = `c.ontology_id IN (${placeholders})`;
  if (iri === "" || iri === null) {
    where += " AND c.target_iri IS NULL";
  } else if (iri !== undefined) {
    where += " AND c.target_iri = ?";
    params.push(iri);
  }
  return db.query(`${COMMENT_SELECT} WHERE ${where} ORDER BY c.id ASC`, params);
}

export async function getCommentTargetsList(ontologyIds) {
  if (!ontologyIds?.length) return [];
  const placeholders = ontologyIds.map(() => "?").join(", ");
  return getDb().query(
    `SELECT target_iri AS iri,
            COUNT(*) AS total,
            SUM(CASE WHEN resolved = 0 THEN 1 ELSE 0 END) AS open
     FROM comments
     WHERE ontology_id IN (${placeholders})
     GROUP BY target_iri`,
    ontologyIds,
  );
}

export async function getParentComment(parentId) {
  return getDb().queryOne("SELECT target_iri, ontology_id FROM comments WHERE id = ?", [parentId]);
}

export async function insertCommentRecord({
  ontologyId,
  targetIri,
  parentId,
  userId,
  body,
  now,
  githubDiscussionId,
  githubCommentId,
  githubSyncedAt,
}) {
  const db = getDb();
  const row = await db.queryOne(
    `INSERT INTO comments
       (ontology_id, target_iri, parent_id, user_id, body, resolved, created_at, updated_at,
        github_discussion_id, github_comment_id, github_synced_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
     RETURNING id`,
    [
      ontologyId,
      targetIri,
      parentId,
      userId,
      body,
      now || Date.now(),
      now || Date.now(),
      githubDiscussionId || null,
      githubCommentId || null,
      githubSyncedAt || null,
    ],
  );
  return db.queryOne(`${COMMENT_SELECT} WHERE c.id = ?`, [row.id]);
}

export async function getCommentWithUser(id) {
  return getDb().queryOne(`${COMMENT_SELECT} WHERE c.id = ?`, [id]);
}

export async function getRawComment(id) {
  return getDb().queryOne("SELECT * FROM comments WHERE id = ?", [id]);
}

export async function updateCommentRecord(
  id,
  { body, resolved, now, githubDiscussionId, githubCommentId, githubSyncedAt },
) {
  const db = getDb();
  const sets = [];
  const params = [];
  if (body !== undefined) {
    sets.push("body = ?");
    params.push(body);
  }
  if (resolved !== undefined) {
    sets.push("resolved = ?");
    params.push(resolved ? 1 : 0);
  }
  if (githubDiscussionId !== undefined) {
    sets.push("github_discussion_id = ?");
    params.push(githubDiscussionId);
  }
  if (githubCommentId !== undefined) {
    sets.push("github_comment_id = ?");
    params.push(githubCommentId);
  }
  if (githubSyncedAt !== undefined) {
    sets.push("github_synced_at = ?");
    params.push(githubSyncedAt);
  }
  sets.push("updated_at = ?");
  params.push(now || Date.now());
  params.push(id);
  await db.run(`UPDATE comments SET ${sets.join(", ")} WHERE id = ?`, params);
  return getCommentWithUser(id);
}

export async function deleteCommentRecord(id) {
  await getDb().run("DELETE FROM comments WHERE id = ? OR parent_id = ?", [id, id]);
}
