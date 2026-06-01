import { parentPort, workerData } from "node:worker_threads";
import oxigraph from "oxigraph";
import {
  generateFormattedRdfXmlFromQuads,
  generateFormattedTurtleFromQuads,
} from "./rdfSerializer.js";

const { nquads, record, format = "text/turtle", graphIri } = workerData;
try {
  // Load the N-Quads into a temporary store so we can extract typed quad objects.
  const tmpStore = new oxigraph.Store();
  const gNode = oxigraph.namedNode(graphIri);
  tmpStore.load(nquads, { format: "application/n-quads", to_graph_name: gNode });

  // Extract quads as an array of plain objects — the serializers only access
  // .termType / .value / .language / .datatype on each term.
  const quads = [...tmpStore.match(null, null, null, gNode)];

  let text;
  if (format === "application/rdf+xml") {
    text = generateFormattedRdfXmlFromQuads(quads, record);
  } else {
    text = generateFormattedTurtleFromQuads(quads, record);
  }

  parentPort.postMessage({ ok: true, text });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message });
}
