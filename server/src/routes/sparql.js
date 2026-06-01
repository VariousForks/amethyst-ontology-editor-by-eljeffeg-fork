import { Router } from "express";
import { requireAuth, requireProjectRole } from "../middleware/auth.js";
import { requireSingleOntology, resolveOntology } from "../middleware/ontology.js";
import { logChange } from "../services/authDb.js";
import {
  graphIriFor,
  graphIrisFor,
  rawQuery,
  update as storeUpdate,
} from "../services/rdfStore.js";

const router = Router();

// Dangerous SPARQL 1.1 UPDATE operations we never accept from the web UI.
// These can address arbitrary graphs outside the caller's scope; blocking them
// keeps the /update endpoint confined to the caller's named graph even if a
// query tries to be creative. Checked as whole-word tokens (case-insensitive).
const FORBIDDEN_UPDATE_OPS = /\b(DROP|CLEAR|LOAD|CREATE|ADD|MOVE|COPY)\b/i;

// Extract every `GRAPH <iri>` / `FROM [NAMED] <iri>` IRI referenced in a SPARQL
// string. Used to reject cross-graph queries that don't match the caller's
// allowed set.
function extractReferencedGraphs(q) {
  const out = new Set();
  const re = /\b(?:GRAPH|FROM(?:\s+NAMED)?)\s*<([^>]+)>/gi;
  let m = re.exec(q);
  while (m !== null) {
    out.add(m[1]);
    m = re.exec(q);
  }
  return [...out];
}

// POST /api/sparql/query  { query }  [?ontology=<id|all>&project=<pid>]
// Runs a SPARQL SELECT/ASK/CONSTRUCT/DESCRIBE scoped to the caller's named
// graph(s). Non-admins cannot escape the scope.
router.post("/query", requireAuth, resolveOntology, requireProjectRole("viewer"), (req, res) => {
  const { query, scoped } = req.body || {};
  if (!query) return res.status(400).json({ error: "query required" });

  // Only global admins may opt out of graph scoping. Regular users are
  // strictly confined to the graphs their current ontology/union resolves to.
  const isAdmin = req.session.user.role === "admin";
  const useRaw = scoped === false && isAdmin;

  // For scoped queries, if the query references any GRAPH/FROM IRIs, every
  // one of them must be within the caller's allowed set. This blocks
  // cross-tenant reads like `GRAPH <urn:ontology-editor:onto:OTHER_ID>`.
  if (!useRaw) {
    const allowed = new Set(graphIrisFor(req.ontologyScope));
    const referenced = extractReferencedGraphs(query);
    for (const iri of referenced) {
      if (!allowed.has(iri)) {
        return res.status(403).json({
          error: `query references graph outside your scope: <${iri}>`,
        });
      }
    }
  }

  try {
    const result = useRaw ? rawQuery(query) : runScopedQuery(query, req.ontologyScope);

    if (typeof result === "boolean") return res.json({ type: "boolean", value: result });
    if (!Array.isArray(result)) return res.json({ type: "empty", value: [] });
    if (result.length === 0) return res.json({ type: "empty", value: [] });

    const first = result[0];
    if (first && typeof first.subject !== "undefined" && typeof first.predicate !== "undefined") {
      return res.json({
        type: "graph",
        quads: result.map((q) => ({
          subject: termToPlain(q.subject),
          predicate: termToPlain(q.predicate),
          object: termToPlain(q.object),
          graph: termToPlain(q.graph),
        })),
      });
    }
    const vars = new Set();
    const rows = result.map((binding) => {
      const row = {};
      if (binding instanceof Map) {
        for (const [k, v] of binding) {
          vars.add(k);
          row[k] = termToPlain(v);
        }
      }
      return row;
    });
    res.json({ type: "bindings", vars: [...vars], rows });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// POST /api/sparql/update { update }  [?ontology=<id>]
// Update the caller's single ontology graph. Non-admins are:
//   - blocked from SPARQL 1.1 graph management ops (DROP/CLEAR/LOAD/CREATE/…),
//   - blocked from referencing any GRAPH other than their own, and
//   - wrapped into their graph when no GRAPH is mentioned at all.
// Global admins can pass { scoped: false } to bypass wrapping (legacy debug
// hook) but the forbidden-ops blocklist still applies as a defense-in-depth.
router.post(
  "/update",
  requireAuth,
  resolveOntology,
  requireSingleOntology,
  requireProjectRole("editor"),
  (req, res) => {
    const { update, scoped } = req.body || {};
    if (!update) return res.status(400).json({ error: "update required" });

    const isAdmin = req.session.user.role === "admin";
    // Hard block: dangerous bulk-graph ops are never allowed from this endpoint.
    if (FORBIDDEN_UPDATE_OPS.test(update)) {
      return res.status(403).json({
        error: "SPARQL DROP/CLEAR/LOAD/CREATE/ADD/MOVE/COPY are not allowed here",
      });
    }

    const myGraph = graphIriFor(req.ontologyId);
    // Every GRAPH IRI the update references must be the caller's own graph.
    const referenced = extractReferencedGraphs(update);
    for (const iri of referenced) {
      if (iri !== myGraph) {
        return res.status(403).json({
          error: `update references graph outside your scope: <${iri}>`,
        });
      }
    }

    try {
      const q = scoped === false && isAdmin ? update : wrapUpdate(update, req.ontologyId);
      storeUpdate(q, req.ontologyId);
      logChange(req.session.user.id, req.ontologyId, "sparql-update", {
        size: update.length,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  },
);

// Helper: delegate to the scoped select (returns raw oxigraph result shape when possible).
// `scope` can be a single ontology id OR an array of ids (project-wide union).
function runScopedQuery(query, scope) {
  // For SELECT we want raw oxigraph output (Map bindings), not the "flat row" helper.
  // Re-run via rawQuery with a wrapped query.
  const wrapped = wrapQueryForSelect(query, scope);
  return rawQuery(wrapped);
}

// Inject FROM <graph> clauses into WHERE-based queries. For union scope,
// multiple FROM clauses are inserted, which Oxigraph merges into the default
// graph for the query.
function wrapQueryForSelect(query, scope) {
  if (/\bFROM\b/i.test(query) || /\bGRAPH\s*</i.test(query)) return query;
  const iris = graphIrisFor(scope);
  if (!iris.length) return query;
  const clauses = iris.map((g) => `FROM <${g}>`).join(" ");
  return query.replace(/\bWHERE\s*\{/i, `${clauses} WHERE {`);
}

// Wrap a SPARQL UPDATE into the caller's named graph when the update doesn't
// scope itself. Covers the simple DATA/WHERE forms the UI actually emits:
//   - INSERT DATA { ... }
//   - DELETE DATA { ... }
//   - DELETE WHERE { ... }
// If the update is an unwrapped SPARQL 1.1 modify form (`DELETE { ... }
// INSERT { ... } WHERE { ... }`), it must use an explicit GRAPH <> clause —
// automatic wrapping would be fragile. The caller-side IRI allowlist check
// (above) guarantees the GRAPH, if any, is the caller's own.
function wrapUpdate(query, ontologyId) {
  const g = `urn:ontology-editor:onto:${ontologyId}`;
  if (/\bGRAPH\s*</i.test(query)) return query;

  // INSERT DATA { ... }  ->  INSERT DATA { GRAPH <g> { ... } }
  let out = query.replace(/\bINSERT\s+DATA\s*\{/i, `INSERT DATA { GRAPH <${g}> {`);
  if (out !== query) return `${out} }`;

  out = query.replace(/\bDELETE\s+DATA\s*\{/i, `DELETE DATA { GRAPH <${g}> {`);
  if (out !== query) return `${out} }`;

  out = query.replace(/\bDELETE\s+WHERE\s*\{/i, `DELETE WHERE { GRAPH <${g}> {`);
  if (out !== query) return `${out} }`;

  // Unwrapped modify form: reject rather than risk a broken rewrite. The UI
  // never emits this; only hand-written SPARQL from the debug console hits it.
  if (/\b(?:INSERT|DELETE)\s*\{[^}]*\}[\s\S]*?\bWHERE\s*\{/i.test(query)) {
    throw new Error(
      "SPARQL modify forms (INSERT/DELETE … WHERE) must include an explicit GRAPH <> clause",
    );
  }

  // Fallback: unchanged — the caller provided their own GRAPH <> or it's a
  // no-op we don't need to rewrite.
  return query;
}

function termToPlain(term) {
  if (!term) return null;
  switch (term.termType) {
    case "NamedNode":
      return { type: "uri", value: term.value };
    case "BlankNode":
      return { type: "bnode", value: term.value };
    case "Literal":
      return {
        type: "literal",
        value: term.value,
        datatype: term.datatype ? term.datatype.value : null,
        language: term.language || null,
      };
    case "DefaultGraph":
      return { type: "graph", value: "" };
    default:
      return { type: term.termType, value: term.value };
  }
}

export default router;
