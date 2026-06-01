import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import { Router } from "express";
import { v4 as uuid } from "uuid";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  createUserRecord,
  DATA_DIR,
  deleteUserRecord,
  getAuditLog,
  getBoolSetting,
  getDb,
  getSystemCounts,
  getUserByEmail,
  getUserById,
  getUserByUsername,
  getUserCountForRole,
  listProjectsWithOntologies,
  listUsers,
  logChange,
  removeAllMembershipsForUser,
  SQLITE_DIR,
  setBoolSetting,
  updateUserRole,
  vacuumDb,
} from "../services/authDb.js";
import { isMailerConfigured } from "../services/mailer.js";

const router = Router();
router.use(requireAuth, requireRole("admin"));

router.get("/system", async (_req, res) => {
  const counts = await getSystemCounts();
  const mem = process.memoryUsage();
  res.json({
    server: {
      node: process.version,
      env: process.env.NODE_ENV || "development",
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
      platform: `${process.platform} ${process.arch}`,
      hostname: os.hostname(),
      load_avg: os.loadavg().map((n) => +n.toFixed(2)),
      memory_rss_mb: +(mem.rss / 1024 / 1024).toFixed(1),
      memory_heap_mb: +(mem.heapUsed / 1024 / 1024).toFixed(1),
    },
    storage: {
      data_dir: DATA_DIR,
      sqlite_dir: SQLITE_DIR,
      data_dir_bytes: null,
    },
    mail: {
      configured: isMailerConfigured(),
      host: process.env.SMTP_HOST || null,
      port: process.env.SMTP_PORT ? +process.env.SMTP_PORT : null,
      from: process.env.SMTP_FROM || null,
    },
    counts,
  });
});

router.get("/system/storage", async (_req, res) => {
  let dataDirBytes = 0;
  const walk = async (dir) => {
    try {
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(p);
        else {
          try {
            dataDirBytes += (await fs.promises.stat(p)).size;
          } catch {
            /* ignore inaccessible files */
          }
        }
      }
    } catch {
      /* tolerate permission issues */
    }
  };
  const exists = (p) =>
    fs.promises
      .access(p)
      .then(() => true)
      .catch(() => false);
  if (await exists(DATA_DIR)) await walk(DATA_DIR);
  if (SQLITE_DIR !== DATA_DIR && (await exists(SQLITE_DIR))) await walk(SQLITE_DIR);
  res.json({ data_dir_bytes: dataDirBytes });
});

router.get("/changes", async (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const rows = await getAuditLog({
    userId: req.query.user || undefined,
    ontologyId: req.query.ontology || undefined,
    action: req.query.action || undefined,
    limit,
  });
  res.json({ changes: rows });
});

router.get("/settings", async (_req, res) => {
  res.json({
    settings: {
      registrationDisabled: await getBoolSetting("registration_disabled", false),
    },
  });
});

router.patch("/settings", async (req, res) => {
  const body = req.body || {};
  const updated = {};
  if (typeof body.registrationDisabled === "boolean") {
    await setBoolSetting("registration_disabled", body.registrationDisabled);
    updated.registrationDisabled = body.registrationDisabled;
  }
  if (!Object.keys(updated).length)
    return res.status(400).json({ error: "no supported settings in request" });
  await logChange(req.session.user.id, null, "admin-settings-update", updated);
  res.json({
    ok: true,
    settings: {
      registrationDisabled: await getBoolSetting("registration_disabled", false),
    },
  });
});

router.get("/users", async (_req, res) => {
  res.json({ users: await listUsers() });
});

router.get("/projects", async (_req, res) => {
  const projects = await listProjectsWithOntologies();
  const [memberCounts, creators] = await Promise.all([
    getDb().query("SELECT project_id, COUNT(*) AS n FROM project_members GROUP BY project_id"),
    getDb().query(
      `SELECT p.id AS project_id, u.username
       FROM projects p LEFT JOIN users u ON u.id = p.created_by`,
    ),
  ]);
  const memberByPid = new Map(memberCounts.map((r) => [r.project_id, Number(r.n)]));
  const creatorByPid = new Map(creators.map((r) => [r.project_id, r.username]));
  res.json({
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      created_at: p.created_at,
      created_by: p.created_by,
      created_by_username: creatorByPid.get(p.id) || null,
      ontology_count: (p.ontologies || []).length,
      member_count: memberByPid.get(p.id) || 0,
    })),
  });
});

router.post("/users", async (req, res) => {
  const { username, password, email, role } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: "username and password are required" });
  if (password.length < 6)
    return res.status(400).json({ error: "password must be at least 6 characters" });
  const normalizedEmail = (email || "").trim() || null;
  if (normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail))
    return res.status(400).json({ error: "invalid email" });
  const effectiveRole = role || "user";
  if (!["admin", "user"].includes(effectiveRole))
    return res.status(400).json({ error: "role must be admin|user" });

  if (await getUserByUsername(username)) return res.status(409).json({ error: "username taken" });
  if (normalizedEmail && (await getUserByEmail(normalizedEmail)))
    return res.status(409).json({ error: "email already in use" });

  const id = uuid();
  const hash = await bcrypt.hash(password, 10);
  await createUserRecord({
    id,
    username,
    email: normalizedEmail,
    hash,
    role: effectiveRole,
    now: Date.now(),
    invitedBy: req.session.user.id,
  });
  await logChange(req.session.user.id, null, "admin-user-create", {
    target: id,
    username,
    role: effectiveRole,
  });
  res.json({
    ok: true,
    user: {
      id,
      username,
      email: normalizedEmail,
      role: effectiveRole,
      created_at: Date.now(),
    },
  });
});

router.patch("/users/:id", async (req, res) => {
  const { id } = req.params;
  const { role } = req.body || {};
  if (!role) return res.status(400).json({ error: "role required" });
  if (!["admin", "user"].includes(role))
    return res.status(400).json({ error: "role must be admin|user" });

  const t = await getUserById(id);
  if (!t) return res.status(404).json({ error: "not found" });

  if (t.role === "admin" && role !== "admin" && (await getUserCountForRole("admin")) <= 1)
    return res.status(400).json({ error: "cannot demote the last admin" });

  await updateUserRole(id, role);
  await logChange(req.session.user.id, null, "admin-role-change", {
    target: id,
    username: t.username,
    from: t.role,
    to: role,
  });
  res.json({ ok: true, user: { id, role } });
});

router.delete("/users/:id", async (req, res) => {
  const { id } = req.params;
  if (id === req.session.user.id) return res.status(400).json({ error: "cannot delete yourself" });
  const t = await getUserById(id);
  if (!t) return res.status(404).json({ error: "not found" });
  if (t.role === "admin" && (await getUserCountForRole("admin")) <= 1)
    return res.status(400).json({ error: "cannot delete the last admin" });
  await removeAllMembershipsForUser(id);
  await deleteUserRecord(id);
  await logChange(req.session.user.id, null, "admin-user-delete", {
    target: id,
    username: t.username,
  });
  res.json({ ok: true });
});

router.post("/maintenance/vacuum", async (req, res) => {
  try {
    await vacuumDb();
    await logChange(req.session.user.id, null, "admin-vacuum", {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
