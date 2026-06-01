import { useState } from "react";
import { api, shortLabel } from "../lib/api.js";

const SAMPLES = {
  "All classes": `PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?class ?label WHERE {
  ?class a owl:Class .
  OPTIONAL { ?class rdfs:label ?label }
} LIMIT 100`,
  "Class hierarchy": `PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?child ?parent WHERE {
  ?child rdfs:subClassOf ?parent .
  ?child a owl:Class . ?parent a owl:Class .
} LIMIT 200`,
  "Object properties": `PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?p ?domain ?range WHERE {
  ?p a owl:ObjectProperty .
  OPTIONAL { ?p rdfs:domain ?domain }
  OPTIONAL { ?p rdfs:range ?range }
} LIMIT 100`,
  "Count triples": `SELECT (COUNT(*) AS ?count) WHERE { ?s ?p ?o }`,
};

export default function SparqlView({ onChange }) {
  const [query, setQuery] = useState(SAMPLES["All classes"]);
  const [mode, setMode] = useState("query");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (mode === "query") {
        const r = await api.sparqlQuery(query);
        setResult(r);
      } else {
        await api.sparqlUpdate(query);
        setResult({ type: "update", ok: true });
        onChange?.();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b border-ink-700 bg-ink-900/60 px-4 py-2 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 p-0.5 bg-ink-800 rounded-md border border-ink-600/50">
          <button
            type="button"
            onClick={() => setMode("query")}
            className={`px-3 py-1 text-xs rounded-sm ${mode === "query" ? "bg-brand-600 text-white" : "text-slate-300 hover:bg-ink-700"}`}
          >
            Query
          </button>
          <button
            type="button"
            onClick={() => setMode("update")}
            className={`px-3 py-1 text-xs rounded-sm ${mode === "update" ? "bg-brand-600 text-white" : "text-slate-300 hover:bg-ink-700"}`}
          >
            Update
          </button>
        </div>
        <select
          className="input max-w-xs"
          onChange={(e) => e.target.value && setQuery(SAMPLES[e.target.value])}
          defaultValue=""
        >
          <option value="">Load sample…</option>
          {Object.keys(SAMPLES).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <div className="ml-auto">
          <button type="button" className="btn-primary" onClick={run} disabled={busy}>
            {busy ? "…" : mode === "query" ? "Run query" : "Run update"}
          </button>
        </div>
      </div>

      <div className="grid grid-rows-[1fr_1fr] flex-1 min-h-0">
        <div className="border-b border-ink-700">
          <textarea
            className="w-full h-full p-4 font-mono text-sm bg-ink-950 text-slate-100 outline-hidden resize-none"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="overflow-auto p-4">
          {error && <div className="panel p-3 text-sm text-red-300 border-red-500/60">{error}</div>}
          {result && <ResultView r={result} />}
          {!error && !result && (
            <div className="text-sm text-slate-500">Results will appear here.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function ResultView({ r }) {
  if (r.type === "update") return <div className="text-sm text-emerald-300">Update applied.</div>;
  if (r.type === "boolean")
    return (
      <div className="text-sm">
        Result:{" "}
        <span className={r.value ? "text-emerald-300" : "text-red-300"}>{String(r.value)}</span>
      </div>
    );
  if (r.type === "empty") return <div className="text-sm text-slate-500">No results.</div>;
  if (r.type === "bindings") {
    return (
      <div className="panel">
        <div className="text-xs text-slate-400 px-3 py-2 border-b border-ink-700">
          {r.rows.length} row{r.rows.length === 1 ? "" : "s"}
        </div>
        <div className="overflow-auto">
          <table className="min-w-full text-sm font-mono">
            <thead className="bg-ink-800/60 sticky top-0">
              <tr>
                {r.vars.map((v) => (
                  <th
                    key={v}
                    className="text-left px-3 py-2 border-b border-ink-700 text-brand-200"
                  >
                    ?{v}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.rows.map((row, i) => (
                <tr
                  key={r.vars.map((v) => row[v]?.value ?? "").join("|") || i}
                  className="hover:bg-ink-800/40"
                >
                  {r.vars.map((v) => (
                    <td key={v} className="px-3 py-1.5 border-b border-ink-800 break-all">
                      {termCell(row[v])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  if (r.type === "graph") {
    return (
      <div className="panel">
        <div className="text-xs text-slate-400 px-3 py-2 border-b border-ink-700">
          {r.quads.length} triple{r.quads.length === 1 ? "" : "s"}
        </div>
        <div className="overflow-auto">
          <table className="min-w-full text-sm font-mono">
            <tbody>
              {r.quads.map((q) => (
                <tr
                  key={`${q.subject?.value}|${q.predicate?.value}|${q.object?.value}`}
                  className="hover:bg-ink-800/40"
                >
                  <td className="px-3 py-1.5 border-b border-ink-800 text-amber-300">
                    {shortLabel(q.subject?.value)}
                  </td>
                  <td className="px-3 py-1.5 border-b border-ink-800 text-brand-300">
                    {shortLabel(q.predicate?.value)}
                  </td>
                  <td className="px-3 py-1.5 border-b border-ink-800 break-all">
                    {termCell(q.object)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  return <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(r, null, 2)}</pre>;
}

function termCell(t) {
  if (!t) return <span className="text-slate-500">—</span>;
  if (t.type === "literal")
    return (
      <span className="text-emerald-300">
        "{t.value}"{t.language ? `@${t.language}` : ""}
      </span>
    );
  if (t.type === "bnode") return <span className="text-slate-400">_:{t.value}</span>;
  return (
    <span className="text-slate-200" title={t.value}>
      {shortLabel(t.value)}
    </span>
  );
}
