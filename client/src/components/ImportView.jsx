import { useState } from "react";
import { api } from "../lib/api.js";
import { useProject } from "./OntologyPicker.jsx";

export default function ImportView({ onChange }) {
  const { currentProject, currentOntology, unionMode, refresh: refreshProjects } = useProject();

  // Mode:
  //   'existing'     – import into the current ontology
  //   'new-ontology' – add a new ontology to the current project
  //   'new-project'  – create a new project seeded from the file
  const [mode, setMode] = useState("existing");

  // Source:
  //   'file' – multipart file upload
  //   'url'  – fetch from a remote URL (+ chase owl:imports)
  const [source, setSource] = useState("file");

  const [file, setFile] = useState(null);
  const [url, setUrl] = useState("");
  const [replace, setReplace] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [format, setFormat] = useState("text/turtle");

  const canImportExisting = !unionMode && !!currentOntology;

  const submit = async (e) => {
    e.preventDefault();

    if (source === "file" && !file) {
      setErr("Choose a file");
      return;
    }
    if (source === "url") {
      const trimmed = url.trim();
      if (!trimmed) {
        setErr("Enter a URL");
        return;
      }
      try {
        new URL(trimmed); // validate
      } catch {
        setErr("Enter a valid URL (must start with http:// or https://)");
        return;
      }
    }
    if (mode === "existing" && !canImportExisting) {
      setErr(
        unionMode
          ? 'Pick a single ontology before importing into it (or switch to "Add new ontology").'
          : "No ontology is currently selected.",
      );
      return;
    }
    setErr(null);
    setOk(null);
    setWarnings([]);
    setBusy(true);
    try {
      const opts = {
        mode,
        replace: mode === "existing" ? replace : false,
        name: name || undefined,
        description: description || undefined,
      };

      const r =
        source === "url"
          ? await api.importFromUrl(url.trim(), opts)
          : await api.importTtl(file, opts);

      // Friendly feedback + switch scope to the freshly-loaded ontology.
      const siblingMsg =
        r.importedOntologies?.length > 0
          ? ` Also added ${r.importedOntologies.length} imported ontolog${r.importedOntologies.length === 1 ? "y" : "ies"} (owl:imports).`
          : "";
      if (r.mode === "new-project") {
        setOk(`Created project "${r.project?.name}" with ${r.added} triples.${siblingMsg}`);
        await refreshProjects({
          projectId: r.project?.id,
          ontologyId: r.ontology?.id,
        });
      } else if (r.mode === "new-ontology") {
        setOk(`Added ontology "${r.ontology?.name}" with ${r.added} triples.${siblingMsg}`);
        // Refresh the project list without switching the write target so the
        // user's current working ontology stays selected after the import.
        await refreshProjects();
      } else {
        setOk(`Imported ${r.added} new triples. Total: ${r.totalTriples}.${siblingMsg}`);
        await refreshProjects();
      }
      // Surface any owl:imports that the server tried but couldn't load.
      if (r.failedImports?.length > 0) {
        setWarnings(r.failedImports);
      }
      onChange?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="p-6 max-w-3xl mx-auto space-y-6">
        <div>
          <h2 className="text-xl font-semibold mb-1">Import / Export</h2>
          <p className="text-sm text-slate-400">
            Load RDF into an ontology, add a new ontology to this project, or start a new project
            from a file or URL.
          </p>
        </div>

        <section className="panel p-5 space-y-4">
          <h3 className="font-semibold">Import RDF</h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <ModeCard
              active={mode === "existing"}
              onClick={() => setMode("existing")}
              title="Into current ontology"
              sub={
                canImportExisting
                  ? currentOntology?.name || ""
                  : unionMode
                    ? "Disabled in union scope"
                    : "No ontology selected"
              }
              disabled={!canImportExisting}
            />
            <ModeCard
              active={mode === "new-ontology"}
              onClick={() => setMode("new-ontology")}
              title="Add new ontology"
              sub={currentProject ? `to ${currentProject.name}` : ""}
              disabled={!currentProject}
            />
            <ModeCard
              active={mode === "new-project"}
              onClick={() => setMode("new-project")}
              title="Create new project"
              sub="Seeded from this file"
            />
          </div>

          {/* Source toggle: File vs URL */}
          <div className="flex items-center gap-1 p-1 bg-ink-900/60 rounded-md w-fit">
            <SourceTab
              active={source === "file"}
              onClick={() => setSource("file")}
              label="File upload"
            />
            <SourceTab
              active={source === "url"}
              onClick={() => setSource("url")}
              label="From URL"
            />
          </div>

          {source === "file" && (
            <p className="text-sm text-slate-400">
              Supported:{" "}
              <code className="font-mono text-xs bg-ink-800 px-1.5 py-0.5 rounded-sm">.ttl</code>,
              <code className="font-mono text-xs bg-ink-800 px-1.5 py-0.5 rounded-sm ml-1">
                .nt
              </code>
              ,
              <code className="font-mono text-xs bg-ink-800 px-1.5 py-0.5 rounded-sm ml-1">
                .nq
              </code>
              ,
              <code className="font-mono text-xs bg-ink-800 px-1.5 py-0.5 rounded-sm ml-1">
                .trig
              </code>
              ,
              <code className="font-mono text-xs bg-ink-800 px-1.5 py-0.5 rounded-sm ml-1">
                .rdf
              </code>
              ,
              <code className="font-mono text-xs bg-ink-800 px-1.5 py-0.5 rounded-sm ml-1">
                .jsonld
              </code>
              . Any{" "}
              <code className="font-mono text-xs bg-ink-800 px-1.5 py-0.5 rounded-sm">
                owl:imports
              </code>{" "}
              declared in the file will be fetched from the web and added as separate ontologies.
            </p>
          )}

          {source === "url" && (
            <p className="text-sm text-slate-400">
              The server will fetch the URL and automatically pull in any{" "}
              <code className="font-mono text-xs bg-ink-800 px-1.5 py-0.5 rounded-sm">
                owl:imports
              </code>{" "}
              declared in the ontology, each as a separate ontology.
            </p>
          )}

          <form onSubmit={submit} className="space-y-3">
            {source === "file" ? (
              <label className="block">
                <span className="label">File</span>
                <input
                  type="file"
                  className="input file:mr-3 file:px-2 file:py-1 file:rounded-sm file:border-0 file:bg-brand-600 file:text-white hover:file:bg-brand-500"
                  accept=".ttl,.nt,.nq,.trig,.rdf,.xml,.n3,.jsonld,.json"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </label>
            ) : (
              <label className="block">
                <span className="label">URL</span>
                <input
                  type="url"
                  className="input"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.org/ontology.ttl"
                  spellCheck={false}
                />
              </label>
            )}

            {mode === "existing" && (
              <>
                <label className="block">
                  <span className="label">Ontology name (optional, updates metadata)</span>
                  <input
                    className="input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My Ontology"
                  />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={replace}
                    onChange={(e) => setReplace(e.target.checked)}
                  />
                  Replace existing data (clears the ontology first)
                </label>
              </>
            )}

            {mode === "new-ontology" && (
              <>
                <label className="block">
                  <span className="label">New ontology name (optional, defaults to filename)</span>
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="block">
                  <span className="label">Description (optional)</span>
                  <textarea
                    className="input min-h-15"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </label>
              </>
            )}

            {mode === "new-project" && (
              <>
                <label className="block">
                  <span className="label">New project name (optional, defaults to filename)</span>
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="block">
                  <span className="label">Description (optional)</span>
                  <textarea
                    className="input min-h-15"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </label>
              </>
            )}

            {err && <div className="text-sm text-red-300">{err}</div>}
            {ok && <div className="text-sm text-emerald-300">{ok}</div>}
            {warnings.length > 0 && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/8 p-3 space-y-1">
                <div className="text-xs font-semibold text-amber-300 uppercase tracking-wide">
                  ⚠ {warnings.length} owl:import{warnings.length > 1 ? "s" : ""} could not be
                  fetched
                </div>
                {warnings.map((w) => (
                  <div key={w.iri} className="text-xs text-amber-200/80">
                    <span className="font-mono break-all">{w.iri}</span>
                    {w.error && <span className="text-amber-400/70 ml-1">— {w.error}</span>}
                  </div>
                ))}
              </div>
            )}
            <button
              type="submit"
              className="btn-primary"
              disabled={busy || (mode === "existing" && !canImportExisting)}
            >
              {busy ? "Importing…" : buttonLabel(mode)}
            </button>
          </form>
        </section>

        <section className="panel p-5 space-y-4">
          <h3 className="font-semibold">Export</h3>
          {unionMode ? (
            <div className="text-sm text-slate-400">
              Union scope is selected — exporting a single file would mix ontologies. Pick a
              specific ontology from the sidebar to export it.
            </div>
          ) : !currentOntology ? (
            <div className="text-sm text-slate-400">No ontology is selected.</div>
          ) : (
            <div className="flex items-end gap-3">
              <label className="block flex-1">
                <span className="label">Format</span>
                <select
                  className="input"
                  value={format}
                  onChange={(e) => setFormat(e.target.value)}
                >
                  <option value="text/turtle">Turtle (.ttl)</option>
                  <option value="application/n-triples">N-Triples (.nt)</option>
                  <option value="application/n-quads">N-Quads (.nq)</option>
                  <option value="application/rdf+xml">RDF/XML (.rdf)</option>
                </select>
              </label>
              <a className="btn-primary" href={api.exportUrl(format)} download>
                Download
              </a>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function SourceTab({ active, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-sm rounded transition font-medium
        ${active ? "bg-brand-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"}`}
    >
      {label}
    </button>
  );
}

function ModeCard({ active, onClick, title, sub, disabled }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`text-left p-3 rounded-md border transition
        ${
          active
            ? "bg-brand-600/15 border-brand-500/50 text-brand-100"
            : "bg-ink-900/40 border-ink-700 text-slate-300 hover:bg-ink-800/60"
        }
        ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <div className="font-medium text-sm">{title}</div>
      {sub && <div className="text-xs text-slate-400 mt-0.5 truncate">{sub}</div>}
    </button>
  );
}

function buttonLabel(mode) {
  switch (mode) {
    case "new-project":
      return "Create project";
    case "new-ontology":
      return "Add ontology";
    default:
      return "Import";
  }
}
