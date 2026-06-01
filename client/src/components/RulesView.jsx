import { ChevronDown, ChevronUp, ClipboardCheck, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, shortLabel } from "../lib/api.js";

// ── SWRL Built-in catalogue ───────────────────────────────────────────────────
// Groups of swrlb: built-ins with their expected argument count.
const SWRL_BUILTINS = [
  // Comparison
  { name: "equal", label: "equal", group: "Comparison", argCount: 2 },
  { name: "notEqual", label: "notEqual", group: "Comparison", argCount: 2 },
  { name: "lessThan", label: "lessThan", group: "Comparison", argCount: 2 },
  {
    name: "lessThanOrEqual",
    label: "lessThanOrEqual",
    group: "Comparison",
    argCount: 2,
  },
  {
    name: "greaterThan",
    label: "greaterThan",
    group: "Comparison",
    argCount: 2,
  },
  {
    name: "greaterThanOrEqual",
    label: "greaterThanOrEqual",
    group: "Comparison",
    argCount: 2,
  },
  // Math
  { name: "add", label: "add", group: "Math", argCount: 3 },
  { name: "subtract", label: "subtract", group: "Math", argCount: 3 },
  { name: "multiply", label: "multiply", group: "Math", argCount: 3 },
  { name: "divide", label: "divide", group: "Math", argCount: 3 },
  { name: "mod", label: "mod", group: "Math", argCount: 3 },
  { name: "pow", label: "pow", group: "Math", argCount: 3 },
  { name: "abs", label: "abs", group: "Math", argCount: 2 },
  { name: "ceiling", label: "ceiling", group: "Math", argCount: 2 },
  { name: "floor", label: "floor", group: "Math", argCount: 2 },
  { name: "round", label: "round", group: "Math", argCount: 2 },
  // String
  { name: "stringConcat", label: "stringConcat", group: "String", argCount: 3 },
  { name: "stringLength", label: "stringLength", group: "String", argCount: 2 },
  { name: "contains", label: "contains", group: "String", argCount: 2 },
  { name: "startsWith", label: "startsWith", group: "String", argCount: 2 },
  { name: "endsWith", label: "endsWith", group: "String", argCount: 2 },
  { name: "upperCase", label: "upperCase", group: "String", argCount: 2 },
  { name: "lowerCase", label: "lowerCase", group: "String", argCount: 2 },
  { name: "matches", label: "matches (regex)", group: "String", argCount: 2 },
  {
    name: "normalizeSpace",
    label: "normalizeSpace",
    group: "String",
    argCount: 2,
  },
  // Boolean
  { name: "booleanNot", label: "booleanNot", group: "Boolean", argCount: 2 },
  // Date/Time
  { name: "year", label: "year", group: "Date/Time", argCount: 2 },
  { name: "month", label: "month", group: "Date/Time", argCount: 2 },
  { name: "day", label: "day", group: "Date/Time", argCount: 2 },
  { name: "hour", label: "hour", group: "Date/Time", argCount: 2 },
  { name: "minute", label: "minute", group: "Date/Time", argCount: 2 },
  { name: "second", label: "second", group: "Date/Time", argCount: 2 },
];

// Pre-grouped for rendering <optgroup> elements without inline reduce.
const SWRL_BUILTINS_BY_GROUP = SWRL_BUILTINS.reduce((acc, b) => {
  if (!acc[b.group]) acc[b.group] = [];
  acc[b.group].push(b);
  return acc;
}, {});

// ── Atom type options ─────────────────────────────────────────────────────────
const ATOM_TYPES = [
  { value: "class", label: "Class Atom" },
  { value: "objectProperty", label: "Object Property Atom" },
  { value: "datatypeProperty", label: "Datatype Property Atom" },
  { value: "builtin", label: "Built-in Atom (swrlb:)" },
  { value: "sameAs", label: "sameAs(?x, ?y)" },
  { value: "differentFrom", label: "differentFrom(?x, ?y)" },
];

// ── Default atom shapes ───────────────────────────────────────────────────────
function defaultAtom(type = "class") {
  // Each atom gets a stable local id so React can key on it instead of index.
  const _id = crypto.randomUUID();
  switch (type) {
    case "class":
      return { _id, type: "class", classIri: "", arg1: "?x" };
    case "objectProperty":
      return {
        _id,
        type: "objectProperty",
        propertyIri: "",
        arg1: "?x",
        arg2: "?y",
      };
    case "datatypeProperty":
      return {
        _id,
        type: "datatypeProperty",
        propertyIri: "",
        arg1: "?x",
        arg2: "?val",
        datatype: "",
      };
    case "builtin":
      return {
        _id,
        type: "builtin",
        builtin: "greaterThan",
        args: ["?x", "?y"],
      };
    case "sameAs":
      return { _id, type: "sameAs", arg1: "?x", arg2: "?y" };
    case "differentFrom":
      return { _id, type: "differentFrom", arg1: "?x", arg2: "?y" };
    default:
      return { _id, type: "class", classIri: "", arg1: "?x" };
  }
}

// ── SWRL Text Preview ─────────────────────────────────────────────────────────
function atomToText(atom, classes, properties) {
  const classLabel = (iri) => {
    if (!iri) return "?";
    const found = classes.find((c) => c.iri === iri);
    return found ? found.label || shortLabel(iri) : shortLabel(iri);
  };
  const propLabel = (iri) => {
    if (!iri) return "?";
    const found = properties.find((p) => p.iri === iri);
    return found ? found.label || shortLabel(iri) : shortLabel(iri);
  };

  switch (atom.type) {
    case "class":
      return `${classLabel(atom.classIri)}(${atom.arg1 || "?x"})`;
    case "objectProperty":
      return `${propLabel(atom.propertyIri)}(${atom.arg1 || "?x"}, ${atom.arg2 || "?y"})`;
    case "datatypeProperty":
      return `${propLabel(atom.propertyIri)}(${atom.arg1 || "?x"}, ${atom.arg2 || "?val"})`;
    case "builtin":
      return `swrlb:${atom.builtin || "?"}(${(atom.args || []).join(", ")})`;
    case "sameAs":
      return `sameAs(${atom.arg1 || "?x"}, ${atom.arg2 || "?y"})`;
    case "differentFrom":
      return `differentFrom(${atom.arg1 || "?x"}, ${atom.arg2 || "?y"})`;
    default:
      return "?";
  }
}

function ruleToText(antecedent, consequent, classes, properties) {
  const lhs = antecedent.map((a) => atomToText(a, classes, properties)).join(" ∧ ");
  const rhs = consequent.map((a) => atomToText(a, classes, properties)).join(" ∧ ");
  if (!lhs && !rhs) return "";
  return `${lhs || "∅"} → ${rhs || "∅"}`;
}

// ── A single atom row ─────────────────────────────────────────────────────────
function AtomRow({ atom, onChange, onRemove, classes, properties, idx }) {
  const objectProps = properties.filter((p) => p.kind === "object");
  const dataProps = properties.filter((p) => p.kind === "datatype" || p.kind === "annotation");

  const update = (patch) => onChange({ ...atom, ...patch });

  const builtinInfo = SWRL_BUILTINS.find((b) => b.name === atom.builtin);
  const builtinArgCount = builtinInfo?.argCount ?? 2;

  // Ensure args array matches expected builtin arg count
  const syncedArgs = (atom.args || []).slice();
  while (syncedArgs.length < builtinArgCount) syncedArgs.push("?x");

  return (
    <div className="flex gap-2 items-start p-2 rounded-lg bg-ink-900/60 border border-ink-700/60 group">
      {/* Atom index badge */}
      <span className="shrink-0 mt-1.5 w-5 h-5 rounded-full bg-ink-800 text-slate-500 text-[10px] flex items-center justify-center font-mono select-none">
        {idx + 1}
      </span>

      {/* Type selector */}
      <div className="shrink-0">
        <select
          value={atom.type}
          onChange={(e) => onChange(defaultAtom(e.target.value))}
          className="input text-xs py-1 h-7"
        >
          {ATOM_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {/* Atom-type specific fields */}
      <div className="flex-1 flex flex-wrap gap-2 items-center min-w-0">
        {atom.type === "class" && (
          <>
            <select
              value={atom.classIri}
              onChange={(e) => update({ classIri: e.target.value })}
              className="input text-xs py-1 h-7 flex-1 min-w-32"
            >
              <option value="">— select class —</option>
              {classes.map((c) => (
                <option key={c.iri} value={c.iri}>
                  {c.label || shortLabel(c.iri)}
                </option>
              ))}
            </select>
            <span className="text-slate-500 text-xs">(</span>
            <VarInput value={atom.arg1} onChange={(v) => update({ arg1: v })} placeholder="?x" />
            <span className="text-slate-500 text-xs">)</span>
          </>
        )}

        {atom.type === "objectProperty" && (
          <>
            <select
              value={atom.propertyIri}
              onChange={(e) => update({ propertyIri: e.target.value })}
              className="input text-xs py-1 h-7 flex-1 min-w-32"
            >
              <option value="">— select object property —</option>
              {objectProps.map((p) => (
                <option key={p.iri} value={p.iri}>
                  {p.label || shortLabel(p.iri)}
                </option>
              ))}
            </select>
            <span className="text-slate-500 text-xs">(</span>
            <VarInput value={atom.arg1} onChange={(v) => update({ arg1: v })} placeholder="?x" />
            <span className="text-slate-500 text-xs">,</span>
            <VarInput value={atom.arg2} onChange={(v) => update({ arg2: v })} placeholder="?y" />
            <span className="text-slate-500 text-xs">)</span>
          </>
        )}

        {atom.type === "datatypeProperty" && (
          <>
            <select
              value={atom.propertyIri}
              onChange={(e) => update({ propertyIri: e.target.value })}
              className="input text-xs py-1 h-7 flex-1 min-w-32"
            >
              <option value="">— select datatype property —</option>
              {dataProps.map((p) => (
                <option key={p.iri} value={p.iri}>
                  {p.label || shortLabel(p.iri)}
                </option>
              ))}
            </select>
            <span className="text-slate-500 text-xs">(</span>
            <VarInput value={atom.arg1} onChange={(v) => update({ arg1: v })} placeholder="?x" />
            <span className="text-slate-500 text-xs">,</span>
            <VarInput
              value={atom.arg2}
              onChange={(v) => update({ arg2: v })}
              placeholder="?val or literal"
            />
            <span className="text-slate-500 text-xs">)</span>
          </>
        )}

        {atom.type === "builtin" && (
          <>
            <span className="text-slate-500 text-[10px] shrink-0">swrlb:</span>
            <select
              value={atom.builtin}
              onChange={(e) => {
                const bi = SWRL_BUILTINS.find((b) => b.name === e.target.value);
                const newCount = bi?.argCount ?? 2;
                const newArgs = [...(atom.args || [])];
                while (newArgs.length < newCount) newArgs.push("?x");
                update({
                  builtin: e.target.value,
                  args: newArgs.slice(0, newCount),
                });
              }}
              className="input text-xs py-1 h-7"
            >
              {Object.entries(SWRL_BUILTINS_BY_GROUP).map(([group, items]) => (
                <optgroup key={group} label={group}>
                  {items.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <span className="text-slate-500 text-xs">(</span>
            {syncedArgs.map((arg, j) => (
              // Builtin args are positional — the index IS the semantic identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: positional arg index is the semantic key
              <span key={j} className="flex items-center gap-1">
                {j > 0 && <span className="text-slate-500 text-xs">,</span>}
                <VarInput
                  value={arg}
                  onChange={(v) => {
                    const next = [...syncedArgs];
                    next[j] = v;
                    update({ args: next });
                  }}
                  placeholder={j === 0 ? "?result" : `?arg${j}`}
                />
              </span>
            ))}
            <span className="text-slate-500 text-xs">)</span>
          </>
        )}

        {(atom.type === "sameAs" || atom.type === "differentFrom") && (
          <>
            <span className="text-slate-400 text-xs font-medium shrink-0">
              {atom.type === "sameAs" ? "sameAs" : "differentFrom"}
            </span>
            <span className="text-slate-500 text-xs">(</span>
            <VarInput value={atom.arg1} onChange={(v) => update({ arg1: v })} placeholder="?x" />
            <span className="text-slate-500 text-xs">,</span>
            <VarInput value={atom.arg2} onChange={(v) => update({ arg2: v })} placeholder="?y" />
            <span className="text-slate-500 text-xs">)</span>
          </>
        )}
      </div>

      {/* Remove button */}
      <button
        type="button"
        onClick={onRemove}
        title="Remove atom"
        className="shrink-0 mt-0.5 text-slate-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

// Small variable name input that renders inline and styled like a variable
function VarInput({ value, onChange, placeholder }) {
  return (
    <input
      type="text"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      className="w-20 min-w-0 px-1.5 py-0.5 text-xs rounded border border-ink-600/70
                 bg-ink-800 text-brand-300 font-mono placeholder-slate-600
                 focus:outline-none focus:border-brand-500/60 focus:ring-0"
    />
  );
}

// ── Atom list (antecedent or consequent) ──────────────────────────────────────
function AtomList({ atoms, onChange, label, accent, classes, properties }) {
  const updateAtom = (i, atom) => {
    const next = [...atoms];
    next[i] = atom;
    onChange(next);
  };
  const removeAtom = (i) => onChange(atoms.filter((_, idx) => idx !== i));
  const moveUp = (i) => {
    if (i === 0) return;
    const next = [...atoms];
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    onChange(next);
  };
  const moveDown = (i) => {
    if (i === atoms.length - 1) return;
    const next = [...atoms];
    [next[i], next[i + 1]] = [next[i + 1], next[i]];
    onChange(next);
  };

  return (
    <div className={`rounded-xl border ${accent} bg-ink-950/40 overflow-hidden`}>
      {/* Zone header */}
      <div
        className={`px-4 py-2.5 flex items-center justify-between border-b ${accent} bg-ink-900/30`}
      >
        <div className="flex items-center gap-2">
          <span
            className={`text-xs font-bold uppercase tracking-wider ${label === "IF" ? "text-amber-400" : "text-emerald-400"}`}
          >
            {label}
          </span>
          <span className="text-[10px] text-slate-500">
            {label === "IF"
              ? "antecedent — conditions that must be true"
              : "THEN — conclusions to assert"}
          </span>
        </div>
        <span className="text-[10px] text-slate-600 font-mono">
          {atoms.length} atom{atoms.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Atoms */}
      <div className="p-3 flex flex-col gap-2">
        {atoms.length === 0 && (
          <div className="text-center py-6 text-slate-600 text-xs select-none border border-dashed border-ink-700/50 rounded-lg">
            No atoms yet — click <span className="text-slate-400 font-medium">+ Add Atom</span> to
            begin
          </div>
        )}
        {atoms.map((atom, i) => (
          <div key={atom._id} className="flex gap-1 items-start">
            {/* Reorder controls */}
            <div className="flex flex-col gap-0.5 shrink-0 mt-1.5">
              <button
                type="button"
                onClick={() => moveUp(i)}
                disabled={i === 0}
                className="text-slate-600 hover:text-slate-300 disabled:opacity-20 disabled:cursor-not-allowed"
                title="Move up"
              >
                <ChevronUp size={10} strokeWidth={2.5} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => moveDown(i)}
                disabled={i === atoms.length - 1}
                className="text-slate-600 hover:text-slate-300 disabled:opacity-20 disabled:cursor-not-allowed"
                title="Move down"
              >
                <ChevronDown size={10} strokeWidth={2.5} aria-hidden="true" />
              </button>
            </div>
            <div className="flex-1 min-w-0">
              <AtomRow
                atom={atom}
                onChange={(updated) => updateAtom(i, updated)}
                onRemove={() => removeAtom(i)}
                classes={classes}
                properties={properties}
                idx={i}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Add atom */}
      <div className="px-3 pb-3">
        <AddAtomMenu onAdd={(type) => onChange([...atoms, defaultAtom(type)])} />
      </div>
    </div>
  );
}

// Dropdown menu for choosing which atom type to add
function AddAtomMenu({ onAdd }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const h = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200
                   border border-dashed border-ink-600/60 hover:border-ink-500
                   rounded-md px-3 py-1.5 transition-colors w-full justify-center"
      >
        <Plus size={12} strokeWidth={2.5} aria-hidden="true" />
        Add Atom
      </button>
      {open && (
        <div
          className="absolute z-50 left-0 bottom-full mb-1 rounded-lg shadow-xl shadow-black/40
                        border border-ink-600/80 bg-ink-900/95 backdrop-blur-xs py-1 min-w-52"
        >
          {ATOM_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => {
                onAdd(t.value);
                setOpen(false);
              }}
              className="block w-full text-left px-3 py-1.5 text-xs text-slate-200
                         hover:bg-ink-700/70 transition-colors"
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── SWRL text preview bar ─────────────────────────────────────────────────────
function RulePreview({ antecedent, consequent, classes, properties }) {
  const text = ruleToText(antecedent, consequent, classes, properties);
  if (!text) return null;
  return (
    <div className="rounded-lg border border-ink-700/60 bg-ink-950/60 p-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-600 font-medium mb-1.5">
        SWRL Preview
      </div>
      <pre className="text-xs text-slate-300 font-mono whitespace-pre-wrap break-all leading-relaxed">
        {text}
      </pre>
    </div>
  );
}

// ── Rule list sidebar item ────────────────────────────────────────────────────
function RuleListItem({ rule, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors border
        ${
          active
            ? "bg-brand-600/20 border-brand-500/30 text-brand-100"
            : "border-transparent text-slate-300 hover:bg-ink-700/50 hover:text-slate-100"
        }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          title={rule.enabled ? "Enabled" : "Disabled"}
          className={`shrink-0 w-2 h-2 rounded-full ${rule.enabled ? "bg-emerald-400" : "bg-slate-600"}`}
        />
        <span className="truncate text-sm font-medium">
          {rule.label || <span className="italic text-slate-500">Untitled Rule</span>}
        </span>
      </div>
      {rule.antecedent?.length > 0 || rule.consequent?.length > 0 ? (
        <div className="text-[10px] text-slate-500 mt-0.5 pl-4 truncate font-mono">
          {rule.antecedent?.length ?? 0} IF · {rule.consequent?.length ?? 0} THEN
        </div>
      ) : null}
    </button>
  );
}

// ── Empty slate ───────────────────────────────────────────────────────────────
function EmptyCanvas({ onNew }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-8 select-none">
      <div className="w-16 h-16 rounded-2xl bg-ink-800/60 border border-ink-700/60 flex items-center justify-center">
        <ClipboardCheck size={32} className="text-slate-500" aria-hidden="true" />
      </div>
      <div>
        <p className="text-slate-300 font-medium">No rule selected</p>
        <p className="text-slate-500 text-sm mt-1">
          Select a rule from the list or create a new one to start building.
        </p>
      </div>
      <button type="button" onClick={onNew} className="btn-primary text-sm">
        + New Rule
      </button>
    </div>
  );
}

// ── Toggle switch (accessible) ────────────────────────────────────────────────
function ToggleSwitch({ checked, onChange, label }) {
  const handleKeyDown = (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      onChange(!checked);
    }
  };
  return (
    <div className="flex items-center gap-2 shrink-0 select-none">
      <span className="text-xs text-slate-400" id="enabled-label">
        {label}
      </span>
      <span
        role="switch"
        aria-checked={checked}
        aria-labelledby="enabled-label"
        tabIndex={0}
        onClick={() => onChange(!checked)}
        onKeyDown={handleKeyDown}
        className={`relative inline-flex w-8 h-4.5 rounded-full border transition-colors cursor-pointer
          focus:outline-none focus:ring-2 focus:ring-brand-500/50
          ${checked ? "bg-emerald-600/80 border-emerald-500/50" : "bg-ink-700 border-ink-600"}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform
            ${checked ? "translate-x-3.5" : "translate-x-0"}`}
        />
      </span>
    </div>
  );
}

const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 560;
const SIDEBAR_DEFAULT = 256; // px — matches original w-64

// ── Main RulesView ────────────────────────────────────────────────────────────
export default function RulesView({ onChange }) {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const isDragging = useRef(false);

  // Currently-editing rule state
  const [selectedId, setSelectedId] = useState(null); // null = nothing selected; "new" = new rule
  const [label, setLabel] = useState("");
  const [comment, setComment] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [antecedent, setAntecedent] = useState([]);
  const [consequent, setConsequent] = useState([]);

  // Ontology entity data for dropdowns
  const [classes, setClasses] = useState([]);
  const [properties, setProperties] = useState([]);

  // Save / delete state
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [dirty, setDirty] = useState(false);

  // Load rules list
  const loadRules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.rules();
      setRules(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  // Load classes & properties for dropdowns
  useEffect(() => {
    Promise.all([api.classesAll(), api.propertiesAll()])
      .then(([cls, props]) => {
        setClasses((cls ?? []).map((c) => ({ iri: c.iri, label: c.label || "" })));
        setProperties(
          (props ?? []).map((p) => ({
            iri: p.iri,
            label: p.label || "",
            kind: p.kind || "object",
          })),
        );
      })
      .catch(() => {});
  }, []);

  const markDirty = () => setDirty(true);

  // Load a rule into the editor
  function selectRule(rule) {
    setSelectedId(rule.id);
    setLabel(rule.label ?? "");
    setComment(rule.comment ?? "");
    setEnabled(rule.enabled ?? true);
    setAntecedent(reconstructAtoms(rule.antecedent ?? []));
    setConsequent(reconstructAtoms(rule.consequent ?? []));
    setDirty(false);
    setSaveError(null);
  }

  function newRule() {
    setSelectedId("new");
    setLabel("");
    setComment("");
    setEnabled(true);
    setAntecedent([]);
    setConsequent([]);
    setDirty(false);
    setSaveError(null);
  }

  async function saveRule() {
    setSaving(true);
    setSaveError(null);
    try {
      const body = { label, comment, enabled, antecedent, consequent };
      if (selectedId === "new") {
        const created = await api.createRule(body);
        await loadRules();
        setSelectedId(created.id);
      } else {
        await api.updateRule(selectedId, body);
        await loadRules();
      }
      setDirty(false);
      onChange?.();
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function deleteRule() {
    if (!selectedId || selectedId === "new") return;
    if (!window.confirm("Delete this rule? This cannot be undone.")) return;
    setDeleting(true);
    try {
      await api.deleteRule(selectedId);
      await loadRules();
      setSelectedId(null);
      setDirty(false);
      onChange?.();
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setDeleting(false);
    }
  }

  // ── Drag-to-resize sidebar ──────────────────────────────────────────────
  const startDrag = useCallback(
    (e) => {
      e.preventDefault();
      isDragging.current = true;
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      const onMove = (ev) => {
        if (!isDragging.current) return;
        setSidebarWidth(
          Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startWidth + ev.clientX - startX)),
        );
      };
      const onUp = () => {
        isDragging.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [sidebarWidth],
  );

  const isNew = selectedId === "new";
  const hasSelection = selectedId !== null;

  return (
    <div className="flex-1 min-h-0 flex overflow-hidden">
      {/* ── Left sidebar: rule list ──────────────────────────────────────── */}
      <aside
        className="shrink-0 flex flex-col bg-ink-950/50 overflow-hidden"
        style={{ width: sidebarWidth }}
      >
        <div className="shrink-0 flex items-center justify-between px-3 py-3 border-b border-ink-700">
          <span className="text-sm font-semibold text-slate-200">SWRL Rules</span>
          <button
            type="button"
            onClick={newRule}
            title="New rule"
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-ink-700/60 transition-colors"
          >
            <Plus size={14} strokeWidth={2.5} aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
          {loading && (
            <div className="text-xs text-slate-500 text-center py-8 select-none">Loading…</div>
          )}
          {!loading && error && <div className="text-xs text-red-400 px-2 py-4">{error}</div>}
          {!loading && !error && rules.length === 0 && (
            <div className="text-xs text-slate-500 text-center py-8 select-none">No rules yet</div>
          )}
          {rules.map((r) => (
            <RuleListItem
              key={r.id}
              rule={r}
              active={r.id === selectedId}
              onClick={() => selectRule(r)}
            />
          ))}
          {isNew && (
            <RuleListItem
              rule={{
                id: "new",
                label: "New Rule",
                enabled: true,
                antecedent: [],
                consequent: [],
              }}
              active
              onClick={() => {}}
            />
          )}
        </div>

        <div className="shrink-0 border-t border-ink-700 px-3 py-2">
          <a
            href="https://www.w3.org/Submission/SWRL/"
            target="_blank"
            rel="noreferrer"
            className="text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
          >
            SWRL Specification ↗
          </a>
        </div>
      </aside>

      {/* Drag handle */}
      <div
        onMouseDown={startDrag}
        aria-hidden="true"
        title="Drag to resize"
        className="group w-0.75 shrink-0 cursor-col-resize relative bg-ink-700/60 hover:bg-brand-500/50 active:bg-brand-500/70 transition-colors select-none"
      >
        <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 flex flex-col items-center justify-center gap-0.75 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity">
          {[0, 1, 2, 3, 4].map((n) => (
            <span key={n} className="w-0.75 h-0.75 rounded-full bg-brand-300/80" />
          ))}
        </div>
      </div>

      {/* ── Main canvas ──────────────────────────────────────────────────── */}
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {!hasSelection ? (
          <EmptyCanvas onNew={newRule} />
        ) : (
          <>
            {/* Toolbar */}
            <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-ink-700 bg-ink-950/40">
              <div className="flex-1 flex items-center gap-3 min-w-0">
                <input
                  type="text"
                  value={label}
                  onChange={(e) => {
                    setLabel(e.target.value);
                    markDirty();
                  }}
                  placeholder="Rule name…"
                  className="input text-sm font-medium flex-1 min-w-0 max-w-72 py-1"
                />
                <ToggleSwitch
                  checked={enabled}
                  onChange={(v) => {
                    setEnabled(v);
                    markDirty();
                  }}
                  label="Enabled"
                />
              </div>

              {dirty && (
                <span className="text-[10px] text-amber-400/80 shrink-0">Unsaved changes</span>
              )}

              <div className="flex items-center gap-2 shrink-0">
                {!isNew && (
                  <button
                    type="button"
                    onClick={deleteRule}
                    disabled={deleting}
                    className="px-3 py-1.5 text-xs rounded-md border border-red-500/30 text-red-400
                               hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50 transition-colors"
                  >
                    {deleting ? "Deleting…" : "Delete"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={saveRule}
                  disabled={saving || (!dirty && !isNew)}
                  className="btn-primary text-xs py-1.5 px-4 disabled:opacity-50"
                >
                  {saving ? "Saving…" : isNew ? "Create Rule" : "Save Rule"}
                </button>
              </div>
            </div>

            {saveError && (
              <div className="shrink-0 mx-4 mt-2 p-2 rounded-md bg-red-500/10 border border-red-500/30 text-xs text-red-300">
                {saveError}
              </div>
            )}

            {/* Rule comment */}
            <div className="shrink-0 px-4 pt-3 pb-2">
              <textarea
                value={comment}
                onChange={(e) => {
                  setComment(e.target.value);
                  markDirty();
                }}
                placeholder="Optional description or comment for this rule…"
                rows={2}
                className="input text-xs w-full resize-none text-slate-400 py-1.5"
              />
            </div>

            {/* Rule editor body */}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 flex flex-col gap-4">
              <AtomList
                label="IF"
                accent="border-amber-500/25"
                atoms={antecedent}
                onChange={(a) => {
                  setAntecedent(a);
                  markDirty();
                }}
                classes={classes}
                properties={properties}
              />

              <div className="flex items-center gap-3 px-2">
                <div className="flex-1 h-px bg-ink-700/60" />
                <span className="text-2xl text-slate-600 font-light select-none">→</span>
                <div className="flex-1 h-px bg-ink-700/60" />
              </div>

              <AtomList
                label="THEN"
                accent="border-emerald-500/25"
                atoms={consequent}
                onChange={(c) => {
                  setConsequent(c);
                  markDirty();
                }}
                classes={classes}
                properties={properties}
              />

              <RulePreview
                antecedent={antecedent}
                consequent={consequent}
                classes={classes}
                properties={properties}
              />

              <HelpCard />
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// ── Reconstruct UI atom objects from server response ─────────────────────────
function reconstructAtoms(serverAtoms) {
  if (!Array.isArray(serverAtoms)) return [];
  return serverAtoms.map((a) => {
    const _id = crypto.randomUUID();
    const t = a.atomType ?? "";
    if (t.includes("ClassAtom")) {
      return {
        _id,
        type: "class",
        classIri: a.classPredicate ?? "",
        arg1: a.arg1 ? `?${a.arg1.replace(/^\?/, "")}` : "?x",
      };
    }
    if (t.includes("IndividualPropertyAtom")) {
      return {
        _id,
        type: "objectProperty",
        propertyIri: a.propertyPredicate ?? "",
        arg1: a.arg1 ? `?${a.arg1.replace(/^\?/, "")}` : "?x",
        arg2: a.arg2 ? `?${a.arg2.replace(/^\?/, "")}` : "?y",
      };
    }
    if (t.includes("DatavaluedPropertyAtom")) {
      return {
        _id,
        type: "datatypeProperty",
        propertyIri: a.propertyPredicate ?? "",
        arg1: a.arg1 ? `?${a.arg1.replace(/^\?/, "")}` : "?x",
        arg2: a.arg2 ?? "?val",
        datatype: "",
      };
    }
    if (t.includes("BuiltinAtom")) {
      return {
        _id,
        type: "builtin",
        builtin: a.builtin ?? "greaterThan",
        args: [
          a.arg1 ? `?${a.arg1.replace(/^\?/, "")}` : "?x",
          a.arg2 ? `?${a.arg2.replace(/^\?/, "")}` : "?y",
        ],
      };
    }
    if (t.includes("SameIndividualAtom")) {
      return {
        _id,
        type: "sameAs",
        arg1: a.arg1 ? `?${a.arg1.replace(/^\?/, "")}` : "?x",
        arg2: a.arg2 ? `?${a.arg2.replace(/^\?/, "")}` : "?y",
      };
    }
    if (t.includes("DifferentIndividualsAtom")) {
      return {
        _id,
        type: "differentFrom",
        arg1: a.arg1 ? `?${a.arg1.replace(/^\?/, "")}` : "?x",
        arg2: a.arg2 ? `?${a.arg2.replace(/^\?/, "")}` : "?y",
      };
    }
    return defaultAtom("class");
  });
}

// ── Help card ────────────────────────────────────────────────────────────────
function HelpCard() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-ink-700/50 bg-ink-900/30 overflow-hidden text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-slate-400 hover:text-slate-200 transition-colors"
      >
        <span className="font-medium">SWRL Quick Reference</span>
        <ChevronDown
          size={12}
          className={`transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="border-t border-ink-700/50 px-4 py-3 text-slate-400 space-y-3">
          <div>
            <p className="text-slate-300 font-medium mb-1">Rule Structure</p>
            <pre className="font-mono text-[11px] text-slate-400 bg-ink-950/60 rounded p-2">
              {`antecedent₁ ∧ antecedent₂ ∧ … → consequent₁ ∧ …`}
            </pre>
          </div>
          <div>
            <p className="text-slate-300 font-medium mb-1">Variable Binding</p>
            <p>
              Variables (e.g. <code className="font-mono text-brand-300">?x</code>,{" "}
              <code className="font-mono text-brand-300">?age</code>) must start with{" "}
              <code className="font-mono text-brand-300">?</code>. The same variable name in
              different atoms binds them together.
            </p>
          </div>
          <div>
            <p className="text-slate-300 font-medium mb-1">Atom Types</p>
            <ul className="space-y-1 list-disc list-inside">
              <li>
                <span className="text-slate-300 font-medium">Class Atom</span> — asserts an
                individual belongs to a class:{" "}
                <code className="font-mono text-brand-300">Person(?x)</code>
              </li>
              <li>
                <span className="text-slate-300 font-medium">Object Property Atom</span> — asserts a
                relationship: <code className="font-mono text-brand-300">hasParent(?x, ?y)</code>
              </li>
              <li>
                <span className="text-slate-300 font-medium">Datatype Property Atom</span> — asserts
                a data value: <code className="font-mono text-brand-300">hasAge(?x, ?age)</code>
              </li>
              <li>
                <span className="text-slate-300 font-medium">Built-in Atom</span> — SWRL built-in
                comparison/math/string:{" "}
                <code className="font-mono text-brand-300">swrlb:greaterThan(?age, 18)</code>
              </li>
              <li>
                <span className="text-slate-300 font-medium">sameAs / differentFrom</span> —
                identity constraints
              </li>
            </ul>
          </div>
          <div>
            <p className="text-slate-300 font-medium mb-1">Example Rule</p>
            <pre className="font-mono text-[11px] text-slate-400 bg-ink-950/60 rounded p-2 whitespace-pre-wrap">
              {`Person(?x) ∧ hasAge(?x, ?age) ∧ swrlb:greaterThan(?age, 65)
  → Senior(?x)`}
            </pre>
          </div>
          <p className="text-slate-600">
            Rules are stored as SWRL RDF triples in the ontology and export with the Turtle file.
          </p>
        </div>
      )}
    </div>
  );
}
