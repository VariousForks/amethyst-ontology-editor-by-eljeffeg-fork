import { getProjectRoleFor, projectRoleMeets, touchLastActive } from "../services/authDb.js";

// Throttle last-active writes: one DB update per user per minute.
const _lastActiveSent = new Map();
const LAST_ACTIVE_INTERVAL_MS = 60_000;

function maybeUpdateLastActive(userId) {
  if (!userId) return;
  const now = Date.now();
  const last = _lastActiveSent.get(userId) || 0;
  if (now - last < LAST_ACTIVE_INTERVAL_MS) return;
  _lastActiveSent.set(userId, now);
  // Fire-and-forget — don't slow down the request.
  touchLastActive(userId).catch(() => {});
}

// CSRF defense via custom-header check.
export function requireCsrfHeader(req, res, next) {
  const m = (req.method || "GET").toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
  const h = req.get("X-Requested-With");
  if (!h) return res.status(403).json({ error: "CSRF: missing X-Requested-With header" });
  next();
}

export function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: "unauthorized" });
  maybeUpdateLastActive(req.session.user.id);
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: "unauthorized" });
    if (!roles.includes(req.session.user.role)) return res.status(403).json({ error: "forbidden" });
    next();
  };
}

// Gate a route on a minimum per-project role (manager > editor > viewer).
// Must run AFTER resolveOntology/resolveProject so `req.projectId` is set.
// Global admins are always allowed (fast path inside getProjectRoleFor).
// On success, exposes the effective role as `req.projectRole`.
// Express 5 natively catches rejected async middleware — no try/catch needed.
export function requireProjectRole(minRole = "viewer") {
  return async (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: "unauthorized" });
    const uid = req.session.user.id;
    const pid = req.projectId || req.project?.id;
    if (!pid) return res.status(400).json({ error: "project context required" });
    const role = await getProjectRoleFor(uid, pid, req.session.user.role);
    if (!role || !projectRoleMeets(role, minRole))
      return res.status(403).json({ error: "forbidden" });
    req.projectRole = role;
    next();
  };
}
