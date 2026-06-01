import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import session from "express-session";
import { requireCsrfHeader } from "./middleware/auth.js";
import { timingMiddleware } from "./middleware/timing.js";
import adminRoutes from "./routes/admin.js";
import aiRoutes from "./routes/ai.js";
import authRoutes from "./routes/auth.js";
import commentsRoutes from "./routes/comments.js";
import graphRoutes from "./routes/graph.js";
import importRoutes from "./routes/import.js";
import invitesRoutes from "./routes/invites.js";
import ontologiesRoutes from "./routes/ontologies.js";
import ontologyRoutes from "./routes/ontology.js";
import projectsRoutes from "./routes/projects.js";
import rulesRoutes from "./routes/rules.js";
import sparqlRoutes from "./routes/sparql.js";
import { getDb, initAuthDb, SQLITE_DIR } from "./services/authDb.js";
import { initRdfStore } from "./services/rdfStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  (NODE_ENV === "production"
    ? (() => {
        throw new Error("SESSION_SECRET env var must be set in production");
      })()
    : "dev-only-insecure-secret");

async function main() {
  await initAuthDb();
  await initRdfStore();

  const app = express();

  // Trust the first reverse-proxy hop (Cloud Run, nginx, ALB).
  app.set("trust proxy", 1);

  // ── Session store — SQLite or PostgreSQL ──────────────────────────────
  const db = getDb();
  let sessionStore;
  if (db.dialect === "postgres") {
    // connect-pg-simple auto-creates a "session" table in the PG database.
    const { default: connectPgSimple } = await import("connect-pg-simple");
    const PGStore = connectPgSimple(session);
    sessionStore = new PGStore({ pool: db._pool, createTableIfMissing: true });
    console.log("[session] using PostgreSQL session store");
  } else {
    const { default: connectSqlite3 } = await import("better-sqlite3-session-store");
    const SQLiteStore = connectSqlite3(session);
    const { default: BetterSqlite3 } = await import("better-sqlite3");

    // SQLite session store on local disk. SQLITE_DIR must point at real local
    // storage (not a FUSE mount); use Litestream to replicate to object
    // storage if cross-restart durability is required.
    const sessionsDbPath = path.join(SQLITE_DIR, "sessions.sqlite");
    const sessionDb = new BetterSqlite3(sessionsDbPath);
    sessionDb.pragma("journal_mode = WAL");
    sessionDb.pragma("synchronous = NORMAL");

    sessionStore = new SQLiteStore({ client: sessionDb });
    console.log(`[session] using SQLite session store at ${sessionsDbPath}`);
  }

  // CORS allowlist
  const rawOrigins = (process.env.CORS_ORIGIN || "").trim();
  const allowed = rawOrigins
    ? rawOrigins
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : NODE_ENV === "production"
      ? []
      : ["http://localhost:5173", "http://127.0.0.1:5173"];
  console.log(`[cors] allowlist=${JSON.stringify(allowed)} (same-origin always allowed)`);

  app.use(
    cors((req, cb) => {
      const origin = req.headers.origin;
      const host = req.headers.host;
      if (!origin) return cb(null, { origin: true, credentials: true });
      try {
        if (host && new URL(origin).host === host)
          return cb(null, { origin: true, credentials: true });
      } catch {
        /* malformed Origin */
      }
      if (allowed.includes(origin)) return cb(null, { origin: true, credentials: true });
      return cb(null, { origin: false, credentials: true });
    }),
  );

  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ extended: true, limit: "100mb" }));
  app.use(cookieParser());
  // Determine whether to set the Secure flag on session cookies.
  // Default: true in production (requires HTTPS), false in development.
  // Override with COOKIE_SECURE=false to allow plain-HTTP Docker deployments,
  // or COOKIE_SECURE=true to force Secure cookies behind a TLS proxy in prod.
  const cookieSecure =
    process.env.COOKIE_SECURE !== undefined
      ? process.env.COOKIE_SECURE === "true"
      : NODE_ENV === "production";
  console.log(
    `[session] cookie.secure=${cookieSecure} (NODE_ENV=${NODE_ENV}, COOKIE_SECURE=${process.env.COOKIE_SECURE ?? "unset"})`,
  );

  app.use(
    session({
      store: sessionStore,
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: cookieSecure,
        maxAge: 1000 * 60 * 60 * 24 * 7,
      },
    }),
  );

  // Timing must come first so it covers all API routes.
  app.use("/api", timingMiddleware);
  app.get("/api/health", (_req, res) => res.json({ ok: true, env: NODE_ENV }));
  app.use("/api", requireCsrfHeader);

  app.use("/api/auth", authRoutes);
  app.use("/api/projects", projectsRoutes);
  app.use("/api/ontologies", ontologiesRoutes);
  app.use("/api/ontology", ontologyRoutes);
  app.use("/api/sparql", sparqlRoutes);
  app.use("/api/import", importRoutes);
  app.use("/api/graph", graphRoutes);
  app.use("/api/invites", invitesRoutes);
  app.use("/api/comments", commentsRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/rules", rulesRoutes);
  app.use("/api/ai", aiRoutes);

  const clientDist = path.resolve(__dirname, "..", "..", "client", "dist");
  app.use(express.static(clientDist));
  app.get(/.*/, (req, res) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "not found" });
    res.sendFile(path.join(clientDist, "index.html"), (err) => {
      if (err)
        res
          .status(404)
          .send("Client not built. Run `npm run build` or use dev server on port 5173.");
    });
  });

  app.listen(PORT, () => {
    console.log(`[ontology-editor] listening on :${PORT} (${NODE_ENV})`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
