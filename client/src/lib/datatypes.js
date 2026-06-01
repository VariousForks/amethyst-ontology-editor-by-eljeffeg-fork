// ---------------------------------------------------------------------------
// Shared built-in datatype definitions
// ---------------------------------------------------------------------------
// Used by DatatypesView (sidebar list) and PropertiesView (data property range
// selector) so both views show a consistent, complete set of standard types.
//
// Sources:
//   XSD:  https://www.w3.org/TR/xmlschema-2/
//   RDF:  https://www.w3.org/TR/rdf-concepts/
//   OWL:  https://www.w3.org/TR/owl2-syntax/

const XSD = "http://www.w3.org/2001/XMLSchema#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const OWL = "http://www.w3.org/2002/07/owl#";

// ---------------------------------------------------------------------------
// XSD primitive + derived datatypes
// ---------------------------------------------------------------------------
export const XSD_DATATYPES = [
  // ── Strings ──────────────────────────────────────────────────────────────
  { iri: `${XSD}string`, label: "xsd:string", description: "Character string" },
  {
    iri: `${XSD}normalizedString`,
    label: "xsd:normalizedString",
    description: "String without line feeds, carriage returns, or tabs",
  },
  {
    iri: `${XSD}token`,
    label: "xsd:token",
    description: "Tokenized string (no leading/trailing spaces, no internal sequences)",
  },
  { iri: `${XSD}language`, label: "xsd:language", description: "Language identifier (e.g. en-US)" },
  { iri: `${XSD}Name`, label: "xsd:Name", description: "XML Name token" },
  { iri: `${XSD}NCName`, label: "xsd:NCName", description: "Non-colonized XML name" },
  { iri: `${XSD}NMTOKEN`, label: "xsd:NMTOKEN", description: "XML name token" },

  // ── Numerics ─────────────────────────────────────────────────────────────
  { iri: `${XSD}boolean`, label: "xsd:boolean", description: "true or false" },
  { iri: `${XSD}decimal`, label: "xsd:decimal", description: "Arbitrary-precision decimal number" },
  { iri: `${XSD}integer`, label: "xsd:integer", description: "Arbitrary-precision integer" },
  {
    iri: `${XSD}long`,
    label: "xsd:long",
    description: "64-bit signed integer (−9223372036854775808 to 9223372036854775807)",
  },
  {
    iri: `${XSD}int`,
    label: "xsd:int",
    description: "32-bit signed integer (−2147483648 to 2147483647)",
  },
  {
    iri: `${XSD}short`,
    label: "xsd:short",
    description: "16-bit signed integer (−32768 to 32767)",
  },
  { iri: `${XSD}byte`, label: "xsd:byte", description: "8-bit signed integer (−128 to 127)" },
  { iri: `${XSD}nonNegativeInteger`, label: "xsd:nonNegativeInteger", description: "Integer ≥ 0" },
  { iri: `${XSD}positiveInteger`, label: "xsd:positiveInteger", description: "Integer > 0" },
  { iri: `${XSD}unsignedLong`, label: "xsd:unsignedLong", description: "64-bit unsigned integer" },
  { iri: `${XSD}unsignedInt`, label: "xsd:unsignedInt", description: "32-bit unsigned integer" },
  {
    iri: `${XSD}unsignedShort`,
    label: "xsd:unsignedShort",
    description: "16-bit unsigned integer",
  },
  { iri: `${XSD}unsignedByte`, label: "xsd:unsignedByte", description: "8-bit unsigned integer" },
  { iri: `${XSD}nonPositiveInteger`, label: "xsd:nonPositiveInteger", description: "Integer ≤ 0" },
  { iri: `${XSD}negativeInteger`, label: "xsd:negativeInteger", description: "Integer < 0" },
  { iri: `${XSD}float`, label: "xsd:float", description: "32-bit IEEE 754 floating-point" },
  { iri: `${XSD}double`, label: "xsd:double", description: "64-bit IEEE 754 floating-point" },

  // ── Dates & Times ────────────────────────────────────────────────────────
  {
    iri: `${XSD}dateTime`,
    label: "xsd:dateTime",
    description: "Date and time (e.g. 2024-01-15T13:45:00)",
  },
  {
    iri: `${XSD}dateTimeStamp`,
    label: "xsd:dateTimeStamp",
    description: "Date-time with required timezone",
  },
  { iri: `${XSD}date`, label: "xsd:date", description: "Calendar date (e.g. 2024-01-15)" },
  { iri: `${XSD}time`, label: "xsd:time", description: "Time of day (e.g. 13:45:00)" },
  { iri: `${XSD}gYear`, label: "xsd:gYear", description: "Gregorian year (e.g. 2024)" },
  {
    iri: `${XSD}gYearMonth`,
    label: "xsd:gYearMonth",
    description: "Gregorian year and month (e.g. 2024-01)",
  },
  { iri: `${XSD}gMonth`, label: "xsd:gMonth", description: "Gregorian month (e.g. --01)" },
  {
    iri: `${XSD}gMonthDay`,
    label: "xsd:gMonthDay",
    description: "Gregorian month and day (e.g. --01-15)",
  },
  { iri: `${XSD}gDay`, label: "xsd:gDay", description: "Gregorian day of month (e.g. ---15)" },
  { iri: `${XSD}duration`, label: "xsd:duration", description: "Duration (e.g. P1Y2M3DT4H)" },
  {
    iri: `${XSD}yearMonthDuration`,
    label: "xsd:yearMonthDuration",
    description: "Duration in years and months",
  },
  {
    iri: `${XSD}dayTimeDuration`,
    label: "xsd:dayTimeDuration",
    description: "Duration in days, hours, minutes, seconds",
  },

  // ── Other primitives ─────────────────────────────────────────────────────
  { iri: `${XSD}anyURI`, label: "xsd:anyURI", description: "Uniform Resource Identifier" },
  {
    iri: `${XSD}base64Binary`,
    label: "xsd:base64Binary",
    description: "Base64-encoded binary data",
  },
  { iri: `${XSD}hexBinary`, label: "xsd:hexBinary", description: "Hex-encoded binary data" },
];

// ---------------------------------------------------------------------------
// RDF / RDFS built-in types
// ---------------------------------------------------------------------------
export const RDF_DATATYPES = [
  {
    iri: `${RDF}langString`,
    label: "rdf:langString",
    description: "Plain literal with a language tag",
  },
  { iri: `${RDF}HTML`, label: "rdf:HTML", description: "Well-formed HTML fragment" },
  { iri: `${RDF}XMLLiteral`, label: "rdf:XMLLiteral", description: "Well-formed XML fragment" },
  { iri: `${RDFS}Literal`, label: "rdfs:Literal", description: "The class of all literal values" },
];

// ---------------------------------------------------------------------------
// OWL built-in types
// ---------------------------------------------------------------------------
export const OWL_DATATYPES = [
  { iri: `${OWL}real`, label: "owl:real", description: "All real numbers" },
  { iri: `${OWL}rational`, label: "owl:rational", description: "All rational numbers" },
];

// ---------------------------------------------------------------------------
// Combined set — everything a range picker or datatype list would want
// ---------------------------------------------------------------------------
export const BUILTIN_DATATYPES = [...XSD_DATATYPES, ...RDF_DATATYPES, ...OWL_DATATYPES];

/** Set of built-in datatype IRIs for quick membership testing. */
export const BUILTIN_DATATYPE_IRI_SET = new Set(BUILTIN_DATATYPES.map((d) => d.iri));

/** Look up a built-in datatype by IRI. Returns undefined if not found. */
export function findBuiltinDatatype(iri) {
  return BUILTIN_DATATYPES.find((d) => d.iri === iri);
}
