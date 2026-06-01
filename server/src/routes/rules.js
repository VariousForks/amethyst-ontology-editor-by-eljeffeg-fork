import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { requireAuth, requireProjectRole } from "../middleware/auth.js";
import { requireSingleOntology, resolveOntology } from "../middleware/ontology.js";
import { logChange } from "../services/authDb.js";
import { graphIriFor, NS, safeIri, select, update as storeUpdate } from "../services/rdfStore.js";

const router = Router();

// ── SWRL Namespaces ──────────────────────────────────────────────────────────
const SWRL = "http://www.w3.org/2003/11/swrl#";
const SWRLB = "http://www.w3.org/2003/11/swrlb#";

const PREFIXES = `
PREFIX rdf:   <${NS.rdf}>
PREFIX rdfs:  <${NS.rdfs}>
PREFIX owl:   <${NS.owl}>
PREFIX xsd:   <${NS.xsd}>
PREFIX swrl:  <${SWRL}>
PREFIX swrlb: <${SWRLB}>
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build the IRI for a rule given its local ID. */
function ruleIri(id) {
  return `urn:swrl:rule:${id}`;
}

/** Escape a string for embedding in a SPARQL literal. */
function esc(str) {
  return String(str ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

/**
 * Serialise a rule's atom list into an RDF list of SWRL atom blank nodes,
 * returning the Turtle fragment (without the INSERT DATA wrapper) and the
 * IRI of the head list node.
 *
 * atoms: Array of atom descriptors (see RulesView for shape)
 * graphIri: the named-graph IRI to scope the INSERT into
 * Returns: { turtle, headBnode } where headBnode is the rdf:List head variable.
 *
 * We use blank nodes with deterministic labels derived from the rule id and
 * atom index so re-saves are idempotent in terms of structure.
 */
function atomsToTurtle(atoms, prefix) {
  if (!atoms || atoms.length === 0) {
    // Empty atom list → rdf:nil
    return { listTurtle: `rdf:nil`, extraTurtle: "" };
  }

  const triples = [];
  const listNodes = [];

  atoms.forEach((atom, i) => {
    const atomBn = `_:${prefix}_atom_${i}`;
    listNodes.push(atomBn);

    switch (atom.type) {
      case "class": {
        triples.push(
          `${atomBn} rdf:type swrl:ClassAtom .`,
          `${atomBn} swrl:classPredicate ${safeIri(atom.classIri)} .`,
          `${atomBn} swrl:argument1 _:${prefix}_var_${sanitizeVar(atom.arg1)} .`,
          `_:${prefix}_var_${sanitizeVar(atom.arg1)} rdf:type swrl:Variable .`,
          `_:${prefix}_var_${sanitizeVar(atom.arg1)} rdfs:label "${esc(atom.arg1)}" .`,
        );
        break;
      }
      case "objectProperty": {
        triples.push(
          `${atomBn} rdf:type swrl:IndividualPropertyAtom .`,
          `${atomBn} swrl:propertyPredicate ${safeIri(atom.propertyIri)} .`,
          `${atomBn} swrl:argument1 _:${prefix}_var_${sanitizeVar(atom.arg1)} .`,
          `_:${prefix}_var_${sanitizeVar(atom.arg1)} rdf:type swrl:Variable .`,
          `_:${prefix}_var_${sanitizeVar(atom.arg1)} rdfs:label "${esc(atom.arg1)}" .`,
          `${atomBn} swrl:argument2 _:${prefix}_var_${sanitizeVar(atom.arg2)} .`,
          `_:${prefix}_var_${sanitizeVar(atom.arg2)} rdf:type swrl:Variable .`,
          `_:${prefix}_var_${sanitizeVar(atom.arg2)} rdfs:label "${esc(atom.arg2)}" .`,
        );
        break;
      }
      case "datatypeProperty": {
        // arg2 might be a variable or a literal value
        const arg2IsVar = atom.arg2?.startsWith("?");
        const arg2Node = arg2IsVar
          ? `_:${prefix}_var_${sanitizeVar(atom.arg2)}`
          : `_:${prefix}_dv_${i}`;
        triples.push(
          `${atomBn} rdf:type swrl:DatavaluedPropertyAtom .`,
          `${atomBn} swrl:propertyPredicate ${safeIri(atom.propertyIri)} .`,
          `${atomBn} swrl:argument1 _:${prefix}_var_${sanitizeVar(atom.arg1)} .`,
          `_:${prefix}_var_${sanitizeVar(atom.arg1)} rdf:type swrl:Variable .`,
          `_:${prefix}_var_${sanitizeVar(atom.arg1)} rdfs:label "${esc(atom.arg1)}" .`,
          `${atomBn} swrl:argument2 ${arg2Node} .`,
        );
        if (arg2IsVar) {
          triples.push(
            `${arg2Node} rdf:type swrl:Variable .`,
            `${arg2Node} rdfs:label "${esc(atom.arg2)}" .`,
          );
        } else {
          const dtIri = atom.datatype ? `^^${safeIri(atom.datatype)}` : "";
          triples.push(
            `${arg2Node} rdf:type swrl:Constant .`,
            `${arg2Node} rdfs:label "${esc(atom.arg2)}"${dtIri} .`,
          );
        }
        break;
      }
      case "builtin": {
        triples.push(
          `${atomBn} rdf:type swrl:BuiltinAtom .`,
          `${atomBn} swrl:builtin ${safeIri(SWRLB + atom.builtin)} .`,
        );
        // args is an array of variable names or literal values
        const argListNodes = (atom.args || []).map((arg, j) => {
          const isVar = String(arg).startsWith("?");
          const argNode = isVar
            ? `_:${prefix}_var_${sanitizeVar(arg)}`
            : `_:${prefix}_ba_${i}_${j}`;
          if (isVar) {
            triples.push(
              `${argNode} rdf:type swrl:Variable .`,
              `${argNode} rdfs:label "${esc(arg)}" .`,
            );
          } else {
            triples.push(
              `${argNode} rdf:type swrl:Constant .`,
              `${argNode} rdfs:label "${esc(arg)}" .`,
            );
          }
          return argNode;
        });
        // Build the argument list
        const { listTurtle: argListTurtle, extraTurtle: argExtra } = buildRdfList(
          argListNodes,
          `${prefix}_bargs_${i}`,
        );
        triples.push(argExtra, `${atomBn} swrl:arguments ${argListTurtle} .`);
        break;
      }
      case "sameAs": {
        triples.push(
          `${atomBn} rdf:type swrl:SameIndividualAtom .`,
          `${atomBn} swrl:argument1 _:${prefix}_var_${sanitizeVar(atom.arg1)} .`,
          `_:${prefix}_var_${sanitizeVar(atom.arg1)} rdf:type swrl:Variable .`,
          `_:${prefix}_var_${sanitizeVar(atom.arg1)} rdfs:label "${esc(atom.arg1)}" .`,
          `${atomBn} swrl:argument2 _:${prefix}_var_${sanitizeVar(atom.arg2)} .`,
          `_:${prefix}_var_${sanitizeVar(atom.arg2)} rdf:type swrl:Variable .`,
          `_:${prefix}_var_${sanitizeVar(atom.arg2)} rdfs:label "${esc(atom.arg2)}" .`,
        );
        break;
      }
      case "differentFrom": {
        triples.push(
          `${atomBn} rdf:type swrl:DifferentIndividualsAtom .`,
          `${atomBn} swrl:argument1 _:${prefix}_var_${sanitizeVar(atom.arg1)} .`,
          `_:${prefix}_var_${sanitizeVar(atom.arg1)} rdf:type swrl:Variable .`,
          `_:${prefix}_var_${sanitizeVar(atom.arg1)} rdfs:label "${esc(atom.arg1)}" .`,
          `${atomBn} swrl:argument2 _:${prefix}_var_${sanitizeVar(atom.arg2)} .`,
          `_:${prefix}_var_${sanitizeVar(atom.arg2)} rdf:type swrl:Variable .`,
          `_:${prefix}_var_${sanitizeVar(atom.arg2)} rdfs:label "${esc(atom.arg2)}" .`,
        );
        break;
      }
      default:
        break;
    }
  });

  const { listTurtle, extraTurtle: listExtra } = buildRdfList(listNodes, `${prefix}_list`);

  return {
    listTurtle,
    extraTurtle: [...triples, listExtra].join("\n"),
  };
}

/** Build an rdf:List from an array of node IRIs/blank-node labels.
 *  Returns { listTurtle (the head node reference), extraTurtle (triple block) }. */
function buildRdfList(nodes, prefix) {
  if (!nodes || nodes.length === 0) return { listTurtle: "rdf:nil", extraTurtle: "" };
  if (nodes.length > 500) throw new Error("rule atom list exceeds maximum length");
  const triples = [];
  for (let i = 0; i < nodes.length; i++) {
    const cell = `_:${prefix}_cell_${i}`;
    const next = i + 1 < nodes.length ? `_:${prefix}_cell_${i + 1}` : "rdf:nil";
    triples.push(
      `${cell} rdf:type rdf:List .`,
      `${cell} rdf:first ${nodes[i]} .`,
      `${cell} rdf:rest ${next} .`,
    );
  }
  return {
    listTurtle: `_:${prefix}_cell_0`,
    extraTurtle: triples.join("\n"),
  };
}

/** Sanitise a variable name (strip leading ? and any non-alphanumeric) so it
 *  can be used as a blank-node suffix. */
function sanitizeVar(name) {
  return String(name ?? "v")
    .replace(/^\?/, "")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .slice(0, 40);
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/rules  — list all SWRL rules in the ontology scope
router.get("/", requireAuth, resolveOntology, requireProjectRole("viewer"), (req, res) => {
  const scope = req.ontologyScope;
  try {
    const q = `${PREFIXES}
SELECT ?rule ?label ?comment ?enabled WHERE {
  ?rule rdf:type swrl:Imp .
  OPTIONAL { ?rule rdfs:label ?label }
  OPTIONAL { ?rule rdfs:comment ?comment }
  OPTIONAL { ?rule swrl:isEnabled ?enabled }
}`;
    const rows = select(q, scope);
    // Use the full IRI as the id so imported rules (with arbitrary IRIs)
    // are handled correctly alongside rules created by this tool.
    const rules = rows.map((r) => ({
      id: r.rule?.value ?? "",
      iri: r.rule?.value ?? "",
      label: r.label?.value ?? "",
      comment: r.comment?.value ?? "",
      enabled: r.enabled?.value !== "false",
    }));
    // For each rule, fetch its antecedent and consequent atom descriptions
    const detailed = rules.map((rule) => {
      try {
        const atomQ = `${PREFIXES}
SELECT ?side ?atomType ?classPredicate ?propPredicate ?builtin ?arg1Label ?arg2Label WHERE {
  {
    <${rule.iri}> swrl:body ?list .
    BIND("antecedent" AS ?side)
  } UNION {
    <${rule.iri}> swrl:head ?list .
    BIND("consequent" AS ?side)
  }
  ?list rdf:rest* ?cell .
  ?cell rdf:first ?atom .
  ?atom rdf:type ?atomType .
  OPTIONAL { ?atom swrl:classPredicate ?classPredicate }
  OPTIONAL { ?atom swrl:propertyPredicate ?propPredicate }
  OPTIONAL { ?atom swrl:builtin ?builtin }
  OPTIONAL {
    ?atom swrl:argument1 ?a1 .
    ?a1 rdfs:label ?arg1Label .
  }
  OPTIONAL {
    ?atom swrl:argument2 ?a2 .
    ?a2 rdfs:label ?arg2Label .
  }
}`;
        const atomRows = select(atomQ, scope);
        const antecedent = [];
        const consequent = [];
        for (const ar of atomRows) {
          const side = ar.side?.value;
          const atomTypeIri = ar.atomType?.value ?? "";
          const atomDesc = {
            atomType: atomTypeIri.replace(SWRL, "swrl:"),
            classPredicate: ar.classPredicate?.value ?? null,
            propertyPredicate: ar.propPredicate?.value ?? null,
            builtin: ar.builtin?.value ? ar.builtin.value.replace(SWRLB, "") : null,
            arg1: ar.arg1Label?.value ?? null,
            arg2: ar.arg2Label?.value ?? null,
          };
          if (side === "antecedent") antecedent.push(atomDesc);
          else if (side === "consequent") consequent.push(atomDesc);
        }
        return { ...rule, antecedent, consequent };
      } catch {
        return { ...rule, antecedent: [], consequent: [] };
      }
    });
    res.json(detailed);
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// GET /api/rules/:id  — get a single rule
// :id is the full rule IRI (URL-encoded by the client).
router.get("/:id", requireAuth, resolveOntology, requireProjectRole("viewer"), (req, res) => {
  const scope = req.ontologyScope;
  // Express already URL-decodes params, so req.params.id is the full IRI.
  const iri = req.params.id;
  try {
    safeIri(iri); // validate before interpolating into SPARQL
    const q = `${PREFIXES}
SELECT ?label ?comment ?enabled WHERE {
  <${iri}> rdf:type swrl:Imp .
  OPTIONAL { <${iri}> rdfs:label ?label }
  OPTIONAL { <${iri}> rdfs:comment ?comment }
  OPTIONAL { <${iri}> swrl:isEnabled ?enabled }
}`;
    const rows = select(q, scope);
    if (!rows.length) return res.status(404).json({ error: "Rule not found" });
    const r = rows[0];
    res.json({
      id: iri,
      iri,
      label: r.label?.value ?? "",
      comment: r.comment?.value ?? "",
      enabled: r.enabled?.value !== "false",
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// POST /api/rules  — create a new SWRL rule
router.post(
  "/",
  requireAuth,
  resolveOntology,
  requireSingleOntology,
  requireProjectRole("editor"),
  (req, res) => {
    const { label, comment, enabled = true, antecedent = [], consequent = [] } = req.body || {};
    const id = uuidv4();
    const iri = ruleIri(id);
    const g = graphIriFor(req.ontologyId);
    const prefix = `r_${id.replace(/-/g, "_")}`;

    try {
      const { listTurtle: bodyList, extraTurtle: bodyExtra } = atomsToTurtle(
        antecedent,
        `${prefix}_body`,
      );
      const { listTurtle: headList, extraTurtle: headExtra } = atomsToTurtle(
        consequent,
        `${prefix}_head`,
      );

      const labelTriple = label ? `<${iri}> rdfs:label "${esc(label)}" .` : "";
      const commentTriple = comment ? `<${iri}> rdfs:comment "${esc(comment)}" .` : "";
      const enabledTriple = `<${iri}> swrl:isEnabled "${enabled}"^^xsd:boolean .`;

      const insertQ = `${PREFIXES}
INSERT DATA {
  GRAPH <${g}> {
    <${iri}> rdf:type swrl:Imp .
    <${iri}> rdf:type owl:Thing .
    ${labelTriple}
    ${commentTriple}
    ${enabledTriple}
    <${iri}> swrl:body ${bodyList} .
    ${bodyExtra}
    <${iri}> swrl:head ${headList} .
    ${headExtra}
  }
}`;

      storeUpdate(insertQ, req.ontologyId);
      logChange(req.session.user.id, req.ontologyId, "create-swrl-rule", {
        ruleIri: iri,
        label,
      });
      // Return id as the full IRI so the client always uses full IRIs for edits/deletes.
      res.status(201).json({ id: iri, iri, label, comment, enabled });
    } catch (err) {
      res.status(500).json({ error: String(err.message ?? err) });
    }
  },
);

// PUT /api/rules/:id  — replace/update a SWRL rule
// :id is the full rule IRI (URL-encoded by the client).
router.put(
  "/:id",
  requireAuth,
  resolveOntology,
  requireSingleOntology,
  requireProjectRole("editor"),
  (req, res) => {
    const { label, comment, enabled = true, antecedent = [], consequent = [] } = req.body || {};
    // req.params.id is the full IRI (Express URL-decodes it automatically).
    const iri = req.params.id;
    const g = graphIriFor(req.ontologyId);
    // Derive a safe blank-node prefix from the IRI.
    const prefix = `r_${iri.replace(/[^a-zA-Z0-9]/g, "_").slice(-60)}`;

    try {
      safeIri(iri); // validate before interpolating into SPARQL
      // Delete all existing triples related to this rule (including its blank-node lists/atoms)
      // We do this by first dropping everything in the rule's subgraph pattern.
      // Since blank nodes are graph-local we use a SPARQL DELETE with a broad pattern.
      const deleteQ = `${PREFIXES}
DELETE {
  GRAPH <${g}> {
    <${iri}> ?p ?o .
    ?bn ?bp ?bo .
    ?bn2 ?bp2 ?bo2 .
  }
}
WHERE {
  GRAPH <${g}> {
    <${iri}> ?p ?o .
    OPTIONAL {
      {
        <${iri}> swrl:body ?list .
        ?list rdf:rest* ?cell .
        ?cell ?bp ?bo .
        ?cell rdf:first ?bn .
        ?bn ?bp2 ?bo2 .
      } UNION {
        <${iri}> swrl:head ?list .
        ?list rdf:rest* ?cell .
        ?cell ?bp ?bo .
        ?cell rdf:first ?bn .
        ?bn ?bp2 ?bo2 .
      }
    }
  }
}`;
      storeUpdate(deleteQ, req.ontologyId);

      // Re-insert with new content
      const { listTurtle: bodyList, extraTurtle: bodyExtra } = atomsToTurtle(
        antecedent,
        `${prefix}_body`,
      );
      const { listTurtle: headList, extraTurtle: headExtra } = atomsToTurtle(
        consequent,
        `${prefix}_head`,
      );

      const labelTriple = label ? `<${iri}> rdfs:label "${esc(label)}" .` : "";
      const commentTriple = comment ? `<${iri}> rdfs:comment "${esc(comment)}" .` : "";
      const enabledTriple = `<${iri}> swrl:isEnabled "${enabled}"^^xsd:boolean .`;

      const insertQ = `${PREFIXES}
INSERT DATA {
  GRAPH <${g}> {
    <${iri}> rdf:type swrl:Imp .
    <${iri}> rdf:type owl:Thing .
    ${labelTriple}
    ${commentTriple}
    ${enabledTriple}
    <${iri}> swrl:body ${bodyList} .
    ${bodyExtra}
    <${iri}> swrl:head ${headList} .
    ${headExtra}
  }
}`;

      storeUpdate(insertQ, req.ontologyId);
      logChange(req.session.user.id, req.ontologyId, "update-swrl-rule", {
        ruleIri: iri,
        label,
      });
      res.json({ id: iri, iri, label, comment, enabled });
    } catch (err) {
      res.status(500).json({ error: String(err.message ?? err) });
    }
  },
);

// DELETE /api/rules/:id  — remove a SWRL rule and its blank-node atoms
// :id is the full rule IRI (URL-encoded by the client).
router.delete(
  "/:id",
  requireAuth,
  resolveOntology,
  requireSingleOntology,
  requireProjectRole("editor"),
  (req, res) => {
    // req.params.id is the full IRI (Express URL-decodes it automatically).
    const iri = req.params.id;
    const g = graphIriFor(req.ontologyId);

    try {
      safeIri(iri); // validate before interpolating into SPARQL
      const deleteQ = `${PREFIXES}
DELETE {
  GRAPH <${g}> {
    <${iri}> ?p ?o .
    ?cell ?cp ?co .
    ?atom ?ap ?ao .
    ?argCell ?argcp ?argco .
    ?arg ?argap ?argao .
  }
}
WHERE {
  GRAPH <${g}> {
    <${iri}> ?p ?o .
    OPTIONAL {
      {
        <${iri}> swrl:body ?list .
      } UNION {
        <${iri}> swrl:head ?list .
      }
      ?list rdf:rest* ?cell .
      ?cell ?cp ?co .
      OPTIONAL {
        ?cell rdf:first ?atom .
        ?atom ?ap ?ao .
        OPTIONAL {
          ?atom swrl:arguments ?argList .
          ?argList rdf:rest* ?argCell .
          ?argCell ?argcp ?argco .
          OPTIONAL {
            ?argCell rdf:first ?arg .
            ?arg ?argap ?argao .
          }
        }
      }
    }
  }
}`;
      storeUpdate(deleteQ, req.ontologyId);
      logChange(req.session.user.id, req.ontologyId, "delete-swrl-rule", {
        ruleIri: iri,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message ?? err) });
    }
  },
);

export default router;
