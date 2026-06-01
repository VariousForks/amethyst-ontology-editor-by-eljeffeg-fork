/**
 * In-process result cache for SPARQL read queries.
 *
 * Why this exists:
 *   The Oxigraph store lives in memory on the server process, so queries are
 *   CPU-bound — not I/O-bound. On a local machine that CPU cost is negligible,
 *   but in the cloud (Cloud Run, ECS, etc.) each request may arrive on a cold
 *   CPU and even a fast in-memory SPARQL query has measurable overhead when 4-6
 *   queries are chained serially for a single page load. This cache eliminates
 *   that overhead for repeated reads of the same scope within a short window.
 *
 * Invalidation:
 *   Every write that calls rdfStore.update(query, ontologyId) automatically
 *   evicts all cache entries that were scoped to that ontologyId, so stale
 *   reads are impossible beyond the TTL window (and in practice the cache is
 *   cleared immediately on write).
 *
 * Sizing:
 *   MAX_ENTRIES caps memory usage. At ~2 KB per cached result, 500 entries ≈ 1 MB.
 */

const DEFAULT_TTL_MS = parseInt(process.env.QUERY_CACHE_TTL_MS || "15000", 10);
const MAX_ENTRIES = parseInt(process.env.QUERY_CACHE_MAX_ENTRIES || "500", 10);

// key -> { value, expiresAt, ontologyIds: Set<string> }
const _cache = new Map();
// ontologyId -> Set<key>  — reverse index for fast invalidation
const _byOntology = new Map();

function scopeToIds(scope) {
  if (!scope) return [];
  if (Array.isArray(scope)) return scope.filter(Boolean);
  return [scope];
}

export function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    _evictKey(key);
    return undefined;
  }
  return entry.value;
}

export function cacheSet(key, value, scope, ttlMs = DEFAULT_TTL_MS) {
  // Simple eviction: remove the oldest entry when at capacity.
  if (_cache.size >= MAX_ENTRIES && !_cache.has(key)) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _evictKey(oldest);
  }

  const ids = scopeToIds(scope);
  _cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
    ontologyIds: new Set(ids),
  });

  for (const id of ids) {
    if (!_byOntology.has(id)) _byOntology.set(id, new Set());
    _byOntology.get(id).add(key);
  }
}

/** Evict every cached result that was derived from `ontologyId`. */
export function cacheInvalidate(ontologyId) {
  if (!ontologyId) return;
  const keys = _byOntology.get(ontologyId);
  if (!keys) return;
  // Copy to avoid mutating while iterating (evictKey removes from the set).
  for (const key of [...keys]) _evictKey(key);
  _byOntology.delete(ontologyId);
}

/** Flush the entire cache (useful in tests or after a bulk import). */
export function cacheClear() {
  _cache.clear();
  _byOntology.clear();
}

function _evictKey(key) {
  const entry = _cache.get(key);
  if (!entry) return;
  for (const id of entry.ontologyIds) {
    const s = _byOntology.get(id);
    if (s) {
      s.delete(key);
      if (s.size === 0) _byOntology.delete(id);
    }
  }
  _cache.delete(key);
}
