import { Router } from "express";
import { requireAuth, requireProjectRole } from "../middleware/auth.js";
import { requireSingleOntology, resolveOntology } from "../middleware/ontology.js";
import {
  deleteCommentRecord,
  getCommentsList,
  getCommentTargetsList,
  getOntology,
  getParentComment,
  getProject,
  getProjectRoleFor,
  getRawComment,
  insertCommentRecord,
  logChange,
  projectRoleMeets,
  updateCommentRecord,
} from "../services/authDb.js";
import { ensureFreshToken } from "../services/githubService.js";

const router = Router();

function scopedOntologyIds(req) {
  if (req.scope?.mode === "union") return req.ontologyIds || [];
  return req.ontologyId ? [req.ontologyId] : [];
}

router.get("/", requireAuth, resolveOntology, requireProjectRole("viewer"), async (req, res) => {
  const ids = scopedOntologyIds(req);
  const rows = await getCommentsList({
    ontologyIds: ids,
    iri: req.query.iri,
  });
  res.json({ comments: rows });
});

router.get(
  "/targets",
  requireAuth,
  resolveOntology,
  requireProjectRole("viewer"),
  async (req, res) => {
    const ids = scopedOntologyIds(req);
    const rows = await getCommentTargetsList(ids);
    res.json({ targets: rows });
  },
);

router.post(
  "/",
  requireAuth,
  resolveOntology,
  requireSingleOntology,
  requireProjectRole("viewer"),
  async (req, res) => {
    const { target_iri = null, parent_id = null, body, post_to_github = false } = req.body || {};
    if (!body?.trim()) return res.status(400).json({ error: "body required" });

    let effectiveTarget = target_iri;
    if (parent_id) {
      const parent = await getParentComment(parent_id);
      if (!parent) return res.status(404).json({ error: "parent comment not found" });
      if (parent.ontology_id !== req.ontologyId)
        return res.status(400).json({ error: "parent comment in different ontology" });
      effectiveTarget = parent.target_iri;
    }

    const row = await insertCommentRecord({
      ontologyId: req.ontologyId,
      targetIri: effectiveTarget,
      parentId: parent_id,
      userId: req.session.user.id,
      body: body.trim(),
      now: Date.now(),
    });
    await logChange(req.session.user.id, req.ontologyId, "comment-create", {
      id: row.id,
      target: effectiveTarget,
      parent_id,
    });

    // Optionally push to GitHub Discussions
    if (post_to_github && !parent_id) {
      try {
        const cred = await ensureFreshToken(req.session.user.id);
        if (cred?.token && cred.scope?.includes("write:discussion")) {
          const onto = await getOntology(req.ontologyId);
          if (onto?.project_id) {
            const project = await getProject(onto.project_id);
            if (project?.github_repo) {
              const [owner, repo] = project.github_repo.split("/");
              const { getOrCreateDiscussionCategory, createDiscussion } = await import(
                "../services/githubService.js"
              );
              const categoryId = await getOrCreateDiscussionCategory(
                cred.token,
                owner,
                repo,
                "Amethyst",
              );
              const discussionTitle = `${onto.name} — ${effectiveTarget || "General"}`;
              const ghDiscussion = await createDiscussion(cred.token, owner, repo, {
                categoryId,
                title: discussionTitle,
                body: body.trim(),
              });
              await updateCommentRecord(row.id, {
                githubDiscussionId: ghDiscussion.id,
                githubSyncedAt: Date.now(),
              });
              row.github_discussion_id = ghDiscussion.id;
            }
          }
        }
      } catch (err) {
        // GitHub push is best-effort — don't fail the comment creation
        console.error("[comments] GitHub Discussions push failed:", err.message);
      }
    }

    res.json({ comment: row });
  },
);

function requireCommentAccess(minRole = "viewer") {
  return async (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    const existing = await getRawComment(id);
    if (!existing) return res.status(404).json({ error: "not found" });
    const onto = await getOntology(existing.ontology_id);
    if (!onto?.project_id) return res.status(404).json({ error: "not found" });
    const u = req.session.user;
    const role = await getProjectRoleFor(u.id, onto.project_id, u.role);
    if (!role || !projectRoleMeets(role, minRole))
      return res.status(403).json({ error: "forbidden" });
    req._comment = existing;
    req._commentProjectRole = role;
    next();
  };
}

router.patch("/:id", requireAuth, requireCommentAccess("viewer"), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = req._comment;
  const isOwner = existing.user_id === req.session.user.id;
  const isAdmin = req.session.user.role === "admin" || req._commentProjectRole === "manager";

  const updates = {};
  if (typeof req.body?.body === "string") {
    if (!isOwner && !isAdmin) return res.status(403).json({ error: "only the author can edit" });
    updates.body = req.body.body.trim();
  }
  if (typeof req.body?.resolved === "boolean") {
    updates.resolved = req.body.resolved;
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: "nothing to update" });

  const row = await updateCommentRecord(id, { ...updates, now: Date.now() });
  await logChange(req.session.user.id, existing.ontology_id, "comment-update", {
    id,
    resolved: row.resolved,
  });
  res.json({ comment: row });
});

router.delete("/:id", requireAuth, requireCommentAccess("viewer"), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = req._comment;
  const isOwner = existing.user_id === req.session.user.id;
  const isAdmin = req.session.user.role === "admin" || req._commentProjectRole === "manager";
  if (!isOwner && !isAdmin) return res.status(403).json({ error: "forbidden" });
  await deleteCommentRecord(id);
  await logChange(req.session.user.id, existing.ontology_id, "comment-delete", { id });
  res.json({ ok: true });
});

export default router;
