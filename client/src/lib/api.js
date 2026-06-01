const API = "/api";

async function j(res) {
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401) {
      // Session expired or not authenticated — send the user to the login page.
      window.location.replace("/login");
      return;
    }
    const msg = data?.error || res.statusText || "Request failed";
    throw new Error(msg);
  }
  return data;
}

// ── Client-side fetch cache ───────────────────────────────────────────────────
//
// Every navigation to Classes / Properties / Individuals / Graph fires the
// same GET requests even though the data hasn't changed. Caching these for a
// short window eliminates redundant round-trips to the cloud without any
// perceptible staleness — mutations always clear the relevant entries.
//
// TTL: 15 s.  Small enough that background edits in another tab appear
// quickly; large enough to cover a user clicking between views rapidly.

const FETCH_CACHE_TTL = 15_000; // ms
const _fetchCache = new Map(); // url -> { data, expiresAt }

/** Cache a GET response by URL. Called internally by cachedGet(). */
function _cachePut(url, data) {
  _fetchCache.set(url, { data, expiresAt: Date.now() + FETCH_CACHE_TTL });
}

/** Return cached data for `url` if still fresh, otherwise undefined. */
function _cacheHit(url) {
  const e = _fetchCache.get(url);
  if (!e) return undefined;
  if (Date.now() > e.expiresAt) {
    _fetchCache.delete(url);
    return undefined;
  }
  return e.data;
}

/**
 * Evict all cache entries whose URL contains any of the given substrings.
 * Called after every mutation so the next read always sees fresh data.
 * Pass no arguments to clear the entire cache.
 */
export function clearFetchCache(...patterns) {
  if (!patterns.length) {
    _fetchCache.clear();
    return;
  }
  for (const key of [..._fetchCache.keys()]) {
    if (patterns.some((p) => key.includes(p))) _fetchCache.delete(key);
  }
}

/** GET with cache.  Identical interface to fetch(url, {credentials:'include'}). */
function cachedGet(url) {
  const hit = _cacheHit(url);
  if (hit !== undefined) return Promise.resolve(hit);
  return fetch(url, { credentials: "include" })
    .then(j)
    .then((data) => {
      _cachePut(url, data);
      return data;
    });
}

// Current project + ontology scope.
//   currentProjectId: always a UUID once a project is loaded
//   currentOntologyId: either a UUID (single-ontology scope) or the literal
//                      string 'all' to indicate "union across all ontologies
//                      in the current project". `null` means the server should
//                      fall back to the project's first ontology.
// currentOntologyId  : READ scope — single UUID, 'all', or comma-separated
//                      UUIDs for workspace mode (multiple visible ontologies).
// currentWriteOntologyId : WRITE target — always a single UUID.  All mutating
//                      endpoints use this so writes always go to the designated
//                      writable ontology even when multiple ontologies are
//                      visible in the workspace.
let currentProjectId = null;
let currentOntologyId = null;
let currentWriteOntologyId = null;

export function setCurrentProject(id) {
  currentProjectId = id || null;
}
export function getCurrentProject() {
  return currentProjectId;
}
export function setCurrentOntology(id) {
  currentOntologyId = id || null;
}
export function getCurrentOntology() {
  return currentOntologyId;
}
export function setWriteOntology(id) {
  currentWriteOntologyId = id || null;
}
export function getWriteOntology() {
  return currentWriteOntologyId;
}
export function isUnionScope() {
  return (
    currentOntologyId === "all" ||
    currentOntologyId === "*" ||
    Boolean(currentOntologyId?.includes(","))
  );
}

// Pull a URL-encoded IRI out of a location hash formatted like
// "#iri=http%3A%2F%2Fexample.org%2FFoo". Returns null when no iri=… is present.
// Used by the entity list pages so the graph's "Edit in …" button can drop
// the user on the right row.
export function parseIriFromHash(hash) {
  if (!hash) return null;
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  for (const pair of raw.split("&")) {
    const [k, v] = pair.split("=");
    if (k === "iri" && v) {
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return null;
}

// Appends read-scope params (project + read ontology/union) to a URL.
// Used for all GET-style data fetching so the view shows all visible ontologies.
function withOntology(url) {
  const params = [];
  if (currentProjectId) params.push(`project=${encodeURIComponent(currentProjectId)}`);
  if (currentOntologyId) params.push(`ontology=${encodeURIComponent(currentOntologyId)}`);
  if (!params.length) return url;
  return url + (url.includes("?") ? "&" : "?") + params.join("&");
}

// Bypasses the current visibility scope and reads from ALL ontologies in the
// project.  Use for detail views and pickers that should always show the
// complete picture regardless of which ontologies are hidden or linked.
function withAllOntologies(url) {
  const params = [];
  if (currentProjectId) params.push(`project=${encodeURIComponent(currentProjectId)}`);
  params.push("ontology=all");
  return url + (url.includes("?") ? "&" : "?") + params.join("&");
}

// Appends write-scope params (project + the single designated write ontology)
// to a URL.  All mutating endpoints must use this so writes always target the
// one writable ontology even when multiple are visible.
function withWriteOntology(url) {
  const params = [];
  if (currentProjectId) params.push(`project=${encodeURIComponent(currentProjectId)}`);
  // Prefer the explicit write target; fall back to the read scope only when
  // it is unambiguously a single ontology (not 'all' or comma-separated).
  const wid =
    currentWriteOntologyId ||
    (currentOntologyId &&
    currentOntologyId !== "all" &&
    currentOntologyId !== "*" &&
    !currentOntologyId.includes(",")
      ? currentOntologyId
      : null);
  if (wid) params.push(`ontology=${encodeURIComponent(wid)}`);
  if (!params.length) return url;
  return url + (url.includes("?") ? "&" : "?") + params.join("&");
}

// All mutating (non-GET) calls carry `X-Requested-With: fetch`. The server's
// CSRF middleware refuses state-changing requests without this header; since
// browsers disallow cross-origin requests from setting non-simple headers
// without a successful CORS preflight (which our tight allowlist rejects),
// this prevents classic drive-by CSRF via <form>/<img>/<script>.
const opts = (method, body, isForm = false) => ({
  method,
  credentials: "include",
  headers: isForm
    ? { "X-Requested-With": "fetch" }
    : { "Content-Type": "application/json", "X-Requested-With": "fetch" },
  body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
});

export const api = {
  // Auth
  status: () => fetch(`${API}/auth/status`, { credentials: "include" }).then(j),
  me: () => fetch(`${API}/auth/me`, { credentials: "include" }).then(j),
  login: (username, password) =>
    fetch(`${API}/auth/login`, opts("POST", { username, password })).then(j),
  register: (username, email, password) =>
    fetch(`${API}/auth/register`, opts("POST", { username, email, password })).then(j),
  logout: () => fetch(`${API}/auth/logout`, opts("POST")).then(j),
  users: () => fetch(`${API}/auth/users`, { credentials: "include" }).then(j),
  updateEmail: (email) => fetch(`${API}/auth/email`, opts("PATCH", { email })).then(j),
  updatePassword: (currentPassword, newPassword) =>
    fetch(`${API}/auth/password`, opts("PATCH", { currentPassword, newPassword })).then(j),

  // Projects (CRUD)
  // cache:"no-store" bypasses the 15-second browser cache set by the server's
  // Cache-Control: private, max-age=15 header so post-mutation refreshes always
  // see the latest data instead of a stale snapshot.
  projects: () => fetch(`${API}/projects`, { credentials: "include", cache: "no-store" }).then(j),
  getProject: (id) => fetch(`${API}/projects/${id}`, { credentials: "include" }).then(j),
  createProject: (body) => fetch(`${API}/projects`, opts("POST", body)).then(j),
  updateProject: (id, body) => fetch(`${API}/projects/${id}`, opts("PATCH", body)).then(j),
  deleteProject: (id) =>
    fetch(`${API}/projects/${id}`, {
      method: "DELETE",
      credentials: "include",
      headers: { "X-Requested-With": "fetch" },
    }).then(j),

  // Project members & per-project invites
  projectMembers: (projectId) =>
    fetch(`${API}/projects/${projectId}/members`, {
      credentials: "include",
    }).then(j),
  setProjectMemberRole: (projectId, userId, role) =>
    fetch(`${API}/projects/${projectId}/members/${userId}`, opts("PUT", { role })).then(j),
  removeProjectMember: (projectId, userId) =>
    fetch(`${API}/projects/${projectId}/members/${userId}`, {
      method: "DELETE",
      credentials: "include",
      headers: { "X-Requested-With": "fetch" },
    }).then(j),
  projectInvites: (projectId) =>
    fetch(`${API}/projects/${projectId}/invites`, {
      credentials: "include",
    }).then(j),
  createProjectInvite: (projectId, body) =>
    fetch(`${API}/projects/${projectId}/invites`, opts("POST", body)).then(j),
  revokeProjectInvite: (projectId, token) =>
    fetch(`${API}/projects/${projectId}/invites/${token}`, {
      method: "DELETE",
      credentials: "include",
      headers: { "X-Requested-With": "fetch" },
    }).then(j),
  projectUsers: (projectId) =>
    fetch(`${API}/projects/${projectId}/users`, {
      credentials: "include",
    }).then(j),
  // Build an export URL for a specific ontology (opens directly in browser)
  exportOntologyUrl: (ontologyId, format = "text/turtle") =>
    `${API}/import/export?ontology=${encodeURIComponent(ontologyId)}&format=${encodeURIComponent(format)}`,

  // Ontologies (CRUD). Creating/listing are project-scoped on the server.
  ontologies: (projectId = currentProjectId) => {
    const u = projectId
      ? `${API}/ontologies?project=${encodeURIComponent(projectId)}`
      : `${API}/ontologies`;
    return fetch(u, { credentials: "include" }).then(j);
  },
  createOntology: (body) => {
    const payload = { ...body };
    if (!payload.project_id && currentProjectId) payload.project_id = currentProjectId;
    return fetch(`${API}/ontologies`, opts("POST", payload)).then(j);
  },
  updateOntology: (id, body) => fetch(`${API}/ontologies/${id}`, opts("PUT", body)).then(j),
  branchOntology: (id, body) => fetch(`${API}/ontologies/${id}/branch`, opts("POST", body)).then(j),
  mergeOntology: (id) => fetch(`${API}/ontologies/${id}/merge`, opts("POST", {})).then(j),
  resolveConflict: (branchId, choice) =>
    fetch(`${API}/ontologies/${branchId}/resolve-conflict`, opts("POST", { choice })).then(j),
  getOntologyHistory: (id, limit = 30) =>
    fetch(`${API}/ontologies/${id}/history?limit=${limit}`, opts("GET")).then(j),
  compareOntology: (id) =>
    fetch(`${API}/ontologies/${id}/compare`, { credentials: "include" }).then(j),
  deleteOntology: (id) =>
    fetch(`${API}/ontologies/${id}`, {
      method: "DELETE",
      credentials: "include",
      headers: { "X-Requested-With": "fetch" },
    }).then(j),

  // Persist a user-defined sort order for root ontologies in a project.
  // orderedIds: array of root ontology UUIDs in the desired display order.
  reorderOntologies: (projectId, orderedIds) =>
    fetch(
      `${API}/ontologies/reorder`,
      opts("PUT", { project_id: projectId, ids: orderedIds }),
    ).then(j),

  /**
   * Refresh (reload) an existing ontology from a file upload or a URL.
   * Unlike the generic importTtl / importFromUrl helpers this always targets
   * a specific ontology by ID regardless of the current write scope.
   *
   * @param {string}  ontologyId  – UUID of the ontology to refresh
   * @param {string}  projectId   – UUID of the owning project (for auth)
   * @param {object}  opts
   * @param {File}   [opts.file]    – browser File object (file-upload path)
   * @param {string} [opts.url]     – remote URL to fetch (url path)
   * @param {boolean} [opts.replace=true] – clear existing triples before loading
   */
  refreshOntology: (ontologyId, projectId, { file, url, replace = true } = {}) => {
    const qp = new URLSearchParams();
    qp.set("ontology", ontologyId);
    if (projectId) qp.set("project", projectId);
    const endpoint = `${API}/import/ttl?${qp.toString()}`;

    if (file) {
      const fd = new FormData();
      fd.append("file", file);
      if (replace) fd.append("replace", "true");
      return fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { "X-Requested-With": "fetch" },
        body: fd,
      })
        .then(j)
        .then((d) => {
          clearFetchCache();
          return d;
        });
    }

    if (url) {
      return fetch(endpoint, opts("POST", { url, replace }))
        .then(j)
        .then((d) => {
          clearFetchCache();
          return d;
        });
    }

    return Promise.reject(new Error("Either file or url must be provided"));
  },

  /**
   * Replace an existing ontology's content with raw Turtle text.
   * Mirrors refreshOntology but accepts a text string instead of a file/url.
   */
  refreshOntologyText: (ontologyId, projectId, { text, replace = true } = {}) => {
    const qp = new URLSearchParams();
    qp.set("ontology", ontologyId);
    if (projectId) qp.set("project", projectId);
    const endpoint = `${API}/import/ttl?${qp.toString()}`;
    return fetch(endpoint, opts("POST", { text, format: "text/turtle", replace }))
      .then(j)
      .then((d) => {
        clearFetchCache();
        return d;
      });
  },

  // Current-ontology-scoped entity / property endpoints.
  // Read endpoints use cachedGet (15 s TTL, cleared on any write below).
  meta: () => cachedGet(withOntology(`${API}/ontology/meta`)),
  saveMeta: (patch) =>
    fetch(withWriteOntology(`${API}/ontology/meta`), opts("PUT", patch))
      .then(j)
      .then((d) => {
        clearFetchCache("/ontology");
        return d;
      }),
  classes: () => {
    let url = withOntology(`${API}/ontology/classes`);
    // Pass the write target so the server can prefer its labels over the
    // parent-graph values when a class exists in both graphs (branch scenario).
    if (currentWriteOntologyId)
      url += `&writeOntology=${encodeURIComponent(currentWriteOntologyId)}`;
    return cachedGet(url);
  },
  properties: () => cachedGet(withOntology(`${API}/ontology/properties`)),
  individuals: () => cachedGet(withOntology(`${API}/ontology/individuals`)),
  // Entity detail always reads from ALL project ontologies so hidden/linked
  // ontologies' properties and relationships are never silently omitted.
  entity: (iri) => {
    let url = withAllOntologies(`${API}/ontology/entity?iri=${encodeURIComponent(iri)}`);
    if (currentWriteOntologyId)
      url += `&writeOntology=${encodeURIComponent(currentWriteOntologyId)}`;
    return cachedGet(url);
  },
  // Blank-node OWL expressions (restrictions, equivalentClass intersections,
  // etc.) reachable from an entity IRI. Returns { topLevel, bnodeMap }.
  entityExpressions: (iri) => {
    let url = withAllOntologies(
      `${API}/ontology/entity/expressions?iri=${encodeURIComponent(iri)}`,
    );
    if (currentWriteOntologyId)
      url += `&writeOntology=${encodeURIComponent(currentWriteOntologyId)}`;
    return cachedGet(url);
  },
  // All classes across every ontology in the project (ignores visibility).
  // Used for pickers (parent class, domain, range) so hidden-ontology classes
  // are always available as options.
  classesAll: () => cachedGet(withAllOntologies(`${API}/ontology/classes`)),
  // All properties across every ontology in the project (ignores visibility).
  // Used in EntityDetail so inherited-property and axiom-candidate lists are
  // complete regardless of which ontologies are currently hidden.
  propertiesAll: () => cachedGet(withAllOntologies(`${API}/ontology/properties`)),

  // Linked context: entities from sibling ontologies referenced by the primary
  // (write) ontology but not defined there.  Used by the "Linked Context" mode
  // in the workspace picker to show partial cross-ontology visibility.
  //   primaryId  – the write ontology UUID (must be a single ID, never 'all')
  //   searchIds  – array of sibling ontology UUIDs to search
  linkedContext: (primaryId, searchIds) => {
    if (!primaryId || !searchIds?.length) return Promise.resolve({ classes: [], properties: [] });
    const params = [`ontology=${encodeURIComponent(primaryId)}`];
    if (currentProjectId) params.push(`project=${encodeURIComponent(currentProjectId)}`);
    params.push(`search=${encodeURIComponent(searchIds.join(","))}`);
    return cachedGet(`${API}/ontology/linked-context?${params.join("&")}`);
  },
  createClass: (body) =>
    fetch(withWriteOntology(`${API}/ontology/class`), opts("POST", body))
      .then(j)
      .then((d) => {
        clearFetchCache("/ontology", "/graph");
        return d;
      }),
  createProperty: (body) =>
    fetch(withWriteOntology(`${API}/ontology/property`), opts("POST", body))
      .then(j)
      .then((d) => {
        clearFetchCache("/ontology", "/graph");
        return d;
      }),
  setPropertyCharacteristics: (iri, kind, characteristics) =>
    fetch(
      withWriteOntology(`${API}/ontology/property/characteristics`),
      opts("PUT", { iri, kind, characteristics }),
    )
      .then(j)
      .then((d) => {
        clearFetchCache("/ontology", "/graph");
        return d;
      }),
  setRelations: (iri, predicate, targets) =>
    fetch(withWriteOntology(`${API}/ontology/relations`), opts("PUT", { iri, predicate, targets }))
      .then(j)
      .then((d) => {
        clearFetchCache("/ontology", "/graph");
        return d;
      }),
  setDeprecated: (iri, deprecated) =>
    fetch(withWriteOntology(`${API}/ontology/entity/deprecated`), opts("PUT", { iri, deprecated }))
      .then(j)
      .then((d) => {
        clearFetchCache("/ontology", "/graph");
        return d;
      }),
  createIndividual: (body) =>
    fetch(withWriteOntology(`${API}/ontology/individual`), opts("POST", body))
      .then(j)
      .then((d) => {
        clearFetchCache("/ontology", "/graph");
        return d;
      }),
  addTriple: (body) =>
    fetch(withWriteOntology(`${API}/ontology/triple`), opts("POST", body))
      .then(j)
      .then((d) => {
        clearFetchCache("/ontology", "/graph");
        return d;
      }),
  renameEntityIri: (oldIri, newIri) =>
    fetch(withWriteOntology(`${API}/ontology/entity/iri`), opts("PUT", { oldIri, newIri }))
      .then(j)
      .then((d) => {
        clearFetchCache("/ontology", "/graph");
        return d;
      }),
  deleteEntity: (iri) =>
    fetch(withWriteOntology(`${API}/ontology/entity?iri=${encodeURIComponent(iri)}`), {
      method: "DELETE",
      credentials: "include",
      headers: { "X-Requested-With": "fetch" },
    })
      .then(j)
      .then((d) => {
        clearFetchCache("/ontology", "/graph");
        return d;
      }),
  deleteTriple: (body) =>
    fetch(withWriteOntology(`${API}/ontology/triple`), {
      method: "DELETE",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "fetch",
      },
      body: JSON.stringify(body),
    })
      .then(j)
      .then((d) => {
        clearFetchCache("/ontology", "/graph");
        return d;
      }),
  // ── OWL expression editing ──────────────────────────────────────────────────
  // POST /entity/restriction: add a new owl:Restriction blank node to an entity.
  addRestriction: (body) =>
    fetch(withWriteOntology(`${API}/ontology/entity/restriction`), opts("POST", body))
      .then(j)
      .then((d) => {
        clearFetchCache("/ontology", "/graph");
        return d;
      }),
  // DELETE /entity/expression: remove a blank-node expression subgraph (restriction,
  // equivalentClass anonymous class, etc.) from an entity via BFS quad deletion.
  deleteExpression: (body) =>
    fetch(withWriteOntology(`${API}/ontology/entity/expression`), {
      method: "DELETE",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "fetch",
      },
      body: JSON.stringify(body),
    })
      .then(j)
      .then((d) => {
        clearFetchCache("/ontology", "/graph");
        return d;
      }),
  changes: (limit = 50) =>
    fetch(withOntology(`${API}/ontology/changes?limit=${limit}`), {
      credentials: "include",
    }).then(j),
  updateChangeNote: (id, note) =>
    fetch(
      withOntology(`${API}/ontology/changes/${encodeURIComponent(id)}/note`),
      opts("PATCH", { note: note ?? null }),
    ).then(j),
  undoChange: (id) =>
    fetch(withOntology(`${API}/ontology/changes/${encodeURIComponent(id)}/undo`), opts("POST", {}))
      .then(j)
      .then((d) => {
        clearFetchCache("/ontology", "/graph");
        return d;
      }),

  // SPARQL
  sparqlQuery: (query, scoped = true) =>
    fetch(withOntology(`${API}/sparql/query`), opts("POST", { query, scoped })).then(j),
  sparqlUpdate: (update, scoped = true) =>
    fetch(withWriteOntology(`${API}/sparql/update`), opts("POST", { update, scoped }))
      .then(j)
      .then((d) => {
        clearFetchCache("/ontology", "/graph");
        return d;
      }),

  // Import/Export
  //
  // Three modes, selected by the `mode` option:
  //   'existing'    - replace or add into the currently-scoped ontology
  //   'new-ontology' - create a new ontology in the current project, seeded
  //                    from the file (default name = filename or opts.name)
  //   'new-project' - create a brand new project containing one ontology
  //                   seeded from the file
  importTtl: (file, { mode = "existing", replace = false, name, description, projectId } = {}) => {
    const fd = new FormData();
    fd.append("file", file);
    if (mode === "new-project") fd.append("new_project", "true");
    if (mode === "new-ontology") fd.append("new_ontology", "true");
    if (mode === "existing" && replace) fd.append("replace", "true");
    if (name) fd.append("name", name);
    if (description) fd.append("description", description);

    // New-project mode doesn't need any project context; for new-ontology we
    // need the target project id; existing mode uses the current scope.
    let url = `${API}/import/ttl`;
    if (mode === "new-project") {
      // No scope params.
    } else if (mode === "new-ontology") {
      const pid = projectId || currentProjectId;
      if (pid) url += `?project=${encodeURIComponent(pid)}`;
    } else {
      url = withWriteOntology(url);
    }
    return fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "X-Requested-With": "fetch" },
      body: fd,
    })
      .then(j)
      .then((d) => {
        clearFetchCache();
        return d;
      });
  },
  importFromUrl: (
    url,
    { mode = "existing", replace = false, name, description, projectId } = {},
  ) => {
    const payload = { url };
    if (mode === "new-project") payload.new_project = true;
    if (mode === "new-ontology") payload.new_ontology = true;
    if (mode === "existing" && replace) payload.replace = true;
    if (name) payload.name = name;
    if (description) payload.description = description;

    let apiUrl = `${API}/import/ttl`;
    if (mode === "new-project") {
      // no scope
    } else if (mode === "new-ontology") {
      const pid = projectId || currentProjectId;
      if (pid) apiUrl += `?project=${encodeURIComponent(pid)}`;
    } else {
      apiUrl = withWriteOntology(apiUrl);
    }
    return fetch(apiUrl, opts("POST", payload))
      .then(j)
      .then((d) => {
        clearFetchCache();
        return d;
      });
  },
  importTtlText: (
    text,
    {
      mode = "existing",
      format = "text/turtle",
      replace = false,
      name,
      description,
      projectId,
    } = {},
  ) => {
    const payload = { text, format };
    if (mode === "new-project") payload.new_project = true;
    if (mode === "new-ontology") payload.new_ontology = true;
    if (mode === "existing" && replace) payload.replace = true;
    if (name) payload.name = name;
    if (description) payload.description = description;

    let url = `${API}/import/ttl`;
    if (mode === "new-project") {
      // no scope
    } else if (mode === "new-ontology") {
      const pid = projectId || currentProjectId;
      if (pid) url += `?project=${encodeURIComponent(pid)}`;
    } else {
      url = withWriteOntology(url);
    }
    return fetch(url, opts("POST", payload))
      .then(j)
      .then((d) => {
        clearFetchCache();
        return d;
      });
  },
  exportUrl: (format = "text/turtle") =>
    withOntology(`${API}/import/export?format=${encodeURIComponent(format)}`),
  exportMarkdownUrl: () => withOntology(`${API}/ontology/export/markdown`),

  // Graph — cached; cleared by any ontology write above.
  graph: (mode = "classes", limit = 500) => {
    let url = withOntology(`${API}/graph/?mode=${mode}&limit=${limit}`);
    // Pass the write target so the server can prefer its labels over linked ontologies.
    if (currentWriteOntologyId)
      url += `&writeOntology=${encodeURIComponent(currentWriteOntologyId)}`;
    return cachedGet(url);
  },

  // Invites
  invitesList: () => fetch(`${API}/invites`, { credentials: "include" }).then(j),
  createInvite: (body) => fetch(`${API}/invites`, opts("POST", body)).then(j),
  revokeInvite: (token) =>
    fetch(`${API}/invites/${token}`, {
      method: "DELETE",
      credentials: "include",
      headers: { "X-Requested-With": "fetch" },
    }).then(j),
  inviteInfo: (token) => fetch(`${API}/invites/${token}/info`).then(j),
  acceptInvite: (token, body) =>
    fetch(`${API}/invites/${token}/accept`, opts("POST", body)).then(j),

  // Comments
  comments: (iri) => {
    const u = new URL(`${API}/comments`, window.location.origin);
    if (currentOntologyId) u.searchParams.set("ontology", currentOntologyId);
    if (iri !== undefined) u.searchParams.set("iri", iri || "");
    return fetch(u.toString().replace(window.location.origin, ""), {
      credentials: "include",
    }).then(j);
  },
  commentTargets: () =>
    fetch(withOntology(`${API}/comments/targets`), {
      credentials: "include",
    }).then(j),
  createComment: (body) => fetch(withWriteOntology(`${API}/comments`), opts("POST", body)).then(j),
  updateComment: (id, body) => fetch(`${API}/comments/${id}`, opts("PATCH", body)).then(j),
  deleteComment: (id) =>
    fetch(`${API}/comments/${id}`, {
      method: "DELETE",
      credentials: "include",
      headers: { "X-Requested-With": "fetch" },
    }).then(j),

  // All comments across a whole ontology (no iri filter) — used by ChatView.
  allComments: (ontologyId) => {
    const u = new URL(`${API}/comments`, window.location.origin);
    if (ontologyId) u.searchParams.set("ontology", ontologyId);
    return fetch(u.toString().replace(window.location.origin, ""), {
      credentials: "include",
    }).then(j);
  },

  // SWRL Rules
  rules: () => cachedGet(withOntology(`${API}/rules`)),
  getRule: (id) => cachedGet(withOntology(`${API}/rules/${encodeURIComponent(id)}`)),
  createRule: (body) =>
    fetch(withWriteOntology(`${API}/rules`), opts("POST", body))
      .then(j)
      .then((d) => {
        clearFetchCache("/rules", "/ontology");
        return d;
      }),
  updateRule: (id, body) =>
    fetch(withWriteOntology(`${API}/rules/${encodeURIComponent(id)}`), opts("PUT", body))
      .then(j)
      .then((d) => {
        clearFetchCache("/rules", "/ontology");
        return d;
      }),
  deleteRule: (id) =>
    fetch(withWriteOntology(`${API}/rules/${encodeURIComponent(id)}`), {
      method: "DELETE",
      credentials: "include",
      headers: { "X-Requested-With": "fetch" },
    })
      .then(j)
      .then((d) => {
        clearFetchCache("/rules", "/ontology");
        return d;
      }),

  // Administration (admin role only on the server)
  adminSystem: () => fetch(`${API}/admin/system`, { credentials: "include" }).then(j),
  adminSystemStorage: () =>
    fetch(`${API}/admin/system/storage`, { credentials: "include" }).then(j),
  adminProjects: () => fetch(`${API}/admin/projects`, { credentials: "include" }).then(j),
  adminChanges: (params = {}) => {
    const u = new URL(`${API}/admin/changes`, window.location.origin);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
    }
    return fetch(u.toString().replace(window.location.origin, ""), {
      credentials: "include",
    }).then(j);
  },
  adminSetRole: (userId, role) =>
    fetch(`${API}/admin/users/${userId}`, opts("PATCH", { role })).then(j),
  adminDeleteUser: (userId) =>
    fetch(`${API}/admin/users/${userId}`, {
      method: "DELETE",
      credentials: "include",
      headers: { "X-Requested-With": "fetch" },
    }).then(j),
  adminCreateUser: (body) => fetch(`${API}/admin/users`, opts("POST", body)).then(j),
  adminVacuum: () => fetch(`${API}/admin/maintenance/vacuum`, opts("POST", {})).then(j),
  adminGetSettings: () => fetch(`${API}/admin/settings`, { credentials: "include" }).then(j),
  adminUpdateSettings: (body) => fetch(`${API}/admin/settings`, opts("PATCH", body)).then(j),

  // ── GitHub integration ────────────────────────────────────────────────────
  connectGitHubPAT: (token) => fetch(`${API}/auth/github/pat`, opts("POST", { token })).then(j),
  disconnectGitHub: () =>
    fetch(`${API}/auth/github/connect`, {
      method: "DELETE",
      credentials: "include",
      headers: { "X-Requested-With": "fetch" },
    }).then(j),
  setProjectGitHub: (projectId, body) =>
    fetch(`${API}/projects/${projectId}/github`, opts("PATCH", body))
      .then(j)
      .then((d) => {
        clearFetchCache("/projects");
        return d;
      }),
  syncProjectFromGitHub: (projectId) =>
    fetch(`${API}/projects/${projectId}/github/sync`, opts("POST", {}))
      .then(j)
      .then((d) => {
        clearFetchCache("/projects");
        return d;
      }),
  syncProjectDiscussions: (projectId) =>
    fetch(`${API}/projects/${projectId}/github/discussions/sync`, opts("POST", {})).then(j),
  pushOntologyToGitHub: (projectId, ontologyId, body) =>
    fetch(
      `${API}/projects/${projectId}/ontologies/${ontologyId}/github/push`,
      opts("POST", body),
    ).then(j),
  createGitHubPR: (projectId, ontologyId, body) =>
    fetch(`${API}/projects/${projectId}/ontologies/${ontologyId}/github/pr`, opts("POST", body))
      .then(j)
      .then((d) => {
        clearFetchCache("/projects");
        return d;
      }),
  getProjectIssues: (projectId, { state = "open", page = 1 } = {}) =>
    fetch(
      `${API}/projects/${projectId}/github/issues?state=${state}&page=${page}`,
      opts("GET"),
    ).then(j),
  getProjectIssue: (projectId, number) =>
    fetch(`${API}/projects/${projectId}/github/issues/${number}`, opts("GET")).then(j),
  createProjectIssue: (projectId, body) =>
    fetch(`${API}/projects/${projectId}/github/issues`, opts("POST", body)).then(j),
  createIssueComment: (projectId, number, body) =>
    fetch(
      `${API}/projects/${projectId}/github/issues/${number}/comments`,
      opts("POST", { body }),
    ).then(j),
  compareOntologyWithGitHub: (projectId, ontologyId, { vsMain = false } = {}) =>
    fetch(
      `${API}/projects/${projectId}/github/compare/${ontologyId}${vsMain ? "?vsMain=true" : ""}`,
      { credentials: "include" },
    ).then(j),
  listGitHubBranches: (projectId) =>
    fetch(`${API}/projects/${projectId}/github/branches`, { credentials: "include" }).then(j),
  checkoutGitHubBranch: (projectId, ontologyId, body) =>
    fetch(
      `${API}/projects/${projectId}/ontologies/${ontologyId}/github/checkout`,
      opts("POST", body),
    ).then(j),
  chatStream: (messages, { model, ontologyId, entityIri } = {}, signal) =>
    fetch(`${API}/ai/chat`, {
      ...opts("POST", { messages, model, ontologyId, entityIri }),
      signal,
    }),
};

export function shortLabel(iri) {
  if (!iri) return "";
  // Split on the last '#', '/', or ':' so that URN-style IRIs like
  // urn:dataminr:COMMUNICATES_WITH render as just "COMMUNICATES_WITH".
  const m = iri.match(/[#/:]([^#/:]+)$/);
  return m ? m[1] : iri;
}

const RDFS_DOMAIN = "http://www.w3.org/2000/01/rdf-schema#domain";
const RDFS_RANGE = "http://www.w3.org/2000/01/rdf-schema#range";
// Schema.org equivalents — both http: and https: variants are in the wild.
const SCHEMA_DOMAIN_INCLUDES = "http://schema.org/domainIncludes";
const SCHEMA_RANGE_INCLUDES = "http://schema.org/rangeIncludes";
const SCHEMAS_DOMAIN_INCLUDES = "https://schema.org/domainIncludes";
const SCHEMAS_RANGE_INCLUDES = "https://schema.org/rangeIncludes";

/** Predicate IRI shown in triple UIs; maps rdfs:domain / rdfs:range (and their
 *  schema.org equivalents, both http and https) to terminology
 *  (Source/Target vs Domain/Range). */
export function predicateLabel(iri) {
  if (!iri) return "";
  if (iri === RDFS_DOMAIN || iri === SCHEMA_DOMAIN_INCLUDES || iri === SCHEMAS_DOMAIN_INCLUDES)
    return term("domain");
  if (iri === RDFS_RANGE || iri === SCHEMA_RANGE_INCLUDES || iri === SCHEMAS_RANGE_INCLUDES)
    return term("range");
  return shortLabel(iri);
}

// ---- Terminology helper (LPG Friendly names vs. OWL/RDF names) ----
// Stored in localStorage. "friendly" uses Relationship/Attribute/Source/Target,
// "rdf" uses Object Property / Datatype Property / Domain / Range.
const TERM_STORAGE_KEY = "ontology-editor:terminology";

const TERMS = {
  friendly: {
    objectproperty: "Relationship",
    objectpropertyplural: "Relationships",
    datatypeproperty: "Attribute",
    datatypepropertyplural: "Attributes",
    annotationproperty: "Annotation",
    annotationpropertyplural: "Annotations",
    property: "Property",
    propertiesplural: "Properties",
    class: "Entity",
    classplural: "Entities",
    individual: "Instance",
    individualplural: "Instances",
    domain: "Source",
    domainclassplural: "Source Entities",
    range: "Target",
    rangeclassplural: "Target Entities",
  },
  rdf: {
    objectproperty: "Object Property",
    objectpropertyplural: "Object Properties",
    datatypeproperty: "Datatype Property",
    datatypepropertyplural: "Datatype Properties",
    annotationproperty: "Annotation Property",
    annotationpropertyplural: "Annotation Properties",
    property: "Property",
    propertiesplural: "Properties",
    class: "Class",
    classplural: "Classes",
    individual: "Individual",
    individualplural: "Individuals",
    domain: "Domain",
    domainclassplural: "Domain Classes",
    range: "Range",
    rangeclassplural: "Range Classes",
  },
};

// Default new users to the RDF / OWL terminology ("Object Property", "Domain",
// "Individual"). Users can flip to the friendly ("Relationship", "Source",
// "Instance") set from Settings. Anyone who has already picked a preference
// keeps what they chose.
export function getTerminology() {
  try {
    return localStorage.getItem(TERM_STORAGE_KEY) || "rdf";
  } catch {
    return "rdf";
  }
}
export function setTerminology(t) {
  try {
    localStorage.setItem(TERM_STORAGE_KEY, t);
  } catch {}
}
export function term(key, mode = getTerminology()) {
  key = key.toLowerCase();
  return TERMS[mode]?.[key] || TERMS.rdf[key] || key;
}

const OWL_OBJECT_PROPERTY = "http://www.w3.org/2002/07/owl#ObjectProperty";
const OWL_DATATYPE_PROPERTY = "http://www.w3.org/2002/07/owl#DatatypeProperty";
const OWL_ANNOTATION_PROPERTY = "http://www.w3.org/2002/07/owl#AnnotationProperty";

/** Subject/object IRI in triple UIs; maps OWL metaclass IRIs to terminology (e.g. Relationship vs Object Property). */
export function resourceLabel(iri) {
  if (!iri) return "";
  if (iri === OWL_OBJECT_PROPERTY) return term("ObjectProperty");
  if (iri === OWL_DATATYPE_PROPERTY) return term("DatatypeProperty");
  if (iri === OWL_ANNOTATION_PROPERTY) return term("AnnotationProperty");
  return shortLabel(iri);
}

// ---- OWL 2 property characteristics ----
// Kept as a single source of truth; UI uses `name` as both storage token and
// i18n/label key. `kinds` restricts which property kinds may assert the
// characteristic (datatype/annotation props only support Functional).
export const PROPERTY_CHARACTERISTICS = [
  {
    name: "Functional",
    iri: "http://www.w3.org/2002/07/owl#FunctionalProperty",
    label: "Functional",
    tip: "At most one outgoing value per subject.",
    kinds: ["object", "datatype", "annotation"],
  },
  {
    name: "InverseFunctional",
    iri: "http://www.w3.org/2002/07/owl#InverseFunctionalProperty",
    label: "Inverse functional",
    tip: "At most one incoming value per subject.",
    kinds: ["object"],
  },
  {
    name: "Transitive",
    iri: "http://www.w3.org/2002/07/owl#TransitiveProperty",
    label: "Transitive",
    tip: "If A→B and B→C then A→C.",
    kinds: ["object"],
  },
  {
    name: "Symmetric",
    iri: "http://www.w3.org/2002/07/owl#SymmetricProperty",
    label: "Symmetric",
    tip: "If A→B then B→A (the property is its own inverse).",
    kinds: ["object"],
  },
  {
    name: "Asymmetric",
    iri: "http://www.w3.org/2002/07/owl#AsymmetricProperty",
    label: "Asymmetric",
    tip: "If A→B then not B→A.",
    kinds: ["object"],
  },
  {
    name: "Reflexive",
    iri: "http://www.w3.org/2002/07/owl#ReflexiveProperty",
    label: "Reflexive",
    tip: "Every individual is related to itself.",
    kinds: ["object"],
  },
  {
    name: "Irreflexive",
    iri: "http://www.w3.org/2002/07/owl#IrreflexiveProperty",
    label: "Irreflexive",
    tip: "No individual is related to itself.",
    kinds: ["object"],
  },
];

export const PROPERTY_CHARACTERISTIC_IRIS = new Set(PROPERTY_CHARACTERISTICS.map((c) => c.iri));

/** Returns the list of characteristics assertable for a given property kind.
 *  Unknown/generic 'property' is treated as 'object' — the most permissive
 *  option, matching how Protégé presents properties whose kind can't yet be
 *  determined. */
export function allowedCharacteristics(kind) {
  const k = kind === "property" || !kind ? "object" : kind;
  return PROPERTY_CHARACTERISTICS.filter((c) => c.kinds.includes(k));
}

// ---- Axiom predicates managed via PUT /ontology/relations ----
// These are the four whitelisted predicates the generic relations endpoint
// accepts. `symmetric` matches the server semantics: both directions are
// considered the same axiom; UI reads and displays a merged set.
export const OWL_INVERSE_OF = "http://www.w3.org/2002/07/owl#inverseOf";
export const RDFS_SUB_PROPERTY_OF = "http://www.w3.org/2000/01/rdf-schema#subPropertyOf";
export const OWL_EQUIVALENT_CLASS = "http://www.w3.org/2002/07/owl#equivalentClass";
export const OWL_DISJOINT_WITH = "http://www.w3.org/2002/07/owl#disjointWith";

// Predicates that get their own dedicated chip rows on the EntityDetail page
// AND should therefore be filtered out of the generic "outgoing triples" list
// so each axiom shows up exactly once.
export const AXIOM_PREDICATE_IRIS = new Set([
  OWL_INVERSE_OF,
  RDFS_SUB_PROPERTY_OF,
  OWL_EQUIVALENT_CLASS,
  OWL_DISJOINT_WITH,
]);

// ---- Annotation predicates surfaced as their own rows on EntityDetail ----
// Unlike axioms, these are plain RDF annotations. seeAlso/isDefinedBy take an
// IRI target (usually external, e.g. a doc URL) and are managed through
// PUT /relations. Deprecation is a boolean flag managed via a dedicated
// PUT /entity/deprecated endpoint.
export const RDFS_SEE_ALSO = "http://www.w3.org/2000/01/rdf-schema#seeAlso";
export const RDFS_IS_DEFINED_BY = "http://www.w3.org/2000/01/rdf-schema#isDefinedBy";
export const OWL_DEPRECATED = "http://www.w3.org/2002/07/owl#deprecated";

// SKOS predicates treated as primary content fields (handled by BasicSection
// in EntityDetail, not by the generic Advanced section).
export const SKOS_PREF_LABEL = "http://www.w3.org/2004/02/skos/core#prefLabel";
export const SKOS_ALT_LABEL = "http://www.w3.org/2004/02/skos/core#altLabel";
export const SKOS_DEFINITION = "http://www.w3.org/2004/02/skos/core#definition";
export const SKOS_SCOPE_NOTE = "http://www.w3.org/2004/02/skos/core#scopeNote";

// Predicates with a dedicated chip row in EntityDetail's Annotations section;
// filter these out of the generic "outgoing triples" list so they don't render
// twice.
export const ANNOTATION_PREDICATE_IRIS = new Set([
  RDFS_SEE_ALSO,
  RDFS_IS_DEFINED_BY,
  OWL_DEPRECATED,
]);
