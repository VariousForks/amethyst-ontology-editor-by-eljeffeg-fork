import { Check } from "lucide-react";
import { useState } from "react";
import { setTerminology } from "../lib/api.js";

/**
 * Shown once on first login (when no terminology preference has been saved).
 * Lets the user pick LPG-friendly or RDF/OWL terms before entering the app.
 */
export default function TerminologyOnboardModal({ onDone }) {
  const [selected, setSelected] = useState(null);

  const confirm = () => {
    const choice = selected || "rdf";
    setTerminology(choice);
    onDone();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl border border-ink-600/60 bg-ink-900 shadow-2xl p-6 space-y-5">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-white">Choose your terminology</h2>
          <p className="text-sm text-slate-400">
            Pick the label style you prefer. You can always change this later in{" "}
            <span className="text-slate-300">Settings → Terminology</span>.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <TermOption
            selected={selected === "friendly"}
            onSelect={() => setSelected("friendly")}
            title="LPG Friendly"
            items={[
              ["Object Property", "→ Relationship"],
              ["Datatype Property", "→ Attribute"],
              ["Domain", "→ Source"],
              ["Range", "→ Target"],
              ["Class", "→ Entity"],
              ["Individual", "→ Instance"],
            ]}
          />
          <TermOption
            selected={selected === "rdf"}
            onSelect={() => setSelected("rdf")}
            title="RDF / OWL (standard)"
            items={[
              ["Object Property"],
              ["Datatype Property"],
              ["Domain"],
              ["Range"],
              ["Class"],
              ["Individual"],
            ]}
          />
        </div>

        <div className="flex justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={confirm}
            className="btn-primary text-sm"
            disabled={!selected}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

function TermOption({ selected, onSelect, title, items }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`text-left rounded-md border p-4 space-y-2 transition
        ${selected ? "bg-brand-600/20 border-brand-500/60" : "bg-ink-800/50 border-ink-600/50 hover:bg-ink-700/60"}`}
    >
      <div className="flex items-center justify-between">
        <div className="font-semibold text-sm">{title}</div>
        {selected && <Check size={15} className="text-brand-200" aria-hidden="true" />}
      </div>
      <ul className="text-xs text-slate-300 space-y-0.5">
        {items.map(([a, b]) => (
          <li key={a}>
            <span className="text-slate-400">{a}</span>
            {b ? <span className="ml-1 text-brand-200">{b}</span> : null}
          </li>
        ))}
      </ul>
    </button>
  );
}
