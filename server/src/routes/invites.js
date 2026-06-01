import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { Router } from "express";
import { v4 as uuid } from "uuid";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  acceptInviteRecord,
  addProjectMember,
  createUserRecord,
  deleteInviteRecord,
  getInviteByToken,
  getInvitesList,
  getUserByEmail,
  getUserByUsername,
  insertInviteRecord,
  listProjects,
  logChange,
  updateInviteEmailStatus,
} from "../services/authDb.js";
import { isMailerConfigured, sendInviteEmail } from "../services/mailer.js";

const router = Router();
const INVITE_EXPIRY_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

// GET /api/invites — list all invites (admin only)
router.get("/", requireAuth, requireRole("admin"), async (_req, res) => {
  const rows = await getInvitesList();
  res.json({ invites: rows, mailerConfigured: isMailerConfigured() });
});

// POST /api/invites — create a global invite (admin only)
// This creates a server-level invite. For project-scoped invites use
// POST /api/projects/:id/invites instead.
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { email: rawEmail, role = "user" } = req.body || {};
  const email = rawEmail ? String(rawEmail).trim() : null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return res.status(400).json({ error: "invalid email" });
  if (!["admin", "user"].includes(role))
    return res.status(400).json({ error: "invalid role: must be admin|user" });

  const token = crypto.randomBytes(24).toString("base64url");
  const now = Date.now();
  const expires = now + INVITE_EXPIRY_MS;
  await insertInviteRecord({
    token,
    email,
    invitedBy: req.session.user.id,
    role,
    now,
    expires,
  });

  const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
  const inviteUrl = `${baseUrl}/invite/${token}`;

  let emailResult = { sent: false, reason: email ? "SMTP not configured" : "no email" };
  if (email && isMailerConfigured()) {
    emailResult = await sendInviteEmail({
      to: email,
      inviteUrl,
      invitedBy: req.session.user.username,
      role,
    });
    await updateInviteEmailStatus(token, emailResult.sent, emailResult.reason);
  }

  await logChange(req.session.user.id, null, "create-invite", {
    email: email || null,
    role,
    emailSent: emailResult.sent,
  });
  res.json({
    invite: {
      token,
      email,
      role,
      inviteUrl,
      created_at: now,
      expires_at: expires,
      email_sent: emailResult.sent,
      email_error: emailResult.sent ? null : emailResult.reason || null,
    },
  });
});

// DELETE /api/invites/:token — revoke an invite (admin only)
router.delete("/:token", requireAuth, requireRole("admin"), async (req, res) => {
  const row = await getInviteByToken(req.params.token);
  if (!row) return res.status(404).json({ error: "not found" });
  await deleteInviteRecord(req.params.token);
  await logChange(req.session.user.id, null, "revoke-invite", {
    email: row.email,
  });
  res.json({ ok: true });
});

// GET /api/invites/:token/info — public, used by the invite accept page
router.get("/:token/info", async (req, res) => {
  const row = await getInviteByToken(req.params.token);
  if (!row) return res.status(404).json({ error: "invite not found" });
  if (row.accepted_at) return res.status(410).json({ error: "invite already accepted" });
  if (row.expires_at < Date.now()) return res.status(410).json({ error: "invite expired" });
  res.json({ invite: row });
});

// POST /api/invites/:token/accept — accept an invite and create account
router.post("/:token/accept", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: "username and password required" });
  if (password.length < 6)
    return res.status(400).json({ error: "password must be at least 6 characters" });

  const invite = await getInviteByToken(req.params.token);
  if (!invite) return res.status(404).json({ error: "invite not found" });
  if (invite.accepted_at) return res.status(410).json({ error: "invite already accepted" });
  if (invite.expires_at < Date.now()) return res.status(410).json({ error: "invite expired" });

  if (await getUserByUsername(username)) return res.status(409).json({ error: "username taken" });
  if (invite.email && (await getUserByEmail(invite.email)))
    return res.status(409).json({ error: "email already registered" });

  const id = uuid();
  const hash = await bcrypt.hash(password, 10);
  // Server role is always from invite.role (either 'user' or 'admin')
  await createUserRecord({
    id,
    username,
    email: invite.email,
    hash,
    role: invite.role,
    now: Date.now(),
    invitedBy: invite.invited_by,
  });
  await acceptInviteRecord(req.params.token, id, Date.now());

  // Grant project membership:
  //   • Project-scoped invite → add to specific project with invite.project_role
  //   • Legacy global invite  → add to all projects as viewer
  if (invite.project_id) {
    await addProjectMember(invite.project_id, id, invite.project_role || "viewer");
  } else {
    for (const p of await listProjects()) {
      await addProjectMember(p.id, id, "viewer");
    }
  }

  req.session.user = { id, username, email: invite.email, role: invite.role };
  await logChange(id, null, "accept-invite", {
    email: invite.email,
    role: invite.role,
    projectId: invite.project_id || null,
    projectRole: invite.project_role || null,
  });
  res.json({ user: req.session.user });
});

export default router;
