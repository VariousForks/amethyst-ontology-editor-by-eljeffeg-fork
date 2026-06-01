/**
 * Pure, store-independent Turtle and RDF/XML serializers.
 *
 * All functions here take a plain `quads` array (objects with .subject,
 * .predicate, .object each having .termType / .value / .language / .datatype)
 * rather than reading from the global rdfStore.  This lets the serializers
 * run inside a worker thread where the main oxigraph store is unavailable.
 *
 * rdfStore.js wraps these with thin helpers that extract quads from the live
 * store and call through to these functions.
 */

const TURTLE_WELL_KNOWN_NS = [
  ["http://www.w3.org/1999/02/22-rdf-syntax-ns#", "rdf"],
  ["http://www.w3.org/2000/01/rdf-schema#", "rdfs"],
  ["http://www.w3.org/2002/07/owl#", "owl"],
  ["http://www.w3.org/2001/XMLSchema#", "xsd"],
  ["http://www.w3.org/XML/1998/namespace", "xml"],
  ["http://www.w3.org/2004/02/skos/core#", "skos"],
  ["http://purl.org/dc/terms/", "dcterms"],
  ["http://purl.org/dc/elements/1.1/", "dc"],
  ["http://schema.org/", "schema"],
  ["https://schema.org/", "schemas"],
];

// Preferred predicate display order (Protégé convention).
const TURTLE_PRED_ORDER = [
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
  "http://www.w3.org/2002/07/owl#versionIRI",
  "http://www.w3.org/2002/07/owl#versionInfo",
  "http://www.w3.org/2002/07/owl#imports",
  "http://www.w3.org/2000/01/rdf-schema#subClassOf",
  "http://www.w3.org/2000/01/rdf-schema#subPropertyOf",
  "http://www.w3.org/2002/07/owl#equivalentClass",
  "http://www.w3.org/2002/07/owl#disjointWith",
  "http://www.w3.org/2002/07/owl#inverseOf",
  "http://www.w3.org/2000/01/rdf-schema#domain",
  "http://www.w3.org/2000/01/rdf-schema#range",
  "http://www.w3.org/2000/01/rdf-schema#label",
  "http://www.w3.org/2000/01/rdf-schema#comment",
  "http://www.w3.org/2004/02/skos/core#prefLabel",
  "http://www.w3.org/2004/02/skos/core#altLabel",
  "http://www.w3.org/2004/02/skos/core#definition",
  "http://www.w3.org/2004/02/skos/core#scopeNote",
  "http://www.w3.org/2004/02/skos/core#example",
  "http://purl.org/dc/terms/title",
  "http://purl.org/dc/terms/description",
  "http://purl.org/dc/terms/creator",
  "http://purl.org/dc/terms/license",
  "http://www.w3.org/2002/07/owl#deprecated",
];

function turtleNsOf(iri) {
  const h = iri.lastIndexOf("#");
  if (h > 0) return iri.substring(0, h + 1);
  const s = iri.lastIndexOf("/");
  if (s > 7) return iri.substring(0, s + 1);
  return null;
}

const PREFIX_MIN_USES = 3;

function turtleBuildPrefixTable(allIris, baseIri) {
  const nsToPrefix = new Map(TURTLE_WELL_KNOWN_NS);
  const prefixToNs = new Map(TURTLE_WELL_KNOWN_NS.map(([ns, pfx]) => [pfx, ns]));

  function addNs(ns, hint) {
    if (!ns || nsToPrefix.has(ns)) return;
    const raw = (hint || "ns")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .replace(/^[0-9]+/, "");
    const cand = raw.substring(0, 20) || "ns";
    let unique = cand;
    let i = 2;
    while (prefixToNs.has(unique)) unique = `${cand}${i++}`;
    nsToPrefix.set(ns, unique);
    prefixToNs.set(unique, ns);
  }

  if (baseIri) {
    const ns = turtleNsOf(baseIri);
    if (ns && !nsToPrefix.has(ns)) {
      const stripped = ns.replace(/[#/]+$/, "");
      const parts = stripped.split(/[/#]/);
      addNs(ns, parts[parts.length - 1] || "ont");
    }
  }

  const nsCandidates = new Map();
  for (const iri of allIris) {
    let covered = false;
    for (const [ns] of nsToPrefix) {
      if (iri.startsWith(ns)) {
        covered = true;
        break;
      }
    }
    if (covered) continue;
    const ns = turtleNsOf(iri);
    if (!ns) continue;
    nsCandidates.set(ns, (nsCandidates.get(ns) ?? 0) + 1);
  }

  for (const [ns, count] of nsCandidates) {
    if (nsToPrefix.has(ns)) continue;
    if (count < PREFIX_MIN_USES) continue;
    const stripped = ns.replace(/[#/]+$/, "");
    const parts = stripped.split(/[/#]/);
    addNs(ns, parts[parts.length - 1] || "ns");
  }

  return nsToPrefix;
}

function turtleAbbrev(iri, nsToPrefix) {
  let bestLen = 0;
  let bestPfx = null;
  for (const [ns, pfx] of nsToPrefix) {
    if (iri.startsWith(ns) && ns.length > bestLen) {
      bestLen = ns.length;
      bestPfx = pfx;
    }
  }
  if (bestPfx !== null) {
    const local = iri.substring(bestLen);
    if (
      local &&
      /^[a-zA-Z_\u00C0-\uFFFF][a-zA-Z0-9_\-.:\u00B7-\uFFFF]*$/.test(local) &&
      !local.endsWith(".")
    ) {
      return `${bestPfx}:${local}`;
    }
  }
  return `<${iri}>`;
}

function turtleTerm(term, nsToPrefix) {
  switch (term.termType) {
    case "NamedNode":
      return turtleAbbrev(term.value, nsToPrefix);
    case "BlankNode":
      return `_:${term.value}`;
    case "Literal": {
      const dt = term.datatype?.value;
      const lang = term.language || null;
      const raw = term.value;
      const useTriple =
        raw.includes("\n") || raw.includes("\r") || (raw.match(/"/g) || []).length > 1;
      let base;
      if (useTriple) {
        const esc = raw.replace(/\\/g, "\\\\").replace(/\0/g, "\\u0000").replace(/"/g, '\\"');
        base = `"""${esc}"""`;
      } else {
        const esc = raw
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')
          .replace(/\t/g, "\\t")
          .replace(/\n/g, "\\n")
          .replace(/\r/g, "\\r");
        base = `"${esc}"`;
      }
      if (lang) return `${base}@${lang}`;
      if (dt && dt !== "http://www.w3.org/2001/XMLSchema#string") {
        return `${base}^^${turtleAbbrev(dt, nsToPrefix)}`;
      }
      return base;
    }
    default:
      return `<${term.value}>`;
  }
}

function termSortKey(t) {
  switch (t.termType) {
    case "NamedNode":
      return `0\x00${t.value}`;
    case "Literal":
      return `1\x00${t.value}\x00${t.datatype?.value || ""}\x00${t.language || ""}`;
    case "BlankNode":
      return `2\x00${t.value}`;
    default:
      return `3\x00${t.value}`;
  }
}

function turtleEntityBlock(iri, predMap, nsToPrefix, objectSerializer) {
  const serObj = objectSerializer ?? ((o) => turtleTerm(o, nsToPrefix));
  const subj = iri.startsWith("_:") ? iri : turtleAbbrev(iri, nsToPrefix);
  const pad = " ".repeat(subj.length + 1);

  const entries = [...predMap.entries()].sort(([pA], [pB]) => {
    const iA = TURTLE_PRED_ORDER.indexOf(pA);
    const iB = TURTLE_PRED_ORDER.indexOf(pB);
    if (iA !== -1 && iB !== -1) return iA - iB;
    if (iA !== -1) return -1;
    if (iB !== -1) return 1;
    return pA.localeCompare(pB);
  });

  const parts = entries.map(([pred, objects]) => {
    const p = turtleAbbrev(pred, nsToPrefix);
    const os = [...objects]
      .sort((a, b) => termSortKey(a).localeCompare(termSortKey(b)))
      .map((o) => serObj(o))
      .join(" , ");
    return `${p} ${os}`;
  });

  if (parts.length === 0) return [`${subj} .`];
  if (parts.length === 1) return [`${subj} ${parts[0]} .`];

  const lines = [`${subj} ${parts[0]} ;`];
  for (let i = 1; i < parts.length - 1; i++) lines.push(`${pad}${parts[i]} ;`);
  lines.push(`${pad}${parts[parts.length - 1]} .`);
  return lines;
}

const _OWL_NS = "http://www.w3.org/2002/07/owl#";
const _RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

function turtleCategorize(subjectMap) {
  const cats = {
    ontology: [],
    objectProperties: [],
    datatypeProperties: [],
    annotationProperties: [],
    classes: [],
    individuals: [],
    other: [],
  };
  for (const [iri, predMap] of subjectMap) {
    if (iri.startsWith("_:")) {
      cats.other.push(iri);
      continue;
    }
    const types = (predMap.get(_RDF_TYPE) || []).map((t) => t.value);
    if (types.includes(`${_OWL_NS}Ontology`)) cats.ontology.push(iri);
    else if (types.includes(`${_OWL_NS}ObjectProperty`)) cats.objectProperties.push(iri);
    else if (types.includes(`${_OWL_NS}DatatypeProperty`)) cats.datatypeProperties.push(iri);
    else if (types.includes(`${_OWL_NS}AnnotationProperty`)) cats.annotationProperties.push(iri);
    else if (types.includes(`${_OWL_NS}Class`)) cats.classes.push(iri);
    else if (types.includes(`${_OWL_NS}NamedIndividual`)) cats.individuals.push(iri);
    else cats.other.push(iri);
  }
  return cats;
}

function turtleSectionBanner(title) {
  return [
    "",
    "#################################################################",
    `#    ${title}`,
    "#################################################################",
    "",
  ];
}

/**
 * Deterministically renumber blank nodes in a list of quads.
 */
function canonicalizeBnodes(quads) {
  const termKey = (t) => {
    switch (t.termType) {
      case "NamedNode":
        return `N\x01${t.value}`;
      case "BlankNode":
        return `B\x01${t.value}`;
      case "Literal":
        return `L\x01${t.value}\x01${t.datatype?.value || ""}\x01${t.language || ""}`;
      default:
        return `?\x01${t.value}`;
    }
  };
  const quadKey = (q) => `${termKey(q.subject)}\x00${termKey(q.predicate)}\x00${termKey(q.object)}`;
  const sorted = [...quads].sort((a, b) => quadKey(a).localeCompare(quadKey(b)));

  const bnMap = new Map();
  let n = 0;
  for (const q of sorted) {
    if (q.subject.termType === "BlankNode" && !bnMap.has(q.subject.value))
      bnMap.set(q.subject.value, `c${n++}`);
    if (q.object.termType === "BlankNode" && !bnMap.has(q.object.value))
      bnMap.set(q.object.value, `c${n++}`);
  }
  if (bnMap.size === 0) return sorted;

  return sorted.map((q) => ({
    subject:
      q.subject.termType === "BlankNode"
        ? { termType: "BlankNode", value: bnMap.get(q.subject.value) }
        : q.subject,
    predicate: q.predicate,
    object:
      q.object.termType === "BlankNode"
        ? { termType: "BlankNode", value: bnMap.get(q.object.value) }
        : q.object,
    graph: q.graph,
  }));
}

/**
 * Build the canonical subject map from a quads array.
 * Returns null when the array is empty.
 */
function buildCanonicalSubjectMap(quads) {
  if (!quads || quads.length === 0) return null;

  const canonQuads = canonicalizeBnodes(quads);

  const subjectMap = new Map();
  const allIris = new Set();
  const bnodeRefCount = new Map();

  for (const quad of canonQuads) {
    if (quad.subject.termType === "NamedNode") allIris.add(quad.subject.value);
    allIris.add(quad.predicate.value);
    if (quad.object.termType === "NamedNode") allIris.add(quad.object.value);
    if (quad.object.termType === "Literal" && quad.object.datatype)
      allIris.add(quad.object.datatype.value);
    if (quad.object.termType === "BlankNode") {
      const k = quad.object.value;
      bnodeRefCount.set(k, (bnodeRefCount.get(k) ?? 0) + 1);
    }

    let s;
    if (quad.subject.termType === "NamedNode") {
      s = quad.subject.value;
    } else if (quad.subject.termType === "BlankNode") {
      s = `_:${quad.subject.value}`;
    } else {
      continue;
    }
    if (!subjectMap.has(s)) subjectMap.set(s, new Map());
    const pm = subjectMap.get(s);
    const p = quad.predicate.value;
    if (!pm.has(p)) pm.set(p, []);
    pm.get(p).push(quad.object);
  }

  return { subjectMap, allIris, bnodeRefCount };
}

/**
 * Generate a deterministic, human-readable, Protégé-style Turtle serialization.
 * Takes a plain quads array (works on both main thread and worker threads).
 */
export function generateFormattedTurtleFromQuads(quads, ontologyRecord) {
  const data = buildCanonicalSubjectMap(quads);
  if (!data) return "";
  const { subjectMap, allIris, bnodeRefCount } = data;

  const baseIri = ontologyRecord?.iri ?? null;
  const nsToPrefix = turtleBuildPrefixTable(allIris, baseIri);

  const inlinedBnodes = new Set();

  const _RDF_FIRST = "http://www.w3.org/1999/02/22-rdf-syntax-ns#first";
  const _RDF_REST = "http://www.w3.org/1999/02/22-rdf-syntax-ns#rest";
  const _RDF_NIL = "http://www.w3.org/1999/02/22-rdf-syntax-ns#nil";
  const _RDF_TYPE_L = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

  let _entityPad = "";

  function serializePredObjects(pm, contIndent) {
    const entries = [...pm.entries()].sort(([pA], [pB]) => {
      const iA = TURTLE_PRED_ORDER.indexOf(pA);
      const iB = TURTLE_PRED_ORDER.indexOf(pB);
      if (iA !== -1 && iB !== -1) return iA - iB;
      if (iA !== -1) return -1;
      if (iB !== -1) return 1;
      return pA.localeCompare(pB);
    });
    return entries.map(([pred, objects]) => {
      const p = pred === _RDF_TYPE_L ? "a" : turtleAbbrev(pred, nsToPrefix);
      const os = [...objects]
        .sort((a, b) => termSortKey(a).localeCompare(termSortKey(b)))
        .map((o) => serializeObject(o, `${contIndent}    `))
        .join(" , ");
      return `${p} ${os}`;
    });
  }

  function trySerializeList(bn, listElemIndent) {
    const elems = [];
    const visitedList = [];
    let cur = bn;
    while (cur !== null) {
      const cpm = subjectMap.get(`_:${cur}`);
      if (!cpm) return null;
      const firsts = cpm.get(_RDF_FIRST);
      const rests = cpm.get(_RDF_REST);
      if (!firsts?.length || !rests?.length) return null;
      elems.push(serializeObject(firsts[0], `${listElemIndent}    `));
      visitedList.push(cur);
      const rest = rests[0];
      if (rest.termType === "NamedNode" && rest.value === _RDF_NIL) {
        cur = null;
      } else if (rest.termType === "BlankNode") {
        if (visitedList.includes(rest.value)) return null;
        cur = rest.value;
      } else {
        return null;
      }
    }
    if (elems.length === 0) return null;
    for (const v of visitedList) inlinedBnodes.add(v);
    const allSimple = elems.every((e) => !e.includes("\n"));
    if (allSimple) return `( ${elems.join(" ")} )`;
    const closingIndent = listElemIndent.slice(0, -4) || "";
    return `(\n${listElemIndent}${elems.join(`\n${listElemIndent}`)}\n${closingIndent})`;
  }

  function serializeObject(term, contIndent) {
    if (contIndent === undefined) contIndent = `${_entityPad}      `;

    if (term.termType !== "BlankNode") return turtleTerm(term, nsToPrefix);

    const bn = term.value;
    const key = `_:${bn}`;
    const pm = subjectMap.get(key);

    if (!pm || (bnodeRefCount.get(bn) ?? 0) !== 1) return `_:${bn}`;
    if (inlinedBnodes.has(bn)) return `_:${bn}`;
    inlinedBnodes.add(bn);

    if (pm.has(_RDF_FIRST)) {
      const listStr = trySerializeList(bn, `${contIndent}    `);
      if (listStr !== null) return listStr;
    }

    const parts = serializePredObjects(pm, contIndent);
    if (parts.length === 0) return "[]";
    if (parts.length === 1) return `[ ${parts[0]} ]`;

    const lines = [`[ ${parts[0]} ;`];
    for (let i = 1; i < parts.length - 1; i++) lines.push(`${contIndent}${parts[i]} ;`);
    lines.push(`${contIndent}${parts[parts.length - 1]} ]`);
    return lines.join("\n");
  }

  const cats = turtleCategorize(subjectMap);

  const out = [];

  const usedNs = new Set();
  for (const iri of allIris) {
    let bestLen = 0;
    let bestNs = null;
    for (const [ns] of nsToPrefix) {
      if (iri.startsWith(ns) && ns.length > bestLen) {
        bestLen = ns.length;
        bestNs = ns;
      }
    }
    if (bestNs) usedNs.add(bestNs);
  }
  const STD = ["rdf", "rdfs", "owl", "xsd", "xml"];
  const sortedPfx = [...nsToPrefix.entries()]
    .filter(([ns]) => usedNs.has(ns))
    .sort(([, pA], [, pB]) => {
      const iA = STD.indexOf(pA);
      const iB = STD.indexOf(pB);
      if (iA !== -1 && iB !== -1) return iA - iB;
      if (iA !== -1) return -1;
      if (iB !== -1) return 1;
      return pA.localeCompare(pB);
    });

  for (const [ns, pfx] of sortedPfx) out.push(`@prefix ${pfx}: <${ns}> .`);
  if (baseIri) out.push(`@base <${baseIri}> .`);
  out.push("");

  const emitEntity = (iri) => {
    out.push(`###  ${iri}`);
    const predMap = subjectMap.get(iri);
    if (!predMap) {
      out.push("");
      return;
    }
    const subj = iri.startsWith("_:") ? iri : turtleAbbrev(iri, nsToPrefix);
    _entityPad = " ".repeat(subj.length + 1);
    out.push(...turtleEntityBlock(iri, predMap, nsToPrefix, serializeObject));
    out.push("");
  };

  const emitSection = (iris, title) => {
    if (!iris.length) return;
    out.push(...turtleSectionBanner(title));
    for (const iri of [...iris].sort()) emitEntity(iri);
  };

  for (const iri of cats.ontology) emitEntity(iri);
  emitSection(cats.objectProperties, "Object Properties");
  emitSection(cats.datatypeProperties, "Data Properties");
  emitSection(cats.annotationProperties, "Annotation Properties");
  emitSection(cats.classes, "Classes");
  emitSection(cats.individuals, "Named Individuals");

  const isListCellOnly = (iri) => {
    if (!iri.startsWith("_:")) return false;
    const pm = subjectMap.get(iri);
    if (!pm || pm.size === 0) return false;
    for (const p of pm.keys()) {
      if (p !== _RDF_FIRST && p !== _RDF_REST) return false;
    }
    return true;
  };
  const sortedGeneral = [...cats.other].sort((a, b) => {
    const aList = isListCellOnly(a) ? 1 : 0;
    const bList = isListCellOnly(b) ? 1 : 0;
    if (aList !== bList) return aList - bList;
    return a.localeCompare(b);
  });
  let generalBannerEmitted = false;
  for (const iri of sortedGeneral) {
    if (iri.startsWith("_:") && inlinedBnodes.has(iri.slice(2))) continue;
    if (!generalBannerEmitted) {
      out.push(...turtleSectionBanner("General Axioms"));
      generalBannerEmitted = true;
    }
    emitEntity(iri);
  }

  return out.join("\n");
}

// ── RDF/XML helpers ───────────────────────────────────────────────────────────

function xmlEscape(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlAttrEscape(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

const OWL_TYPE_TO_ELEMENT = new Map([
  ["http://www.w3.org/2002/07/owl#Ontology", "owl:Ontology"],
  ["http://www.w3.org/2002/07/owl#ObjectProperty", "owl:ObjectProperty"],
  ["http://www.w3.org/2002/07/owl#DatatypeProperty", "owl:DatatypeProperty"],
  ["http://www.w3.org/2002/07/owl#AnnotationProperty", "owl:AnnotationProperty"],
  ["http://www.w3.org/2002/07/owl#Class", "owl:Class"],
  ["http://www.w3.org/2002/07/owl#NamedIndividual", "owl:NamedIndividual"],
  ["http://www.w3.org/2002/07/owl#Restriction", "owl:Restriction"],
  ["http://www.w3.org/2002/07/owl#AllDisjointClasses", "owl:AllDisjointClasses"],
  ["http://www.w3.org/2002/07/owl#AllDisjointProperties", "owl:AllDisjointProperties"],
  ["http://www.w3.org/2002/07/owl#AllDifferent", "owl:AllDifferent"],
  ["http://www.w3.org/2002/07/owl#NegativePropertyAssertion", "owl:NegativePropertyAssertion"],
]);

function rdfXmlSectionComment(title) {
  const bar = "/".repeat(87);
  return `\n\n    <!-- \n    ${bar}\n    //\n    // ${title}\n    //\n    ${bar}\n     -->`;
}

/**
 * Generate a deterministic, Protégé-style RDF/XML serialization.
 * Takes a plain quads array (works on both main thread and worker threads).
 */
export function generateFormattedRdfXmlFromQuads(quads, ontologyRecord) {
  const data = buildCanonicalSubjectMap(quads);
  if (!data) return "";
  const { subjectMap, allIris, bnodeRefCount } = data;

  const baseIri = ontologyRecord?.iri ?? null;
  const nsToPrefix = turtleBuildPrefixTable(allIris, baseIri);

  function iriToQName(iri) {
    let bestLen = 0;
    let bestPfx = null;
    for (const [ns, pfx] of nsToPrefix) {
      if (iri.startsWith(ns) && ns.length > bestLen) {
        bestLen = ns.length;
        bestPfx = pfx;
      }
    }
    if (bestPfx !== null) {
      const local = iri.substring(bestLen);
      if (local && /^[a-zA-Z_À-￿][a-zA-Z0-9_\-.·-￿]*$/.test(local)) {
        return `${bestPfx}:${local}`;
      }
    }
    return null;
  }

  function primaryTypeElement(predMap) {
    const types = (predMap.get(_RDF_TYPE) || []).map((t) => t.value);
    for (const t of types) {
      const elem = OWL_TYPE_TO_ELEMENT.get(t);
      if (elem) return { elem, primaryTypeIri: t };
    }
    return { elem: "rdf:Description", primaryTypeIri: null };
  }

  const _RDF_FIRST_X = "http://www.w3.org/1999/02/22-rdf-syntax-ns#first";
  const _RDF_REST_X = "http://www.w3.org/1999/02/22-rdf-syntax-ns#rest";
  const _RDF_NIL_X = "http://www.w3.org/1999/02/22-rdf-syntax-ns#nil";

  const inlinedBnodes = new Set();

  function tryGetListMembers(bn) {
    const members = [];
    const visited = [];
    let cur = bn;
    while (cur !== null) {
      const cpm = subjectMap.get(`_:${cur}`);
      if (!cpm) return null;
      const firsts = cpm.get(_RDF_FIRST_X);
      const rests = cpm.get(_RDF_REST_X);
      if (!firsts?.length || !rests?.length) return null;
      members.push(firsts[0]);
      visited.push(cur);
      const rest = rests[0];
      if (rest.termType === "NamedNode" && rest.value === _RDF_NIL_X) {
        cur = null;
      } else if (rest.termType === "BlankNode") {
        if (visited.includes(rest.value)) return null;
        cur = rest.value;
      } else {
        return null;
      }
    }
    if (members.length === 0) return null;
    for (const v of visited) inlinedBnodes.add(v);
    return members;
  }

  function serializeBnodeChild(bn, predElem, indent) {
    const pm = subjectMap.get(`_:${bn}`);
    if (!pm || (bnodeRefCount.get(bn) ?? 0) !== 1 || inlinedBnodes.has(bn)) {
      return `<${predElem} rdf:nodeID="${bn}"/>`;
    }
    inlinedBnodes.add(bn);

    if (pm.has(_RDF_FIRST_X)) {
      const members = tryGetListMembers(bn);
      if (members !== null) {
        const memberLines = members.map((m) => {
          if (m.termType === "NamedNode") {
            return `${indent}    <rdf:Description rdf:about="${xmlAttrEscape(m.value)}"/>`;
          }
          if (m.termType === "BlankNode") {
            return serializeBnodeElement(m.value, `${indent}    `);
          }
          return `${indent}    <!-- literal collection member unsupported -->`;
        });
        return `<${predElem} rdf:parseType="Collection">\n${memberLines.join("\n")}\n${indent}</${predElem}>`;
      }
    }

    const { elem: innerElem, primaryTypeIri } = primaryTypeElement(pm);
    const childLines = buildPredicateLines(pm, primaryTypeIri, `${indent}    `);
    if (childLines.length === 0) {
      return `<${predElem}>\n${indent}    <${innerElem}/>\n${indent}</${predElem}>`;
    }
    return `<${predElem}>\n${indent}    <${innerElem}>\n${childLines.join("\n")}\n${indent}    </${innerElem}>\n${indent}</${predElem}>`;
  }

  function serializeBnodeElement(bn, indent) {
    const pm = subjectMap.get(`_:${bn}`);
    if (!pm) return `${indent}<rdf:Description rdf:nodeID="${bn}"/>`;
    inlinedBnodes.add(bn);
    const { elem, primaryTypeIri } = primaryTypeElement(pm);
    const childLines = buildPredicateLines(pm, primaryTypeIri, `${indent}    `);
    if (childLines.length === 0) return `${indent}<${elem} rdf:nodeID="${bn}"/>`;
    return `${indent}<${elem} rdf:nodeID="${bn}">\n${childLines.join("\n")}\n${indent}</${elem}>`;
  }

  function buildPredicateLines(pm, skipTypeIri, indent) {
    const lines = [];

    const sortedPreds = [...pm.entries()].sort(([pA], [pB]) => {
      const iA = TURTLE_PRED_ORDER.indexOf(pA);
      const iB = TURTLE_PRED_ORDER.indexOf(pB);
      if (iA !== -1 && iB !== -1) return iA - iB;
      if (iA !== -1) return -1;
      if (iB !== -1) return 1;
      return pA.localeCompare(pB);
    });

    for (const [pred, objects] of sortedPreds) {
      if (pred === _RDF_TYPE) {
        const extras = [...objects]
          .filter((o) => o.termType === "NamedNode" && o.value !== skipTypeIri)
          .sort((a, b) => termSortKey(a).localeCompare(termSortKey(b)));
        for (const t of extras) {
          lines.push(`${indent}<rdf:type rdf:resource="${xmlAttrEscape(t.value)}"/>`);
        }
        continue;
      }

      const predElem = iriToQName(pred) ?? "rdf:Description";
      const sortedObjs = [...objects].sort((a, b) => termSortKey(a).localeCompare(termSortKey(b)));

      for (const obj of sortedObjs) {
        if (obj.termType === "NamedNode") {
          lines.push(`${indent}<${predElem} rdf:resource="${xmlAttrEscape(obj.value)}"/>`);
        } else if (obj.termType === "Literal") {
          const lang = obj.language;
          const dt = obj.datatype?.value;
          const text = xmlEscape(obj.value);
          if (lang) {
            lines.push(`${indent}<${predElem} xml:lang="${lang}">${text}</${predElem}>`);
          } else if (dt && dt !== "http://www.w3.org/2001/XMLSchema#string") {
            lines.push(
              `${indent}<${predElem} rdf:datatype="${xmlAttrEscape(dt)}">${text}</${predElem}>`,
            );
          } else {
            lines.push(`${indent}<${predElem}>${text}</${predElem}>`);
          }
        } else if (obj.termType === "BlankNode") {
          lines.push(`${indent}${serializeBnodeChild(obj.value, predElem, indent)}`);
        }
      }
    }

    return lines;
  }

  const usedNs = new Set();
  for (const iri of allIris) {
    for (const [ns] of nsToPrefix) {
      if (iri.startsWith(ns)) {
        usedNs.add(ns);
        break;
      }
    }
  }
  const STD_XML_PFX = ["rdf", "rdfs", "owl", "xsd", "xml"];
  const sortedPfx = [...nsToPrefix.entries()]
    .filter(([ns]) => usedNs.has(ns))
    .sort(([, pA], [, pB]) => {
      const iA = STD_XML_PFX.indexOf(pA);
      const iB = STD_XML_PFX.indexOf(pB);
      if (iA !== -1 && iB !== -1) return iA - iB;
      if (iA !== -1) return -1;
      if (iB !== -1) return 1;
      return pA.localeCompare(pB);
    });

  const out = ['<?xml version="1.0"?>'];

  let defaultNs = null;
  const rdfRdfAttrs = [];

  if (baseIri) {
    const baseNs = turtleNsOf(baseIri);
    if (baseNs) {
      defaultNs = baseNs;
      rdfRdfAttrs.push(`xmlns="${xmlAttrEscape(baseNs)}"`);
      rdfRdfAttrs.push(`xml:base="${xmlAttrEscape(baseNs.replace(/[#/]+$/, ""))}"`);
    }
  }

  for (const [ns, pfx] of sortedPfx) {
    if (ns === defaultNs) continue;
    rdfRdfAttrs.push(`xmlns:${pfx}="${xmlAttrEscape(ns)}"`);
  }

  if (rdfRdfAttrs.length === 0) {
    out.push("<rdf:RDF>");
  } else {
    const align = " ".repeat(9);
    out.push(`<rdf:RDF ${rdfRdfAttrs[0]}`);
    for (let i = 1; i < rdfRdfAttrs.length; i++) {
      out.push(`${align}${rdfRdfAttrs[i]}`);
    }
    out[out.length - 1] += ">";
  }

  const cats = turtleCategorize(subjectMap);

  function emitNamedEntity(iri) {
    const predMap = subjectMap.get(iri);
    if (!predMap) return;
    const { elem, primaryTypeIri } = primaryTypeElement(predMap);
    const aboutAttr = `rdf:about="${xmlAttrEscape(iri)}"`;
    const childLines = buildPredicateLines(predMap, primaryTypeIri, "        ");
    out.push(`\n\n    <!-- ${iri} -->\n`);
    if (childLines.length === 0) {
      out.push(`    <${elem} ${aboutAttr}/>`);
    } else {
      out.push(`    <${elem} ${aboutAttr}>`);
      out.push(...childLines);
      out.push(`    </${elem}>`);
    }
  }

  function emitXmlSection(iris, title) {
    if (!iris.length) return;
    out.push(rdfXmlSectionComment(title));
    for (const iri of [...iris].sort()) emitNamedEntity(iri);
  }

  for (const iri of cats.ontology) emitNamedEntity(iri);
  emitXmlSection(cats.objectProperties, "Object Properties");
  emitXmlSection(cats.datatypeProperties, "Data Properties");
  emitXmlSection(cats.annotationProperties, "Annotation Properties");
  emitXmlSection(cats.classes, "Classes");
  emitXmlSection(cats.individuals, "Named Individuals");

  const generalAxioms = cats.other.filter(
    (iri) => !iri.startsWith("_:") || !inlinedBnodes.has(iri.slice(2)),
  );
  if (generalAxioms.length > 0) {
    out.push(rdfXmlSectionComment("General Axioms"));
    for (const iri of generalAxioms) {
      if (iri.startsWith("_:")) {
        const bn = iri.slice(2);
        out.push(`\n\n    <!-- Axiom -->\n`);
        out.push(serializeBnodeElement(bn, "    "));
      } else {
        emitNamedEntity(iri);
      }
    }
  }

  out.push("\n\n</rdf:RDF>");
  return out.join("\n");
}
