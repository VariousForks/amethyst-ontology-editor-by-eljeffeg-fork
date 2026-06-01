import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuid } from "uuid";
import {
  addProjectMember,
  insertOntologyRecord,
  insertProjectRecord,
  logChange,
} from "./authDb.js";
import { loadOntologyFromText } from "./rdfStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// <repo-root>/examples/pizza.ttl
const SEED_PATH = path.resolve(__dirname, "..", "..", "..", "examples", "pizza.ttl");

export async function createPizzaExampleProject(userId) {
  if (!userId) return null;
  try {
    if (!fs.existsSync(SEED_PATH)) {
      console.warn(`[seedPizza] missing seed file at ${SEED_PATH}`);
      return null;
    }
    const text = fs.readFileSync(SEED_PATH, "utf-8");

    const pid = uuid();
    const oid = uuid();
    const now = Date.now();

    await insertProjectRecord({
      id: pid,
      name: "Pizza Example",
      description: "Example ontology — feel free to delete.",
      now,
      userId,
    });
    await addProjectMember(pid, userId, "manager");
    await insertOntologyRecord({
      id: oid,
      name: "Pizza Ontology",
      iri: "http://example.org/pizza",
      description: null,
      projectId: pid,
      now,
      userId,
    });

    loadOntologyFromText(oid, text, { replace: false, format: "text/turtle" });

    await logChange(userId, oid, "seed-pizza-example", { projectId: pid });
    return { projectId: pid, ontologyId: oid };
  } catch (err) {
    console.warn(`[seedPizza] failed: ${err.message || err}`);
    return null;
  }
}
