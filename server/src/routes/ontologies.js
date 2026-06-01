import { Router } from "express";
import { v4 as uuid } from "uuid";
import { requireAuth, requireProjectRole } from "../middleware/auth.js";
import {
  deleteOntologyRecord,
  getDb,
  getFirstEditableProject,
  getOntology,
  getProject,
  getProjectRoleFor,
  insertOntologyRecord,
  listOntologies,
  listOntologiesForProject,
  listProjectIdsForUser,
  logChange,
  projectRoleMeets,
  reorderOntologiesForProject,
  updateOntologyRecord,
} from "../services/authDb.js";
import {
  compareBranch,
  createBranch,
  deleteBranch,
  getFileHistory,
} from "../services/ontologyGit.js";
import {
  copyOntologyGraph,
  dropOntologyGraph,
  enrichOntology,
  mergeOntologyBranch,
  persistOntology,
  resolveOntologyConflict,
  setOntologyRdfMeta,
  writeFileToDisk,
} from "../services/rdfStore.js";

const router = Router();

async function projectFromOntologyParam(req, res, next) {
  const onto = await getOntology(req.params.id);
  if (!onto) return res.status(404).json({ error: "not found" });
  req.ontology = onto;
  req.ontologyId = onto.id;
  if (onto.project_id) {
    const p = await getProject(onto.project_id);
    if (p) {
      req.project = p;
      req.projectId = p.id;
    }
  }
  next();
}

router.get("/", requireAuth, async (req, res) => {
  const u = req.session.user;
  const pid = (req.query.project || "").toString();
  if (pid) {
    const p = await getProject(pid);
    if (!p) return res.status(404).json({ error: "project not found" });
    const role = await getProjectRoleFor(u.id, pid, u.role);
    if (!role || !projectRoleMeets(role, "viewer"))
      return res.status(403).json({ error: "forbidden" });
    return res.json({
      ontologies: (await listOntologiesForProject(pid)).map(enrichOntology),
    });
  }
  const allowed = new Set(await listProjectIdsForUser(u.id));
  const rows = (await listOntologies()).filter((o) => allowed.has(o.project_id));
  res.json({ ontologies: rows.map(enrichOntology) });
});

router.post(
  "/",
  requireAuth,
  async (req, res, next) => {
    const { project_id } = req.body || {};
    let pid = project_id;
    if (!pid) {
      const anyProject = await getFirstEditableProject(req.session.user.id);
      if (!anyProject)
        return res.status(400).json({ error: "no project exists; create one first" });
      req.body.project_id = anyProject.id;
      pid = anyProject.id;
    }
    const p = await getProject(pid);
    if (!p) return res.status(404).json({ error: "project not found" });
    req.project = p;
    req.projectId = p.id;
    next();
  },
  requireProjectRole("editor"),
  async (req, res) => {
    const { name, iri, description } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });
    const id = uuid();
    const now = Date.now();
    await insertOntologyRecord({
      id,
      name,
      iri,
      description,
      projectId: req.projectId,
      now,
      userId: req.session.user.id,
    });
    persistOntology(id);
    await logChange(req.session.user.id, id, "create-ontology", {
      name,
      iri,
      projectId: req.projectId,
    });
    res.json({ ontology: await getOntology(id) });
  },
);

// PUT /api/ontologies/reorder — update sort_order for root ontologies in a project.
// Body: { project_id: "<uuid>", ids: ["<uuid>", …] }
// The ids array must list ALL root-level ontology IDs for the project in the
// desired order; branches are intentionally excluded (they follow their parent).
router.put(
  "/reorder",
  requireAuth,
  async (req, res, next) => {
    const { project_id, ids } = req.body || {};
    if (!project_id) return res.status(400).json({ error: "project_id is required" });
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: "ids must be a non-empty array" });
    const p = await getProject(project_id);
    if (!p) return res.status(404).json({ error: "project not found" });
    req.project = p;
    req.projectId = p.id;
    next();
  },
  requireProjectRole("editor"),
  async (req, res) => {
    const { ids } = req.body;
    await reorderOntologiesForProject(req.projectId, ids);
    await logChange(req.session.user.id, null, "reorder-ontologies", {
      projectId: req.projectId,
      ids,
    });
    res.json({ ok: true });
  },
);

router.get(
  "/:id",
  requireAuth,
  projectFromOntologyParam,
  requireProjectRole("viewer"),
  async (req, res) => {
    res.json({ ontology: enrichOntology(req.ontology) });
  },
);

router.put(
  "/:id",
  requireAuth,
  projectFromOntologyParam,
  requireProjectRole("editor"),
  async (req, res) => {
    const { name, iri, description, title, creator, license, versionInfo, github_branch_name } =
      req.body || {};
    // Only bump updated_at when RDF content actually changes — a name-only edit
    // must not mark child branches as stale.  For DB-backed fields we compare
    // incoming vs current values.
    const existing = req.ontology;
    const hasRdfChange =
      iri !== (existing.iri ?? null) ||
      description !== (existing.description ?? null) ||
      (title !== undefined && title !== null) ||
      (versionInfo !== undefined && versionInfo !== null) ||
      (creator !== undefined && creator !== null) ||
      (license !== undefined && license !== null);
    const now = hasRdfChange ? Date.now() : null;
    await updateOntologyRecord(req.params.id, {
      name,
      iri,
      description,
      now,
      userId: req.session.user.id,
    });

    if (
      title !== undefined ||
      description !== undefined ||
      versionInfo !== undefined ||
      creator !== undefined ||
      license !== undefined
    ) {
      const subjectIri = (iri ?? req.ontology?.iri) || `urn:ontology-editor:onto:${req.params.id}`;
      setOntologyRdfMeta(req.params.id, subjectIri, {
        title,
        description,
        version: versionInfo,
        creator,
        license,
      });
    }

    // Switching the tracked GitHub branch is a config change — no content bump.
    if (github_branch_name !== undefined) {
      await getDb().run("UPDATE ontologies SET github_branch_name = ? WHERE id = ?", [
        github_branch_name || null,
        req.params.id,
      ]);
    }

    await logChange(req.session.user.id, req.params.id, "update-ontology", {
      name,
      iri,
    });
    res.json({ ontology: enrichOntology(await getOntology(req.params.id)) });
  },
);

router.delete(
  "/:id",
  requireAuth,
  projectFromOntologyParam,
  requireProjectRole("manager"),
  async (req, res) => {
    const existing = req.ontology;
    if (existing.project_id) {
      const siblings = await listOntologiesForProject(existing.project_id);
      if (siblings.length <= 1)
        return res.status(400).json({
          error: "cannot delete the last ontology in a project; delete the project instead",
        });
    }
    try {
      await dropOntologyGraph(req.params.id);
    } catch {}
    // If this was a branch, also remove its directory.
    if (existing.branch_of) {
      try {
        await deleteBranch(req.params.id);
      } catch {}
    }
    await deleteOntologyRecord(req.params.id);
    await logChange(req.session.user.id, req.params.id, "delete-ontology", {
      name: existing.name,
    });
    res.json({ ok: true });
  },
);

// POST /api/ontologies/:id/branch  — create a snapshot copy (branch) of an ontology
router.post(
  "/:id/branch",
  requireAuth,
  projectFromOntologyParam,
  requireProjectRole("editor"),
  async (req, res) => {
    const parent = req.ontology;
    const { name } = req.body || {};
    const branchName = (name || `${parent.name} (branch)`).toString().trim();
    const branchId = uuid();
    const now = Date.now();
    const userId = req.session.user.id;

    await insertOntologyRecord({
      id: branchId,
      name: branchName,
      iri: parent.iri || null,
      description: parent.description || null,
      projectId: parent.project_id,
      now,
      userId,
    });

    // Record branch lineage and snapshot the parent version at branch time.
    await getDb().run(
      `UPDATE ontologies
         SET branch_of = ?, branched_at = ?, branched_from_version = ?
       WHERE id = ?`,
      [parent.id, now, parent.updated_at, branchId],
    );

    // Flush the parent's current TTL to disk so the base snapshot is up-to-date
    // before we copy it.  This is fast (file write only, no git commit).
    await writeFileToDisk(parent.id);

    // Set up the branch directory + base snapshot BEFORE copying the graph, so
    // persistOntology (called inside copyOntologyGraph) writes to the branch path.
    await createBranch(branchId, parent.id);

    // Copy the RDF graph from parent into the new branch's named graph.
    copyOntologyGraph(parent.id, branchId);

    await logChange(userId, branchId, "branch-ontology", {
      branchName,
      parentId: parent.id,
      parentName: parent.name,
      projectId: parent.project_id,
    });

    const branch = await getOntology(branchId);
    res.json({ ontology: enrichOntology(branch) });
  },
);

// POST /api/ontologies/:id/merge  — merge a branch back into its parent
// This replaces ALL data in the parent with this branch's data. Cannot be undone.
router.post(
  "/:id/merge",
  requireAuth,
  projectFromOntologyParam,
  requireProjectRole("editor"),
  async (req, res) => {
    const branch = req.ontology;
    if (!branch.branch_of) {
      return res.status(400).json({ error: "This ontology is not a branch and cannot be merged." });
    }

    const parent = await getOntology(branch.branch_of);
    if (!parent) {
      return res.status(404).json({ error: "Parent ontology not found." });
    }

    // Check if the parent was modified after the branch was created (stale branch).
    const isStale = parent.updated_at > branch.branched_from_version;

    const userId = req.session.user.id;
    const now = Date.now();

    try {
      const result = await mergeOntologyBranch(branch.id, parent.id);

      if (result.conflict) {
        // Let the client choose which side to keep.
        return res.json({
          conflict: true,
          branchId: branch.id,
          parentId: parent.id,
          parentName: parent.name,
          branchName: branch.name,
          ours: result.ours, // current parent's content
          theirs: result.theirs, // branch's content
        });
      }

      // Clean RDF merge — parent named graph already updated in-memory by mergeOntologyBranch.
      // Update the parent's updated_at so sibling branches can detect staleness.
      await getDb().run("UPDATE ontologies SET updated_at = ?, updated_by = ? WHERE id = ?", [
        now,
        userId,
        parent.id,
      ]);

      // Clean up: remove branch directory, drop its named graph, delete DB record.
      await deleteBranch(branch.id);
      await dropOntologyGraph(branch.id);
      await deleteOntologyRecord(branch.id);

      await logChange(userId, parent.id, "merge-branch", {
        branchId: branch.id,
        branchName: branch.name,
        parentId: parent.id,
        parentName: parent.name,
        wasStale: isStale,
      });

      res.json({
        ok: true,
        wasStale: isStale,
        parent: enrichOntology(await getOntology(parent.id)),
      });
    } catch (err) {
      res.status(500).json({ error: `Merge failed: ${err.message || err}` });
    }
  },
);

// POST /api/ontologies/:id/resolve-conflict
// Resolve a pending git merge conflict by choosing one side.
// choice: "ours" (keep parent) | "theirs" (use branch)
router.post(
  "/:id/resolve-conflict",
  requireAuth,
  projectFromOntologyParam,
  requireProjectRole("editor"),
  async (req, res) => {
    const branch = req.ontology;
    if (!branch.branch_of) {
      return res.status(400).json({ error: "Not a branch." });
    }

    const { choice } = req.body || {};
    if (choice !== "ours" && choice !== "theirs") {
      return res.status(400).json({ error: "choice must be 'ours' or 'theirs'" });
    }

    const parent = await getOntology(branch.branch_of);
    if (!parent) return res.status(404).json({ error: "Parent ontology not found." });

    const userId = req.session.user.id;
    const now = Date.now();

    try {
      // resolveOntologyConflict updates the in-memory store and persists — no reload needed.
      await resolveOntologyConflict(branch.id, parent.id, choice);

      await getDb().run("UPDATE ontologies SET updated_at = ?, updated_by = ? WHERE id = ?", [
        now,
        userId,
        parent.id,
      ]);

      // Clean up: remove branch directory, drop its named graph, delete DB record.
      await deleteBranch(branch.id);
      await dropOntologyGraph(branch.id);
      await deleteOntologyRecord(branch.id);

      await logChange(userId, parent.id, "resolve-merge-conflict", {
        branchId: branch.id,
        branchName: branch.name,
        choice,
      });

      res.json({ ok: true, parent: enrichOntology(await getOntology(parent.id)) });
    } catch (err) {
      res.status(500).json({ error: `Conflict resolution failed: ${err.message || err}` });
    }
  },
);

// GET /api/ontologies/:id/compare — unified git diff between a branch and its parent
router.get(
  "/:id/compare",
  requireAuth,
  projectFromOntologyParam,
  requireProjectRole("viewer"),
  async (req, res) => {
    const branch = req.ontology;
    if (!branch.branch_of) {
      return res.status(400).json({ error: "Not a branch ontology." });
    }

    const parent = await getOntology(branch.branch_of);
    if (!parent) return res.status(404).json({ error: "Parent ontology not found." });

    try {
      const diff = await compareBranch(branch.id, parent.id);
      res.json({
        branchId: branch.id,
        branchName: branch.name,
        parentId: parent.id,
        parentName: parent.name,
        diff: diff || "",
      });
    } catch (err) {
      res.status(500).json({ error: `Compare failed: ${err.message || err}` });
    }
  },
);

// GET /api/ontologies/:id/history — git commit history for this ontology's file
router.get(
  "/:id/history",
  requireAuth,
  projectFromOntologyParam,
  requireProjectRole("viewer"),
  async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 200);
    const history = await getFileHistory(req.params.id, limit);
    res.json({ history });
  },
);

export default router;
