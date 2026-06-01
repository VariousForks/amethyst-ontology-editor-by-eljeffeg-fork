// ---------------------------------------------------------------------------
// Shared ontology colour palette
// ---------------------------------------------------------------------------
// This module is the single source of truth for the per-ontology colours used
// by BOTH the Cytoscape graph (GraphView) and the UI swatches
// (OntologyPicker, ManageProjectsView).
//
// GraphView previously defined its own copy of this logic internally.  It now
// imports getOntologyBorderColor() from here so the swatch colours always match
// the node border colours rendered in the graph.
//
// Colour assignment rules (must be identical here and in GraphView):
//   Slot 0 — the first root ontology → brand purple  (#ae9cff)
//   Slot 1 → hue 180 (teal/cyan)
//   Slot 2 → hue 340 (rose/pink)
//   Slot 3 → hue  85 (lime/yellow-green)
//   Slot 4 → hue 265 (violet/purple)
//   Slot 5 → hue 110 (green)
//   Slot 6 → hue 300 (magenta)
//   Slot 7 → hue 220 (blue)
//   Slot 8 → hue 200 (sky/cyan-blue)
// ---------------------------------------------------------------------------

// OKLCH → sRGB hex conversion (OKLab colour space).
function _oklchToHex(l, c, h) {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const ll = l_ ** 3;
  const mm = m_ ** 3;
  const ss = s_ ** 3;
  const γ = (x) => (x >= 0.0031308 ? 1.055 * x ** (1 / 2.4) - 0.055 : 12.92 * x);
  const clamp = (x) => Math.max(0, Math.min(255, Math.round(γ(x) * 255)));
  const r = clamp(4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss);
  const g = clamp(-1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss);
  const bv = clamp(-0.004196086 * ll - 0.7034186147 * mm + 1.707614701 * ss);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bv.toString(16).padStart(2, "0")}`;
}

// Hue angles for slots 1–8 (same order as GraphView._LINKED_HUES).
export const ONTO_HUES = [180, 340, 85, 265, 110, 300, 220, 200];

// Slot 0 — brand purple border (= PALETTE.classBorder in GraphView).
const BRAND_BORDER = "#ae9cff";

// The full per-slot colour triples (fill1, fill2, border).
// Slot 0 uses the brand purple values from GraphView's PALETTE.
export const LINKED_PALETTE = [
  // Slot 0 — brand purple (write / first ontology)
  { fill1: "#3b2aa0", fill2: "#6645dc", border: BRAND_BORDER },
  // Slots 1–8 — OKLCH-computed
  ...ONTO_HUES.map((h) => ({
    fill1: _oklchToHex(0.52, 0.14, h),
    fill2: _oklchToHex(0.62, 0.11, h),
    border: _oklchToHex(0.76, 0.22, h),
  })),
];

/**
 * Returns the "border" hex colour for ontology at position `index`
 * (0-based, matching the graph's slot assignment).
 *
 * This is the brightest / most saturated colour in each slot and is used
 * as the swatch colour in the picker and Manage Projects view.
 */
export function getOntologyColor(index) {
  const slot = index % LINKED_PALETTE.length;
  return LINKED_PALETTE[slot].border;
}

/**
 * Deterministic palette slot from a stable string (the ontology's database ID).
 * Same algorithm as GraphView._stableSlot (djb2 / Math.imul variant).
 */
export function stableSlot(id, len) {
  let h = 5381;
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % len;
}
