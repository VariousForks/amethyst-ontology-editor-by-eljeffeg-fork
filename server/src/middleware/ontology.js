import {
  getOntology,
  getProject,
  listOntologies,
  listOntologiesForProject,
  listProjects,
} from "../services/authDb.js";

// ── In-process DB record cache ───────────────────────────────────────────────
//
// resolveOntology runs on every API request and issues 2-4 sequential DB
// queries. On a local SQLite instance those are microsecond-fast, but on
// PostgreSQL in the cloud each query is a network round-trip (5-20 ms each).
// Projects and ontologies change very rarely, so caching them for a short
// window eliminates the majority of that overhead with no observable staleness
// for normal usage.
//
// TTL is intentionally short (30 s) so edits made in another tab / another
// server instance become visible quickly. Callers that mutate project or
// ontology records should call the corresponding invalidation helpers below.
//
// The cache stores `null` as a valid value (record genuinely not found) so we
// don't hammer the DB for lookups of non-existent IDs.

const DB_CACHE_TTL_MS = parseInt(process.env.DB_CACHE_TTL_MS || "30000", 10);

const _projects = new Map(); // id -> { row, expiresAt }
const _ontologies = new Map(); // id -> { row, expiresAt }
const _projectOntologies = new Map(); // projectId -> { rows, expiresAt }

function _fresh(entry) {
  return entry && Date.now() < entry.expiresAt;
}

async function _cachedGetProject(id) {
  const e = _projects.get(id);
  if (_fresh(e)) return e.row;
  const row = await getProject(id);
  _projects.set(id, {
    row: row ?? null,
    expiresAt: Date.now() + DB_CACHE_TTL_MS,
  });
  return row ?? null;
}

async function _cachedGetOntology(id) {
  const e = _ontologies.get(id);
  if (_fresh(e)) return e.row;
  const row = await getOntology(id);
  _ontologies.set(id, {
    row: row ?? null,
    expiresAt: Date.now() + DB_CACHE_TTL_MS,
  });
  return row ?? null;
}

async function _cachedListOntologiesForProject(projectId) {
  const e = _projectOntologies.get(projectId);
  if (_fresh(e)) return e.rows;
  const rows = await listOntologiesForProject(projectId);
  _projectOntologies.set(projectId, {
    rows,
    expiresAt: Date.now() + DB_CACHE_TTL_MS,
  });
  return rows;
}

/**
 * Invalidate cached DB records for a project and/or ontology.
 * Call this from any route that creates, updates, or deletes a project or
 * ontology so the next request sees the fresh record.
 */
export function invalidateDbCache({ projectId, ontologyId } = {}) {
  if (projectId) {
    _projects.delete(projectId);
    _projectOntologies.delete(projectId);
  }
  if (ontologyId) {
    _ontologies.delete(ontologyId);
  }
}

// ── Middleware ───────────────────────────────────────────────────────────────

// Coerce a query/param value to a single string (guards against array injection
// where ?ontology=a&ontology=b would produce an array in Express).
function toSingleString(v) {
  if (v == null) return null;
  const s = Array.isArray(v) ? String(v[0] ?? "") : String(v);
  return s || null;
}

export async function resolveOntology(req, res, next) {
  const rawOnto = toSingleString(
    req.params?.ontology ??
      req.query?.ontology ??
      req.headers["x-ontology-id"] ??
      req.body?.ontology,
  );
  const rawProj = toSingleString(
    req.params?.project ?? req.query?.project ?? req.headers["x-project-id"] ?? req.body?.project,
  );

  let project = null;
  if (rawProj) {
    project = await _cachedGetProject(rawProj);
    if (!project) return res.status(404).json({ error: "project not found" });
  }

  const wantAll = rawOnto === "all" || rawOnto === "*";

  if (rawOnto && !wantAll && rawOnto.includes(",")) {
    const ids = rawOnto
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const resolved = (await Promise.all(ids.map((id) => _cachedGetOntology(id)))).filter(Boolean);
    if (!resolved.length) return res.status(404).json({ error: "no valid ontologies found" });
    if (!project && resolved[0]?.project_id)
      project = await _cachedGetProject(resolved[0].project_id);
    const siblings = project ? await _cachedListOntologiesForProject(project.id) : resolved;
    req.project = project || null;
    req.projectId = project?.id || null;
    req.ontologies = siblings;
    req.ontologyIds = resolved.map((o) => o.id);
    req.ontologyId = null;
    req.ontology = null;
    req.scope = { mode: "union", ontologyIds: req.ontologyIds };
    req.ontologyScope = req.ontologyIds;
    return next();
  }

  if (rawOnto && !wantAll) {
    const onto = await _cachedGetOntology(rawOnto);
    if (!onto) return res.status(404).json({ error: "ontology not found" });
    if (project && onto.project_id !== project.id)
      return res.status(400).json({ error: "ontology does not belong to the given project" });
    if (!project && onto.project_id) project = await _cachedGetProject(onto.project_id);
    const siblings = project ? await _cachedListOntologiesForProject(project.id) : [onto];
    req.project = project || null;
    req.projectId = project?.id || null;
    req.ontologies = siblings;
    req.ontologyId = onto.id;
    req.ontology = onto;
    req.scope = { mode: "single", ontologyId: onto.id };
    req.ontologyScope = onto.id;
    return next();
  }

  if (!project) {
    const projects = await listProjects();
    project = projects[0] || null;
    if (!project) {
      const all = await listOntologies();
      if (!all.length) return res.status(500).json({ error: "no ontologies exist" });
      const first = all[0];
      req.project = null;
      req.projectId = null;
      req.ontologies = [first];
      req.ontologyId = first.id;
      req.ontology = first;
      req.scope = { mode: "single", ontologyId: first.id };
      req.ontologyScope = first.id;
      return next();
    }
  }

  const siblings = await _cachedListOntologiesForProject(project.id);
  if (!siblings.length) return res.status(500).json({ error: "project has no ontologies" });
  req.project = project;
  req.projectId = project.id;
  req.ontologies = siblings;

  if (wantAll) {
    const ids = siblings.map((o) => o.id);
    req.ontologyIds = ids;
    req.ontologyId = null;
    req.ontology = null;
    req.scope = { mode: "union", ontologyIds: ids };
    req.ontologyScope = ids;
    return next();
  }

  const first = siblings[0];
  req.ontologyId = first.id;
  req.ontology = first;
  req.scope = { mode: "single", ontologyId: first.id };
  req.ontologyScope = first.id;
  next();
}

export function requireSingleOntology(req, res, next) {
  if (!req.ontologyId)
    return res.status(400).json({
      error: "this action requires a specific ontology; union (all) mode cannot be used for writes",
    });
  next();
}

export async function resolveProject(req, res, next) {
  const rawProj =
    req.params?.project ||
    req.query?.project ||
    req.headers["x-project-id"] ||
    req.body?.project ||
    null;
  if (rawProj) {
    const project = await _cachedGetProject(rawProj);
    if (!project) return res.status(404).json({ error: "project not found" });
    req.project = project;
    req.projectId = project.id;
    req.ontologies = await _cachedListOntologiesForProject(project.id);
    return next();
  }
  const projects = await listProjects();
  const project = projects[0] || null;
  if (!project) return res.status(404).json({ error: "no projects exist" });
  req.project = project;
  req.projectId = project.id;
  req.ontologies = await _cachedListOntologiesForProject(project.id);
  next();
}
