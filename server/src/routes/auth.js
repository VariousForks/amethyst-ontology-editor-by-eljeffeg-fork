import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { Router } from "express";
import { OAuth2Client } from "google-auth-library";
import { v4 as uuid } from "uuid";
import { requireAuth } from "../middleware/auth.js";
import {
  acceptInviteRecord,
  addProjectMember,
  clearGitHubConnection,
  createOAuthUser,
  createUserRecord,
  getBoolSetting,
  getInviteByToken,
  getTotalUserCount,
  getUserByEmail,
  getUserByGoogleId,
  getUserById,
  getUserByUsername,
  getUserGitHubToken,
  getUserPasswordRecord,
  linkGoogleIdToUser,
  listProjects,
  listUsers,
  logChange,
  updateGitHubConnection,
  updateUserEmail,
  updateUserPassword,
} from "../services/authDb.js";
import { exchangeCodeForToken, GitHubError, getGitHubUser } from "../services/githubService.js";
import { createPizzaExampleProject } from "../services/seedPizza.js";

const router = Router();

function isGoogleConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function isGitHubConfigured() {
  return !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

function getGitHubCallbackUrl(req) {
  return (
    process.env.GITHUB_CALLBACK_URL ||
    `${req.protocol}://${req.get("host")}/api/auth/github/callback`
  );
}

const GITHUB_SCOPE_PRESETS = {
  sync: "read:user read:discussion",
  push: "read:user repo write:discussion",
  discussions: "read:user read:discussion write:discussion",
};
const GITHUB_DEFAULT_SCOPE = GITHUB_SCOPE_PRESETS.sync;

function getGoogleClient(req) {
  const callbackUrl =
    process.env.GOOGLE_CALLBACK_URL ||
    `${req.protocol}://${req.get("host")}/api/auth/google/callback`;
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    callbackUrl,
  );
}

// Derive a unique username from a Google display name / email prefix.
async function makeUniqueUsername(base) {
  const slug =
    (base || "user")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24) || "user";
  let candidate = slug;
  let i = 2;
  while (await getUserByUsername(candidate)) {
    candidate = `${slug}_${i++}`;
  }
  return candidate;
}

// GET /api/auth/status
// Also refreshes the session user's role from the DB so stale roles (e.g.
// after a server-side role migration) never persist across restarts.
router.get("/status", async (req, res) => {
  const count = await getTotalUserCount();
  const registrationDisabled = await getBoolSetting("registration_disabled", false);

  let sessionUser = req.session?.user || null;
  if (sessionUser?.id) {
    // Re-read role (and email) from DB in case they changed since last login.
    const fresh = await getUserById(sessionUser.id);
    if (fresh) {
      const updated = {
        ...sessionUser,
        role: fresh.role,
        email: fresh.email,
        auth_provider: fresh.oauth_provider || sessionUser.auth_provider || null,
      };
      // Only save session if something actually changed (avoids unnecessary writes).
      if (
        updated.role !== sessionUser.role ||
        updated.email !== sessionUser.email ||
        updated.auth_provider !== sessionUser.auth_provider
      ) {
        req.session.user = updated;
        await new Promise((resolve) => req.session.save(() => resolve()));
      }
      sessionUser = updated;
    } else {
      // User was deleted — clear session.
      req.session.destroy(() => {});
      sessionUser = null;
    }
  }

  // Include the current user's GitHub connection status in the response.
  let githubConnection = null;
  if (sessionUser?.id) {
    const conn = await getUserGitHubToken(sessionUser.id);
    if (conn) githubConnection = { login: conn.login, scope: conn.scope };
  }

  res.json({
    hasUsers: count > 0,
    registrationDisabled: registrationDisabled && count > 0,
    user: sessionUser,
    googleEnabled: isGoogleConfigured(),
    githubEnabled: true, // PAT connection always available; OAuth additionally when env vars set
    githubOAuthEnabled: isGitHubConfigured(),
    githubConnection,
  });
});

router.post("/register", async (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: "username and password are required" });
  if (password.length < 6)
    return res.status(400).json({ error: "password must be at least 6 characters" });

  if (await getUserByUsername(username)) return res.status(409).json({ error: "username taken" });

  const userCount = await getTotalUserCount();
  if (userCount > 0 && (await getBoolSetting("registration_disabled", false)))
    return res.status(403).json({ error: "registration is disabled" });

  const role = userCount === 0 ? "admin" : "user";
  const id = uuid();
  const hash = await bcrypt.hash(password, 10);
  await createUserRecord({
    id,
    username,
    email: email || null,
    hash,
    role,
    now: Date.now(),
  });
  await createPizzaExampleProject(id);
  req.session.user = { id, username, email: email || null, role };
  // Explicitly persist the session before responding so the cookie is
  // immediately readable on the very next request (status check).
  await new Promise((resolve, reject) =>
    req.session.save((err) => (err ? reject(err) : resolve())),
  );
  await logChange(id, null, "register", { username });
  res.json({ user: req.session.user });
});

router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "missing credentials" });

  const row = await getUserByUsername(username);
  if (!row) return res.status(401).json({ error: "invalid credentials" });

  if (row.password === "OAUTH_ONLY") {
    return res.status(401).json({
      error:
        "This account uses OAuth sign-in (Google or GitHub). Please use the appropriate sign-in button.",
    });
  }

  const ok = await bcrypt.compare(password, row.password);
  if (!ok) return res.status(401).json({ error: "invalid credentials" });

  req.session.user = {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
  };
  // Explicitly persist the session before responding so the cookie is
  // immediately readable on the very next request (status check).
  await new Promise((resolve, reject) =>
    req.session.save((err) => (err ? reject(err) : resolve())),
  );
  await logChange(row.id, null, "login", {});
  res.json({ user: req.session.user });
});

router.post("/logout", requireAuth, (req, res) => {
  const uid = req.session.user.id;
  req.session.destroy(async () => {
    await logChange(uid, null, "logout", {});
    res.json({ ok: true });
  });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

router.get("/users", requireAuth, async (_req, res) => {
  res.json({ users: await listUsers() });
});

router.patch("/email", requireAuth, async (req, res) => {
  const { email } = req.body || {};
  const normalized = (email || "").trim() || null;
  if (normalized && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
    return res.status(400).json({ error: "invalid email" });
  const uid = req.session.user.id;
  await updateUserEmail(uid, normalized);
  req.session.user = { ...req.session.user, email: normalized };
  await logChange(uid, null, "update-email", {});
  res.json({ user: req.session.user });
});

router.patch("/password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: "currentPassword and newPassword are required" });
  if (newPassword.length < 6)
    return res.status(400).json({ error: "password must be at least 6 characters" });

  const row = await getUserPasswordRecord(req.session.user.id);
  if (!row) return res.status(404).json({ error: "user not found" });
  if (row.password === "OAUTH_ONLY")
    return res.status(400).json({ error: "OAuth accounts cannot set a password this way." });

  const ok = await bcrypt.compare(currentPassword, row.password);
  if (!ok) return res.status(401).json({ error: "current password is incorrect" });

  const hash = await bcrypt.hash(newPassword, 10);
  await updateUserPassword(row.id, hash);
  await logChange(row.id, null, "update-password", {});
  res.json({ ok: true });
});

// GET /api/auth/google — redirect to Google's OAuth consent screen.
// Optional ?invite=TOKEN: if present the token is stored in the session so
// the callback can accept the invite once Google auth completes.
router.get("/google", (req, res) => {
  if (!isGoogleConfigured())
    return res.status(503).json({ error: "Google OAuth is not configured on this server." });
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  // Persist the invite token so the callback can redeem it after OAuth.
  if (req.query.invite) req.session.pendingInviteToken = String(req.query.invite);
  const authUrl = getGoogleClient(req).generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    state,
  });
  res.redirect(authUrl);
});

// GET /api/auth/google/callback
router.get("/google/callback", async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  if (oauthError) return res.redirect(`/login?error=${encodeURIComponent(String(oauthError))}`);
  if (!state || !req.session.oauthState || state !== req.session.oauthState)
    return res.redirect("/login?error=invalid_state");
  delete req.session.oauthState;

  // Grab (and immediately clear) any pending invite token stored by GET /google.
  const pendingToken = req.session.pendingInviteToken || null;
  delete req.session.pendingInviteToken;

  try {
    const client = getGoogleClient(req);
    const { tokens } = await client.getToken(String(code));
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email = payload.email || null;
    const displayName = payload.name || payload.given_name || null;

    // Load and validate the invite (if the flow was started from an invite link).
    let invite = null;
    if (pendingToken) {
      const row = await getInviteByToken(pendingToken);
      if (row && !row.accepted_at && row.expires_at >= Date.now()) {
        invite = row;
      }
    }

    // 1. Find by Google ID.
    let row = await getUserByGoogleId(googleId);

    // 2. Merge with existing email-matched account.
    if (!row && email) {
      row = await getUserByEmail(email);
      if (row) await linkGoogleIdToUser(row.id, googleId);
    }

    // 3. Register a new account if needed.
    if (!row) {
      const userCount = await getTotalUserCount();
      // A valid invite bypasses the registration_disabled setting.
      if (userCount > 0 && !invite && (await getBoolSetting("registration_disabled", false)))
        return res.redirect("/login?error=registration_disabled");

      // Use the invite's server role; otherwise fall back to default.
      const role = invite ? invite.role : userCount === 0 ? "admin" : "user";
      const id = uuid();
      const nameBase = displayName || (email ? email.split("@")[0] : null) || "user";
      const username = await makeUniqueUsername(nameBase);
      await createOAuthUser({
        id,
        username,
        email,
        role,
        now: Date.now(),
        googleId,
        oauthProvider: "google",
      });
      await logChange(id, null, "register", { username, provider: "google" });
      if (!invite) await createPizzaExampleProject(id);
      row = { id, username, email, role };
    }

    // 4. Accept the invite and grant project memberships.
    if (invite) {
      await acceptInviteRecord(pendingToken, row.id, Date.now());
      if (invite.project_id) {
        // Project-scoped invite: add to that specific project
        await addProjectMember(invite.project_id, row.id, invite.project_role || "viewer");
      } else {
        // Legacy global invite: add to all projects as viewer (in parallel)
        await Promise.all(
          (await listProjects()).map((p) => addProjectMember(p.id, row.id, "viewer")),
        );
      }
      await logChange(row.id, null, "accept-invite", {
        email: invite.email,
        role: invite.role,
        projectId: invite.project_id || null,
        projectRole: invite.project_role || null,
        provider: "google",
      });
    }

    req.session.user = {
      id: row.id,
      username: row.username,
      email: row.email,
      role: row.role,
      auth_provider: "google",
    };
    // Explicitly persist the session before redirecting.
    await new Promise((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve())),
    );
    await logChange(row.id, null, "oauth-login", { provider: "google" });
    res.redirect("/");
  } catch (err) {
    console.error("[oauth] Google callback error:", err);
    res.redirect("/login?error=oauth_failed");
  }
});

// ── GitHub OAuth connection (not a login method — requires existing session) ──

// GET /api/auth/github/connect?scope=sync|push|discussions&returnTo=/path
// Redirects the already-logged-in user to GitHub's authorization screen.
router.get("/github/connect", requireAuth, (req, res) => {
  if (!isGitHubConfigured())
    return res.status(503).json({ error: "GitHub OAuth is not configured on this server." });

  const scopeKey = req.query.scope;
  const scope = GITHUB_SCOPE_PRESETS[scopeKey] || GITHUB_DEFAULT_SCOPE;
  const state = crypto.randomBytes(16).toString("hex");
  req.session.githubOauthState = state;
  req.session.githubReturnTo = req.query.returnTo
    ? String(req.query.returnTo).replace(/[^a-zA-Z0-9/_#?=-]/g, "")
    : "/settings#github";

  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: getGitHubCallbackUrl(req),
    scope,
    state,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// GET /api/auth/github/callback
// Exchange the OAuth code for a token and store it on the current user.
router.get("/github/callback", async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError)
    return res.redirect(`/settings#github?error=${encodeURIComponent(String(oauthError))}`);

  if (!state || !req.session.githubOauthState || state !== req.session.githubOauthState)
    return res.redirect("/settings#github?error=invalid_state");

  delete req.session.githubOauthState;
  const returnTo = req.session.githubReturnTo || "/settings#github";
  delete req.session.githubReturnTo;

  // The session must contain a logged-in user — this is a connect flow, not sign-in.
  if (!req.session?.user?.id) return res.redirect("/login");

  try {
    const tokenData = await exchangeCodeForToken(
      String(code),
      process.env.GITHUB_CLIENT_ID,
      process.env.GITHUB_CLIENT_SECRET,
      getGitHubCallbackUrl(req),
    );
    const ghUser = await getGitHubUser(tokenData.access_token);
    // GitHub App tokens include expires_in (seconds) + refresh_token.
    // OAuth App tokens have neither — treat as non-expiring.
    const expiresAt = tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : null;

    await updateGitHubConnection(req.session.user.id, {
      githubId: String(ghUser.id),
      githubLogin: ghUser.login,
      githubToken: tokenData.access_token,
      scope: tokenData.scope || null,
      expiresAt,
      refreshToken: tokenData.refresh_token ?? null,
    });

    await logChange(req.session.user.id, null, "github-connect", {
      login: ghUser.login,
      scope: tokenData.scope,
    });
    res.redirect(returnTo);
  } catch (err) {
    console.error("[oauth] GitHub connect callback error:", err);
    const code = err instanceof GitHubError ? err.status : 500;
    res.redirect(`/settings#github?error=connect_failed&status=${code}`);
  }
});

// POST /api/auth/github/pat — connect via Personal Access Token (no OAuth app required)
router.post("/github/pat", requireAuth, async (req, res) => {
  const { token } = req.body || {};
  if (!token?.trim()) return res.status(400).json({ error: "token is required" });
  try {
    const ghUser = await getGitHubUser(token.trim());
    // Determine scopes by probing the token header (GitHub includes X-OAuth-Scopes on user endpoint).
    // We call the raw REST helper to capture the response headers.
    const scopeRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        "User-Agent": "Amethyst-Ontology-Editor",
      },
    });
    // Fine-grained PATs return an empty X-OAuth-Scopes header; classic tokens
    // list their scopes there. Store "fine-grained" as a sentinel so downstream
    // checks can distinguish it from a classic token with only read:user scope.
    const rawScope = scopeRes.headers.get("x-oauth-scopes");
    const scope = rawScope ? rawScope.trim() : "fine-grained";
    await updateGitHubConnection(req.session.user.id, {
      githubId: String(ghUser.id),
      githubLogin: ghUser.login,
      githubToken: token.trim(),
      scope,
    });
    await logChange(req.session.user.id, null, "github-connect-pat", { login: ghUser.login });
    res.json({ ok: true, login: ghUser.login, scope });
  } catch (err) {
    if (err instanceof GitHubError) {
      if (err.status === 401)
        return res.status(401).json({ error: "Invalid token — check it and try again." });
    }
    console.error("[auth] GitHub PAT connect error:", err.message);
    res.status(500).json({ error: "Failed to verify token." });
  }
});

// DELETE /api/auth/github/connect — remove stored GitHub token
router.delete("/github/connect", requireAuth, async (req, res) => {
  await clearGitHubConnection(req.session.user.id);
  await logChange(req.session.user.id, null, "github-disconnect", {});
  res.json({ ok: true });
});

export default router;
