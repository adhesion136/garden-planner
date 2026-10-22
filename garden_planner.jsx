/**
 * Homestead Bed Planner — a garden/homestead planning app: draw beds to scale, trace them from a
 * satellite photo, plant and space them out, track companion planting and crop rotation, plan a
 * zone-aware calendar, and keep a year-over-year journal. Runs entirely in the browser — all data
 * lives in localStorage (via the `window.storage` shim used in the standalone build), nothing is
 * sent to a server.
 *
 * A few architectural things worth knowing before reading further:
 *
 * - COORDINATES. Two different position systems are used, and mixing them up is the easiest way
 *   to introduce a bug: (1) FEET, used for anything describing real-world size or a position
 *   relative to a bed's own origin (bed.widthFt, a plant's x/y, a plant-spacing box's x/y). (2)
 *   CANVAS PIXELS, used for a bed's or freestanding plant's own position on the open map (bed.x,
 *   bed.y, a freestanding plant's x/y). FT_TO_PX (14) converts between them: canvasPx = feet *
 *   FT_TO_PX. A plant's x/y inside a bed is feet relative to THAT BED's own origin, not the
 *   canvas — so rendering a plant's dot requires adding the bed's own canvas position first.
 *
 * - PLANT-SPACING BOXES. A "fill" operation (either the sidebar tool or dragging directly from an
 *   existing plant's own handle) creates a persistent, visible box (bed.plantBoxes) at a chosen
 *   spacing, and every plant it creates carries that box's id (plant.boxId). The box can be
 *   dragged or resized as a group; an individual plant detaches from its box (boxId cleared) by
 *   being dragged past the box's edge or via an explicit "release from group" action. Different
 *   boxes are allowed to overlap on purpose, for companion planting — surfaced as a colored
 *   border and a note (see the box-rendering block inside BedCard) rather than being prevented.
 *
 * - PERSISTENCE & UNDO. Everything meaningful (beds, plants, zone, light zones, year history,
 *   journal, background images) is debounced-saved to storage ~500ms after the last change settles
 *   (see the `persist` useCallback), so a fast drag doesn't fire dozens of saves. Undo/redo tracks
 *   the same fields on a similar debounce, using refs (not React state) as the source of truth for
 *   the undo/redo stacks — see the big comment above `undoStackRef` for why state wouldn't work
 *   safely there. Pure UI state (zoom, sidebar open/closed, viewport size) is deliberately excluded
 *   from both persistence and undo.
 *
 * - FILE LAYOUT, roughly top to bottom: reference data and constants → pure helper functions
 *   (spacing/companion/rotation lookups, date math, migration for old saved data) → standalone view
 *   components (CalendarView, HistoryView, JournalView) → modals (plant details, bed fields,
 *   calibration, year rollover) → BedCard (a single bed's rendering and interaction) → the main
 *   GardenPlanner component, which owns essentially all app state and the top-level layout.
 */

import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, memo, Fragment } from "react";
import {
  Trash2, Plus, X, ArrowUpRightFromCircle, Sprout, MapPin,
  PenTool, Undo2, Check, Edit3, Copy, ChevronDown, ChevronRight, Pencil,
  ZoomIn, ZoomOut, Download, Upload, Info, AlertTriangle, Sun, CalendarDays, Map, History, Eye, EyeOff, BookOpen,
  Image as ImageIcon, Lock, Unlock,
} from "lucide-react";

// Key under which the whole garden (beds, plants, zone, light zones, history, journal, images) is saved in storage.
const STORAGE_KEY = "garden-planner-v1";
// Pixels per foot at 100% zoom — the single scale factor between real-world feet and canvas pixels.
const FT_TO_PX = 14;
// Fallback spacing (inches) for a plant with nothing on file in PLANT_REFERENCE — used only to size
// its dot reasonably; the user's actual chosen spacing (from the fill tool) always takes precedence.
const DEFAULT_SPACING_IN = 12;
// The grid adapts its square size to the current zoom level, the same way a map's scale bar
// changes as you zoom — a fixed size either turns to visual noise when zoomed out far enough to
// see a large farm, or feels too coarse when zoomed in on a small garden bed. Uses the standard
// "1-2-5" sequence (1, 2, 5, 10, 20, 50...) that maps and technical drawings use for round, legible
// scale steps, picking the finest one that still renders at a comfortably visible size on screen.
const GRID_SIZE_OPTIONS_FT = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
// Smallest on-screen size (px) an automatic grid square is allowed to shrink to before it steps up to the next size.
const MIN_GRID_SCREEN_PX = 45;
// Picks the finest grid square size (feet) that still renders at least MIN_GRID_SCREEN_PX wide at the given zoom;
// used when the grid is on "Auto" instead of a fixed size the user typed in.
function getAdaptiveGridSizeFt(zoom) {
  for (const ft of GRID_SIZE_OPTIONS_FT) {
    if (ft * FT_TO_PX * zoom >= MIN_GRID_SCREEN_PX) return ft;
  }
  return GRID_SIZE_OPTIONS_FT[GRID_SIZE_OPTIONS_FT.length - 1];
}

// Soil type choices for a bed: display label plus the Tailwind classes used for its swatch, fill, border and text colors.
const SOIL_TYPES = {
  clay: { label: "Clay", swatch: "bg-orange-800", fill: "fill-orange-800", border: "border-orange-900", text: "text-orange-50", chip: "bg-orange-100 text-orange-900 border-orange-300" },
  sandy: { label: "Sandy", swatch: "bg-amber-500", fill: "fill-amber-500", border: "border-amber-700", text: "text-amber-950", chip: "bg-amber-100 text-amber-900 border-amber-300" },
  silty: { label: "Silty", swatch: "bg-yellow-600", fill: "fill-yellow-600", border: "border-yellow-800", text: "text-yellow-950", chip: "bg-yellow-100 text-yellow-900 border-yellow-300" },
  loamy: { label: "Loamy", swatch: "bg-amber-950", fill: "fill-amber-950", border: "border-black", text: "text-amber-50", chip: "bg-amber-100 text-amber-900 border-amber-300" },
  mixed: { label: "Mixed / combination", swatch: "bg-lime-700", fill: "fill-lime-700", border: "border-lime-900", text: "text-lime-50", chip: "bg-lime-100 text-lime-900 border-lime-300" },
  potting_mix: { label: "Store-bought potting mix", swatch: "bg-purple-700", fill: "fill-purple-700", border: "border-purple-900", text: "text-purple-50", chip: "bg-purple-100 text-purple-900 border-purple-300" },
  garden_soil: { label: "Store-bought garden soil", swatch: "bg-teal-700", fill: "fill-teal-700", border: "border-teal-900", text: "text-teal-50", chip: "bg-teal-100 text-teal-900 border-teal-300" },
  unknown: { label: "Unknown", swatch: "bg-stone-400", fill: "fill-stone-400", border: "border-stone-600", text: "text-stone-900", chip: "bg-stone-200 text-stone-800 border-stone-400" },
};

// Where in the yard a bed is (front, back, side, ...) — used for labels and filtering.
const YARD_LOCATIONS = {
  front: "Front yard",
  back: "Back yard",
  side: "Side yard",
  middle: "Middle / interior of yard",
  container: "Container / patio",
  indoor: "Indoor",
  unknown: "Unknown",
};

// How a bed is built (raised, in-ground, container, ...) — shown as a label on the bed card.
const BED_STRUCTURES = {
  in_ground: "In-ground",
  raised_bed: "Raised bed",
  hugelkultur: "Hugelkultur mound",
  container_pot: "Container / pot",
  straw_bale: "Straw bale",
  keyhole: "Keyhole garden",
  no_dig: "No-dig / lasagna bed",
  wicking_bed: "Wicking bed",
  unknown: "Unknown",
};

// Sun-exposure levels for a bed or light zone, keyed by the stored value, with the label shown to the user.
const SUN_EXPOSURES = {
  full_sun: "Full sun (6+ hrs direct)",
  part_sun: "Part sun / part shade (3-6 hrs)",
  full_shade: "Full shade (<3 hrs)",
  unknown: "Unknown / not tracked yet",
};

// Shapes a bed can have. "custom_points" is a freehand outline drawn on the map.
const BED_SHAPES = {
  rectangle: "Rectangle",
  circle_oval: "Circle / oval",
  custom_points: "Custom — draw it yourself",
};

// List of USDA hardiness zones (1a-13b) as { value, label } options for the zone dropdown, built once at load.
const USDA_ZONES = (() => {
  const zones = { unset: "Not set yet", international: "International / not sure (describe below)" };
  for (let z = 1; z <= 13; z++) {
    zones[`${z}a`] = `Zone ${z}a`;
    zones[`${z}b`] = `Zone ${z}b`;
  }
  return zones;
})();

// Water-need levels a plant can have, with display labels.
const WATER_NEEDS = {
  low: "Low (drought-tolerant)",
  medium: "Medium (regular watering)",
  high: "High (keep consistently moist)",
  unknown: "Unknown / not tracked yet",
};

// Temperature tolerance categories a plant can have (frost tender, average, cold hardy), with display labels.
const TEMP_PREFERENCES = {
  cold_hardy: "Cold-hardy",
  average: "Average / no special needs",
  heat_loving: "Heat-loving",
  frost_tender: "Frost-tender (protect from cold)",
  unknown: "Unknown / not tracked yet",
};

let idCounter = 1;
const nextId = () => `id-${Date.now()}-${idCounter++}`;

// Color styling (fill and badge classes) for each light-zone sun level so zones are visually distinguishable on the map.
const LIGHT_ZONE_STYLES = {
  full_sun: { fill: "fill-cyan-300", badge: "bg-cyan-100 text-cyan-800 border-cyan-400" },
  part_sun: { fill: "fill-blue-400", badge: "bg-blue-100 text-blue-800 border-blue-400" },
  full_shade: { fill: "fill-indigo-500", badge: "bg-indigo-100 text-indigo-800 border-indigo-400" },
};

// Landscape features (paths, patios, water features, structures) — a fixed set of kinds, each
// with a label, an icon, and its own accent color, but ALL sharing the same diagonal-hatch fill
// pattern and stone-gray border (see the feature-rendering block in the map canvas) — a
// deliberately different visual language from both beds (soil texture, green accents) and light
// zones (translucent color washes), so a feature reads unmistakably as "nothing plantable here"
// at a glance, regardless of which specific kind it is.
const SITE_FEATURE_KINDS = {
  path: { label: "Path", icon: "\u{1F463}", accent: "#78716c" },
  patio: { label: "Patio / hardscape", icon: "\u{25FC}\u{FE0F}", accent: "#a8a29e" },
  water_feature: { label: "Water feature", icon: "\u{1F4A7}", accent: "#0e7490" },
  structure: { label: "Structure", icon: "\u{1F3E0}", accent: "#78350f" },
  fence: { label: "Fence / border", icon: "\u{1F6A7}", accent: "#57534e" },
  other: { label: "Other (non-plantable)", icon: "\u{1F6AB}", accent: "#57534e" },
};
// Just the keys of SITE_FEATURE_KINDS, for iterating the kinds in a dropdown.
const SITE_FEATURE_KIND_KEYS = Object.keys(SITE_FEATURE_KINDS);

// Standard ray-casting point-in-polygon test — used specifically for checking whether a light
// zone's center falls within a custom-drawn bed shape (see suggestSunForBed below). Note: this is
// functionally identical to isInsidePolygon further down (same algorithm, different call sites) —
// left as two separate functions here rather than consolidated, since that's a small cleanup
// outside the scope of this annotation pass, not a behavior change.
function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Looks at where a bed's center point falls relative to drawn light zones,
// and returns the sun exposure of whichever zone contains it (or null if none).
function suggestSunForBed(bed, zones, ftToPx) {
  const centerX = bed.x + (bed.widthFt * ftToPx) / 2;
  const centerY = bed.y + (bed.lengthFt * ftToPx) / 2;
  for (const zone of zones) {
    const absPoints = zone.points.map((p) => ({ x: zone.x + p.x * ftToPx, y: zone.y + p.y * ftToPx }));
    if (pointInPolygon(centerX, centerY, absPoints)) return zone.sunExposure;
  }
  return null;
}

// Three-letter month names, indexed 0-11 to match JavaScript Date months.
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Rough, generalized average frost dates by USDA zone number. Real frost dates vary a lot by
// microclimate even within one zone — this is a starting point, not a precise local forecast.
const ZONE_FROST_DATES = {
  1: { lastFrost: [5, 15], firstFrost: [7, 15] },
  2: { lastFrost: [5, 1], firstFrost: [8, 15] },
  3: { lastFrost: [4, 15], firstFrost: [8, 15] },
  4: { lastFrost: [4, 15], firstFrost: [9, 1] },
  5: { lastFrost: [3, 30], firstFrost: [9, 15] },
  6: { lastFrost: [3, 15], firstFrost: [9, 30] },
  7: { lastFrost: [2, 30], firstFrost: [10, 15] },
  8: { lastFrost: [2, 15], firstFrost: [10, 31] },
  9: { lastFrost: [1, 15], firstFrost: [11, 15] },
  10: { lastFrost: [0, 30], firstFrost: [11, 30] },
};

// A modest set of common garden plants — anything not matched here just gets manual date fields, no guessing.
const PLANT_REFERENCE = {
  tomato: { tolerance: "tender", startIndoorsWks: 6, transplantAfterWks: 2, daysToMaturity: 75, recLight: "full_sun", recWater: "medium", spacingIn: 24 },
  pepper: { tolerance: "tender", startIndoorsWks: 8, transplantAfterWks: 2, daysToMaturity: 70, recLight: "full_sun", recWater: "medium", spacingIn: 18 },
  eggplant: { tolerance: "tender", startIndoorsWks: 8, transplantAfterWks: 2, daysToMaturity: 75, recLight: "full_sun", recWater: "medium", spacingIn: 24 },
  cucumber: { tolerance: "tender", startIndoorsWks: 3, transplantAfterWks: 2, daysToMaturity: 60, recLight: "full_sun", recWater: "high", spacingIn: 12 },
  squash: { tolerance: "tender", directSowAfterWks: 1, daysToMaturity: 50, recLight: "full_sun", recWater: "medium", spacingIn: 24 },
  zucchini: { tolerance: "tender", directSowAfterWks: 1, daysToMaturity: 50, recLight: "full_sun", recWater: "medium", spacingIn: 24 },
  pumpkin: { tolerance: "tender", directSowAfterWks: 1, daysToMaturity: 100, recLight: "full_sun", recWater: "medium", spacingIn: 36 },
  bean: { tolerance: "tender", directSowAfterWks: 1, daysToMaturity: 55, recLight: "full_sun", recWater: "medium", spacingIn: 6 },
  corn: { tolerance: "tender", directSowAfterWks: 1, daysToMaturity: 75, recLight: "full_sun", recWater: "medium", spacingIn: 12 },
  basil: { tolerance: "tender", startIndoorsWks: 6, transplantAfterWks: 2, daysToMaturity: 60, recLight: "full_sun", recWater: "medium", spacingIn: 10 },
  marigold: { tolerance: "tender", startIndoorsWks: 6, transplantAfterWks: 1, daysToMaturity: 50, recLight: "full_sun", recWater: "low", spacingIn: 10 },
  sunflower: { tolerance: "tender", directSowAfterWks: 1, daysToMaturity: 80, recLight: "full_sun", recWater: "medium", spacingIn: 18 },
  pea: { tolerance: "hardy", directSowBeforeWks: 4, daysToMaturity: 60, recLight: "full_sun", recWater: "medium", spacingIn: 4 },
  spinach: { tolerance: "hardy", directSowBeforeWks: 6, daysToMaturity: 45, recLight: "part_sun", recWater: "medium", spacingIn: 6 },
  carrot: { tolerance: "hardy", directSowBeforeWks: 3, daysToMaturity: 70, recLight: "full_sun", recWater: "medium", spacingIn: 3 },
  beet: { tolerance: "hardy", directSowBeforeWks: 3, daysToMaturity: 55, recLight: "full_sun", recWater: "medium", spacingIn: 4 },
  radish: { tolerance: "hardy", directSowBeforeWks: 4, daysToMaturity: 25, recLight: "full_sun", recWater: "medium", spacingIn: 3 },
  potato: { tolerance: "hardy", directSowBeforeWks: 2, daysToMaturity: 90, recLight: "full_sun", recWater: "medium", spacingIn: 12 },
  chard: { tolerance: "hardy", directSowBeforeWks: 2, daysToMaturity: 55, recLight: "full_sun", recWater: "medium", spacingIn: 9 },
  kale: { tolerance: "hardy", startIndoorsWks: 6, transplantBeforeWks: 3, daysToMaturity: 55, recLight: "full_sun", recWater: "medium", spacingIn: 15 },
  onion: { tolerance: "hardy", startIndoorsWks: 10, transplantBeforeWks: 4, daysToMaturity: 100, recLight: "full_sun", recWater: "medium", spacingIn: 5 },
  lettuce: { tolerance: "half_hardy", directSowBeforeWks: 3, daysToMaturity: 50, recLight: "part_sun", recWater: "medium", spacingIn: 10 },
  broccoli: { tolerance: "half_hardy", startIndoorsWks: 6, transplantBeforeWks: 2, daysToMaturity: 65, recLight: "full_sun", recWater: "medium", spacingIn: 18 },
  cabbage: { tolerance: "half_hardy", startIndoorsWks: 6, transplantBeforeWks: 2, daysToMaturity: 70, recLight: "full_sun", recWater: "medium", spacingIn: 15 },
  cilantro: { tolerance: "half_hardy", directSowBeforeWks: 2, daysToMaturity: 50, recLight: "part_sun", recWater: "medium", spacingIn: 6 },
  parsley: { tolerance: "half_hardy", startIndoorsWks: 8, transplantBeforeWks: 2, daysToMaturity: 70, recLight: "part_sun", recWater: "medium", spacingIn: 8 },
  strawberry: { perennialNote: "Perennial — plant crowns in early spring or early fall, not tied to frost timing.", recLight: "full_sun", recWater: "medium", recTemp: "average", spacingIn: 12 },
  blueberry: { perennialNote: "Perennial shrub — best planted in early spring or fall, in acidic soil.", recLight: "full_sun", recWater: "medium", recTemp: "average", spacingIn: 60 },
  elderberry: { perennialNote: "Perennial shrub — plant dormant bare-root stock in early spring or fall.", recLight: "full_sun", recWater: "medium", recTemp: "cold_hardy", spacingIn: 96 },
  raspberry: { perennialNote: "Perennial — plant dormant canes in early spring.", recLight: "full_sun", recWater: "medium", recTemp: "cold_hardy", spacingIn: 24 },
  garlic: { perennialNote: "Usually fall-planted (about 4-6 weeks before your first fall frost) for a summer harvest.", recLight: "full_sun", recWater: "low", recTemp: "cold_hardy", spacingIn: 5 },
};
// Precomputed once — PLANT_REFERENCE is a fixed constant, so there's no need to rebuild this
// array on every single matchPlantReference call (which happens frequently, e.g. once per plant
// per bed render).
const PLANT_REFERENCE_KEYS = Object.keys(PLANT_REFERENCE);

// Derives an implied temperature preference from a plant's frost tolerance, when it has one
// (annual entries) — perennial entries set recTemp explicitly instead, since they don't have "tolerance".
const TOLERANCE_TO_TEMP = { tender: "frost_tender", half_hardy: "average", hardy: "cold_hardy" };

// Looks up a plant's typical light/water/temperature needs from PLANT_REFERENCE by fuzzy name match;
// returns { matchKey, light, water, temp } or null when the plant name matches nothing known.
function getRecommendedNeeds(plantName) {
  const key = matchPlantReference(plantName);
  if (!key) return null;
  const ref = PLANT_REFERENCE[key];
  return {
    matchKey: key,
    light: ref.recLight || "unknown",
    water: ref.recWater || "unknown",
    temp: ref.recTemp || TOLERANCE_TO_TEMP[ref.tolerance] || "unknown",
  };
}

// Looks up a plant's recommended spacing (inches between plants) for the "fill bed" tool below.
// Returns null when the plant isn't in PLANT_REFERENCE or has no spacing figure on file.
function getRecommendedSpacingIn(plantName) {
  const key = matchPlantReference(plantName);
  if (!key) return null;
  const spacing = PLANT_REFERENCE[key].spacingIn;
  return typeof spacing === "number" ? spacing : null;
}

// Standard ray-casting point-in-polygon test, used for custom-shaped beds below.
function isInsidePolygon(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// Standard point-in-ellipse test (feet), used for a circle/oval bed — treats the bed's own
// width/length as the ellipse's full axes, centered on the bed.
function isInsideEllipse(px, py, widthFt, lengthFt) {
  const rx = widthFt / 2;
  const ry = lengthFt / 2;
  if (rx <= 0 || ry <= 0) return false;
  const dx = (px - rx) / rx;
  const dy = (py - ry) / ry;
  return dx * dx + dy * dy <= 1;
}

// Computes the grid of plant positions (feet, relative to the bed's own origin) for a box of a
// given rectangle and spacing — shared by the live fill-tool preview and by resizing an
// already-placed plant box, so both use identical math rather than two copies that could drift
// apart. For non-rectangular beds, a cell only counts if its center actually falls inside the
// bed's real shape, not just its bounding box.
function computeGridPositions(bed, boxRect, spacingFt) {
  const cols = Math.max(1, Math.floor(boxRect.widthFt / spacingFt));
  const rows = Math.max(1, Math.floor(boxRect.heightFt / spacingFt));
  const cellWFt = boxRect.widthFt / cols;
  const cellHFt = boxRect.heightFt / rows;
  const positions = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cellCenterXFt = boxRect.x + (c + 0.5) * cellWFt;
      const cellCenterYFt = boxRect.y + (r + 0.5) * cellHFt;
      let fits = true;
      if (bed.shape === "circle_oval") {
        fits = isInsideEllipse(cellCenterXFt, cellCenterYFt, bed.widthFt, bed.lengthFt);
      } else if (bed.shape === "custom_points" && bed.customPoints && bed.customPoints.length >= 3) {
        fits = isInsidePolygon(cellCenterXFt, cellCenterYFt, bed.customPoints);
      }
      if (fits) positions.push({ x: cellCenterXFt, y: cellCenterYFt });
    }
  }
  return positions;
}

// Computes a properly-spaced interplanted layout for two companion plant types sharing the same
// merged area — used when merging two overlapping plant-spacing boxes. The plant with the larger
// spacing (the "primary") keeps its own completely normal grid, unaffected by the other plant at
// all. The plant with the smaller spacing (the "companion") gets its own grid too, but offset by
// half the primary's spacing so its cells naturally target the gaps between primary cells, then
// filtered to drop any candidate that would land too close to a primary plant — using the same
// "personal space" radius (half of each plant's own spacing) the rest of the app already uses for
// distance checks. Returns { primaryPositions, companionPositions }, both in feet relative to the
// bed's own origin, ready to hand to blankPlant for each box.
function computeInterplantedLayout(bed, mergedRect, primarySpacingFt, companionSpacingFt) {
  const primaryPositions = computeGridPositions(bed, mergedRect, primarySpacingFt);
  // Both grids are computed over the exact same rectangle — no origin offset. An earlier version
  // offset the companion's grid by half the primary's *nominal* spacing to target the gaps
  // directly, but computeGridPositions actually redistributes cell size evenly to fill the box
  // exactly, so the real spacing is usually a bit larger than nominal — the offset didn't quite
  // line up with the real gaps, and also pushed the far edge outside the original box entirely.
  // Since the companion's own spacing is normally much smaller than the primary's, its plain grid
  // already has plenty of candidates naturally falling in the gaps; the distance filter below does
  // all the real work of keeping proper separation, and this way the companion's grid can never
  // extend past the box it's computed over in the first place.
  const minDistFt = primarySpacingFt / 2 + companionSpacingFt / 2;
  const companionPositions = computeGridPositions(bed, mergedRect, companionSpacingFt).filter((candidate) =>
    primaryPositions.every((p) => Math.hypot(candidate.x - p.x, candidate.y - p.y) >= minDistFt)
  );
  return { primaryPositions, companionPositions };
}

// Resolves a plant's stored light/water/temp value — if it's the literal "recommended" sentinel,
// looks up the current best-guess value instead of the raw string, so warnings/comparisons work correctly.
function resolveNeedValue(rawValue, plantName, field) {
  if (rawValue !== "recommended") return rawValue;
  const rec = getRecommendedNeeds(plantName);
  return rec ? rec[field] : "unknown";
}

// Fuzzy name matching used throughout — finds which of a list of known keys (e.g. "tomato",
// "cherry tomato") appears as a substring of the plant name the user actually typed, preferring
// the longest match so "cherry tomato" matches "cherry tomato" over the shorter "tomato" if both
// are known keys. This is how a user's free-text plant name gets connected to reference data
// (spacing, companion planting, rotation family, etc.) without requiring an exact match.
//
// PERFORMANCE: the result depends only on the (lowercased) name and the key list, and the key lists
// are fixed module-level constants — but this runs once per plant per neighbor on every render of
// a bed (a bed of 120 plants is ~14,000 lookups per render), each scanning every known key. Results
// are cached per key list (a WeakMap keyed by the array itself, so each list gets its own cache)
// and per lowercased name, which turns the repeated scans into a Map hit.
const matchKeyCache = new WeakMap(); // keys array -> Map(lowercased name -> best key | null)
function matchKeyIn(plantName, keys) {
  const name = (plantName || "").toLowerCase();
  let cache = matchKeyCache.get(keys);
  if (!cache) {
    cache = new Map();
    matchKeyCache.set(keys, cache);
  }
  if (cache.has(name)) return cache.get(name);
  let best = null;
  for (const key of keys) {
    if (name.includes(key) && (!best || key.length > best.length)) best = key;
  }
  cache.set(name, best);
  return best;
}

// Matches a plant name against PLANT_REFERENCE's own keys specifically (spacing, planting timing,
// light/water/temp recommendations) — see matchKeyIn above for the matching logic itself.
function matchPlantReference(plantName) {
  return matchKeyIn(plantName, PLANT_REFERENCE_KEYS);
}

// Perennials (berries, etc.) default to "keep" on year rollover since they don't get replanted each year.
function isPerennialPlant(plantName) {
  const key = matchPlantReference(plantName);
  return !!(key && PLANT_REFERENCE[key].perennialNote);
}

// Date math for planting-calendar calculations, all working with [month, day] pairs (0-indexed
// month, matching JS's own convention) rather than full dates, since a planting date is a
// recurring yearly thing, not tied to a specific year. The year 2001 is an arbitrary placeholder
// used only so Date's own day-of-week/month-rollover math can do the work.
function addWeeksToDate(monthDay, weeks) {
  const d = new Date(2001, monthDay[0], monthDay[1]);
  d.setDate(d.getDate() + weeks * 7);
  return [d.getMonth(), d.getDate()];
}

// Adds (or subtracts, if negative) days to a [month, day] pair and returns the new [month, day], rolling over month ends.
function addDaysToDate(monthDay, days) {
  const d = new Date(2001, monthDay[0], monthDay[1]);
  d.setDate(d.getDate() + days);
  return [d.getMonth(), d.getDate()];
}

// Renders a [month, day] pair as "Month D" for display (e.g. [2, 15] -> "March 15").
function formatMonthDay(monthDay) {
  return `${MONTH_NAMES[monthDay[0]]} ${monthDay[1]}`;
}

// Returns a best-effort, rough planting/harvest suggestion for a plant name given a zone, or null.
function getPlantingSuggestion(plantName, zoneValue) {
  const matchKey = matchPlantReference(plantName);
  if (!matchKey) return null;
  const ref = PLANT_REFERENCE[matchKey];
  if (ref.perennialNote) return { matchKey, perennialNote: ref.perennialNote };

  const zoneNum = parseInt(zoneValue, 10);
  const frost = ZONE_FROST_DATES[zoneNum];
  if (!zoneValue || zoneValue === "unset" || zoneValue === "international" || !frost) {
    return { matchKey, note: "Set your zone above (or a zone 1-10) to get suggested dates for this plant." };
  }

  let startIndoors = null;
  if (ref.startIndoorsWks) startIndoors = formatMonthDay(addWeeksToDate(frost.lastFrost, -ref.startIndoorsWks));

  let plantOutsideMD = null;
  if (ref.transplantAfterWks != null) plantOutsideMD = addWeeksToDate(frost.lastFrost, ref.transplantAfterWks);
  else if (ref.transplantBeforeWks != null) plantOutsideMD = addWeeksToDate(frost.lastFrost, -ref.transplantBeforeWks);
  else if (ref.directSowBeforeWks != null) plantOutsideMD = addWeeksToDate(frost.lastFrost, -ref.directSowBeforeWks);
  else if (ref.directSowAfterWks != null) plantOutsideMD = addWeeksToDate(frost.lastFrost, ref.directSowAfterWks);

  const plantOutside = plantOutsideMD ? formatMonthDay(plantOutsideMD) : null;

  let harvest = null;
  if (plantOutsideMD && ref.daysToMaturity) {
    const start = formatMonthDay(addDaysToDate(plantOutsideMD, ref.daysToMaturity));
    const end = formatMonthDay(addDaysToDate(plantOutsideMD, ref.daysToMaturity + 14));
    harvest = `${start} – ${end}`;
  }

  return { matchKey, startIndoors, plantOutside, harvest };
}

// Matches a leading month name or abbreviation ("jan", "March", ...) in free-text planting dates.
const MONTH_PATTERN = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

// Best-effort parse of a free-text date string like "Mar 19" or "Jul 28 – Aug 11" into a month index (0-11).
// Returns null if the text doesn't start with a recognizable month — those go in an "Unscheduled" bucket
// rather than being silently dropped or guessed at.
function parseMonthFromText(text) {
  if (!text) return null;
  const match = text.trim().match(MONTH_PATTERN);
  if (!match) return null;
  return MONTH_NAMES.findIndex((m) => m.toLowerCase() === match[1].toLowerCase());
}

// Pulls the first 1-2 digit number out of a free-text date (e.g. "Mar 19" -> 19), used to sort
// same-month calendar events by day. 99 (a deliberately-large sentinel) sorts undated entries last.
function parseDayFromText(text) {
  if (!text) return 99;
  const match = text.match(/(\d{1,2})/);
  return match ? parseInt(match[1], 10) : 99;
}

// What makes two plants "the same" for display purposes: same name AND same cultivar (case and
// surrounding spaces ignored). A bed can hold hundreds of individual plants from one fill, and
// listing each one separately in the calendar or in companion-planting notes is just noise — but a
// plant explicitly labeled as a different cultivar is a genuinely different thing worth its own
// line, so cultivar is part of the identity.
function varietyKey(plant) {
  return `${(plant.name || "").trim().toLowerCase()}|${(plant.cultivar || "").trim().toLowerCase()}`;
}

// Collapses a list of entries (each with a `plant`) into one entry per distinct variety+context,
// counting how many were merged. `contextKey(entry)` adds whatever else must also match for two
// entries to count as the same thing (location, dates, ...). The first entry of each group is kept
// as the representative and gets a `count` field.
function collapseByVariety(entries, contextKey) {
  const groups = new Map();
  entries.forEach((entry) => {
    const key = `${varietyKey(entry.plant)}||${contextKey(entry)}`;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { ...entry, count: 1 });
  });
  return Array.from(groups.values());
}

// Flattens every plant (in beds and freestanding) into timeline events for the calendar tab —
// collapsed so a bed with 144 identical carrots contributes one event per phase (carrot x144), not
// 144 copies of it. Plants only merge when name, cultivar, location, AND the date text all match,
// so a differently-labeled cultivar or a plant with its own dates still gets its own event.
function buildCalendarEvents(beds, plants) {
  const events = [];
  // Adds one calendar event per filled-in planting phase (start indoors / plant outside / harvest) for a plant.
  const addEvents = (plant, locationLabel) => {
    if (plant.plantingStartIndoors) {
      events.push({ plant, locationLabel, type: "Start indoors", text: plant.plantingStartIndoors, sortDay: parseDayFromText(plant.plantingStartIndoors) });
    }
    if (plant.plantingOutside) {
      events.push({ plant, locationLabel, type: "Plant outside", text: plant.plantingOutside, sortDay: parseDayFromText(plant.plantingOutside) });
    }
    if (plant.harvestWindow) {
      events.push({ plant, locationLabel, type: "Harvest", text: plant.harvestWindow, sortDay: parseDayFromText(plant.harvestWindow) });
    }
  };
  beds.forEach((bed) => bed.plants.forEach((p) => addEvents(p, bed.name)));
  plants.forEach((p) => addEvents(p, "Freestanding"));
  return collapseByVariety(events, (ev) => `${ev.locationLabel}|${ev.type}|${ev.text}`);
}

// Small "x36" marker shown next to a collapsed entry when it stands for more than one plant.
function countLabel(count) {
  return count > 1 ? `\u00d7${count}` : "";
}

// Every plant in the garden, regardless of whether any planting/harvest data has been entered —
// used so the calendar can show a plant even with nothing filled in yet, instead of hiding it.
function getAllPlantEntries(beds, plants) {
  const entries = [];
  beds.forEach((bed) => bed.plants.forEach((p) => entries.push({ plant: p, locationLabel: bed.name })));
  plants.forEach((p) => entries.push({ plant: p, locationLabel: "Freestanding" }));
  return entries;
}

// Calendar list-view colors for each kind of event (start indoors / plant outside / harvest).
const EVENT_TYPE_STYLES = {
  "Start indoors": "bg-purple-100 text-purple-800 border-purple-300",
  "Plant outside": "bg-emerald-100 text-emerald-800 border-emerald-300",
  Harvest: "bg-amber-100 text-amber-800 border-amber-300",
};

// Journal entry types (harvest, note, expense, ...) with their label and icon.
const JOURNAL_TYPES = {
  harvest: { label: "Harvest", badge: "bg-amber-100 text-amber-800 border-amber-300" },
  pest: { label: "Pest / disease", badge: "bg-red-100 text-red-800 border-red-300" },
  expense: { label: "Expense", badge: "bg-blue-100 text-blue-800 border-blue-300" },
  note: { label: "General note", badge: "bg-stone-100 text-stone-700 border-stone-300" },
};

// Gantt-chart bar colors for each growth phase.
const PHASE_COLORS = {
  indoor: "bg-purple-400",
  outside: "bg-emerald-400",
  harvest: "bg-amber-400",
};

// Shared category filter used by both the List and Gantt views — List events use the full label
// ("Start indoors"), Gantt phases use the short key ("indoor"); this bridges the two.
const CATEGORY_TO_PHASE = {
  "Start indoors": "indoor",
  "Plant outside": "outside",
  Harvest: "harvest",
};

// Human-readable names for each Gantt growth phase.
const PHASE_LABELS = {
  indoor: "Start indoors",
  outside: "Plant outside",
  harvest: "Harvest",
};

// Entries shown in the Gantt legend: one color swatch per phase.
const LEGEND_ITEMS = [
  { label: "Start indoors", classes: "border-purple-300 bg-purple-100 text-purple-800" },
  { label: "Plant outside", classes: "border-emerald-300 bg-emerald-100 text-emerald-800" },
  { label: "Harvest", classes: "border-amber-300 bg-amber-100 text-amber-800" },
];

// Converts a month/day into a 0-51 week-of-year index, using a fixed non-leap reference year.
function weekOfYear(month, day) {
  const d = new Date(2001, month, day);
  const start = new Date(2001, 0, 1);
  const dayOfYear = Math.round((d - start) / 86400000) + 1;
  return Math.min(51, Math.max(0, Math.floor((dayOfYear - 1) / 7)));
}

// Parses a free-text date like "Mar 19" into a week index. Falls back to mid-month (day 15) if
// a month is found but no day number — still gives a reasonable week, not a crash or a guess at a day.
function parseDateToWeek(text) {
  const month = parseMonthFromText(text);
  if (month === null || month === -1) return null;
  const dayMatch = text.match(/(\d{1,2})/);
  const day = dayMatch ? Math.min(28, parseInt(dayMatch[1], 10)) : 15;
  return weekOfYear(month, day);
}

// The week index each month "starts" on — used to place month labels along the 52-week header.
const MONTH_START_WEEKS = MONTH_NAMES.map((_, m) => weekOfYear(m, 1));

// Best-effort week-level phases for a single plant, for the Gantt row. Week precision only —
// the underlying dates are rough estimates or free text anyway, so day-level bars would be fake precision.
function getPlantWeekPhases(plant) {
  const phases = Array(52).fill(null);
  const indoorWeek = parseDateToWeek(plant.plantingStartIndoors);
  if (indoorWeek !== null) phases[indoorWeek] = "indoor";
  const outsideWeek = parseDateToWeek(plant.plantingOutside);
  if (outsideWeek !== null) phases[outsideWeek] = "outside";
  if (plant.harvestWindow) {
    const parts = plant.harvestWindow.split(/[–-]/).map((s) => s.trim());
    const startWeek = parseDateToWeek(parts[0]);
    if (startWeek !== null) {
      const endWeek = parts[1] ? parseDateToWeek(parts[1]) : startWeek;
      const validEnd = endWeek !== null ? endWeek : startWeek;
      if (validEnd >= startWeek) {
        for (let w = startWeek; w <= validEnd; w++) phases[w] = "harvest";
      } else {
        phases[startWeek] = "harvest";
      }
    }
  }
  return phases;
}

// Turns every plant into a Gantt row (52-week phase array) for the Gantt view — plants whose
// text couldn't be parsed into a week at all, despite having something entered, go in a separate
// "unscheduled" list rather than silently vanishing from the view.
function buildGanttRows(beds, plants) {
  const rows = [];
  const unscheduled = [];
  // Adds a Gantt row for a plant if it has any parseable dates; otherwise files it under "unscheduled".
  const addRow = (plant, locationLabel) => {
    const phases = getPlantWeekPhases(plant);
    if (phases.some((p) => p !== null)) {
      rows.push({ plant, locationLabel, phases });
    } else if (plant.plantingStartIndoors || plant.plantingOutside || plant.harvestWindow) {
      unscheduled.push({ plant, locationLabel });
    }
  };
  beds.forEach((bed) => bed.plants.forEach((p) => addRow(p, bed.name)));
  plants.forEach((p) => addRow(p, "Freestanding"));
  // One row per distinct variety in each location (same name + cultivar + identical timeline),
  // not one per individual plant.
  return {
    rows: collapseByVariety(rows, (r) => `${r.locationLabel}|${r.phases.map((p) => (p ? p[0] : "-")).join("")}`),
    unscheduled: collapseByVariety(
      unscheduled,
      (u) => `${u.locationLabel}|${u.plant.plantingStartIndoors}|${u.plant.plantingOutside}|${u.plant.harvestWindow}`
    ),
  };
}

// Calendar tab's Gantt-chart view: a 52-week horizontal timeline with one row per plant, colored
// bars for each phase (start indoors / plant outside / harvest), filterable by category.
function GanttView({ beds, plants, categoryFilter }) {
  const { rows, unscheduled } = buildGanttRows(beds, plants);

  if (rows.length === 0) {
    return (
      <div className="bg-white border border-stone-300 rounded-xl p-6 text-center text-stone-400 text-sm">
        Nothing with a recognizable month yet. Add planting or harvest dates on any plant's details (the ⓘ icon) to see it here.
      </div>
    );
  }

  return (
    <div className="bg-white border border-stone-300 rounded-xl p-3 overflow-x-auto">
      <p className="text-xs text-stone-400 mb-2">Scroll sideways to see the full year — each column is one week.</p>
      <div style={{ minWidth: 140 + 52 * 16 }}>
        <div className="grid gap-px" style={{ gridTemplateColumns: "140px repeat(52, minmax(16px, 1fr))" }}>
          <div />
          {Array.from({ length: 52 }, (_, w) => {
            const monthIndex = MONTH_START_WEEKS.indexOf(w);
            return (
              <div
                key={w}
                className={`text-xs mono-label text-stone-400 text-center pb-1 ${monthIndex !== -1 ? "border-l border-stone-300" : ""}`}
              >
                {monthIndex !== -1 ? MONTH_NAMES[monthIndex] : ""}
              </div>
            );
          })}
          {rows.map((row, ri) => (
            <Fragment key={ri}>
              <div className="text-xs text-stone-700 pr-2 py-1 truncate" title={`${row.plant.name}${row.plant.cultivar ? ` (${row.plant.cultivar})` : ""}${row.count > 1 ? ` ${countLabel(row.count)}` : ""} · ${row.locationLabel}`}>
                <div className="font-medium truncate">
                  {row.plant.name}
                  {row.plant.cultivar && <span className="text-stone-500 italic font-normal"> ({row.plant.cultivar})</span>}
                  {row.count > 1 && <span className="text-stone-400 font-normal"> {countLabel(row.count)}</span>}
                </div>
                <div className="text-stone-400 truncate">{row.locationLabel}</div>
              </div>
              {row.phases.map((phase, wi) => (
                <div key={wi} className={`py-1 ${MONTH_START_WEEKS.includes(wi) ? "border-l border-stone-200" : ""}`}>
                  <div
                    className={`h-4 rounded-sm ${phase ? PHASE_COLORS[phase] : "bg-stone-100"} ${
                      categoryFilter && phase && CATEGORY_TO_PHASE[categoryFilter] !== phase ? "opacity-25" : ""
                    }`}
                    title={
                      phase
                        ? `${row.plant.name}${row.plant.cultivar ? ` (${row.plant.cultivar})` : ""} · ${row.locationLabel} — ${PHASE_LABELS[phase]}`
                        : ""
                    }
                  />
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      </div>
      {unscheduled.length > 0 && (
        <p className="text-xs text-stone-400 mt-3 pt-3 border-t border-stone-200">
          {unscheduled.length} kind{unscheduled.length === 1 ? "" : "s"} of plant with dates that didn't start with a recognizable month {unscheduled.length === 1 ? "isn't" : "aren't"} shown on this timeline — see the List view for those.
        </p>
      )}
    </div>
  );
}

// The "Calendar" tab itself: toggles between a flat chronological List view (grouped by month,
// using buildCalendarEvents) and the Gantt view above, with a shared category filter between them.
function CalendarView({ beds, plants }) {
  const [mode, setMode] = useState("list"); // view: "list" or "gantt"
  const [categoryFilter, setCategoryFilter] = useState(null); // event type to emphasize, or null for all
  const events = buildCalendarEvents(beds, plants);
  const byMonth = Array.from({ length: 12 }, () => []);
  const unscheduled = [];
  events.forEach((ev) => {
    const month = parseMonthFromText(ev.text);
    if (month === null || month === -1) unscheduled.push(ev);
    else byMonth[month].push(ev);
  });
  byMonth.forEach((list) => list.sort((a, b) => a.sortDay - b.sortDay));

  const noInfoEntries = collapseByVariety(
    getAllPlantEntries(beds, plants).filter((e) => !e.plant.plantingStartIndoors && !e.plant.plantingOutside && !e.plant.harvestWindow),
    (e) => e.locationLabel
  );

  const totalScheduled = events.length - unscheduled.length;
  // Dims events that don't match the active category filter, so the chosen category stands out.
  const fadeClass = (evType) => (categoryFilter && evType !== categoryFilter ? "opacity-25" : "");

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-4 md:px-6 py-4 sm:py-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="fraunces text-xl text-stone-800">Your planting & harvest calendar</h2>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center border border-stone-300 rounded-lg bg-white overflow-hidden text-sm">
            <button
              type="button"
              onClick={() => setMode("list")}
              className={`px-3 py-1.5 ${mode === "list" ? "bg-emerald-700 text-white" : "text-stone-600 hover:bg-stone-50"}`}
            >
              List
            </button>
            <button
              type="button"
              onClick={() => setMode("gantt")}
              className={`px-3 py-1.5 border-l border-stone-300 ${mode === "gantt" ? "bg-emerald-700 text-white" : "text-stone-600 hover:bg-stone-50"}`}
            >
              Gantt
            </button>
          </div>
          <div className="flex items-center gap-1.5 text-xs mono-label">
            <button
              type="button"
              onClick={() => setCategoryFilter(null)}
              className={`inline-flex items-center gap-1 border rounded-full px-2 py-0.5 transition ${
                categoryFilter === null
                  ? "border-stone-500 bg-stone-700 text-white"
                  : "border-stone-300 bg-white text-stone-500 hover:bg-stone-50"
              }`}
            >
              All
            </button>
            {LEGEND_ITEMS.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => setCategoryFilter(item.label)}
                className={`inline-flex items-center gap-1 border rounded-full px-2 py-0.5 transition ${item.classes} ${
                  categoryFilter && categoryFilter !== item.label ? "opacity-40" : ""
                } ${categoryFilter === item.label ? "ring-2 ring-offset-1 ring-stone-400" : ""}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {events.length === 0 && noInfoEntries.length === 0 ? (
        <div className="bg-white border border-stone-300 rounded-xl p-6 text-center text-stone-400 text-sm">
          Nothing scheduled yet. Add planting or harvest dates on any plant's details (the ⓘ icon) to see it here.
        </div>
      ) : (
        <>
          {mode === "gantt" ? (
            <GanttView beds={beds} plants={plants} categoryFilter={categoryFilter} />
          ) : (
            <>
              {events.length > 0 && totalScheduled === 0 && (
                <p className="text-xs text-stone-500 mb-3">
                  None of your dates start with a recognizable month name yet — they're all in the "Unscheduled" list below.
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {MONTH_NAMES.map((monthName, i) => (
                  <div key={monthName} className="bg-white border border-stone-300 rounded-xl p-3">
                    <h3 className="fraunces text-base text-stone-700 mb-2">{monthName}</h3>
                    {byMonth[i].length === 0 ? (
                      <p className="text-xs text-stone-300 italic">Nothing yet</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {byMonth[i].map((ev, idx) => (
                          <li key={idx} className={`text-xs transition ${fadeClass(ev.type)}`}>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className={`inline-flex border rounded-full px-1.5 py-0.5 text-xs mono-label ${EVENT_TYPE_STYLES[ev.type]}`}>
                                {ev.type}
                              </span>
                              <span className="text-stone-800 font-medium">{ev.plant.name}</span>
                              {ev.plant.cultivar && <span className="text-stone-500 italic">({ev.plant.cultivar})</span>}
                              {ev.count > 1 && <span className="text-stone-400 mono-label">{countLabel(ev.count)}</span>}
                            </div>
                            <div className="text-stone-500 pl-0.5">
                              {ev.text} · {ev.locationLabel}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>

              {unscheduled.length > 0 && (
                <div className="mt-4 bg-white border border-stone-300 rounded-xl p-3">
                  <h3 className="fraunces text-base text-stone-700 mb-2">Unscheduled (couldn't tell which month)</h3>
                  <ul className="space-y-1.5">
                    {unscheduled.map((ev, idx) => (
                      <li key={idx} className={`text-xs transition ${fadeClass(ev.type)}`}>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className={`inline-flex border rounded-full px-1.5 py-0.5 text-xs mono-label ${EVENT_TYPE_STYLES[ev.type]}`}>
                            {ev.type}
                          </span>
                          <span className="text-stone-800 font-medium">{ev.plant.name}</span>
                          {ev.plant.cultivar && <span className="text-stone-500 italic">({ev.plant.cultivar})</span>}
                          {ev.count > 1 && <span className="text-stone-400 mono-label">{countLabel(ev.count)}</span>}
                        </div>
                        <div className="text-stone-500 pl-0.5">
                          {ev.text} · {ev.locationLabel}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {noInfoEntries.length > 0 && (
            <div className="mt-4 bg-white border border-stone-300 rounded-xl p-3">
              <h3 className="fraunces text-base text-stone-700 mb-2">Not yet scheduled</h3>
              <p className="text-xs text-stone-400 mb-2">These plants exist in your garden but have no planting or harvest dates entered yet.</p>
              <ul className="space-y-1">
                {noInfoEntries.map((e, idx) => (
                  <li key={idx} className="text-xs text-stone-700">
                    <span className="font-medium">{e.plant.name}</span>
                    {e.plant.cultivar && <span className="text-stone-500 italic"> ({e.plant.cultivar})</span>}
                    {e.count > 1 && <span className="text-stone-400 mono-label"> {countLabel(e.count)}</span>}
                    <span className="text-stone-400"> · {e.locationLabel}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// One plant's chip within an archived year's history entry — a simple name pill with an
// editable retrospective note ("how did this one do?"), independent of the plant's own live
// details in the current garden (this is a frozen snapshot, not a link back to a live plant).
function HistoryPlantChip({ plant, onSaveNote }) {
  const [editing, setEditing] = useState(false); // true while the inline text editor is open
  const [text, setText] = useState(plant.historyNote || ""); // the text currently typed into the inline editor

  if (editing) {
    return (
      <div className="w-full border border-stone-300 rounded-lg p-2 bg-white">
        <div className="text-xs font-medium text-stone-700 mb-1">
          {plant.name}
          {plant.cultivar && <span className="text-stone-500 italic"> ({plant.cultivar})</span>}
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="How did this one do?"
          rows={2}
          className="w-full border border-stone-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-600"
        />
        <div className="flex justify-end gap-1.5 mt-1">
          <button
            onClick={() => {
              setText(plant.historyNote || "");
              setEditing(false);
            }}
            className="text-xs px-2 py-1 rounded border border-stone-300 hover:bg-stone-50"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onSaveNote(text.trim());
              setEditing(false);
            }}
            className="text-xs px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-800 text-white"
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="inline-flex flex-col items-start max-w-full">
      <span className="inline-flex items-center gap-1 text-xs bg-stone-100 text-stone-700 rounded-full px-2 py-0.5">
        {plant.name}
        {plant.cultivar && <span className="text-stone-500 italic"> ({plant.cultivar})</span>}
        <button
          onClick={() => setEditing(true)}
          className="hover:text-emerald-700 p-0.5 -m-0.5"
          title={plant.historyNote ? "Edit note" : "Add a note"}
        >
          <Pencil size={10} />
        </button>
      </span>
      {plant.historyNote && <p className="text-xs text-stone-500 italic mt-0.5">{plant.historyNote}</p>}
    </div>
  );
}

// A history entry's year label, editable in place. Archives are labeled with free text, so a typo
// (or an entry from an older version of the app, which labeled archives differently) needs a way to
// be corrected without deleting the whole snapshot.
function HistoryYearLabel({ entry, onSave }) {
  const [editing, setEditing] = useState(false); // true while the inline text editor is open
  const [text, setText] = useState(entry.year); // the text currently typed into the inline editor
  // Saves the edited text (if not blank) and leaves edit mode.
  const commit = () => {
    if (text.trim()) onSave(text.trim());
    setEditing(false);
  };
  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <input
          aria-label="Year label"
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="fraunces text-lg w-36 border border-stone-300 rounded-lg px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-emerald-600"
        />
        <button onClick={commit} title="Save year label" className="text-emerald-700 hover:text-emerald-800 p-1">
          <Check size={14} />
        </button>
        <button onClick={() => setEditing(false)} title="Cancel" className="text-stone-400 hover:text-stone-600 p-1">
          <X size={14} />
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <h3 className="fraunces text-lg text-stone-800">{entry.year}</h3>
      <button
        onClick={() => {
          setText(entry.year);
          setEditing(true);
        }}
        title="Edit year label"
        className="text-stone-400 hover:text-emerald-700 p-1 -m-0.5"
      >
        <Pencil size={12} />
      </button>
    </div>
  );
}

// The "History" tab: past years' gardens, archived via the year-rollover flow (YearRolloverModal)
// as frozen snapshots of beds/plants at that point in time — browsing history never touches the
// current live garden, only these separately-stored yearHistory entries.
function HistoryView({ yearHistory, onDeleteEntry, onUpdateYear, onUpdateYearNotes, onUpdatePlantNote }) {
  const sorted = sortYearHistory(yearHistory);

  if (sorted.length === 0) {
    return (
      <div className="max-w-4xl mx-auto px-3 sm:px-4 md:px-6 py-4 sm:py-6">
        <h2 className="fraunces text-xl text-stone-800 mb-4">Garden history</h2>
        <div className="bg-white border border-stone-300 rounded-xl p-6 text-center text-stone-400 text-sm">
          No past years archived yet. Use "Start a new year" on the Garden map tab to save a snapshot of what's planted where before clearing your beds for the next season.
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-4 md:px-6 py-4 sm:py-6">
      <h2 className="fraunces text-xl text-stone-800 mb-4">Garden history</h2>
      <div className="space-y-4">
        {sorted.map((entry) => {
          const totalPlants = entry.beds.reduce((sum, b) => sum + b.plants.length, 0) + entry.plants.length;
          return (
            <div key={entry.id} className="bg-white border border-stone-300 rounded-xl p-4">
              <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
                <HistoryYearLabel entry={entry} onSave={(text) => onUpdateYear(entry.id, text)} />
                <div className="flex items-center gap-2">
                  <span className="text-xs text-stone-400">
                    Archived {new Date(entry.archivedAt).toLocaleDateString()}
                  </span>
                  <button
                    onClick={() => onDeleteEntry(entry.id)}
                    className="text-stone-400 hover:text-red-600 p-1 -m-1"
                    title="Delete this history entry"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              {isFutureYearEntry(entry) && (
                <p className="text-xs text-orange-700 bg-orange-50 border border-orange-200 rounded-lg px-2.5 py-2 mb-3">
                  This entry is labeled {entryCropYear(entry)}, which hasn't happened yet, so crop-rotation checks are ignoring it.
                  Correct the label above (the pencil icon), or delete the entry if it was just a test.
                </p>
              )}
              <p className="text-xs text-stone-400 mb-3">
                {entry.beds.length} bed{entry.beds.length === 1 ? "" : "s"} · {totalPlants} plant{totalPlants === 1 ? "" : "s"}
                {entry.zone && entry.zone !== "unset" ? ` · Zone ${USDA_ZONES[entry.zone] || entry.zone}` : ""}
              </p>

              <div className="mb-3">
                <label className="text-xs mono-label text-stone-400 block mb-1">Notes on this year overall</label>
                <textarea
                  value={entry.yearNotes || ""}
                  onChange={(e) => onUpdateYearNotes(entry.id, e.target.value)}
                  placeholder="e.g. Dry summer, watered more than usual. Aphids were bad on the brassicas."
                  rows={2}
                  className="w-full border border-stone-300 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="space-y-2">
                {entry.beds.map((bed) => (
                  <div key={bed.id} className="border border-stone-200 rounded-lg p-2.5">
                    <div className="text-sm font-medium text-stone-700">{bed.name}</div>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {bed.plants.length === 0 ? (
                        <span className="text-xs text-stone-300 italic">No plants recorded</span>
                      ) : (
                        bed.plants.map((p) => (
                          <HistoryPlantChip
                            key={p.id}
                            plant={p}
                            onSaveNote={(text) => onUpdatePlantNote(entry.id, bed.id, p.id, text)}
                          />
                        ))
                      )}
                    </div>
                  </div>
                ))}
                {entry.plants.length > 0 && (
                  <div className="border border-stone-200 rounded-lg p-2.5">
                    <div className="text-sm font-medium text-stone-700">Freestanding</div>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {entry.plants.map((p) => (
                        <HistoryPlantChip
                          key={p.id}
                          plant={p}
                          onSaveNote={(text) => onUpdatePlantNote(entry.id, null, p.id, text)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The "Journal" tab: free-form dated entries (harvest, pest/disease, expense, general note),
// each optionally tagged to a bed — independent of any plant, calendar, or history data; this is
// just a simple running log the user writes and reads back chronologically.
function JournalView({ journalEntries, beds, onAddEntry, onDeleteEntry }) {
  const [type, setType] = useState("harvest"); // journal entry type being written
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10)); // entry date (defaults to today)
  const [bedName, setBedName] = useState(""); // bed the entry relates to (optional)
  const [plantName, setPlantName] = useState(""); // plant the entry relates to (optional)
  const [amount, setAmount] = useState(""); // harvest quantity or expense amount, as typed
  const [notes, setNotes] = useState(""); // free-text notes
  const [filter, setFilter] = useState(null); // journal type filter, or null for all

  const bedNameOptions = Array.from(new Set(beds.map((b) => b.name)));

  // Validates the journal form (an entry needs some content, expenses need an amount or note) and hands it to onAddEntry.
  function handleSubmit(e) {
    e.preventDefault();
    if (!notes.trim() && !plantName.trim() && type !== "expense") return;
    if (type === "expense" && !amount && !notes.trim()) return;
    onAddEntry({
      type,
      date,
      bedName: bedName.trim(),
      plantName: plantName.trim(),
      amount: type === "expense" ? amount : "",
      notes: notes.trim(),
    });
    setPlantName("");
    setAmount("");
    setNotes("");
  }

  const sorted = [...journalEntries].sort((a, b) => new Date(b.date) - new Date(a.date));
  const filtered = filter ? sorted.filter((e) => e.type === filter) : sorted;
  const totalExpenses = journalEntries
    .filter((e) => e.type === "expense" && e.amount)
    .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-4 md:px-6 py-4 sm:py-6">
      <h2 className="fraunces text-xl text-stone-800 mb-4">Garden journal</h2>

      <div className="bg-white border border-stone-300 rounded-xl p-4 mb-4">
        <h3 className="fraunces text-base text-stone-700 mb-3">Add an entry</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {Object.entries(JOURNAL_TYPES).map(([key, t]) => (
              <button
                key={key}
                type="button"
                onClick={() => setType(key)}
                className={`text-xs px-3 py-1.5 rounded-full border font-medium transition ${
                  type === key ? t.badge + " ring-2 ring-offset-1 ring-current" : "bg-white text-stone-500 border-stone-300 hover:bg-stone-50"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs mono-label text-stone-500 block mb-1">Date</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>
            {type === "expense" ? (
              <div>
                <label className="text-xs mono-label text-stone-500 block mb-1">Amount ($)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="e.g. 24.99"
                  className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
            ) : (
              <div>
                <label className="text-xs mono-label text-stone-500 block mb-1">Plant (optional)</label>
                <input
                  value={plantName}
                  onChange={(e) => setPlantName(e.target.value)}
                  placeholder="e.g. Tomato"
                  className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
            )}
          </div>
          <div>
            <label className="text-xs mono-label text-stone-500 block mb-1">Bed (optional)</label>
            <input
              value={bedName}
              onChange={(e) => setBedName(e.target.value)}
              placeholder="e.g. Front bed 2"
              list="journal-bed-options"
              className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
            />
            <datalist id="journal-bed-options">
              {bedNameOptions.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="text-xs mono-label text-stone-500 block mb-1">
              {type === "harvest" ? "What & how much (e.g. \"3 lbs tomatoes\")" : type === "pest" ? "What you saw" : type === "expense" ? "What it was for" : "Notes"}
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
            />
          </div>
          <button type="submit" className="bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg px-4 py-2 text-sm font-medium">
            Add entry
          </button>
        </form>
      </div>

      {journalEntries.length === 0 ? (
        <div className="bg-white border border-stone-300 rounded-xl p-6 text-center text-stone-400 text-sm">
          No journal entries yet. Log a harvest, a pest sighting, an expense, or just a note above.
        </div>
      ) : (
        <>
          <div className="flex items-center flex-wrap gap-2 mb-3">
            <button
              onClick={() => setFilter(null)}
              className={`text-xs px-3 py-1 rounded-full border ${!filter ? "bg-stone-800 text-white border-stone-800" : "bg-white text-stone-500 border-stone-300"}`}
            >
              All
            </button>
            {Object.entries(JOURNAL_TYPES).map(([key, t]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`text-xs px-3 py-1 rounded-full border ${filter === key ? t.badge + " ring-1 ring-current" : "bg-white text-stone-500 border-stone-300"}`}
              >
                {t.label}
              </button>
            ))}
            {totalExpenses > 0 && (
              <span className="ml-auto text-xs mono-label text-stone-500">
                Total logged expenses: ${totalExpenses.toFixed(2)}
              </span>
            )}
          </div>

          <div className="space-y-2">
            {filtered.map((entry) => {
              const t = JOURNAL_TYPES[entry.type] || JOURNAL_TYPES.note;
              return (
                <div key={entry.id} className="bg-white border border-stone-300 rounded-xl p-3 flex items-start gap-3">
                  <span className={`shrink-0 text-xs mono-label px-2 py-0.5 rounded-full border ${t.badge}`}>{t.label}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-stone-400 mono-label">
                      {new Date(entry.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                      {entry.bedName && <> · {entry.bedName}</>}
                      {entry.plantName && <> · {entry.plantName}</>}
                      {entry.type === "expense" && entry.amount && <> · ${Number(entry.amount).toFixed(2)}</>}
                    </div>
                    {entry.notes && <p className="text-sm text-stone-700 mt-0.5">{entry.notes}</p>}
                  </div>
                  <button onClick={() => onDeleteEntry(entry.id)} className="shrink-0 text-stone-400 hover:text-red-600 p-1 -m-1" title="Delete entry">
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// Traditional companion-planting pairings — this is garden folklore passed down through generations,
// not rigorously proven science. Treated here as a starting point worth trying, not settled fact.
// Botanical family groupings, used for crop-rotation warnings — growing the same family in the
// same bed repeated years running is what actually depletes soil and builds up pests/disease,
// not just replanting the exact same crop. Common garden guidance, not a hard scientific rule.
const PLANT_FAMILIES = {
  tomato: "nightshade", pepper: "nightshade", eggplant: "nightshade", potato: "nightshade",
  cabbage: "brassica", broccoli: "brassica", kale: "brassica",
  bean: "legume", pea: "legume",
  cucumber: "cucurbit", squash: "cucurbit", zucchini: "cucurbit", pumpkin: "cucurbit",
  onion: "allium", garlic: "allium", chives: "allium",
  carrot: "umbellifer", dill: "umbellifer", parsley: "umbellifer", cilantro: "umbellifer", fennel: "umbellifer",
  beet: "amaranth", spinach: "amaranth", chard: "amaranth",
  lettuce: "aster", marigold: "aster", zinnia: "aster", calendula: "aster", cosmos: "aster", sunflower: "aster", chrysanthemum: "aster",
  corn: "grass",
  strawberry: "rose", raspberry: "rose",
  blueberry: "heath",
  basil: "mint", mint: "mint", rosemary: "mint", thyme: "mint", sage: "mint", oregano: "mint", lavender: "mint", "lemon balm": "mint", catnip: "mint",
};
// Just the keys of PLANT_FAMILIES, used for fuzzy-matching a plant name to its botanical family.
const PLANT_FAMILY_KEYS = Object.keys(PLANT_FAMILIES);

// Looks up a plant's botanical family (e.g. tomato -> nightshade) for crop-rotation checks.
function matchPlantFamily(plantName) {
  const key = matchKeyIn(plantName, PLANT_FAMILY_KEYS);
  return key ? PLANT_FAMILIES[key] : null;
}

// The growing year an archived entry is FOR. Archive labels are free text ("2025", "Summer 2025"),
// so this pulls the 4-digit year out of the label; a label with no year in it falls back to the
// year the snapshot was actually taken.
function entryCropYear(entry) {
  const match = String(entry.year || "").match(/\b(19|20)\d{2}\b/);
  if (match) return parseInt(match[0], 10);
  const archived = new Date(entry.archivedAt);
  return isNaN(archived) ? 0 : archived.getFullYear();
}

// True for an archive labeled with a year that hasn't happened yet — which can't be real history
// (nothing has been grown in the future), so crop-rotation checks ignore it and the History tab
// flags it so the label can be corrected.
function isFutureYearEntry(entry) {
  return entryCropYear(entry) > new Date().getFullYear();
}

// Newest growing year first (ties broken by which was archived most recently). Ordering by the
// crop year rather than by archive date matters: an older season archived late (or a backfilled
// one) shouldn't outrank a more recent one when picking the most relevant past year.
function sortYearHistory(history) {
  return [...history].sort((a, b) => entryCropYear(b) - entryCropYear(a) || new Date(b.archivedAt) - new Date(a.archivedAt));
}

// Best default label for the "Start a new year" archive. From June on, the season being closed out
// is this calendar year's; in January-May it's last year's. (This used to always assume last year,
// which mislabeled an end-of-season archive; an even older version always assumed this year.)
function defaultArchiveYearLabel() {
  const now = new Date();
  return String(now.getMonth() >= 5 ? now.getFullYear() : now.getFullYear() - 1);
}

// Checks whether this plant shares a botanical family with anything grown in a same-named bed
// in past years — the most recent match wins, since that's the most relevant one to flag.
// Expects sortedYearHistory already sorted (see sortYearHistory) — callers that check many plants
// against the same history (like BedCard, once per plant) sort once and reuse it.
//
// Two kinds of entries are deliberately NOT counted as rotation history:
//  - archives labeled with a future year (not real history — see isFutureYearEntry), and
//  - plants that are still in the bed right now (livePlantIds). Starting a new year keeps chosen
//    plants (perennials by default) in place, and the archive holds a copy of them with the same
//    ids — so without this, every kept plant warned about itself ("you grew this here in 2025").
//    A plant that never left the bed wasn't rotated out, so it isn't rotation history.
function getRotationWarning(bedName, plantName, sortedYearHistory, livePlantIds) {
  const family = matchPlantFamily(plantName);
  if (!family || !bedName) return null;
  for (const entry of sortedYearHistory) {
    if (isFutureYearEntry(entry)) continue;
    const pastBed = entry.beds.find((b) => b.name.trim().toLowerCase() === bedName.trim().toLowerCase());
    if (!pastBed) continue;
    for (const p of pastBed.plants) {
      if (livePlantIds && livePlantIds.has(p.id)) continue;
      if (matchPlantFamily(p.name) === family) {
        return { family, year: entry.year, matchedPlant: p.name };
      }
    }
  }
  return null;
}

// Traditional companion-planting reference table: for each plant, which neighbors are good for it and which to avoid.
const COMPANION_DATA = {
  tomato: { good: ["basil", "carrot", "onion", "marigold", "parsley"], bad: ["cabbage", "corn", "fennel", "potato"] },
  basil: { good: ["tomato", "pepper"], bad: [] },
  pepper: { good: ["basil", "onion"], bad: ["fennel"] },
  carrot: { good: ["tomato", "onion", "lettuce", "pea"], bad: ["dill"] },
  onion: { good: ["tomato", "carrot", "pepper", "lettuce"], bad: ["bean", "pea"] },
  bean: { good: ["corn", "squash", "cucumber", "carrot"], bad: ["onion", "garlic"] },
  corn: { good: ["bean", "squash", "cucumber"], bad: ["tomato"] },
  squash: { good: ["corn", "bean"], bad: ["potato"] },
  zucchini: { good: ["corn", "bean"], bad: ["potato"] },
  cucumber: { good: ["bean", "corn", "pea", "radish"], bad: ["potato"] },
  cabbage: { good: ["onion", "potato", "dill"], bad: ["tomato", "strawberry", "pepper"] },
  broccoli: { good: ["onion", "dill"], bad: ["tomato", "strawberry"] },
  potato: { good: ["bean", "corn", "cabbage"], bad: ["tomato", "cucumber", "squash", "pumpkin", "sunflower"] },
  lettuce: { good: ["carrot", "onion", "radish", "cucumber"], bad: [] },
  radish: { good: ["cucumber", "lettuce", "pea", "bean"], bad: [] },
  pea: { good: ["carrot", "radish", "cucumber", "corn"], bad: ["onion", "garlic"] },
  garlic: { good: ["tomato", "cabbage"], bad: ["bean", "pea"] },
  strawberry: { good: ["bean", "lettuce", "spinach", "borage"], bad: ["cabbage", "broccoli"] },
  spinach: { good: ["strawberry", "cabbage"], bad: [] },
  eggplant: { good: ["bean", "pepper", "thyme"], bad: ["fennel"] },

  // Herbs
  fennel: { good: [], bad: ["tomato", "pepper", "bean", "carrot", "dill"] },
  dill: { good: ["cucumber", "cabbage", "lettuce"], bad: ["carrot", "tomato"] },
  mint: { good: ["cabbage", "tomato"], bad: [] },
  rosemary: { good: ["cabbage", "bean", "carrot", "sage"], bad: [] },
  thyme: { good: ["cabbage", "tomato", "eggplant"], bad: [] },
  sage: { good: ["cabbage", "carrot", "tomato", "rosemary"], bad: ["cucumber"] },
  oregano: { good: ["cabbage", "cucumber", "pepper"], bad: [] },
  chives: { good: ["carrot", "tomato", "cucumber"], bad: ["bean", "pea"] },
  parsley: { good: ["tomato", "carrot"], bad: [] },
  cilantro: { good: ["spinach", "pea"], bad: [] },
  lavender: { good: ["cabbage"], bad: [] },
  "lemon balm": { good: ["tomato", "squash"], bad: [] },
  catnip: { good: ["squash", "cucumber"], bad: [] },
  borage: { good: ["tomato", "squash", "strawberry"], bad: [] },

  // Flowers
  marigold: { good: ["tomato", "pepper", "cucumber", "squash"], bad: [] },
  nasturtium: { good: ["cucumber", "squash", "tomato", "cabbage"], bad: [] },
  zinnia: { good: ["cucumber", "squash"], bad: [] },
  calendula: { good: ["tomato", "cabbage"], bad: [] },
  cosmos: { good: ["corn", "bean"], bad: [] },
  sunflower: { good: ["corn", "cucumber"], bad: ["potato"] },
  petunia: { good: ["bean", "squash"], bad: [] },
  geranium: { good: ["cabbage", "corn"], bad: [] },
  chrysanthemum: { good: [], bad: [] },
};
// Just the keys of COMPANION_DATA, used for fuzzy name matching.
const COMPANION_DATA_KEYS = Object.keys(COMPANION_DATA);

// Looks up a plant's key in COMPANION_DATA (the traditional companion-planting reference table).
function matchCompanionKey(plantName) {
  return matchKeyIn(plantName, COMPANION_DATA_KEYS);
}

// Compares one plant against a list of other plants (its neighbors) and returns which of them
// are traditionally good or bad companions, based on name-matching against COMPANION_DATA.
// neighborPlants may be the full bed (including the plant itself) when plant.id is set — it's
// skipped internally rather than requiring the caller to pre-filter it out every time. Callers
// without an id (a plant not yet added to a bed) should keep passing an already-filtered list.
function getCompanionRelations(plant, neighborPlants) {
  const key = matchCompanionKey(plant.name);
  if (!key) return { key: null, goodNeighbors: [], badNeighbors: [] };
  const data = COMPANION_DATA[key];
  // Neighbors are grouped by variety (name + cultivar) rather than listed one per plant — a bed
  // with 36 carrots should read "Carrot x36", not "Carrot, Carrot, Carrot..." thirty-six times —
  // while a differently-labeled cultivar still gets its own entry.
  const good = new Map();
  const bad = new Map();
  // Counts a neighbor plant into a good/bad bucket, grouped by variety so duplicates collapse into one counted entry.
  const tally = (bucket, n) => {
    const k = varietyKey(n);
    const existing = bucket.get(k);
    if (existing) existing.count += 1;
    else bucket.set(k, { label: n.cultivar && n.cultivar.trim() ? `${n.name} (${n.cultivar.trim()})` : n.name, count: 1 });
  };
  neighborPlants.forEach((n) => {
    if (plant.id !== undefined && n.id === plant.id) return;
    const nKey = matchCompanionKey(n.name);
    if (!nKey || nKey === key) return;
    const isBad = data.bad.includes(nKey) || (COMPANION_DATA[nKey] && COMPANION_DATA[nKey].bad.includes(key));
    const isGood = data.good.includes(nKey) || (COMPANION_DATA[nKey] && COMPANION_DATA[nKey].good.includes(key));
    if (isBad) tally(bad, n);
    else if (isGood) tally(good, n);
  });
  // Turns a bucket into display strings, adding a " ×N" suffix where several plants share a variety.
  const toLabels = (bucket) => Array.from(bucket.values()).map(({ label, count }) => (count > 1 ? `${label} ${countLabel(count)}` : label));
  return { key, goodNeighbors: toLabels(good), badNeighbors: toLabels(bad) };
}

// Direct name-to-name companion check (unlike getCompanionRelations, which compares one plant
// against a list of neighbors) — used to compare two overlapping plant-spacing boxes directly.
function getCompanionStatus(nameA, nameB) {
  const keyA = matchCompanionKey(nameA);
  const keyB = matchCompanionKey(nameB);
  if (!keyA || !keyB || keyA === keyB) return "unknown";
  const dataA = COMPANION_DATA[keyA];
  const dataB = COMPANION_DATA[keyB];
  const isBad = (dataA && dataA.bad.includes(keyB)) || (dataB && dataB.bad.includes(keyA));
  const isGood = (dataA && dataA.good.includes(keyB)) || (dataB && dataB.good.includes(keyA));
  if (isBad) return "bad";
  if (isGood) return "good";
  return "unknown";
}

// Compares a bed's own sun exposure against a plant's light preference — returns a warning
// string if they genuinely conflict, null if they match or either side is unknown (an unknown
// value is treated as "no opinion," not as a mismatch to flag).
function lightMismatch(bedSunExposure, plantLight) {
  if (!bedSunExposure || !plantLight) return null;
  if (bedSunExposure === "unknown" || plantLight === "unknown") return null;
  if (bedSunExposure === plantLight) return null;
  return `This bed gets ${SUN_EXPOSURES[bedSunExposure]}, but this plant prefers ${SUN_EXPOSURES[plantLight]}.`;
}

// A sensible default position for a plant within a bed, based on how many plants already exist —
// a loose grid, generous enough to avoid most overlaps without needing the user to specify
// anything. They can drag it wherever they actually want afterward.
function defaultPlantPositionInBed(bed, index) {
  const DEFAULT_SPACING_FT = 1.5;
  const perRow = Math.max(1, Math.floor(bed.widthFt / DEFAULT_SPACING_FT));
  const col = index % perRow;
  const row = Math.floor(index / perRow);
  const x = Math.min(Math.max(0, bed.widthFt - 0.1), col * DEFAULT_SPACING_FT + DEFAULT_SPACING_FT / 2);
  const y = Math.min(Math.max(0, bed.lengthFt - 0.1), row * DEFAULT_SPACING_FT + DEFAULT_SPACING_FT / 2);
  return { x, y };
}

// Finds a spot for a newly-added plant that isn't on top of (or hidden behind) anything already in
// the bed. Scans the WHOLE bed at a fine resolution, left to right and top to bottom, and returns
// the first spot that is (a) inside the bed's actual shape, (b) outside every plant-box's area —
// including the empty gaps between a box's plants, since those are spoken for even though no plant
// is sitting exactly there — and (c) far enough from every existing plant.
//
// An earlier version cycled through a fixed 1.5ft grid keyed on plant COUNT, which had three
// problems: it never used the right-hand stretch of the bed (a 4ft bed only got columns at 0.75ft
// and 2.25ft), it treated gaps inside a filled box as free, and when it found nothing free it fell
// back to an index-based spot that landed directly on top of existing plants.
//
// If the bed truly has no free spot, this doesn't stack the plant on the index-based position —
// it picks the least crowded spot available (preferring anywhere outside a box, then whichever is
// farthest from its nearest neighbor), so a full bed degrades gracefully instead of hiding the new
// plant underneath others. Used when a plant is actually going into a bed right now (adding one,
// or moving a freestanding plant in) — bulk migration keeps using the simple sequential
// defaultPlantPositionInBed above, since spreading many not-yet-positioned plants out by index
// works fine there and occupancy checks against other unmigrated plants would be unreliable.
function findFreePositionInBed(bed) {
  const STEP_FT = 0.5; // scan resolution
  const EDGE_FT = 0.4; // keep a new plant off the bed's very edge
  const MIN_DIST_FT = 0.9; // clearance from any existing plant
  const BOX_PAD_FT = 0.3; // clearance around a plant box's outline
  const plants = bed.plants || [];
  const boxes = bed.plantBoxes || [];
  const hasCustomShape = bed.shape === "custom_points" && bed.customPoints && bed.customPoints.length >= 3;
  // True if a point (feet, bed-relative) lies inside the bed's real outline — ellipse, custom polygon, or rectangle.
  const insideShape = (x, y) => {
    if (bed.shape === "circle_oval") return isInsideEllipse(x, y, bed.widthFt, bed.lengthFt);
    if (hasCustomShape) return isInsidePolygon(x, y, bed.customPoints);
    return true;
  };
  // True if a point falls inside (or within BOX_PAD_FT of) any plant-spacing box, so new plants avoid filled areas.
  const insideAnyBox = (x, y) =>
    boxes.some((b) => x >= b.x - BOX_PAD_FT && x <= b.x + b.widthFt + BOX_PAD_FT && y >= b.y - BOX_PAD_FT && y <= b.y + b.heightFt + BOX_PAD_FT);
  // Distance (feet) from a point to the closest existing plant — Infinity if the bed is empty.
  const nearestPlantDist = (x, y) => plants.reduce((min, p) => Math.min(min, Math.hypot((p.x || 0) - x, (p.y || 0) - y)), Infinity);

  let leastCrowded = null;
  let leastCrowdedScore = -1;
  for (let y = EDGE_FT; y <= bed.lengthFt - EDGE_FT + 1e-9; y += STEP_FT) {
    for (let x = EDGE_FT; x <= bed.widthFt - EDGE_FT + 1e-9; x += STEP_FT) {
      if (!insideShape(x, y)) continue;
      const inBox = insideAnyBox(x, y);
      const dist = nearestPlantDist(x, y);
      if (!inBox && dist >= MIN_DIST_FT) return { x, y, crowded: false };
      const score = (inBox ? 0 : 1000) + Math.min(dist, 999);
      if (score > leastCrowdedScore) {
        leastCrowdedScore = score;
        leastCrowded = { x, y };
      }
    }
  }
  // Nothing fully free — return the least crowded spot, flagged `crowded` so the caller can tell
  // the user the bed is full rather than silently stacking the plant among others. (A bed too
  // narrow to scan at all just gets its center.)
  const fallback = leastCrowded || { x: bed.widthFt / 2, y: bed.lengthFt / 2 };
  return { ...fallback, crowded: true };
}

// Shared between bed-plants (position relative to the bed's own origin, in feet) and freestanding
// plants (position absolute on the canvas, in px) — index/bed are only passed when migrating a
// bed's plants, so the bed-relative default below only ever applies to bed-plants; a freestanding
// plant missing a position (which shouldn't normally happen, since one is always set on creation)
// falls back to a plain absolute default instead.
function migratePlant(plant, index, bed) {
  const hasPosition = typeof plant.x === "number" && typeof plant.y === "number";
  const needsOtherDefaults = !(
    plant.light && plant.water && plant.temp && plant.cultivar !== undefined &&
    plant.plantingOutside !== undefined && plant.companionNotes !== undefined &&
    plant.rotationWarningsDismissed !== undefined && typeof plant.spacingIn === "number"
  );
  if (hasPosition && !needsOtherDefaults) return plant;
  const position = hasPosition ? {} : bed ? defaultPlantPositionInBed(bed, index || 0) : { x: 24, y: 24 };
  return {
    ...plant,
    ...position,
    light: plant.light || "unknown",
    water: plant.water || "unknown",
    temp: plant.temp || "unknown",
    cultivar: plant.cultivar || "",
    plantingStartIndoors: plant.plantingStartIndoors || "",
    plantingOutside: plant.plantingOutside || "",
    harvestWindow: plant.harvestWindow || "",
    companionNotes: plant.companionNotes || "",
    companionWarningsDismissed: plant.companionWarningsDismissed || false,
    rotationWarningsDismissed: plant.rotationWarningsDismissed || false,
    spacingIn: typeof plant.spacingIn === "number" ? plant.spacingIn : getRecommendedSpacingIn(plant.name) || DEFAULT_SPACING_IN,
  };
}

// Handles both the old single-image format (backgroundImage) and the current array (backgroundImages),
// so a save from before multiple images were supported still loads correctly.
function migrateBackgroundImages(data) {
  if (Array.isArray(data.backgroundImages)) return data.backgroundImages;
  if (data.backgroundImage && data.backgroundImage.dataUrl) {
    return [{ locked: false, ...data.backgroundImage, id: data.backgroundImage.id || nextId() }];
  }
  return [];
}

// Brings an old saved bed up to the current shape — fills in any field added since it was last
// saved (soil type, sun exposure source, plant boxes, etc.) with a sensible default, and recurses
// into migratePlant for each of its plants. Returns the bed completely unchanged (same object
// reference) when nothing needs fixing, so this is cheap to call on every load without forcing
// needless re-renders.
function migrateBed(bed) {
  // Every plant brought up to the current shape; reused as-is when nothing needed changing.
  const migratedPlants = (bed.plants || []).map((p, i) => migratePlant(p, i, bed));
  // "Irregular" was removed as a shape option (redundant with Custom); fold any existing beds
  // that still have it into Rectangle, using the square approximation they already had.
  const shape = bed.shape === "irregular" ? "rectangle" : bed.shape || "rectangle";
  if (
    bed.soilType && bed.bedStructure && bed.sunExposure && shape === bed.shape && bed.shape && bed.sunExposureSource &&
    Array.isArray(bed.plantBoxes)
  ) {
    return bed.plants === migratedPlants ? bed : { ...bed, plants: migratedPlants };
  }
  const legacyMap = { clay: "clay", mixed: "mixed", loam: "loamy" };
  const sunExposure = bed.sunExposure || "unknown";
  return {
    ...bed,
    shape,
    soilType: bed.soilType || legacyMap[bed.soilZone] || "unknown",
    yardLocation: bed.yardLocation || "unknown",
    bedStructure: bed.bedStructure || "unknown",
    sunExposure,
    // Existing beds that already had a real value are assumed to be the user's own choice (manual, locked).
    // Beds still on "Unknown" are left open for the light-zone auto-suggestion to fill in.
    sunExposureSource: bed.sunExposureSource || (sunExposure === "unknown" ? "unset" : "manual"),
    approxSqFt: bed.approxSqFt || Math.round((bed.widthFt || 1) * (bed.lengthFt || 1)),
    customPoints: bed.customPoints || null,
    plants: migratedPlants,
    // Plant-spacing "boxes" — a group of plants from one fill operation, bound together and
    // draggable as a unit until a plant is deliberately pulled out. Old beds get an empty list.
    plantBoxes: bed.plantBoxes || [],
  };
}

// Shoelace formula for a polygon's area (square feet) from its vertices — used to show an
// approximate size for a custom hand-drawn bed shape.
function polygonAreaFt(pointsFt) {
  let sum = 0;
  for (let i = 0; i < pointsFt.length; i++) {
    const a = pointsFt[i];
    const b = pointsFt[(i + 1) % pointsFt.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum / 2);
}

// Converts raw canvas-drawn points (px, absolute screen position) into a custom bed's own stored
// shape: points shifted to be relative to their own top-left corner (feet), plus the resulting
// bounding width/length/area — this is what turns a freehand drawing into bed.customPoints.
function normalizePoints(pointsPx, ftToPx) {
  if (pointsPx.length === 0) return { points: [], widthFt: 1, lengthFt: 1, approxSqFt: 1 };
  const xs = pointsPx.map((p) => p.x);
  const ys = pointsPx.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const pointsFt = pointsPx.map((p) => ({
    x: Math.round(((p.x - minX) / ftToPx) * 10) / 10,
    y: Math.round(((p.y - minY) / ftToPx) * 10) / 10,
  }));
  const widthFt = Math.max(1, Math.round(((maxX - minX) / ftToPx) * 10) / 10);
  const lengthFt = Math.max(1, Math.round(((maxY - minY) / ftToPx) * 10) / 10);
  const approxSqFt = Math.max(1, Math.round(polygonAreaFt(pointsFt)));
  return { points: pointsFt, widthFt, lengthFt, approxSqFt };
}

// Turns a working bed-form-like object into final stored dimensions.
function computeDimensions(v) {
  if (v.shape === "custom_points") {
    // Custom shapes are created/edited directly on the map now (see finishCanvasDraw) — this branch just
    // preserves whatever shape data already exists when other fields are saved without touching the shape.
    return {
      widthFt: Number(v.width) || 1,
      lengthFt: Number(v.length) || 1,
      approxSqFt: Number(v.approxSqFt) || 1,
      customPoints: v.existingCustomPoints || null,
    };
  }
  const widthFt = Math.max(1, Number(v.width) || 1);
  const lengthFt = Math.max(1, Number(v.length) || 1);
  return { widthFt, lengthFt, approxSqFt: Math.round(widthFt * lengthFt), customPoints: null };
}

// The inverse of computeDimensions — turns a stored bed back into the working-form shape the
// edit-bed modal expects, so opening "edit" on an existing bed starts from its current values.
function bedToFormValues(bed) {
  return {
    name: bed.name,
    shape: bed.shape,
    width: bed.widthFt,
    length: bed.lengthFt,
    approxSqFt: bed.approxSqFt,
    existingCustomPoints: bed.shape === "custom_points" ? bed.customPoints : null,
    soilType: bed.soilType,
    yardLocation: bed.yardLocation,
    bedStructure: bed.bedStructure,
    sunExposure: bed.sunExposure,
    sunExposureSource: bed.sunExposureSource || (bed.sunExposure === "unknown" ? "unset" : "manual"),
  };
}

const blankFormValues = () => ({
  name: "",
  shape: "rectangle",
  width: 4,
  length: 8,
  approxSqFt: 20,
  existingCustomPoints: null,
  soilType: "unknown",
  yardLocation: "unknown",
  bedStructure: "unknown",
  sunExposure: "unknown",
  sunExposureSource: "unset",
});

// Shared field set used by both the "Add a bed" sidebar form and the edit modal.
function BedFields({ values, setValues, onDrawShape, hasCustomShape, nameError }) {
  const [showMore, setShowMore] = useState(false); // whether the optional "additional details" section is expanded
  // Shorthand to update one or more form fields at once without touching the others.
  const set = (patch) => setValues((v) => ({ ...v, ...patch }));

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs mono-label text-stone-500 block mb-1">Bed name</label>
        <input
          value={values.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="e.g. Front bed 2"
          className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 ${
            nameError ? "border-red-400 focus:ring-red-400" : "border-stone-300 focus:ring-emerald-600"
          }`}
        />
        {nameError && <p className="text-xs text-red-600 mt-1">Give this bed a name before adding it.</p>}
      </div>

      <div>
        <label className="text-xs mono-label text-stone-500 block mb-1">Bed shape</label>
        <select
          value={values.shape}
          onChange={(e) => set({ shape: e.target.value })}
          className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
        >
          {Object.entries(BED_SHAPES).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        {values.shape !== "custom_points" && (
          <p className="text-xs text-stone-400 mt-1">
            Circle/oval shapes show as an approximate outline. Pick "Custom" to trace exact points directly on the map.
          </p>
        )}
      </div>

      {values.shape === "custom_points" ? (
        <div>
          {hasCustomShape && (
            <p className="text-xs text-stone-500 mb-1.5">
              Current shape: ~{values.approxSqFt} sq ft · {values.width}ft × {values.length}ft box
            </p>
          )}
          <button
            type="button"
            onClick={onDrawShape}
            className="w-full flex items-center justify-center gap-2 border border-emerald-700 text-emerald-700 rounded-lg py-2 text-sm font-medium hover:bg-emerald-50"
          >
            <PenTool size={15} />
            {hasCustomShape ? "Edit shape on the map" : "Draw shape on the map"}
          </button>
          {!hasCustomShape && (
            <p className="text-xs text-stone-400 mt-1.5">
              Click directly on "Your land" below to place corner points, then click Finish when done.
            </p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs mono-label text-stone-500 block mb-1">
              {values.shape === "circle_oval" ? "Diameter, side A (ft)" : "Width (ft)"}
            </label>
            <input
              type="number"
              min="1"
              value={values.width}
              onChange={(e) => set({ width: e.target.value })}
              className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
            />
          </div>
          <div>
            <label className="text-xs mono-label text-stone-500 block mb-1">
              {values.shape === "circle_oval" ? "Diameter, side B (ft)" : "Length (ft)"}
            </label>
            <input
              type="number"
              min="1"
              value={values.length}
              onChange={(e) => set({ length: e.target.value })}
              className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
            />
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowMore((s) => !s)}
        className="flex items-center gap-1 text-xs text-emerald-700 hover:text-emerald-800 font-medium pt-1"
      >
        {showMore ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        Additional details (soil, location, structure, sun)
      </button>

      {showMore && (
        <div className="space-y-3 border-l-2 border-stone-200 pl-3">
          <div>
            <label className="text-xs mono-label text-stone-500 block mb-1">Soil type</label>
            <select
              value={values.soilType}
              onChange={(e) => set({ soilType: e.target.value })}
              className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
            >
              {Object.entries(SOIL_TYPES).map(([key, s]) => (
                <option key={key} value={key}>{s.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs mono-label text-stone-500 block mb-1">Yard location</label>
            <select
              value={values.yardLocation}
              onChange={(e) => set({ yardLocation: e.target.value })}
              className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
            >
              {Object.entries(YARD_LOCATIONS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs mono-label text-stone-500 block mb-1">Bed structure</label>
            <select
              value={values.bedStructure}
              onChange={(e) => set({ bedStructure: e.target.value })}
              className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
            >
              {Object.entries(BED_STRUCTURES).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs mono-label text-stone-500 block mb-1">
              Sun exposure {values.sunExposureSource === "auto" && <span className="text-emerald-600 normal-case">(auto-detected from your light zones)</span>}
            </label>
            <select
              value={values.sunExposure}
              onChange={(e) =>
                set({ sunExposure: e.target.value, sunExposureSource: e.target.value === "unknown" ? "unset" : "manual" })
              }
              className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
            >
              {Object.entries(SUN_EXPOSURES).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            {values.sunExposureSource === "auto" && (
              <p className="text-xs text-stone-400 mt-1">Changing this yourself will lock it in — it'll stop following the light zones.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// The popup for a single plant's full details — light/water/temp preferences, cultivar, planting
// dates, companion-planting and crop-rotation warnings for its current neighbors, and its
// lock/group state. Shared between bed-plants and freestanding ones (isBedPlant switches a few
// bed-specific bits, like the eject/release actions, on or off). Saving here is the only place
// these fields get edited — nothing else in the app writes to a plant's light/water/temp/cultivar.
function PlantDetailsModal({ plantName, initialValues, zone, neighborPlants, livePlantIds, bedName, yearHistory, isBedPlant, onCancel, onSave, onEject, onDelete, onReleaseFromGroup }) {
  const [name, setName] = useState(plantName); // name field
  const [locked, setLocked] = useState(initialValues.locked || false); // locked plants can't be dragged
  const [light, setLight] = useState(initialValues.light || "unknown"); // sun need ("recommended" resolves from the plant name)
  const [water, setWater] = useState(initialValues.water || "unknown"); // water need
  const [temp, setTemp] = useState(initialValues.temp || "unknown"); // temperature tolerance
  const [cultivar, setCultivar] = useState(initialValues.cultivar || ""); // specific variety (e.g. "Nantes"); plants with different cultivars are listed separately
  const [companionNotes, setCompanionNotes] = useState(initialValues.companionNotes || ""); // user's own companion-planting notes
  const [companionWarningsDismissed, setCompanionWarningsDismissed] = useState(initialValues.companionWarningsDismissed || false); // hide companion-planting warnings for this plant
  const [rotationWarningsDismissed, setRotationWarningsDismissed] = useState(initialValues.rotationWarningsDismissed || false); // hide crop-rotation warnings for this plant

  const suggestion = getPlantingSuggestion(plantName, zone);
  // Free-text indoor-start window, defaulting to a suggestion based on the plant name and hardiness zone.
  const [plantingStartIndoors, setPlantingStartIndoors] = useState(
    initialValues.plantingStartIndoors || suggestion?.startIndoors || ""
  );
  const [plantingOutside, setPlantingOutside] = useState(initialValues.plantingOutside || suggestion?.plantOutside || ""); // free-text outdoor planting window
  const [harvestWindow, setHarvestWindow] = useState(initialValues.harvestWindow || suggestion?.harvest || ""); // free-text harvest window

  const hasStoredTiming = initialValues.plantingStartIndoors || initialValues.plantingOutside || initialValues.harvestWindow;
  const companion = getCompanionRelations({ name: plantName }, neighborPlants || []);
  const companionRef = companion.key ? COMPANION_DATA[companion.key] : null;
  const recommended = getRecommendedNeeds(plantName);
  const rotationWarning = bedName
    ? getRotationWarning(bedName, plantName, sortYearHistory(yearHistory || []), livePlantIds)
    : null;

  const LIGHT_OPTIONS = { recommended: "Recommended (based on plant type)", ...SUN_EXPOSURES };
  const WATER_OPTIONS = { recommended: "Recommended (based on plant type)", ...WATER_NEEDS };
  const TEMP_OPTIONS = { recommended: "Recommended (based on plant type)", ...TEMP_PREFERENCES };

  // Small hint line under a need dropdown: the typical value for this plant name, or a note that none is known.
  const recommendedHint = (field, label) => {
    if (!recommended) return <p className="text-xs text-stone-400 mt-1">No general recommendation for this plant name — pick a value yourself.</p>;
    return <p className="text-xs text-emerald-700 mt-1">→ {label[recommended[field]]}, typical for {recommended.matchKey}.</p>;
  };

  return (
    <div
      className="fixed inset-0 bg-stone-900/60 flex items-start justify-center z-50 p-2 sm:p-4 overflow-y-auto"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-4 sm:p-5 my-4 sm:my-8">
        <div className="flex items-center gap-2 mb-1">
          <Sprout size={18} className="text-emerald-700 shrink-0" />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="fraunces text-xl flex-1 min-w-0 border-b border-transparent hover:border-stone-300 focus:border-emerald-600 focus:outline-none"
          />
        </div>
        <p className="text-xs text-stone-500 mb-3">Plant-specific needs, separate from the bed it's sitting in.</p>
        {isBedPlant && (
          <div className="flex items-center justify-between mb-3 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2">
            <button
              type="button"
              onClick={() => setLocked((l) => !l)}
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border ${
                locked ? "border-emerald-600 bg-emerald-50 text-emerald-800" : "border-stone-300 hover:bg-stone-100"
              }`}
              title={locked ? "Unlock so this plant can be dragged again" : "Lock this plant in place to avoid nudging it by accident"}
            >
              {locked ? <Lock size={13} /> : <Unlock size={13} />}
              {locked ? "Locked" : "Unlocked"}
            </button>
            <div className="flex items-center gap-3">
              {onReleaseFromGroup && (
                <button type="button" onClick={onReleaseFromGroup} className="text-xs text-stone-500 hover:text-blue-700 underline">
                  Release from group
                </button>
              )}
              {onEject && (
                <button type="button" onClick={onEject} className="text-xs text-stone-500 hover:text-emerald-700 underline">
                  Move to open map
                </button>
              )}
              {onDelete && (
                <button type="button" onClick={onDelete} className="text-xs text-stone-500 hover:text-red-600 underline">
                  Delete
                </button>
              )}
            </div>
          </div>
        )}
        <div className="space-y-3">
          <div>
            <label className="text-xs mono-label text-stone-500 block mb-1">Cultivar / variety (optional)</label>
            <input
              value={cultivar}
              onChange={(e) => setCultivar(e.target.value)}
              placeholder="e.g. Cherokee Purple, Brandywine"
              className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
            />
          </div>
          <div>
            <label className="text-xs mono-label text-stone-500 block mb-1">Light needs</label>
            <select
              value={light}
              onChange={(e) => setLight(e.target.value)}
              className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
            >
              {Object.entries(LIGHT_OPTIONS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            {light === "recommended" && recommendedHint("light", SUN_EXPOSURES)}
          </div>
          <div>
            <label className="text-xs mono-label text-stone-500 block mb-1">Water needs</label>
            <select
              value={water}
              onChange={(e) => setWater(e.target.value)}
              className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
            >
              {Object.entries(WATER_OPTIONS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            {water === "recommended" && recommendedHint("water", WATER_NEEDS)}
          </div>
          <div>
            <label className="text-xs mono-label text-stone-500 block mb-1">Temperature preference</label>
            <select
              value={temp}
              onChange={(e) => setTemp(e.target.value)}
              className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
            >
              {Object.entries(TEMP_OPTIONS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            {temp === "recommended" && recommendedHint("temp", TEMP_PREFERENCES)}
          </div>

          <div className="border-t border-stone-200 pt-3">
            <div className="text-xs mono-label text-stone-400 mb-1.5 uppercase tracking-wide">Planting & harvest timing</div>
            {!hasStoredTiming && suggestion?.perennialNote && (
              <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-2 mb-2">
                {suggestion.perennialNote}
              </p>
            )}
            {!hasStoredTiming && suggestion?.note && (
              <p className="text-xs text-stone-500 bg-stone-50 border border-stone-200 rounded-lg px-2.5 py-2 mb-2">{suggestion.note}</p>
            )}
            {!hasStoredTiming && suggestion && !suggestion.perennialNote && !suggestion.note && (
              <p className="text-xs text-stone-500 mb-2">
                Rough starting point below, based on typical timing for "{suggestion.matchKey}" and your zone's average frost dates —
                not precise to your exact location. Edit any of it freely.
              </p>
            )}
            {!hasStoredTiming && !suggestion && (
              <p className="text-xs text-stone-400 mb-2">No general timing data for this plant name — enter your own dates below.</p>
            )}
            <div className="space-y-2">
              <div>
                <label className="text-xs mono-label text-stone-500 block mb-1">Start indoors</label>
                <input
                  value={plantingStartIndoors}
                  onChange={(e) => setPlantingStartIndoors(e.target.value)}
                  placeholder="e.g. Mar 1 (leave blank if direct-sown)"
                  className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
              <div>
                <label className="text-xs mono-label text-stone-500 block mb-1">Plant outside / direct sow</label>
                <input
                  value={plantingOutside}
                  onChange={(e) => setPlantingOutside(e.target.value)}
                  placeholder="e.g. May 10"
                  className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
              <div>
                <label className="text-xs mono-label text-stone-500 block mb-1">Harvest window</label>
                <input
                  value={harvestWindow}
                  onChange={(e) => setHarvestWindow(e.target.value)}
                  placeholder="e.g. Jul 20 – Aug 5"
                  className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
            </div>
          </div>

          <div className="border-t border-stone-200 pt-3">
            <div className="text-xs mono-label text-stone-400 mb-1.5 uppercase tracking-wide">Companion planting</div>
            <p className="text-xs text-stone-400 mb-2">
              Traditional garden pairings passed down through generations — not rigorously proven science, just a starting point worth trying.
            </p>
            {!companion.key && (
              <p className="text-xs text-stone-400 mb-2">No companion-planting data for this plant name.</p>
            )}
            {companion.key && (
              <div className="space-y-1.5 mb-2">
                {companion.goodNeighbors.length > 0 && (
                  <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-2">
                    Grows well near, and currently has: {companion.goodNeighbors.join(", ")}
                  </p>
                )}
                {companion.badNeighbors.length > 0 && (
                  <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-2">
                    Traditionally avoided near, but currently has: {companion.badNeighbors.join(", ")}
                  </p>
                )}
                {companionRef && (companionRef.good.length > 0 || companionRef.bad.length > 0) && (
                  <p className="text-xs text-stone-500">
                    {companionRef.good.length > 0 && <>Generally good with: {companionRef.good.join(", ")}. </>}
                    {companionRef.bad.length > 0 && <>Generally avoid: {companionRef.bad.join(", ")}.</>}
                  </p>
                )}
              </div>
            )}
            <div className="mb-2">
              <label className="text-xs mono-label text-stone-500 block mb-1">Your own notes (optional)</label>
              <textarea
                value={companionNotes}
                onChange={(e) => setCompanionNotes(e.target.value)}
                placeholder="e.g. Planted next to cabbage anyway, seemed fine last year"
                rows={2}
                className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-stone-600">
              <input
                type="checkbox"
                checked={companionWarningsDismissed}
                onChange={(e) => setCompanionWarningsDismissed(e.target.checked)}
                className="rounded border-stone-300"
              />
              Don't warn me about companion conflicts for this plant
            </label>
          </div>

          {bedName && (
            <div className="border-t border-stone-200 pt-3">
              <div className="text-xs mono-label text-stone-400 mb-1.5 uppercase tracking-wide">Crop rotation</div>
              {rotationWarning ? (
                <p className="text-xs text-orange-700 bg-orange-50 border border-orange-200 rounded-lg px-2.5 py-2 mb-2">
                  You grew {rotationWarning.matchedPlant} (also a {rotationWarning.family}) in this bed in {rotationWarning.year}.
                  Rotating away from the same family helps avoid depleting the soil and building up pests here.
                </p>
              ) : (
                <p className="text-xs text-stone-400 mb-2">No rotation conflicts found for this bed's history.</p>
              )}
              <label className="flex items-center gap-2 text-xs text-stone-600">
                <input
                  type="checkbox"
                  checked={rotationWarningsDismissed}
                  onChange={(e) => setRotationWarningsDismissed(e.target.checked)}
                  className="rounded border-stone-300"
                />
                Don't warn me about crop rotation for this plant
              </label>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onCancel} className="text-sm px-4 py-2 rounded-lg border border-stone-300 hover:bg-stone-50">
            Cancel
          </button>
          <button
            onClick={() =>
              onSave({
                name: name.trim() || plantName,
                locked,
                light,
                water,
                temp,
                cultivar: cultivar.trim(),
                plantingStartIndoors: plantingStartIndoors.trim(),
                plantingOutside: plantingOutside.trim(),
                harvestWindow: harvestWindow.trim(),
                companionNotes: companionNotes.trim(),
                companionWarningsDismissed,
                rotationWarningsDismissed,
              })
            }
            className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white"
          >
            <Check size={15} /> Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

// Two-click calibration for a satellite/aerial photo: the user clicks two points on the image a
// known real-world distance apart (e.g. two corners of a driveway), and this converts that into a
// pixels-per-foot scale for the image, so it can be traced at the correct size on the map.
function CalibrationModal({ session, onCancel, onConfirm }) {
  const [points, setPoints] = useState(session.points); // the (up to two) reference points clicked on the image, in native image pixels
  const [referenceFt, setReferenceFt] = useState(session.referenceFt); // real-world distance in feet between the two points
  // The displayed calibration image element, used to convert clicks into image coordinates.
  const imgRef = useRef(null);

  // The old approach (fit the whole image within a fixed box) meant a narrow/tall image got
  // shrunk down to a sliver just a hundred-some pixels wide — clicking a precise reference point
  // on that is nearly impossible, and small errors get amplified enormously into the final scale.
  // Instead: guarantee the SHORTER dimension gets enough room to click precisely, even if that
  // means the LONGER dimension needs to scroll.
  const DISPLAY_MAX = 560;
  const MIN_DISPLAY_DIM = 320;
  const naturalMax = Math.max(session.naturalWidth, session.naturalHeight);
  const naturalMin = Math.min(session.naturalWidth, session.naturalHeight);
  const fitScale = Math.min(DISPLAY_MAX / naturalMax, 1);
  const minDimScale = Math.min(MIN_DISPLAY_DIM / naturalMin, 1);
  const displayScale = Math.max(fitScale, minDimScale);
  const displayWidth = session.naturalWidth * displayScale;
  const displayHeight = session.naturalHeight * displayScale;
  // Even with the above, a genuinely tiny source image can't be helped further without upscaling
  // it (which would blur the very thing you're trying to click precisely) — flag that honestly.
  const limitedPrecision = Math.min(displayWidth, displayHeight) < MIN_DISPLAY_DIM;

  // Records a calibration point (max two) where the image was clicked, converted to the image's native pixel space.
  function handleClick(e) {
    if (points.length >= 2) return;
    const rect = imgRef.current.getBoundingClientRect();
    const displayX = e.clientX - rect.left;
    const displayY = e.clientY - rect.top;
    // Store in the image's own native pixel space, not display space, so the math is resolution-independent.
    const nativeX = displayX / displayScale;
    const nativeY = displayY / displayScale;
    setPoints((prev) => [...prev, { x: nativeX, y: nativeY }]);
  }


  return (
    <div
      className="fixed inset-0 bg-stone-900/70 flex items-start justify-center z-50 p-2 sm:p-4 overflow-y-auto"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full p-4 sm:p-5 my-4 sm:my-8">
        <h3 className="fraunces text-xl flex items-center gap-2 mb-1">
          <ImageIcon size={18} className="text-emerald-700" /> Calibrate your image
        </h3>
        <p className="text-xs text-stone-500 mb-3">
          Click two points on something you know the real length of — a driveway edge, a fence line, the side of a
          building — then tell us how many feet that actually is. This is what lets your traced beds line up with
          real-world measurements.
        </p>
        {limitedPrecision && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2 mb-3">
            This image is quite small ({session.naturalWidth}×{session.naturalHeight}px), so even at full resolution
            there isn't much room to click precisely. Try to zoom in as much as possible when you click, and pick the
            longest reference distance you can find in the image — a longer reference line is more forgiving of small
            clicking errors than a short one. A larger source screenshot will always calibrate more accurately.
          </p>
        )}
        <div className="mx-auto border border-stone-300 rounded-lg bg-stone-100" style={{ maxHeight: "60vh", maxWidth: "100%", overflow: "auto" }}>
          <div
            ref={imgRef}
            onClick={handleClick}
            className="relative"
            style={{ width: displayWidth, height: displayHeight, cursor: points.length < 2 ? "crosshair" : "default" }}
          >
            <img src={session.dataUrl} alt="Uploaded reference" className="absolute inset-0 w-full h-full object-cover pointer-events-none" draggable={false} />
          <svg className="absolute inset-0 pointer-events-none" width={displayWidth} height={displayHeight}>
            {points.length === 2 && (
              <line
                x1={points[0].x * displayScale}
                y1={points[0].y * displayScale}
                x2={points[1].x * displayScale}
                y2={points[1].y * displayScale}
                stroke="rgb(16,185,129)"
                strokeWidth="2.5"
                strokeDasharray="5 4"
              />
            )}
            {points.map((p, i) => (
              <circle key={i} cx={p.x * displayScale} cy={p.y * displayScale} r="6" fill="rgb(16,185,129)" stroke="white" strokeWidth="2" />
            ))}
          </svg>
          </div>
        </div>
        <div className="flex items-center justify-between mt-2">
          <p className="text-xs text-stone-400">
            {points.length === 0 && "Click your first point."}
            {points.length === 1 && "Click your second point."}
            {points.length === 2 && "Line placed — enter its real length below."}
          </p>
          {points.length > 0 && (
            <button onClick={() => setPoints([])} className="text-xs text-stone-500 hover:text-stone-800 underline">
              Redo points
            </button>
          )}
        </div>

        {points.length === 2 && (
          <div className="mt-3 flex items-end gap-3">
            <div className="flex-1">
              <label className="text-xs mono-label text-stone-500 block mb-1">Real length of that line (feet)</label>
              <input
                type="number"
                min="0.1"
                step="0.1"
                autoFocus
                value={referenceFt}
                onChange={(e) => setReferenceFt(e.target.value)}
                placeholder="e.g. 20"
                className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onCancel} className="text-sm px-4 py-2 rounded-lg border border-stone-300 hover:bg-stone-50">
            Cancel
          </button>
          <button
            onClick={() => onConfirm(referenceFt, points, session.dataUrl, session.naturalWidth, session.naturalHeight)}
            disabled={points.length < 2 || !referenceFt || Number(referenceFt) <= 0}
            className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-40"
          >
            <Check size={15} /> Place on map
          </button>
        </div>
      </div>
    </div>
  );
}

// "Start a new year" flow: archives the entire current garden (every bed and freestanding plant)
// as a frozen snapshot into yearHistory under a chosen year label, then clears the live garden —
// except whichever plants the user chooses to keep (perennials are pre-checked by default, since
// they don't get replanted each year, but the user can override any plant either way).
function YearRolloverModal({ beds, plants, onCancel, onConfirm }) {
  const [yearLabel, setYearLabel] = useState(defaultArchiveYearLabel()); // label for the archived year, e.g. "2026"
  // An archive is a record of a season that already happened, so a label naming a future year can't
  // be right — and would be ignored by rotation checks anyway. Block it rather than save bad history.
  const labelYear = (yearLabel.match(/\b(19|20)\d{2}\b/) || [])[0];
  const isFutureLabel = !!labelYear && parseInt(labelYear, 10) > new Date().getFullYear();
  const allEntries = getAllPlantEntries(beds, plants);
  // Map of plant id -> true if it stays in the garden after rollover; perennials start checked.
  const [kept, setKept] = useState(() => {
    const initial = {};
    allEntries.forEach((e) => {
      initial[e.plant.id] = isPerennialPlant(e.plant.name);
    });
    return initial;
  });

  // Flips whether a plant is marked "keep in the bed" for the new year.
  const toggle = (id) => setKept((prev) => ({ ...prev, [id]: !prev[id] }));
  const keptCount = Object.values(kept).filter(Boolean).length;

  return (
    <div
      className="fixed inset-0 bg-stone-900/60 flex items-start justify-center z-50 p-2 sm:p-4 overflow-y-auto"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-4 sm:p-5 my-4 sm:my-8">
        <h3 className="fraunces text-xl flex items-center gap-2 mb-1">
          <CalendarDays size={18} className="text-emerald-700" /> Start a new year
        </h3>
        <p className="text-xs text-stone-500 mb-3">
          This saves a snapshot of everything currently in your garden — beds, plants, and all — into History under
          the year label below (the year you're closing out, not the one ahead). Then it clears your beds for the
          new season, except for whatever you check to keep (perennials are pre-checked, since they don't get
          replanted each year).
        </p>
        <div className="mb-3">
          <label className="text-xs mono-label text-stone-500 block mb-1">Year label</label>
          <input
            value={yearLabel}
            onChange={(e) => setYearLabel(e.target.value)}
            placeholder="e.g. 2026"
            className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
          />
          {isFutureLabel && (
            <p className="text-xs text-red-600 mt-1">
              {labelYear} hasn't happened yet — label the year you're closing out. (Archives are records of a past season.)
            </p>
          )}
        </div>

        <div className="text-xs mono-label text-stone-400 mb-1.5 uppercase tracking-wide">
          Keep these {allEntries.length} plant{allEntries.length === 1 ? "" : "s"} in your beds ({keptCount} selected)
        </div>
        {allEntries.length === 0 ? (
          <p className="text-xs text-stone-400 mb-2">No plants to carry over — your garden is currently empty.</p>
        ) : (
          <div className="max-h-60 overflow-y-auto border border-stone-200 rounded-lg divide-y divide-stone-100">
            {allEntries.map((e) => (
              <label key={e.plant.id} className="flex items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-stone-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!kept[e.plant.id]}
                  onChange={() => toggle(e.plant.id)}
                  className="rounded border-stone-300"
                />
                <span className="text-stone-800">{e.plant.name}</span>
                {e.plant.cultivar && <span className="text-stone-500 italic">({e.plant.cultivar})</span>}
                <span className="text-stone-400 ml-auto">{e.locationLabel}</span>
              </label>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onCancel} className="text-sm px-4 py-2 rounded-lg border border-stone-300 hover:bg-stone-50">
            Cancel
          </button>
          <button
            disabled={isFutureLabel}
            onClick={() => {
              const keptIds = new Set(Object.keys(kept).filter((id) => kept[id]));
              onConfirm(yearLabel, keptIds);
            }}
            className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Check size={15} /> Archive & start new year
          </button>
        </div>
      </div>
    </div>
  );
}

// PERFORMANCE HELPER — gives a bundle of handler functions permanent identities.
//
// Every handler in GardenPlanner (addPlantToBed, startDrag, ...) is a plain function recreated on
// every render, because it closes over that render's state. That's normally fine, but it defeats
// React.memo: BedCard receives ~25 of them as props, so every bed would count as "changed" on every
// render and re-render in full — including during a drag of ONE bed, when the other beds have not
// changed at all (with 8 beds of 120 plants each, that was roughly 95ms per mouse-move).
//
// The fix is the "latest ref" pattern: each handler is wrapped in a tiny stable function that calls
// whatever the newest version of that handler is. The wrapper's identity never changes (so memo
// can skip unchanged beds), yet it can never run stale code, because it always looks the real
// handler up in `ref.current`, which is overwritten with the fresh set on every render.
//
// Pass an object of handlers; get back an object with the same keys whose functions are stable.
// The key set must stay the same between renders (it is read once, on first render).
function useStableHandlers(handlers) {
  const ref = useRef(handlers);
  ref.current = handlers; // refreshed every render, so wrappers below always reach the latest closures
  return useMemo(() => {
    const stable = {};
    Object.keys(handlers).forEach((name) => {
      stable[name] = (...args) => ref.current[name](...args);
    });
    return stable;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

// A single bed's full rendering and interaction: its shape on the map, its plants (as
// individually-positioned, draggable dots) and their plant-spacing boxes, the pinned/hover details
// panel with soil/sun/structure info, the "+ plant" and fill-at-spacing tools, multi-select and
// marquee selection, and the resize handles for the bed's own shape. Almost all of the actual
// state (beds, plantFillTool, selection state, etc.) lives in the parent GardenPlanner component
// and is threaded in as props — BedCard itself only holds small pieces of local, purely-visual
// state (hover/pinned, the fill tool's open/closed toggle, the marquee's current rectangle).
function BedCard({
  bed,
  lightZones,
  renaming,
  setRenaming,
  renameInputRef,
  commitRename,
  startRename,
  bedPlantInputs,
  setBedPlantInputs,
  crowdedNotice,
  addPlantToBed,
  fillBedInputs,
  setFillBedInputs,
  setPlantFillTool,
  ejectPlantFromBed,
  deletePlantFromBed,
  setEditingPlant,
  setEditingBed,
  startCanvasDrawForBedShape,
  duplicateBed,
  deleteBed,
  startDrag,
  startResizeDrag,
  startBedPlantDrag,
  startPlantBoxDrag,
  startPlacedBoxResize,
  mergeBoxes,
  unmergeBoxes,
  startPlantChipFillDrag,
  plantFillTool,
  selectionModeBedId,
  selectedPlantIds,
  toggleSelectionMode,
  togglePlantSelection,
  selectAllInBed,
  selectPlantsInRect,
  bulkSetPlantsLocked,
  bulkDeletePlants,
  yearHistory,
  clearBedHistory,
  zoom,
}) {
  const [hovering, setHovering] = useState(false); // mouse is over the bed
  const [fillToolOpen, setFillToolOpen] = useState(false); // whether the fill-at-spacing tool panel is open
  // Marquee (rubber-band) selection while in multi-select mode: drag across empty space within the
  // bed to select every plant inside the dragged rectangle. Coordinates are local px (unscaled —
  // divided by zoom already) relative to the plant container's own top-left corner, only converted
  // to feet at the end when handing off to selectPlantsInRect.
  const [marquee, setMarquee] = useState(null); // { startXPx, startYPx, curXPx, curYPx } | null
  // Begins a rubber-band selection drag on empty bed background (not on a plant dot); on release, selects plants inside the rectangle.
  const startMarquee = (bedId, e) => {
    if (e.target !== e.currentTarget) return; // only start on the empty background, not a plant dot
    const containerEl = e.currentTarget;
    const rect = containerEl.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const startXPx = (clientX - rect.left) / zoom;
    const startYPx = (clientY - rect.top) / zoom;
    let current = { startXPx, startYPx, curXPx: startXPx, curYPx: startYPx };
    setMarquee(current);

    const onMove = (moveEvent) => {
      const mClientX = moveEvent.touches ? moveEvent.touches[0].clientX : moveEvent.clientX;
      const mClientY = moveEvent.touches ? moveEvent.touches[0].clientY : moveEvent.clientY;
      current = { ...current, curXPx: (mClientX - rect.left) / zoom, curYPx: (mClientY - rect.top) / zoom };
      setMarquee(current);
    };
    const onEnd = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onEnd);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      setMarquee(null);
      const minXFt = Math.min(current.startXPx, current.curXPx) / FT_TO_PX;
      const maxXFt = Math.max(current.startXPx, current.curXPx) / FT_TO_PX;
      const minYFt = Math.min(current.startYPx, current.curYPx) / FT_TO_PX;
      const maxYFt = Math.max(current.startYPx, current.curYPx) / FT_TO_PX;
      selectPlantsInRect(bedId, minXFt, maxXFt, minYFt, maxYFt);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onEnd);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
  };
  const [pinned, setPinned] = useState(false); // details panel is pinned open by a click
  const showDetails = hovering || pinned;
  // Sorted once per render and reused for every plant's rotation check below, instead of each
  // plant re-sorting the same yearHistory array from scratch.
  const sortedYearHistory = useMemo(() => sortYearHistory(yearHistory), [yearHistory]);
  // Ids of every plant currently in this bed — an archived plant with one of these ids never left,
  // so it isn't crop-rotation history (see getRotationWarning).
  const livePlantIds = useMemo(() => new Set(bed.plants.map((p) => p.id)), [bed.plants]);

  // PERFORMANCE: every plant's warnings (light mismatch, companion-planting conflicts, crop-rotation
  // history) computed once per change to the bed's plants — not on every render. The companion check
  // compares each plant against every other plant in the bed, so a 120-plant bed costs ~14,000
  // comparisons; recomputing that on every mouse-move while the bed is being dragged (when its
  // plants haven't changed at all, only its position) was the main cost of dragging a full bed.
  // Depends only on the inputs the warnings actually read, so moving the bed reuses the cache.
  const plantWarnings = useMemo(() => {
    const byPlantId = new Map();
    bed.plants.forEach((p) => {
      byPlantId.set(p.id, {
        mismatchReason: lightMismatch(bed.sunExposure, resolveNeedValue(p.light, p.name, "light")),
        companion: p.companionWarningsDismissed ? { goodNeighbors: [], badNeighbors: [] } : getCompanionRelations(p, bed.plants),
        rotationWarning: p.rotationWarningsDismissed ? null : getRotationWarning(bed.name, p.name, sortedYearHistory, livePlantIds),
      });
    });
    return byPlantId;
  }, [bed.plants, bed.sunExposure, bed.name, sortedYearHistory, livePlantIds]);

  const soil = SOIL_TYPES[bed.soilType] || SOIL_TYPES.unknown;
  const locationLabel = YARD_LOCATIONS[bed.yardLocation] || YARD_LOCATIONS.unknown;
  const structureLabel = BED_STRUCTURES[bed.bedStructure] || BED_STRUCTURES.unknown;
  const sunLabel = SUN_EXPOSURES[bed.sunExposure] || SUN_EXPOSURES.unknown;
  const liveSuggestion = suggestSunForBed(bed, lightZones, FT_TO_PX);
  const suggestionDiffers =
    liveSuggestion && bed.sunExposureSource === "manual" && liveSuggestion !== bed.sunExposure
      ? `The light zones on your map suggest ${SUN_EXPOSURES[liveSuggestion]} here, but you've manually set this bed to ${sunLabel}.`
      : null;
  const isCustom = bed.shape === "custom_points" && bed.customPoints && bed.customPoints.length >= 3;
  const hasHistoryForThisBed = yearHistory.some((entry) =>
    entry.beds.some((b) => b.name.trim().toLowerCase() === bed.name.trim().toLowerCase())
  );
  const shapeRadius = bed.shape === "circle_oval" ? "50%" : "0.6rem";
  const sizeLabel =
    bed.shape === "custom_points"
      ? `~${bed.approxSqFt} sq ft`
      : bed.shape === "circle_oval"
      ? `⌀${bed.widthFt}ft × ${bed.lengthFt}ft`
      : `${bed.widthFt}ft × ${bed.lengthFt}ft`;
  // Drawn at exactly true scale — the same size the app uses for every limit on this bed (where a
  // plant can be dragged, how big a box can grow, whether a spot counts as inside the bed). This
  // used to enforce a minimum drawn size of 170x100px so small beds stayed readable back when the
  // name label lived inside the bed, but that made a small bed LOOK bigger than it really was: a
  // 4ft-wide bed (56px) was drawn 170px wide while plants stayed clamped to the real 56px — so
  // only the left third of the drawn bed was actually usable, and the rest was dead space. The
  // label sits outside the bed now, so there's no reason left to distort the size. (At least 1ft
  // guards against a degenerate zero-size bed.)
  const boxWidthPx = Math.max(FT_TO_PX, bed.widthFt * FT_TO_PX);
  const boxHeightPx = Math.max(FT_TO_PX, bed.lengthFt * FT_TO_PX);
  const polyString = isCustom ? bed.customPoints.map((p) => `${p.x * FT_TO_PX},${p.y * FT_TO_PX}`).join(" ") : "";

  return (
    <div
      className="absolute"
      style={{ left: bed.x, top: bed.y, width: boxWidthPx, minHeight: boxHeightPx }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {/* Label lives entirely outside the shape now — name/size text was getting cramped or cut off
          when squeezed inside small or oddly-shaped beds. This is also the drag handle. */}
      <div
        className="absolute z-10 flex items-center gap-1.5 bg-white border border-stone-300 rounded-full shadow-sm px-2.5 py-1 cursor-grab active:cursor-grabbing"
        style={{ bottom: "100%", left: 0, marginBottom: 6, whiteSpace: "nowrap" }}
        onMouseDown={(e) => startDrag("bed", bed.id, e)}
        onTouchStart={(e) => startDrag("bed", bed.id, e)}
      >
        <div>
          <div className="fraunces text-sm leading-tight">{bed.name}</div>
          <div className="mono-label text-xs text-stone-500">{sizeLabel}</div>
        </div>
        <button
          onClick={() => setPinned((p) => !p)}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          className={`shrink-0 p-1.5 rounded-full hover:bg-stone-100 ${pinned ? "bg-stone-200" : ""}`}
          title={pinned ? "Hide bed details" : "Show bed details"}
        >
          <Info size={14} className="text-stone-600" />
        </button>
      </div>

      {isCustom && (
        <svg
          className="absolute inset-0 pointer-events-none"
          width={Math.max(boxWidthPx, bed.widthFt * FT_TO_PX)}
          height={Math.max(boxHeightPx, bed.lengthFt * FT_TO_PX)}
          style={{ overflow: "visible" }}
        >
          <polygon points={polyString} className={`${soil.fill} opacity-90`} stroke="rgba(0,0,0,0.35)" strokeWidth="2" />
        </svg>
      )}
      <div
        className={`relative shadow-md border-2 ${soil.border} ${!isCustom ? `${soil.swatch} soil-texture` : "bg-transparent"} flex flex-col overflow-hidden`}
        style={{
          width: "100%",
          minHeight: boxHeightPx,
          borderRadius: isCustom ? "0.4rem" : shapeRadius,
          borderColor: isCustom ? "transparent" : undefined,
          boxShadow: isCustom ? "none" : undefined,
        }}
      >
        {/* Interior is dedicated to plants. Circle/oval needs extra padding here — its usable interior
            (the largest rectangle that fits inside a circle) is meaningfully smaller than its bounding
            box, so content near the corners would otherwise get clipped by the curved edge. */}
        {/* Plants are individually positioned within the bed now (feet, relative to the bed's own
            origin) rather than a flowing list — this container just needs to be a positioned parent
            for them, sized to the bed's own footprint. */}
        <div
          className={`relative h-full ${selectionModeBedId === bed.id ? "cursor-crosshair" : ""}`}
          onMouseDown={selectionModeBedId === bed.id ? (e) => startMarquee(bed.id, e) : undefined}
          onTouchStart={selectionModeBedId === bed.id ? (e) => startMarquee(bed.id, e) : undefined}
        >
          {(bed.plantBoxes || []).map((box) => {
            const linkedPartner = box.linkedBoxId ? (bed.plantBoxes || []).find((b) => b.id === box.linkedBoxId) : null;
            // A linked pair shares the exact same rectangle — rendering both boxes' own borders
            // and handles would just be two identical, exactly-overlapping controls. The one with
            // the smaller spacing (the "companion" in the interplanted layout) skips its own
            // outline entirely; its plants still render normally via the plants map below, and
            // the primary box's outline/handles below already move and resize both together.
            if (linkedPartner && box.spacingIn < linkedPartner.spacingIn) return null;

            const overlappingBoxes = (bed.plantBoxes || []).filter((other) => {
              if (other.id === box.id) return false;
              return (
                box.x < other.x + other.widthFt &&
                box.x + box.widthFt > other.x &&
                box.y < other.y + other.heightFt &&
                box.y + box.heightFt > other.y
              );
            });
            let borderClass = "border-blue-400";
            let note = null;
            if (linkedPartner) {
              borderClass = "border-purple-600";
              note = `Merged with ${linkedPartner.plantName} — spacing between both plant types is kept automatically as either box is moved or resized.`;
            } else if (overlappingBoxes.length > 0) {
              const statuses = overlappingBoxes.map((o) => getCompanionStatus(box.plantName, o.plantName));
              const names = [...new Set(overlappingBoxes.map((o) => o.plantName))].join(", ");
              if (statuses.includes("bad")) {
                borderClass = "border-red-500";
                note = `Overlaps ${names}'s spacing — traditionally avoided together (folklore, not proven science). Check both plants' spacing needs.`;
              } else if (statuses.includes("good")) {
                borderClass = "border-emerald-500";
                note = `Overlaps ${names}'s spacing — traditionally grows well together. Still worth checking both plants' spacing needs.`;
              } else {
                borderClass = "border-amber-500";
                note = `Overlaps ${names}'s spacing — no companion data on file either way. Check both plants' spacing needs before relying on this pairing.`;
              }
            }
            // Merging is only offered when there's exactly one eligible overlapping candidate —
            // neither already linked to someone else, and not a traditionally-bad companion pair
            // (merging is for creating proper interplanted spacing between plants that are
            // actually meant to grow near each other, not for plants better kept apart).
            const mergeCandidates = overlappingBoxes.filter((o) => !o.linkedBoxId && getCompanionStatus(box.plantName, o.plantName) !== "bad");
            const mergeCandidate = !linkedPartner && mergeCandidates.length === 1 ? mergeCandidates[0] : null;
            const inSelectionMode = selectionModeBedId === bed.id;
            return (
              <div
                key={box.id}
                onMouseDown={inSelectionMode ? undefined : (e) => startPlantBoxDrag(bed.id, box.id, e)}
                onTouchStart={inSelectionMode ? undefined : (e) => startPlantBoxDrag(bed.id, box.id, e)}
                title={`${box.plantName} spacing box (${box.spacingIn}in)${linkedPartner ? ` + ${linkedPartner.plantName} spacing box (${linkedPartner.spacingIn}in)` : ""}${note ? ` — ${note}` : ""}`}
                className={`absolute border-2 ${linkedPartner ? "border-solid" : "border-dashed"} rounded bg-blue-500/5 ${borderClass} ${inSelectionMode ? "" : "cursor-grab active:cursor-grabbing"}`}
                style={{
                  left: box.x * FT_TO_PX,
                  top: box.y * FT_TO_PX,
                  width: box.widthFt * FT_TO_PX,
                  height: box.heightFt * FT_TO_PX,
                }}
              >
                {/* A dedicated, always-clickable handle for dragging the whole box — relying only
                    on "click empty space inside the box" breaks down once it's densely packed with
                    plant dots, which render on top and would otherwise intercept every click. */}
                {!inSelectionMode && (
                  <div
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      startPlantBoxDrag(bed.id, box.id, e);
                    }}
                    onTouchStart={(e) => {
                      e.stopPropagation();
                      startPlantBoxDrag(bed.id, box.id, e);
                    }}
                    title={linkedPartner ? `Drag to move the merged ${box.plantName} + ${linkedPartner.plantName} group` : `Drag to move the whole ${box.plantName} group`}
                    className="absolute bg-blue-600 border-2 border-white rounded-full shadow cursor-grab active:cursor-grabbing"
                    style={{ left: -7, top: -7, width: 14, height: 14, zIndex: 10 }}
                  />
                )}
                {/* Resize handle — grows or shrinks the box, regenerating its plants to match the
                    new area at the same spacing, live as you drag. Green matches the same
                    resize-handle color already used in the fill tool, so the two mean the same
                    thing consistently across the app. */}
                {!inSelectionMode && (
                  <div
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      startPlacedBoxResize(bed.id, box.id, e);
                    }}
                    onTouchStart={(e) => {
                      e.stopPropagation();
                      startPlacedBoxResize(bed.id, box.id, e);
                    }}
                    title={linkedPartner ? `Drag to resize the merged ${box.plantName} + ${linkedPartner.plantName} group — both plant counts update to match` : `Drag to resize the ${box.plantName} group — the number of plants updates to match`}
                    className="absolute bg-emerald-700 border-2 border-white rounded-full shadow"
                    style={{ right: -7, bottom: -7, width: 14, height: 14, cursor: "nwse-resize", zIndex: 10 }}
                  />
                )}
                {/* Merge / unmerge — a plain click, not a drag, since it's a one-shot action rather
                    than a continuous interaction. Merging creates a properly-spaced interplanted
                    layout between two companion plant types (see computeInterplantedLayout) and
                    links the two boxes so future resizes stay in sync; unmerging just breaks that
                    link without changing the current layout. */}
                {!inSelectionMode && linkedPartner && (
                  <button
                    type="button"
                    onMouseDown={(e) => e.stopPropagation()}
                    onTouchStart={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      unmergeBoxes(bed.id, box.id);
                    }}
                    title={`Unmerge from ${linkedPartner.plantName} — keeps the current layout, just stops keeping them in sync`}
                    className="absolute flex items-center justify-center bg-purple-600 border-2 border-white rounded-full shadow text-white hover:bg-purple-700"
                    style={{ right: -7, top: -7, width: 14, height: 14, fontSize: 9, lineHeight: 1, zIndex: 10 }}
                  >
                    ✕
                  </button>
                )}
                {!inSelectionMode && mergeCandidate && (
                  <button
                    type="button"
                    onMouseDown={(e) => e.stopPropagation()}
                    onTouchStart={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      mergeBoxes(bed.id, box.id, mergeCandidate.id);
                    }}
                    title={`Merge with ${mergeCandidate.plantName} — creates proper spacing between both plant types and keeps them in sync going forward`}
                    className="absolute flex items-center justify-center bg-purple-600 border-2 border-white rounded-full shadow text-white hover:bg-purple-700"
                    style={{ right: -7, top: -7, width: 14, height: 14, fontSize: 9, lineHeight: 1, zIndex: 10 }}
                  >
                    ⇄
                  </button>
                )}
              </div>
            );
          })}
          {/* Box members draw first, loose plants after — box resizes and merges regenerate their members
              (re-appending them to the plant list), which would otherwise bury a loose plant underneath
              the locked dots and make it impossible to grab. A loose plant should always sit on top. */}
          {[...bed.plants.filter((p) => p.boxId), ...bed.plants.filter((p) => !p.boxId)].map((p) => {
            // While this exact plant is the source of an active fill-drag, its live preview (box +
            // grid of dots) is already showing "this many plants would go here" — showing the
            // original dot at the same time would just be visual clutter/confusion.
            if (plantFillTool && plantFillTool.replacingPlantId === p.id) return null;
            const inSelectionMode = selectionModeBedId === bed.id;
            const isSelected = selectedPlantIds.has(p.id);
            // Looked up from the per-bed cache (plantWarnings, above) rather than recomputed here.
            const { mismatchReason, companion, rotationWarning } = plantWarnings.get(p.id);
            const warningText =
              mismatchReason ||
              (companion.badNeighbors.length > 0 ? `Traditionally avoided near: ${companion.badNeighbors.join(", ")} (this bed).` : null) ||
              (rotationWarning ? `Grew ${rotationWarning.matchedPlant} (also a ${rotationWarning.family}) here in ${rotationWarning.year}.` : null);
            const dotTitle = inSelectionMode
              ? `${p.name}${p.cultivar ? ` (${p.cultivar})` : ""} — click to ${isSelected ? "deselect" : "select"}`
              : `${p.name}${p.cultivar ? ` (${p.cultivar})` : ""}${p.locked ? " — locked" : ""}${warningText ? ` — ${warningText}` : ""} — click for details`;
            // Matches the fill-tool's own preview formula exactly, so a plant's dot renders at the
            // same size once placed as it showed while still being dragged — clamped so a tightly
            // spaced plant (e.g. carrots at 3in) stays clickable and a widely spaced one (e.g.
            // elderberry at 96in) doesn't dwarf the rest of the bed.
            const dotSizePx = Math.max(10, Math.min(40, ((p.spacingIn || DEFAULT_SPACING_IN) / 12) * FT_TO_PX * 0.7));
            return (
              <div
                key={p.id}
                onMouseDown={inSelectionMode || p.locked ? undefined : (e) => startBedPlantDrag(bed.id, p.id, e)}
                onTouchStart={inSelectionMode || p.locked ? undefined : (e) => startBedPlantDrag(bed.id, p.id, e)}
                onClick={
                  inSelectionMode
                    ? () => togglePlantSelection(p.id)
                    : p.locked
                    ? () => setEditingPlant({ scope: "bed", bedId: bed.id, plantId: p.id })
                    : undefined
                }
                title={dotTitle}
                className={`absolute rounded-full shadow bg-emerald-600 border-2 cursor-pointer ${
                  isSelected ? "border-blue-500 ring-2 ring-blue-400 ring-offset-1" : warningText ? "border-red-500" : "border-white"
                } ${!inSelectionMode && !p.locked ? "cursor-grab active:cursor-grabbing" : ""}`}
                style={{
                  left: (p.x || 0) * FT_TO_PX - dotSizePx / 2,
                  top: (p.y || 0) * FT_TO_PX - dotSizePx / 2,
                  width: dotSizePx,
                  height: dotSizePx,
                }}
              >
                {isSelected && (
                  <Check size={10} className="absolute text-white" style={{ left: "50%", top: "50%", transform: "translate(-50%, -50%)" }} />
                )}
                {!isSelected && p.locked && (
                  <Lock size={9} className="absolute text-white" style={{ left: "50%", top: "50%", transform: "translate(-50%, -50%)" }} />
                )}
                {!inSelectionMode && !p.locked && (
                  <div
                    onMouseDown={(e) => startPlantChipFillDrag(bed.id, p.id, e)}
                    onTouchStart={(e) => startPlantChipFillDrag(bed.id, p.id, e)}
                    className="absolute bg-blue-600 border-2 border-white rounded-full shadow"
                    style={{ right: -6, bottom: -6, width: 10, height: 10, cursor: "nwse-resize", transform: `scale(${1 / zoom})`, transformOrigin: "bottom right" }}
                    title="Drag to expand into multiple plants filling this area, at this plant's recommended spacing"
                  />
                )}
              </div>
            );
          })}
          {bed.plants.length === 0 && boxWidthPx >= 100 && (
            <span className={`absolute inset-0 flex items-center justify-center text-xs italic pointer-events-none ${isCustom ? "text-stone-500" : "text-stone-700/70"}`}>
              No plants yet
            </span>
          )}
          {marquee && (
            <div
              className="absolute border-2 border-blue-500 bg-blue-500/10 pointer-events-none"
              style={{
                left: Math.min(marquee.startXPx, marquee.curXPx),
                top: Math.min(marquee.startYPx, marquee.curYPx),
                width: Math.abs(marquee.curXPx - marquee.startXPx),
                height: Math.abs(marquee.curYPx - marquee.startYPx),
              }}
            />
          )}
        </div>
      </div>

      {/* Resize handles — only for shapes with a meaningful width/length to drag (custom shapes have
          their own point-based reshape flow instead). */}
      {showDetails && (bed.shape === "rectangle" || bed.shape === "circle_oval") && (
        <>
          <div
            onMouseDown={(e) => startResizeDrag(bed.id, "right", e)}
            onTouchStart={(e) => startResizeDrag(bed.id, "right", e)}
            className="absolute bg-emerald-600 border-2 border-white rounded-full shadow"
            style={{ right: -6, top: "50%", width: 12, height: 28, marginTop: -14, cursor: "ew-resize", transform: `scale(${1 / zoom})` }}
            title="Drag to resize width"
          />
          <div
            onMouseDown={(e) => startResizeDrag(bed.id, "left", e)}
            onTouchStart={(e) => startResizeDrag(bed.id, "left", e)}
            className="absolute bg-emerald-600 border-2 border-white rounded-full shadow"
            style={{ left: -6, top: "50%", width: 12, height: 28, marginTop: -14, cursor: "ew-resize", transform: `scale(${1 / zoom})` }}
            title="Drag to resize width"
          />
          <div
            onMouseDown={(e) => startResizeDrag(bed.id, "bottom", e)}
            onTouchStart={(e) => startResizeDrag(bed.id, "bottom", e)}
            className="absolute bg-emerald-600 border-2 border-white rounded-full shadow"
            style={{ bottom: -6, left: "50%", width: 28, height: 12, marginLeft: -14, cursor: "ns-resize", transform: `scale(${1 / zoom})` }}
            title="Drag to resize length"
          />
          <div
            onMouseDown={(e) => startResizeDrag(bed.id, "top", e)}
            onTouchStart={(e) => startResizeDrag(bed.id, "top", e)}
            className="absolute bg-emerald-600 border-2 border-white rounded-full shadow"
            style={{ top: -6, left: "50%", width: 28, height: 12, marginLeft: -14, cursor: "ns-resize", transform: `scale(${1 / zoom})` }}
            title="Drag to resize length"
          />
        </>
      )}

      {/* Details card: a completely separate floating element below the bed, so the bed's own
          shape (especially circle/oval, whose border-radius depends on the box's own size) never
          resizes or distorts when this appears on hover or when pinned. */}
      {showDetails && (
        <div
          className="absolute z-20 bg-white border border-stone-300 rounded-lg shadow-lg p-2 flex flex-col gap-1.5"
          style={{ top: "100%", left: 0, marginTop: 6, width: Math.max(220, boxWidthPx) }}
        >
          <div className="flex items-center justify-end gap-1.5">
            <button onClick={() => setEditingBed(bed)} className="opacity-70 hover:opacity-100 p-1.5 rounded-full hover:bg-black/10" title="Edit bed details">
              <Edit3 size={14} />
            </button>
            {bed.shape === "custom_points" && (
              <button onClick={() => startCanvasDrawForBedShape(bed.id)} className="opacity-70 hover:opacity-100 p-1.5 rounded-full hover:bg-black/10" title="Edit shape">
                <PenTool size={14} />
              </button>
            )}
            <button onClick={() => duplicateBed(bed.id)} className="opacity-70 hover:opacity-100 p-1.5 rounded-full hover:bg-black/10" title="Duplicate bed">
              <Copy size={14} />
            </button>
            {hasHistoryForThisBed && (
              <button
                onClick={() => {
                  if (window.confirm(`Clear all past-year history for "${bed.name}"? This removes its records from every archived year and can't be undone.`)) {
                    clearBedHistory(bed.name);
                  }
                }}
                className="opacity-70 hover:opacity-100 hover:text-orange-600 p-1.5 rounded-full hover:bg-black/10"
                title="Clear this bed's rotation history"
              >
                <History size={14} />
              </button>
            )}
            <button onClick={() => deleteBed(bed.id)} className="opacity-70 hover:opacity-100 hover:text-red-500 p-1.5 rounded-full hover:bg-black/10" title="Delete bed">
              <Trash2 size={15} />
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            <div className="inline-flex items-center gap-1 text-xs mono-label text-stone-500 bg-stone-100 border border-stone-300 rounded-full px-2 py-0.5">
              <MapPin size={10} /> {locationLabel}
            </div>
            <div className="inline-flex items-center gap-1 text-xs mono-label text-stone-500 bg-stone-100 border border-stone-300 rounded-full px-2 py-0.5">
              {structureLabel}
            </div>
            <div
              className="inline-flex items-center gap-1 text-xs mono-label text-amber-700 bg-amber-50 border border-amber-300 rounded-full px-2 py-0.5"
              title={bed.sunExposureSource === "auto" ? "Auto-detected from your light zones — will keep updating unless you set it manually." : undefined}
            >
              {sunLabel}
              {bed.sunExposureSource === "auto" && <span className="text-emerald-600">(auto)</span>}
              {suggestionDiffers && (
                <span title={suggestionDiffers} className="inline-flex text-blue-600">
                  <Info size={11} />
                </span>
              )}
            </div>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              addPlantToBed(bed.id);
            }}
            className="flex gap-1"
          >
            <input
              value={bedPlantInputs[bed.id] || ""}
              onChange={(e) => setBedPlantInputs((prev) => ({ ...prev, [bed.id]: e.target.value }))}
              placeholder="+ plant name"
              className="flex-1 min-w-0 border border-stone-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-600"
            />
            <button type="submit" className="bg-emerald-700 hover:bg-emerald-800 text-white rounded px-2 text-xs">
              Add
            </button>
          </form>
          {crowdedNotice && (
            <p className="text-xs text-amber-700 mt-1">
              No open space left in this bed — the new plant went to the least crowded spot. Shrink a box or drag it somewhere clear.
            </p>
          )}
          <button
            type="button"
            onClick={() => setFillToolOpen((s) => !s)}
            className="text-xs text-stone-500 hover:text-emerald-700 underline mt-1.5"
          >
            {fillToolOpen ? "Hide fill-bed tool" : "Fill bed at recommended spacing"}
          </button>
          {bed.plants.length > 0 && (
            <button
              type="button"
              onClick={() => toggleSelectionMode(bed.id)}
              className="text-xs text-stone-500 hover:text-emerald-700 underline mt-1 ml-3"
            >
              {selectionModeBedId === bed.id ? "Cancel selecting" : "Select multiple"}
            </button>
          )}
          {selectionModeBedId === bed.id && (
            <div className="mt-2 border border-blue-200 bg-blue-50 rounded-lg p-2 flex flex-col gap-1.5 text-xs">
              <span className="text-stone-500">Drag across empty space to select everything inside the box, or click plants one at a time.</span>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-stone-700">{selectedPlantIds.size} selected</span>
                <button type="button" onClick={() => selectAllInBed(bed.id)} className="text-blue-700 hover:text-blue-900 underline">
                  Select all ({bed.plants.length})
                </button>
                <button
                  type="button"
                  disabled={selectedPlantIds.size === 0}
                  onClick={() => bulkSetPlantsLocked(bed.id, selectedPlantIds, false)}
                  className="flex items-center gap-1 bg-white border border-stone-300 rounded px-2 py-1 disabled:opacity-40 hover:bg-stone-50"
                >
                  <Unlock size={11} /> Unlock
                </button>
                <button
                  type="button"
                  disabled={selectedPlantIds.size === 0}
                  onClick={() => bulkSetPlantsLocked(bed.id, selectedPlantIds, true)}
                  className="flex items-center gap-1 bg-white border border-stone-300 rounded px-2 py-1 disabled:opacity-40 hover:bg-stone-50"
                >
                  <Lock size={11} /> Lock
                </button>
                <button
                  type="button"
                  disabled={selectedPlantIds.size === 0}
                  onClick={() => bulkDeletePlants(bed.id, selectedPlantIds)}
                  className="flex items-center gap-1 bg-white border border-stone-300 rounded px-2 py-1 disabled:opacity-40 hover:bg-stone-50 hover:text-red-600"
                >
                  <X size={11} /> Delete
                </button>
                <button type="button" onClick={() => toggleSelectionMode(bed.id)} className="ml-auto text-stone-500 hover:text-stone-800 underline">
                  Done
                </button>
              </div>
            </div>
          )}
          {fillToolOpen &&
            (() => {
              const fillState = fillBedInputs[bed.id] || { name: "", spacingOverride: "" };
              const trimmedName = fillState.name.trim();
              const recommended = trimmedName ? getRecommendedSpacingIn(trimmedName) : null;
              const spacingIn = fillState.spacingOverride !== "" ? Number(fillState.spacingOverride) : recommended;
              const validSpacing = typeof spacingIn === "number" && spacingIn > 0;
              return (
                <div className="mt-2 border border-stone-200 rounded-lg p-2 space-y-1.5 bg-stone-50">
                  <input
                    value={fillState.name}
                    onChange={(e) => setFillBedInputs((prev) => ({ ...prev, [bed.id]: { ...fillState, name: e.target.value } }))}
                    placeholder="Plant to fill with"
                    className="w-full border border-stone-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-600"
                  />
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="text-stone-500">Spacing:</span>
                    <input
                      type="number"
                      min="1"
                      value={fillState.spacingOverride !== "" ? fillState.spacingOverride : recommended ?? ""}
                      onChange={(e) =>
                        setFillBedInputs((prev) => ({ ...prev, [bed.id]: { ...fillState, spacingOverride: e.target.value } }))
                      }
                      placeholder="in"
                      className="w-14 border border-stone-300 rounded px-1.5 py-1 text-xs text-center focus:outline-none focus:ring-1 focus:ring-emerald-600"
                    />
                    <span className="text-stone-500">in</span>
                    {recommended && fillState.spacingOverride === "" && <span className="text-stone-400">(recommended)</span>}
                  </div>
                  <div className="text-xs text-stone-500">
                    {trimmedName && !recommended && fillState.spacingOverride === ""
                      ? "No spacing on file for this plant — enter one manually."
                      : validSpacing
                      ? "On the map: drag the box's green corner to choose the fill area, and the blue plant marker's own corner to adjust spacing."
                      : "Enter a plant name to see its spacing."}
                  </div>
                  <button
                    type="button"
                    disabled={!trimmedName || !validSpacing}
                    onClick={() => {
                      const startSizeFt = spacingIn / 12;
                      setPlantFillTool({
                        bedId: bed.id,
                        plantName: trimmedName,
                        spacingIn,
                        boxX: 0,
                        boxY: 0,
                        boxWidthFt: Math.min(startSizeFt, bed.widthFt),
                        boxHeightFt: Math.min(startSizeFt, bed.lengthFt),
                      });
                      setFillToolOpen(false);
                    }}
                    className="w-full bg-emerald-700 hover:bg-emerald-800 disabled:opacity-40 text-white rounded px-2 py-1 text-xs"
                  >
                    Show on map
                  </button>
                </div>
              );
            })()}
        </div>
      )}
    </div>
  );
}

// BedCard wrapped in React.memo: a bed only re-renders when one of its own props actually changes
// (its own data, the zoom level, selection state, ...) instead of whenever anything anywhere on
// the map changes. Works together with useStableHandlers, which keeps the function props stable.
const MemoBedCard = memo(BedCard);

// Popup for editing an existing bed's own fields (name, dimensions, soil/structure/sun) — reuses
// the same BedFields form as bed creation, just pre-populated via bedToFormValues and saving back
// through computeDimensions rather than creating a new bed.
function EditBedModal({ bed, onCancel, onSave, onDrawShape }) {
  const [values, setValues] = useState(() => bedToFormValues(bed)); // the edit form's field values, seeded from the bed
  const hasCustomShape = values.shape === "custom_points" && values.existingCustomPoints && values.existingCustomPoints.length >= 3;
  return (
    <div
      className="fixed inset-0 bg-stone-900/60 flex items-start justify-center z-50 p-2 sm:p-4 overflow-y-auto"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-4 sm:p-5 my-4 sm:my-8">
        <h3 className="fraunces text-xl flex items-center gap-2 mb-3">
          <Edit3 size={18} className="text-emerald-700" /> Edit bed
        </h3>
        <BedFields
          values={values}
          setValues={setValues}
          hasCustomShape={hasCustomShape}
          onDrawShape={() => {
            onSave(values); // commit any other field edits made so far before leaving the modal to draw
            onDrawShape();
          }}
        />
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onCancel} className="text-sm px-4 py-2 rounded-lg border border-stone-300 hover:bg-stone-50">
            Cancel
          </button>
          <button
            onClick={() => onSave(values)}
            className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white"
          >
            <Check size={15} /> Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

// Popup for editing a landscape feature's own fields (name, kind, notes) — created via the
// canvas-draw flow, but its name/kind/notes are edited here afterward, separate from reshaping.
function EditFeatureModal({ feature, onCancel, onSave, onDelete }) {
  const [name, setName] = useState(feature.name); // name field
  const [kind, setKind] = useState(feature.kind); // feature kind (path, patio, water feature, ...)
  const [notes, setNotes] = useState(feature.notes || ""); // free-text notes
  const [nameError, setNameError] = useState(false); // show the "name required" message

  // Validates the name and saves the edited landscape feature.
  const submit = (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setNameError(true);
      return;
    }
    onSave(feature.id, { name: name.trim(), kind, notes });
  };

  return (
    <div
      className="fixed inset-0 bg-stone-900/60 flex items-start justify-center z-50 p-2 sm:p-4 overflow-y-auto"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-4 sm:p-5 my-4 sm:my-8">
        <h3 className="fraunces text-xl flex items-center gap-2 mb-3">
          <Edit3 size={18} className="text-emerald-700" /> Edit landscape feature
        </h3>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="block text-xs mono-label text-stone-500 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameError(false);
              }}
              className={`w-full border rounded-lg px-3 py-2 text-sm ${nameError ? "border-red-400" : "border-stone-300"}`}
              placeholder="e.g. Gravel path"
            />
            {nameError && <p className="text-xs text-red-600 mt-1">A name is needed to save this feature.</p>}
          </div>
          <div>
            <label className="block text-xs mono-label text-stone-500 mb-1">Kind</label>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm">
              {SITE_FEATURE_KIND_KEYS.map((k) => (
                <option key={k} value={k}>
                  {SITE_FEATURE_KINDS[k].icon} {SITE_FEATURE_KINDS[k].label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs mono-label text-stone-500 mb-1">Notes (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm"
              placeholder="Any details worth remembering about this one"
            />
          </div>
          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={() => onDelete(feature.id)}
              className="text-sm text-red-600 hover:text-red-700 flex items-center gap-1"
            >
              <Trash2 size={14} /> Delete
            </button>
            <div className="flex gap-2">
              <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm rounded-lg border border-stone-300 hover:bg-stone-50">
                Cancel
              </button>
              <button type="submit" className="px-3 py-1.5 text-sm rounded-lg bg-emerald-700 text-white hover:bg-emerald-800">
                Save
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// The main component — owns essentially all app state and the top-level layout (sidebar + map +
// tabs for Calendar/History/Journal). Below, roughly in order: state declarations (grouped loosely
// by what they're for — beds/plants, zone, light zones, the map viewport, background images,
// selection/multi-select, undo/redo, various modal-open states), then a large block of plain
// functions that read/write that state (bed and plant CRUD, the fill-spacing tool, drag/resize
// handlers for every draggable thing on the map, import/export, undo/redo), then the JSX render —
// the sidebar's forms, the map canvas with beds/images/freestanding plants, and whichever modal is
// currently open. Most individual pieces have their own comments where they're defined; this is
// just the map of how they fit together.
export default function GardenPlanner() {
  const [beds, setBeds] = useState([]); // every bed on the map, each holding its own plants and plant boxes
  const [plants, setPlants] = useState([]); // freestanding plants placed on the open map (not in any bed)
  const [zone, setZone] = useState("unset"); // USDA hardiness zone ("unset" until chosen)
  const [zoneCustomText, setZoneCustomText] = useState(""); // free-text zone for users outside the USDA system
  const [zipInput, setZipInput] = useState(""); // ZIP code typed into the zone lookup
  const [zipStatus, setZipStatus] = useState("idle"); // ZIP-to-zone lookup progress: "idle" | "loading" | "error"
  const [lightZones, setLightZones] = useState([]); // hand-drawn sunlight regions; beds inside one get their sun level suggested
  // Landscape features (paths, patios, water features, structures, etc.) — hand-drawn shapes like
  // a custom bed, but a completely separate, simpler kind of thing: no plants, no fill tool, just
  // a name, a kind, optional notes, and a shape. See SITE_FEATURE_KINDS below for the fixed kind
  // list and each one's color/icon, used to make it visually obvious these aren't plantable areas.
  const [siteFeatures, setSiteFeatures] = useState([]);
  const [showLightZones, setShowLightZones] = useState(true); // toggle light-zone overlay visibility
  const [showSiteFeatures, setShowSiteFeatures] = useState(true); // toggle landscape-feature visibility
  const [showSidebar, setShowSidebar] = useState(true); // whether the left control panel is shown
  const [manualGridFt, setManualGridFt] = useState(1); // defaults to a fixed 1ft grid rather than adaptive mode, which would start at 5ft (see getAdaptiveGridSizeFt) — "Auto" switches back to adaptive any time
  const [viewportWidth, setViewportWidth] = useState(null); // user-dragged fixed map width in px, or null for responsive
  const [viewportHeight, setViewportHeight] = useState(null); // user-dragged fixed map height in px, or null for responsive
  const [backgroundImages, setBackgroundImages] = useState([]); // satellite/aerial images placed under the beds for tracing
  const [showBackgroundImages, setShowBackgroundImages] = useState(true); // toggle background-image visibility
  const [calibrationSession, setCalibrationSession] = useState(null); // in-progress image-scale calibration, or null
  const imageFileInputRef = useRef(null); // hidden <input type="file"> clicked programmatically to pick a background image
  const [yearHistory, setYearHistory] = useState([]); // archived past growing years (frozen snapshots)
  const [journalEntries, setJournalEntries] = useState([]); // harvest/notes/expense log entries
  const [showYearRollover, setShowYearRollover] = useState(false); // whether the "start a new year" dialog is open
  const [zoneForm, setZoneForm] = useState({ sunExposure: "full_sun", customShape: null });
  const [featureForm, setFeatureForm] = useState({ name: "", kind: "path", notes: "" }); // sidebar form values for a new landscape feature
  const [featureNameError, setFeatureNameError] = useState(false); // show the "feature name required" message
  const [loaded, setLoaded] = useState(false); // true once saved data has been read from storage (gates auto-save so an empty start can't overwrite it)
  const [bedForm, setBedForm] = useState(blankFormValues()); // sidebar "Add a bed" form values
  const [bedNameError, setBedNameError] = useState(false); // show the "bed name required" message
  const [legendOpen, setLegendOpen] = useState(false); // whether the Gantt legend is expanded
  const [activeTab, setActiveTab] = useState("map"); // current tab: "map" | "calendar" | "history" | "journal"
  const [zoom, setZoom] = useState(1); // map zoom factor (1 = 100%); view-only, not saved or undoable
  const [baseWidth, setBaseWidth] = useState(800); // measured width of the map viewport in px (updated by a ResizeObserver)
  const [baseHeight, setBaseHeight] = useState(400); // measured height of the map viewport in px
  const canvasOuterRef = useRef(null); // the scrollable "Your land" viewport; measured for its size and used for drag-panning
  const importInputRef = useRef(null); // hidden <input type="file"> for importing a JSON backup
  const [importError, setImportError] = useState(""); // message shown when a JSON import fails
  const [plantName, setPlantName] = useState(""); // name typed into the "Add a freestanding plant" field
  const [bedPlantInputs, setBedPlantInputs] = useState({}); // text typed into each bed's "add plant" field, by bed id
  // Id of a bed whose last-added plant had nowhere free to go (the bed is full) — drives a short
  // notice under that bed's add-plant form; auto-clears so it doesn't linger.
  const [crowdedBedNotice, setCrowdedBedNotice] = useState(null);
  useEffect(() => {
    if (!crowdedBedNotice) return;
    const t = setTimeout(() => setCrowdedBedNotice(null), 10000);
    return () => clearTimeout(t);
  }, [crowdedBedNotice]);
  const [fillBedInputs, setFillBedInputs] = useState({}); // { [bedId]: { name, spacingOverride } }
  // Multi-select mode for bulk plant actions (unlock/lock/delete several at once) — only one bed
  // can be in selection mode at a time, to avoid ambiguity about which bed a bulk action applies to.
  const [selectionModeBedId, setSelectionModeBedId] = useState(null);
  const [selectedPlantIds, setSelectedPlantIds] = useState(new Set()); // ids of plants currently selected for a bulk action
  // { bedId, plantName, spacingIn, boxX, boxY, boxWidthFt, boxHeightFt } | null — boxX/Y/Width/Height
  // are all in feet, relative to the bed's own origin.
  const [plantFillTool, setPlantFillTool] = useState(null);
  // In-place shape drawing directly on the map. null when not drawing.
  // { kind: 'bed'|'zone', mode: 'create'|'edit', targetId: null|id, points: [{x,y}] } — points are in the
  // same absolute/logical canvas coordinates as bed.x/bed.y (already zoom-divided, not yet normalized).
  const [canvasDraw, setCanvasDraw] = useState(null);
  const draggingDrawPointRef = useRef(null); // index of the in-progress shape point currently being dragged, or null
  const suppressDrawClickRef = useRef(false); // true right after a point drag ends, so its mouseup isn't also counted as a click that adds a point
  const [editingBed, setEditingBed] = useState(null); // bed object or null
  const [editingFeature, setEditingFeature] = useState(null); // site feature object or null
  const [editingPlant, setEditingPlant] = useState(null); // { scope: 'bed'|'free', bedId, plantId } | null
  const [renaming, setRenaming] = useState(null); // { scope: 'bed'|'free', bedId, plantId, text }
  const canvasRef = useRef(null); // the zoom-scaled canvas layer; its bounding rect converts mouse positions to canvas coordinates
  const renameInputRef = useRef(null); // the inline plant-rename input, focused when renaming starts

  const [imageSaveWarning, setImageSaveWarning] = useState(""); // message shown if images were too big to save

  useEffect(() => {
    (async () => {
      try {
        const result = await window.storage.get(STORAGE_KEY);
        if (result && result.value) {
          const data = JSON.parse(result.value);
          setBeds((data.beds || []).map(migrateBed));
          setPlants((data.plants || []).map(migratePlant));
          setZone(data.zone || "unset");
          setZoneCustomText(data.zoneCustomText || "");
          setLightZones(data.lightZones || []);
          setSiteFeatures(data.siteFeatures || []);
          setYearHistory(data.yearHistory || []);
          setJournalEntries(data.journalEntries || []);
          setBackgroundImages(migrateBackgroundImages(data));
        }
      } catch (e) {
        // no saved data yet
      }
      setLoaded(true);
    })();
  }, []);

  // Debounced auto-save (see the useEffect that calls this, further down) — writes the full
  // garden state to storage. Falls back to saving everything except background images if the
  // write fails (almost always a storage-quota issue caused by large images), so a garden's
  // actual data never gets lost just because an image didn't fit.
  const persist = useCallback(
    async (nextBeds, nextPlants, nextZone, nextZoneCustomText, nextLightZones, nextSiteFeatures, nextYearHistory, nextJournalEntries, nextBackgroundImages) => {
      const basePayload = {
        beds: nextBeds,
        plants: nextPlants,
        zone: nextZone,
        zoneCustomText: nextZoneCustomText,
        lightZones: nextLightZones,
        siteFeatures: nextSiteFeatures,
        yearHistory: nextYearHistory,
        journalEntries: nextJournalEntries,
      };
      try {
        await window.storage.set(STORAGE_KEY, JSON.stringify({ ...basePayload, backgroundImages: nextBackgroundImages }));
        // Unconditional — React bails out of a re-render if this is already "", so no need to read
        // imageSaveWarning here. Reading it would make persist's own identity change whenever the
        // warning changes, which (since persist is itself a dependency of the debounced save effect)
        // would reset that debounce every time, adding an extra delay cycle right when a save just failed.
        setImageSaveWarning("");
      } catch (e) {
        // Most likely the browser's storage quota was exceeded by the images. Don't let that take the rest of
        // the garden's data down with it — retry without any images so beds/plants/etc. still save correctly.
        if (nextBackgroundImages && nextBackgroundImages.length > 0) {
          try {
            await window.storage.set(STORAGE_KEY, JSON.stringify({ ...basePayload, backgroundImages: [] }));
            setImageSaveWarning("Your uploaded image(s) are too large to save in this browser — everything else saved fine, but the images won't survive a reload. Try smaller or fewer images.");
          } catch (e2) {
            console.error("Could not save garden data", e2);
          }
        } else {
          console.error("Could not save garden data", e);
        }
      }
    },
    []
  );

  // Undo/redo history: a debounced stack of snapshots of the same core garden data persistence
  // tracks (beds, plants, zone, lightZones, year history, journal, images) — deliberately excludes
  // pure UI state (zoom, sidebar collapse, viewport size), matching what persistence already
  // considers "the data" versus "how it's currently being viewed." Debounced on the same settle
  // logic as auto-save, so a drag through dozens of intermediate positions becomes one undo step
  // once it's released, not hundreds while it's in motion.
  //
  // The stacks live in refs, not state: undo()/redo() need to both read the current stack AND
  // perform side effects (applying a snapshot, updating other refs) in one go, and a React state
  // updater function must stay pure — if React ever re-invokes one for any reason, side effects
  // inside it fire more than once, corrupting the second operation in a chain. Refs have no such
  // constraint. historyVersion is a plain counter, bumped after every ref mutation, whose only job
  // is forcing a re-render so the Undo/Redo buttons' disabled state reflects the current stacks.
  const HISTORY_LIMIT = 50;
  const undoStackRef = useRef([]); // past snapshots, oldest first (see the block comment above)
  const redoStackRef = useRef([]); // snapshots undone and available to redo
  const [historyVersion, setHistoryVersion] = useState(0); // counter bumped to re-render the Undo/Redo buttons
  // Forces a re-render after the undo/redo stacks (refs) change, so the Undo/Redo buttons update.
  const bumpHistoryVersion = () => setHistoryVersion((v) => v + 1);
  const lastSnapshotRef = useRef(null); // the most recent settled state — the baseline the next change is compared against
  const isApplyingHistoryRef = useRef(false); // true while undo/redo applies a snapshot, so that change isn't recorded as a new edit
  const historyTimeoutRef = useRef(null); // pending debounce timer that records an undo step once changes settle

  // Replaces all live garden data with a saved snapshot (used by undo and redo).
  const applySnapshot = (snap) => {
    setBeds(snap.beds);
    setPlants(snap.plants);
    setZone(snap.zone);
    setZoneCustomText(snap.zoneCustomText);
    setLightZones(snap.lightZones);
    setSiteFeatures(snap.siteFeatures || []);
    setYearHistory(snap.yearHistory);
    setJournalEntries(snap.journalEntries);
    setBackgroundImages(snap.backgroundImages);
  };

  // Steps back one change: pushes the current state onto the redo stack and restores the previous snapshot.
  const undo = useCallback(() => {
    if (undoStackRef.current.length === 0) return;
    const previous = undoStackRef.current[undoStackRef.current.length - 1];
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    redoStackRef.current = [...redoStackRef.current, lastSnapshotRef.current].slice(-HISTORY_LIMIT);
    isApplyingHistoryRef.current = true;
    lastSnapshotRef.current = previous;
    applySnapshot(previous);
    bumpHistoryVersion();
  }, []);

  // Re-applies the most recently undone change: pushes the current state onto the undo stack and restores the next snapshot.
  const redo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;
    const next = redoStackRef.current[redoStackRef.current.length - 1];
    redoStackRef.current = redoStackRef.current.slice(0, -1);
    undoStackRef.current = [...undoStackRef.current, lastSnapshotRef.current].slice(-HISTORY_LIMIT);
    isApplyingHistoryRef.current = true;
    lastSnapshotRef.current = next;
    applySnapshot(next);
    bumpHistoryVersion();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const current = { beds, plants, zone, zoneCustomText, lightZones, siteFeatures, yearHistory, journalEntries, backgroundImages };
    if (!lastSnapshotRef.current) {
      lastSnapshotRef.current = current; // first settle after load: establish a baseline, nothing to push yet
      return;
    }
    if (isApplyingHistoryRef.current) {
      // This change came from undo()/redo() applying a snapshot, not a new user action — those
      // functions already updated the stacks directly, so just clear the suppression flag and
      // update the baseline immediately, without going through the debounce below. Checking this
      // right away (not inside the debounced callback) matters: it lets a quick undo-then-redo
      // sequence work correctly instead of the flag still being true when the next call runs.
      isApplyingHistoryRef.current = false;
      lastSnapshotRef.current = current;
      return;
    }
    historyTimeoutRef.current = setTimeout(() => {
      historyTimeoutRef.current = null;
      undoStackRef.current = [...undoStackRef.current, lastSnapshotRef.current].slice(-HISTORY_LIMIT);
      redoStackRef.current = []; // a genuine new change invalidates any previous redo history
      lastSnapshotRef.current = current;
      bumpHistoryVersion();
    }, 600);
    return () => {
      if (historyTimeoutRef.current) clearTimeout(historyTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beds, plants, zone, zoneCustomText, lightZones, siteFeatures, yearHistory, journalEntries, backgroundImages, loaded]);

  useEffect(() => {
    const onKeyDown = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (document.activeElement && document.activeElement.isContentEditable)) return;
      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (e.key === "y" || (e.key === "z" && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo]);

  // Keeps the latest garden-data snapshot available to the safety-net flush below, updated cheaply
  // (just an object assignment, no serialization) on every relevant change.
  const latestSaveDataRef = useRef(null);
  useEffect(() => {
    latestSaveDataRef.current = { beds, plants, zone, zoneCustomText, lightZones, siteFeatures, yearHistory, journalEntries, backgroundImages };
  }, [beds, plants, zone, zoneCustomText, lightZones, siteFeatures, yearHistory, journalEntries, backgroundImages]);

  // Debounced so a fast-changing drag (a bed, plant, or image moving through dozens of positions a
  // second) doesn't trigger a full JSON.stringify-and-write on every single intermediate step — only
  // once the data has actually settled. The flush effect right after this one is the safety net: if
  // the tab is hidden or closed while a debounced save is still pending, it's written immediately
  // instead of being silently lost to the delay.
  const persistTimeoutRef = useRef(null);
  useEffect(() => {
    if (!loaded) return;
    persistTimeoutRef.current = setTimeout(() => {
      persistTimeoutRef.current = null;
      persist(beds, plants, zone, zoneCustomText, lightZones, siteFeatures, yearHistory, journalEntries, backgroundImages);
    }, 500);
    return () => {
      if (persistTimeoutRef.current) clearTimeout(persistTimeoutRef.current);
    };
  }, [beds, plants, zone, zoneCustomText, lightZones, siteFeatures, yearHistory, journalEntries, backgroundImages, loaded, persist]);

  useEffect(() => {
    if (!loaded) return;
    const flushIfPending = () => {
      if (!persistTimeoutRef.current) return;
      clearTimeout(persistTimeoutRef.current);
      persistTimeoutRef.current = null;
      const d = latestSaveDataRef.current;
      if (d) persist(d.beds, d.plants, d.zone, d.zoneCustomText, d.lightZones, d.siteFeatures, d.yearHistory, d.journalEntries, d.backgroundImages);
    };
    const onVisibilityChange = () => {
      if (document.hidden) flushIfPending();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("beforeunload", flushIfPending);
    window.addEventListener("pagehide", flushIfPending);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("beforeunload", flushIfPending);
      window.removeEventListener("pagehide", flushIfPending);
    };
  }, [loaded, persist]);

  useEffect(() => {
    if (bedForm.name.trim()) setBedNameError(false);
  }, [bedForm.name]);

  useEffect(() => {
    if (renaming && renameInputRef.current) renameInputRef.current.focus();
  }, [renaming]);

  useEffect(() => {
    const el = canvasOuterRef.current;
    if (!el) return;
    const measure = () => {
      setBaseWidth(el.clientWidth || 800);
      setBaseHeight(el.clientHeight || 400);
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Zoom controls for the map canvas. zoomIn/zoomOut step by a fixed ratio (25%) rather than a
  // fixed amount, so the step feels proportionally similar whether already zoomed way in or way
  // out. zoomToFit scans every bed/plant/light-zone/image's extent to find a zoom level that fits
  // everything in the currently-visible canvas area, so "fit everything" always works regardless
  // of how spread out the garden actually is.
  const ZOOM_MIN = 0.03;
  const ZOOM_MAX = 2;
  // Zoom controls: each step multiplies/divides zoom by 1.25 (clamped to ZOOM_MIN..ZOOM_MAX); zoomReset returns to 100%.
  const zoomIn = () => setZoom((z) => Math.min(ZOOM_MAX, Math.round(z * 1.25 * 1000) / 1000));
  const zoomOut = () => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z / 1.25) * 1000) / 1000));
  const zoomReset = () => setZoom(1);

  // Mouse-wheel zoom over "Your land", anchored on the cursor: the map point under the pointer
  // stays under the pointer as the scale changes (like a map app), instead of zooming about the
  // top-left corner. zoomRef mirrors the latest zoom so several wheel events fired before React
  // re-renders keep compounding; wheelAnchorRef remembers the point to hold still until the new
  // zoom has rendered (applied in the layout effect below, before paint, so there's no jump).
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const wheelAnchorRef = useRef(null); // { px, py: canvas coords under cursor; mx, my: cursor offset inside viewport; offX, offY: canvas origin inside scroll content }
  useEffect(() => {
    const el = canvasOuterRef.current;
    if (!el) return undefined;
    function onWheel(e) {
      // Leave text fields alone (e.g. scrolling a select list or textarea inside the map).
      const tag = e.target && e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault(); // React's onWheel is passive; a native non-passive listener is needed to stop page scroll
      const lineScale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1; // normalise line/page wheels to pixels
      const factor = Math.exp(-e.deltaY * lineScale * 0.0015); // smooth: ~12% per classic 100px notch, finer for trackpads
      const oldZoom = zoomRef.current;
      const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(oldZoom * factor * 1000) / 1000));
      if (newZoom === oldZoom) return;
      if (!wheelAnchorRef.current) {
        const outer = el.getBoundingClientRect();
        const canvas = canvasRef.current ? canvasRef.current.getBoundingClientRect() : outer;
        wheelAnchorRef.current = {
          px: (e.clientX - canvas.left) / oldZoom,
          py: (e.clientY - canvas.top) / oldZoom,
          mx: e.clientX - outer.left,
          my: e.clientY - outer.top,
          offX: canvas.left - outer.left + el.scrollLeft, // canvas origin within scrollable content (non-zero when the sticky draw toolbar is shown)
          offY: canvas.top - outer.top + el.scrollTop,
        };
      }
      zoomRef.current = newZoom;
      setZoom(newZoom);
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]); // the viewport element is remounted when switching tabs, so re-attach
  // After a wheel zoom renders, scroll so the anchored map point sits back under the cursor.
  useLayoutEffect(() => {
    const a = wheelAnchorRef.current;
    const el = canvasOuterRef.current;
    if (!a || !el) return;
    wheelAnchorRef.current = null;
    el.scrollLeft = a.offX + a.px * zoom - a.mx;
    el.scrollTop = a.offY + a.py * zoom - a.my;
  }, [zoom]);
  // Chooses the zoom that fits every bed, plant, light zone, feature and image in the visible viewport, then scrolls to the top-left of them.
  function zoomToFit() {
    const xs = [];
    const ys = [];
    beds.forEach((b) => {
      xs.push(b.x, b.x + b.widthFt * FT_TO_PX);
      ys.push(b.y, b.y + b.lengthFt * FT_TO_PX);
    });
    plants.forEach((p) => {
      xs.push(p.x, p.x + 40);
      ys.push(p.y, p.y + 30);
    });
    lightZones.forEach((z) => {
      xs.push(z.x, z.x + z.widthFt * FT_TO_PX);
      ys.push(z.y, z.y + z.lengthFt * FT_TO_PX);
    });
    siteFeatures.forEach((f) => {
      xs.push(f.x, f.x + f.widthFt * FT_TO_PX);
      ys.push(f.y, f.y + f.lengthFt * FT_TO_PX);
    });
    backgroundImages.forEach((bgImg) => {
      xs.push(bgImg.x, bgImg.x + bgImg.widthPx);
      ys.push(bgImg.y, bgImg.y + bgImg.heightPx);
    });
    if (xs.length === 0) {
      setZoom(1);
      return;
    }
    const contentWidth = Math.max(...xs) + 40;
    const contentHeight = Math.max(...ys) + 40;
    const containerWidth = (canvasOuterRef.current && canvasOuterRef.current.clientWidth) || baseWidth;
    const availableHeight = baseHeight;
    const fitZoom = Math.min(containerWidth / contentWidth, availableHeight / contentHeight, ZOOM_MAX);
    setZoom(Math.max(ZOOM_MIN, Math.round(fitZoom * 1000) / 1000));
  }

  // Creates a new bed from the sidebar's "add bed" form, placing it in a simple staggered grid
  // (3 per row) so beds don't stack directly on top of each other. If the user hasn't manually
  // set a sun exposure, checks whether the new bed's position falls inside a drawn light zone and
  // auto-fills it from that — otherwise leaves it "unknown" rather than guessing.
  function addBed(e) {
    e.preventDefault();
    if (!bedForm.name.trim()) {
      setBedNameError(true);
      return;
    }
    setBedNameError(false);
    const usedSpots = beds.length;
    const dims = computeDimensions(bedForm);
    const x = 24 + (usedSpots % 3) * 40;
    const y = 24 + Math.floor(usedSpots / 3) * 40;
    let sunExposure = bedForm.sunExposure;
    let sunExposureSource = bedForm.sunExposureSource;
    if (sunExposureSource !== "manual") {
      const suggestion = suggestSunForBed({ x, y, widthFt: dims.widthFt, lengthFt: dims.lengthFt }, lightZones, FT_TO_PX);
      if (suggestion) {
        sunExposure = suggestion;
        sunExposureSource = "auto";
      } else {
        sunExposure = "unknown";
        sunExposureSource = "unset";
      }
    }
    const newBed = {
      id: nextId(),
      name: bedForm.name.trim(),
      shape: bedForm.shape,
      ...dims,
      soilType: bedForm.soilType,
      yardLocation: bedForm.yardLocation,
      bedStructure: bedForm.bedStructure,
      sunExposure,
      sunExposureSource,
      x,
      y,
      plants: [],
      plantBoxes: [],
    };
    setBeds((b) => [...b, newBed]);
    setBedForm((f) => ({ ...blankFormValues(), soilType: f.soilType, yardLocation: f.yardLocation, bedStructure: f.bedStructure, sunExposure: f.sunExposure, sunExposureSource: f.sunExposureSource, shape: f.shape }));
  }

  // Saves changes from EditBedModal back onto an existing bed — a blank name falls back to
  // keeping the bed's current name rather than allowing it to be accidentally cleared.
  function saveEditedBed(bedId, values) {
    const dims = computeDimensions(values);
    setBeds((prev) =>
      prev.map((b) =>
        b.id === bedId
          ? {
              ...b,
              name: values.name.trim() || b.name,
              shape: values.shape,
              ...dims,
              soilType: values.soilType,
              yardLocation: values.yardLocation,
              bedStructure: values.bedStructure,
              sunExposure: values.sunExposure,
              sunExposureSource: values.sunExposureSource,
            }
          : b
      )
    );
    setEditingBed(null);
  }

  // Whenever zones change, re-check any bed that hasn't been manually set by the user.
  // A bed the user has explicitly chosen a value for (sunExposureSource: "manual") is never touched.
  useEffect(() => {
    if (!loaded) return;
    setBeds((prev) =>
      prev.map((bed) => {
        if (bed.sunExposureSource === "manual") return bed;
        const suggestion = suggestSunForBed(bed, lightZones, FT_TO_PX);
        if (suggestion) {
          return bed.sunExposure === suggestion && bed.sunExposureSource === "auto"
            ? bed
            : { ...bed, sunExposure: suggestion, sunExposureSource: "auto" };
        }
        return bed.sunExposure === "unknown" && bed.sunExposureSource === "unset"
          ? bed
          : { ...bed, sunExposure: "unknown", sunExposureSource: "unset" };
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightZones, loaded]);

  // Drawing-mode starters: begin a freehand shape on the map for a new bed, new light zone, or new landscape feature.
  function startCanvasDrawForNewBed() {
    setCanvasDraw({ kind: "bed", mode: "create", targetId: null, points: [] });
  }

  // In-place shape drawing directly on the map (canvasDraw state, set here and consumed by the
  // click/drag handlers further down) — shared between drawing a bed's custom outline and a light
  // zone's outline. "create" starts a brand new bed/zone from the drawn shape once finished;
  // "edit" re-shapes an existing one, seeding the initial points from what it already has
  // (converted from its own stored feet-relative points back to absolute canvas px to draw over).
  function startCanvasDrawForBedShape(bedId) {
    const bed = beds.find((b) => b.id === bedId);
    if (!bed) return;
    const existing = (bed.customPoints || []).map((p) => ({ x: bed.x + p.x * FT_TO_PX, y: bed.y + p.y * FT_TO_PX }));
    setCanvasDraw({ kind: "bed", mode: "edit", targetId: bedId, points: existing });
  }

  function startCanvasDrawForNewZone() {
    setCanvasDraw({ kind: "zone", mode: "create", targetId: null, points: [] });
  }

  // Re-shape an existing light zone: seeds the drawing with its current outline (converted from zone-relative feet to canvas pixels).
  function startCanvasDrawForZoneShape(zoneId) {
    const zone = lightZones.find((z) => z.id === zoneId);
    if (!zone) return;
    const existing = (zone.points || []).map((p) => ({ x: zone.x + p.x * FT_TO_PX, y: zone.y + p.y * FT_TO_PX }));
    setCanvasDraw({ kind: "zone", mode: "edit", targetId: zoneId, points: existing });
  }

  function startCanvasDrawForNewFeature() {
    setCanvasDraw({ kind: "feature", mode: "create", targetId: null, points: [] });
  }

  // Re-shape an existing landscape feature: seeds the drawing with its current outline in canvas pixels.
  function startCanvasDrawForFeatureShape(featureId) {
    const feature = siteFeatures.find((f) => f.id === featureId);
    if (!feature) return;
    const existing = (feature.points || []).map((p) => ({ x: feature.x + p.x * FT_TO_PX, y: feature.y + p.y * FT_TO_PX }));
    setCanvasDraw({ kind: "feature", mode: "edit", targetId: featureId, points: existing });
  }

  // Leaves drawing mode, discarding any points placed so far.
  function cancelCanvasDraw() {
    setCanvasDraw(null);
  }

  // Removes the most recently placed point of the in-progress shape.
  function undoCanvasDrawPoint() {
    setCanvasDraw((d) => (d ? { ...d, points: d.points.slice(0, -1) } : d));
  }

  // Commits the currently-drawn shape (needs at least 3 points to form a real polygon) — creates
  // a new bed/zone or updates the existing one being reshaped, depending on canvasDraw.mode.
  // Creating a new bed this way requires a name already entered in the sidebar form first (same
  // validation as the plain rectangular addBed), since the shape alone isn't enough to save a bed.
  function finishCanvasDraw() {
    if (!canvasDraw || canvasDraw.points.length < 3) return;
    const { widthFt, lengthFt, approxSqFt, points } = normalizePoints(canvasDraw.points.map((p) => ({ x: p.x, y: p.y })), FT_TO_PX);
    const xs = canvasDraw.points.map((p) => p.x);
    const ys = canvasDraw.points.map((p) => p.y);
    const originX = Math.min(...xs);
    const originY = Math.min(...ys);

    if (canvasDraw.kind === "zone") {
      if (canvasDraw.mode === "create") {
        const newZone = { id: nextId(), sunExposure: zoneForm.sunExposure, points, widthFt, lengthFt, approxSqFt, x: originX, y: originY };
        setLightZones((prev) => [...prev, newZone]);
      } else {
        setLightZones((prev) =>
          prev.map((z) => (z.id === canvasDraw.targetId ? { ...z, points, widthFt, lengthFt, approxSqFt, x: originX, y: originY } : z))
        );
      }
    } else if (canvasDraw.kind === "feature") {
      if (canvasDraw.mode === "create") {
        if (!featureForm.name.trim()) {
          setFeatureNameError(true);
          return;
        }
        const newFeature = {
          id: nextId(),
          name: featureForm.name.trim(),
          kind: featureForm.kind,
          notes: featureForm.notes,
          points,
          widthFt,
          lengthFt,
          approxSqFt,
          x: originX,
          y: originY,
        };
        setSiteFeatures((prev) => [...prev, newFeature]);
        setFeatureForm((f) => ({ name: "", kind: f.kind, notes: "" }));
      } else {
        setSiteFeatures((prev) =>
          prev.map((f) => (f.id === canvasDraw.targetId ? { ...f, points, widthFt, lengthFt, approxSqFt, x: originX, y: originY } : f))
        );
      }
    } else {
      if (canvasDraw.mode === "create") {
        if (!bedForm.name.trim()) {
          setBedNameError(true);
          return;
        }
        let sunExposure = bedForm.sunExposure;
        let sunExposureSource = bedForm.sunExposureSource;
        if (sunExposureSource !== "manual") {
          const suggestion = suggestSunForBed({ x: originX, y: originY, widthFt, lengthFt }, lightZones, FT_TO_PX);
          sunExposure = suggestion || "unknown";
          sunExposureSource = suggestion ? "auto" : "unset";
        }
        const newBed = {
          id: nextId(),
          name: bedForm.name.trim(),
          shape: "custom_points",
          widthFt,
          lengthFt,
          approxSqFt,
          customPoints: points,
          soilType: bedForm.soilType,
          yardLocation: bedForm.yardLocation,
          bedStructure: bedForm.bedStructure,
          sunExposure,
          sunExposureSource,
          x: originX,
          y: originY,
          plants: [],
          plantBoxes: [],
        };
        setBeds((b) => [...b, newBed]);
        setBedForm((f) => ({ ...blankFormValues(), soilType: f.soilType, yardLocation: f.yardLocation, bedStructure: f.bedStructure, sunExposure: f.sunExposure, sunExposureSource: f.sunExposureSource, shape: f.shape }));
      } else {
        setBeds((prev) =>
          prev.map((b) =>
            b.id === canvasDraw.targetId ? { ...b, shape: "custom_points", widthFt, lengthFt, approxSqFt, customPoints: points, x: originX, y: originY } : b
          )
        );
      }
    }
    setCanvasDraw(null);
  }

  // Simple removal/update helpers for light zones and landscape features.
  function deleteLightZone(id) {
    setLightZones((prev) => prev.filter((z) => z.id !== id));
  }

  function deleteSiteFeature(id) {
    setSiteFeatures((prev) => prev.filter((f) => f.id !== id));
  }

  function updateSiteFeature(id, values) {
    setSiteFeatures((prev) => prev.map((f) => (f.id === id ? { ...f, ...values } : f)));
  }

  // Looks up the USDA hardiness zone for a 5-digit US ZIP code via phzmapi.org and fills the zone dropdown; sets zipStatus to show progress or an error.
  async function lookupZoneByZip() {
    const zip = zipInput.trim();
    if (!/^\d{5}$/.test(zip)) {
      setZipStatus("error");
      return;
    }
    setZipStatus("loading");
    try {
      const res = await fetch(`https://phzmapi.org/${zip}.json`);
      if (!res.ok) throw new Error("lookup failed");
      const data = await res.json();
      if (!data.zone || !USDA_ZONES[data.zone]) throw new Error("no zone in response");
      setZone(data.zone);
      setZipStatus("idle");
      setZipInput("");
    } catch (err) {
      setZipStatus("error");
    }
  }

  // Downloads the entire garden as a JSON backup file — the counterpart to handleImportFile below.
  // "version" is a simple format marker for future migrations of the export shape itself, separate
  // from the per-bed/per-plant migration that already handles older saved data.
  function exportData() {
    const payload = {
      exportedAt: new Date().toISOString(),
      app: "Homestead Bed Planner",
      version: 6,
      beds,
      plants,
      zone,
      zoneCustomText,
      lightZones,
      siteFeatures,
      yearHistory,
      journalEntries,
      backgroundImages,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const dateStr = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = url;
    a.download = `garden-planner-backup-${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Opens the hidden file-picker input for importing a backup.
  function triggerImport() {
    setImportError("");
    if (importInputRef.current) importInputRef.current.click();
  }

  // Reads a backup JSON file and replaces the entire current garden with it, after a confirmation
  // (since this is destructive) — runs every bed/plant through the same migration functions used
  // on a normal load, so an old backup from before a given feature existed still loads correctly.
  function handleImportFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.beds) || !Array.isArray(data.plants)) {
          setImportError("That file doesn't look like a garden planner backup.");
          return;
        }
        const proceed = window.confirm(
          `This will replace everything currently on your map with the backup from ${data.exportedAt ? new Date(data.exportedAt).toLocaleString() : "this file"}. Continue?`
        );
        if (!proceed) return;
        setBeds(data.beds.map(migrateBed));
        setPlants(data.plants.map(migratePlant));
        setZone(data.zone || "unset");
        setZoneCustomText(data.zoneCustomText || "");
        setLightZones(Array.isArray(data.lightZones) ? data.lightZones : []);
        setSiteFeatures(Array.isArray(data.siteFeatures) ? data.siteFeatures : []);
        setYearHistory(Array.isArray(data.yearHistory) ? data.yearHistory : []);
        setJournalEntries(Array.isArray(data.journalEntries) ? data.journalEntries : []);
        setBackgroundImages(migrateBackgroundImages(data));
        setImportError("");
      } catch (err) {
        setImportError("Couldn't read that file — it may not be a valid backup.");
      }
    };
    reader.readAsText(file);
  }

  // A full reset of everything the app persists — for clearing out old test/example data rather
  // than hunting down individual beds and plants one at a time. Goes through the normal setState
  // calls (not a raw storage wipe), so like any other change it's still covered by undo if this
  // gets clicked by accident.
  function clearAllData() {
    const proceed = window.confirm(
      "Clear everything — every bed, plant, zone, saved year, journal entry, and background image? This can be undone with Ctrl+Z right after, but not once you've made further changes."
    );
    if (!proceed) return;
    setBeds([]);
    setPlants([]);
    setZone("unset");
    setZoneCustomText("");
    setLightZones([]);
    setSiteFeatures([]);
    setYearHistory([]);
    setJournalEntries([]);
    setBackgroundImages([]);
  }

  // Reads an uploaded satellite/aerial photo, downscaling it first if it's larger than MAX_DIM
  // (keeps localStorage usage and rendering cost reasonable without visibly hurting trace
  // precision), then hands it off to the calibration flow rather than adding it to the map yet —
  // an image needs a scale (see finishCalibration) before it means anything as a tracing aid.
  function handleImageFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new window.Image();
      img.onload = () => {
        const MAX_DIM = 2200; // large enough to zoom in for precise tracing without going grainy; the quota-exceeded fallback covers the storage-size tradeoff
        let { naturalWidth: w, naturalHeight: h } = img;
        let dataUrl = reader.result;
        if (w > MAX_DIM || h > MAX_DIM) {
          const scale = Math.min(MAX_DIM / w, MAX_DIM / h);
          const targetW = Math.round(w * scale);
          const targetH = Math.round(h * scale);
          const canvas = document.createElement("canvas");
          canvas.width = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, targetW, targetH);
          dataUrl = canvas.toDataURL("image/jpeg", 0.85);
          w = targetW;
          h = targetH;
        }
        setCalibrationSession({ dataUrl, naturalWidth: w, naturalHeight: h, points: [], referenceFt: "", existingImageId: null });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  // Converts the two calibration points' pixel distance and the user's real-world reference
  // distance into a feet-per-pixel scale for the image, then adds it to the map (or, if
  // recalibrating an already-placed image, updates just its scale/data in place).
  function finishCalibration(referenceFt, points, dataUrl, naturalWidth, naturalHeight) {
    const [p1, p2] = points;
    const pixelDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (pixelDist <= 0 || !referenceFt || Number(referenceFt) <= 0) return;
    const ftPerNativePx = Number(referenceFt) / pixelDist;
    const widthPx = naturalWidth * ftPerNativePx * FT_TO_PX;
    const heightPx = naturalHeight * ftPerNativePx * FT_TO_PX;
    const existingImageId = calibrationSession && calibrationSession.existingImageId;
    if (existingImageId) {
      // Recalibrating an existing image keeps its position/opacity/lock — only the scale changes.
      setBackgroundImages((prev) =>
        prev.map((img) => (img.id === existingImageId ? { ...img, dataUrl, widthPx, heightPx, naturalWidth, naturalHeight } : img))
      );
    } else {
      setBackgroundImages((prev) => [
        ...prev,
        { id: nextId(), dataUrl, x: 24, y: 24, widthPx, heightPx, naturalWidth, naturalHeight, opacity: 0.85, locked: false },
      ]);
    }
    setCalibrationSession(null);
  }

  // Removes one background (satellite/aerial) image.
  function deleteBackgroundImage(id) {
    setBackgroundImages((prev) => prev.filter((img) => img.id !== id));
  }

  // Journal helpers: add a new entry (stamped with an id and creation time) or delete one by id.
  function addJournalEntry(entry) {
    setJournalEntries((prev) => [...prev, { id: nextId(), createdAt: new Date().toISOString(), ...entry }]);
  }

  function deleteJournalEntry(id) {
    setJournalEntries((prev) => prev.filter((e) => e.id !== id));
  }

  // The actual "start a new year" action behind YearRolloverModal: deep-clones the entire current
  // garden into a frozen yearHistory snapshot (JSON round-trip specifically to sever any shared
  // object references — later edits to the live garden must never leak into an archived year),
  // then strips every plant NOT in keptPlantIds from the live garden, leaving just what's kept.
  function archiveYearAndReset(yearLabel, keptPlantIds) {
    const snapshot = {
      id: nextId(),
      year: yearLabel.trim() || String(new Date().getFullYear()),
      archivedAt: new Date().toISOString(),
      zone,
      zoneCustomText,
      yearNotes: "",
      beds: JSON.parse(JSON.stringify(beds)),
      plants: JSON.parse(JSON.stringify(plants)),
    };
    setYearHistory((prev) => [...prev, snapshot]);
    setBeds((prev) => prev.map((bed) => ({ ...bed, plants: bed.plants.filter((p) => keptPlantIds.has(p.id)) })));
    setPlants((prev) => prev.filter((p) => keptPlantIds.has(p.id)));
    setShowYearRollover(false);
  }

  // Deletes one archived year from the history.
  function deleteYearHistoryEntry(id) {
    setYearHistory((prev) => prev.filter((h) => h.id !== id));
  }

  // Removes just this one bed's records from every archived year, leaving other beds in those
  // years untouched — for correcting a bad bed name/entry without losing the rest of that year's data.
  function clearBedHistory(bedName) {
    setYearHistory((prev) =>
      prev.map((entry) => ({
        ...entry,
        beds: entry.beds.filter((b) => b.name.trim().toLowerCase() !== bedName.trim().toLowerCase()),
      }))
    );
  }

  // Corrects an archive's year label (see HistoryYearLabel) — an empty label is ignored rather than
  // blanking out the entry's year.
  function updateYearLabel(entryId, text) {
    if (!text.trim()) return;
    setYearHistory((prev) => prev.map((entry) => (entry.id === entryId ? { ...entry, year: text.trim() } : entry)));
  }

  // Saves the free-text notes written for an archived year.
  function updateYearNotes(entryId, text) {
    setYearHistory((prev) => prev.map((entry) => (entry.id === entryId ? { ...entry, yearNotes: text } : entry)));
  }

  // bedId is null for a freestanding plant in that year's snapshot.
  function updateHistoryPlantNote(entryId, bedId, plantId, text) {
    setYearHistory((prev) =>
      prev.map((entry) => {
        if (entry.id !== entryId) return entry;
        if (bedId) {
          return {
            ...entry,
            beds: entry.beds.map((b) =>
              b.id === bedId ? { ...b, plants: b.plants.map((p) => (p.id === plantId ? { ...p, historyNote: text } : p)) } : b
            ),
          };
        }
        return { ...entry, plants: entry.plants.map((p) => (p.id === plantId ? { ...p, historyNote: text } : p)) };
      })
    );
  }

  // Copies a bed (and its plants and plant boxes, with fresh ids) and places the copy beside the original.
  function duplicateBed(bedId) {
    setBeds((prev) => {
      const bed = prev.find((b) => b.id === bedId);
      if (!bed) return prev;
      // Regenerate box ids too, remapping each plant's boxId reference to match — otherwise a
      // duplicated bed's plants would still point at the original bed's box ids, which don't
      // exist in the copy's own plantBoxes list.
      const boxIdMap = {};
      const newBoxes = (bed.plantBoxes || []).map((box) => {
        const newId = nextId();
        boxIdMap[box.id] = newId;
        return { ...box, id: newId };
      });
      const copy = {
        ...bed,
        id: nextId(),
        name: `${bed.name} (copy)`,
        x: bed.x + 26,
        y: bed.y + 26,
        plants: bed.plants.map((p) => ({ ...p, id: nextId(), boxId: p.boxId ? boxIdMap[p.boxId] : p.boxId })),
        plantBoxes: newBoxes,
      };
      return [...prev, copy];
    });
  }

  // Adds a plant directly to the open map (not inside any bed) from the sidebar's freestanding-
  // plant form — staggered in a simple grid (5 per row) so repeated adds don't stack on each
  // other. Uses its own inline shape rather than blankPlant below, since a freestanding plant's
  // x/y are absolute canvas px (not feet relative to a bed) and it has no spacing/box concept.
  function addFreestandingPlant(e) {
    e.preventDefault();
    if (!plantName.trim()) return;
    const n = plants.length;
    setPlants((p) => [
      ...p,
      {
        id: nextId(),
        name: plantName.trim(),
        x: 40 + (n % 5) * 20,
        y: 400 + Math.floor(n / 5) * 20,
        light: "unknown",
        water: "unknown",
        temp: "unknown",
        cultivar: "",
        plantingStartIndoors: "",
        plantingOutside: "",
        harvestWindow: "",
        companionNotes: "",
        companionWarningsDismissed: false,
        rotationWarningsDismissed: false,
      },
    ]);
    setPlantName("");
  }

  // Shared shape for a freshly-added plant, used by both the single "+ plant name" add and the
  // "fill bed at spacing" batch-add below, so a batch-added plant behaves identically everywhere
  // else in the app (companion checks, rotation checks, the calendar) as a manually-added one.
  // spacingIn is stored on the plant itself (not re-derived at render time) so its dot size stays
  // consistent with whatever spacing was actually used to place it — including a manually
  // overridden spacing from the fill tool, not just the plant's generic "recommended" default.
  // boxId, when set, binds this plant to a plant-spacing box (see fillBedAtSpacing) — it moves as
  // part of that group until deliberately pulled out.
  function blankPlant(name, x, y, locked = false, spacingIn = DEFAULT_SPACING_IN, boxId = null) {
    return {
      id: nextId(),
      name,
      x,
      y,
      locked,
      spacingIn,
      boxId,
      light: "unknown",
      water: "unknown",
      temp: "unknown",
      cultivar: "",
      plantingStartIndoors: "",
      plantingOutside: "",
      harvestWindow: "",
      companionNotes: "",
      companionWarningsDismissed: false,
      rotationWarningsDismissed: false,
    };
  }

  // Adds a plant (named in the bed's text field) at the first free spot in the bed, flagging the bed if it is full.
  function addPlantToBed(bedId) {
    const name = (bedPlantInputs[bedId] || "").trim();
    if (!name) return;
    const targetBed = beds.find((b) => b.id === bedId);
    if (!targetBed) return;
    // Computed here, not inside the state updater — updaters must stay pure, and this also needs to
    // report back whether the bed had any room left (setCrowdedBedNotice is a side effect).
    const { x, y, crowded } = findFreePositionInBed(targetBed);
    const spacingIn = getRecommendedSpacingIn(name) || DEFAULT_SPACING_IN;
    setBeds((prev) => prev.map((bed) => (bed.id !== bedId ? bed : { ...bed, plants: [...bed.plants, blankPlant(name, x, y, false, spacingIn)] })));
    setCrowdedBedNotice(crowded ? bedId : null);
    setBedPlantInputs((prev) => ({ ...prev, [bedId]: "" }));
  }

  // positions: array of {x, y} in feet, relative to the bed's own origin — one entry per plant to
  // add, typically the exact grid positions already shown as preview dots in the fill-spacing tool,
  // so a confirmed fill places plants exactly where the user saw them, not just an unpositioned count.
  // spacingIn: the actual spacing used for this fill (may be a manual override, not necessarily the
  // plant's generic recommended value) — stored on each created plant so its dot renders at the same
  // size the live preview showed, not a fixed generic size.
  // boxRect: {x, y, widthFt, heightFt} of the fill area (feet, relative to the bed's own origin) —
  // creates a persistent plant box that the new plants are bound to, draggable as a group until a
  // plant is deliberately pulled out (see startBedPlantDrag's auto-detach and the "release from
  // group" action).
  // replacingPlantId: when set (dragging an existing plant's own handle to expand it), that one
  // plant is removed and replaced by the new ones, rather than just adding alongside it. If that
  // plant already belonged to a box, the old box is removed too (its plants, if any others remain,
  // keep their boxId — only removed when this was the box's last plant).
  function fillBedAtSpacing(bedId, name, positions, spacingIn, boxRect, replacingPlantId) {
    const trimmed = name.trim();
    if (!trimmed || !positions || positions.length === 0) return;
    setBeds((prev) =>
      prev.map((bed) => {
        if (bed.id !== bedId) return bed;
        const replacedPlant = replacingPlantId ? bed.plants.find((p) => p.id === replacingPlantId) : null;
        const basePlants = replacingPlantId ? bed.plants.filter((p) => p.id !== replacingPlantId) : bed.plants;
        const oldBoxStillUsed = replacedPlant && replacedPlant.boxId ? basePlants.some((p) => p.boxId === replacedPlant.boxId) : true;
        const boxesAfterRemoval =
          replacedPlant && replacedPlant.boxId && !oldBoxStillUsed
            ? (bed.plantBoxes || []).filter((b) => b.id !== replacedPlant.boxId)
            : bed.plantBoxes || [];
        const newBox = { id: nextId(), plantName: trimmed, spacingIn, x: boxRect.x, y: boxRect.y, widthFt: boxRect.widthFt, heightFt: boxRect.heightFt };
        return {
          ...bed,
          plants: [...basePlants, ...positions.map(({ x, y }) => blankPlant(trimmed, x, y, true, spacingIn, newBox.id))],
          plantBoxes: [...boxesAfterRemoval, newBox],
        };
      })
    );
  }

  // Merges two overlapping plant-spacing boxes into a linked pair: both grow to cover their
  // combined (union) area and get their members regenerated together via the interplanting
  // algorithm (see computeInterplantedLayout), then stay linked going forward — resizing or
  // moving either box later keeps both in sync (see startPlantBoxDrag / startPlacedBoxResize /
  // regenerateLinkedOrSoloBox).
  function mergeBoxes(bedId, boxIdA, boxIdB) {
    setBeds((prev) =>
      prev.map((bed) => {
        if (bed.id !== bedId) return bed;
        const boxA = (bed.plantBoxes || []).find((b) => b.id === boxIdA);
        const boxB = (bed.plantBoxes || []).find((b) => b.id === boxIdB);
        if (!boxA || !boxB) return bed;
        const x = Math.min(boxA.x, boxB.x);
        const y = Math.min(boxA.y, boxB.y);
        const widthFt = Math.max(boxA.x + boxA.widthFt, boxB.x + boxB.widthFt) - x;
        const heightFt = Math.max(boxA.y + boxA.heightFt, boxB.y + boxB.heightFt) - y;
        const mergedRect = { x, y, widthFt, heightFt };

        const aIsPrimary = boxA.spacingIn >= boxB.spacingIn;
        const primaryBox = aIsPrimary ? boxA : boxB;
        const companionBox = aIsPrimary ? boxB : boxA;
        const { primaryPositions, companionPositions } = computeInterplantedLayout(
          bed,
          mergedRect,
          primaryBox.spacingIn / 12,
          companionBox.spacingIn / 12
        );
        const untouchedPlants = bed.plants.filter((p) => p.boxId !== boxIdA && p.boxId !== boxIdB);
        const primaryMembers = primaryPositions.map(({ x, y }) => blankPlant(primaryBox.plantName, x, y, true, primaryBox.spacingIn, primaryBox.id));
        const companionMembers = companionPositions.map(({ x, y }) => blankPlant(companionBox.plantName, x, y, true, companionBox.spacingIn, companionBox.id));

        return {
          ...bed,
          plantBoxes: (bed.plantBoxes || []).map((bx) =>
            bx.id === boxIdA || bx.id === boxIdB ? { ...bx, ...mergedRect, linkedBoxId: bx.id === boxIdA ? boxIdB : boxIdA } : bx
          ),
          plants: [...untouchedPlants, ...primaryMembers, ...companionMembers],
        };
      })
    );
  }

  // Breaks the link between two merged boxes — they stay exactly where they currently are (same
  // combined size/position, same plants), just stop moving and resizing together going forward.
  function unmergeBoxes(bedId, boxId) {
    setBeds((prev) =>
      prev.map((bed) => {
        if (bed.id !== bedId) return bed;
        const box = (bed.plantBoxes || []).find((b) => b.id === boxId);
        const linkedBoxId = box && box.linkedBoxId;
        if (!linkedBoxId) return bed;
        return {
          ...bed,
          plantBoxes: (bed.plantBoxes || []).map((bx) => (bx.id === boxId || bx.id === linkedBoxId ? { ...bx, linkedBoxId: null } : bx)),
        };
      })
    );
  }

  // Interactive "drag a box to see how many plants fit" tool. Box position/size are stored in feet,
  // relative to the bed's OWN origin (0,0 = the bed's top-left corner) — this keeps the math simple
  // and keeps the box correctly attached to the bed even if the bed itself gets moved elsewhere.
  // Drags a single plant to a new position within its own bed — coordinates are feet, relative to
  // the bed's own origin (not the canvas), clamped so a plant can't be dragged outside its bed.
  // Also opens the plant's details modal on a genuine click (negligible movement) — can't rely on
  // a native onClick for this, since the dot follows the cursor during a real drag too, so a plain
  // onClick would fire after every drag, not just an actual click.
  const startBedPlantDrag = (bedId, plantId, e) => {
    const bed = beds.find((b) => b.id === bedId);
    const plant = bed && bed.plants.find((p) => p.id === plantId);
    if (!bed || !plant) return;
    // If this plant belongs to a box, dragging it outside that box's bounds deliberately detaches
    // it from the group — from then on it moves independently. A plant with no box (plant.boxId
    // falsy, or the box no longer exists) is unaffected — nothing to detach from.
    const box = plant.boxId ? (bed.plantBoxes || []).find((b) => b.id === plant.boxId) : null;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    let maxMovementPx = 0;
    startDragSession(
      e,
      { startClientX: clientX, startClientY: clientY, startX: plant.x || 0, startY: plant.y || 0, bedWidthFt: bed.widthFt, bedLengthFt: bed.lengthFt },
      (state, moveClientX, moveClientY) => {
        maxMovementPx = Math.max(maxMovementPx, Math.hypot(moveClientX - state.startClientX, moveClientY - state.startClientY));
        const deltaXFt = (moveClientX - state.startClientX) / zoom / FT_TO_PX;
        const deltaYFt = (moveClientY - state.startClientY) / zoom / FT_TO_PX;
        const x = Math.max(0, Math.min(state.bedWidthFt, state.startX + deltaXFt));
        const y = Math.max(0, Math.min(state.bedLengthFt, state.startY + deltaYFt));
        const stillInsideBox = !box || (x >= box.x && x <= box.x + box.widthFt && y >= box.y && y <= box.y + box.heightFt);
        setBeds((prev) =>
          prev.map((b) =>
            b.id !== bedId
              ? b
              : { ...b, plants: b.plants.map((p) => (p.id === plantId ? { ...p, x, y, boxId: stillInsideBox ? p.boxId : null } : p)) }
          )
        );
      },
      () => {
        const CLICK_THRESHOLD_PX = 4;
        if (maxMovementPx < CLICK_THRESHOLD_PX) setEditingPlant({ scope: "bed", bedId, plantId });
      }
    );
  };

  // Recomputes a box's member plants for a new rectangle — and, if the box is linked to a
  // companion box (from a merge), keeps both at the exact same rectangle and regenerates both
  // sets of members together via the interplanting algorithm, so resizing either half of a merged
  // pair keeps proper spacing between both plant types, not just within each one on its own.
  function regenerateLinkedOrSoloBox(bed, boxId, newRect) {
    const box = (bed.plantBoxes || []).find((b) => b.id === boxId);
    if (!box) return { plantBoxes: bed.plantBoxes, plants: bed.plants };
    const linkedBox = box.linkedBoxId ? (bed.plantBoxes || []).find((b) => b.id === box.linkedBoxId) : null;

    if (!linkedBox) {
      const spacingFt = box.spacingIn / 12;
      const newPositions = computeGridPositions(bed, newRect, spacingFt);
      const otherPlants = bed.plants.filter((p) => p.boxId !== boxId);
      const newMembers = newPositions.map(({ x, y }) => blankPlant(box.plantName, x, y, true, box.spacingIn, boxId));
      return {
        plantBoxes: (bed.plantBoxes || []).map((bx) => (bx.id === boxId ? { ...bx, ...newRect } : bx)),
        plants: [...otherPlants, ...newMembers],
      };
    }

    // Linked pair: larger spacing is the "primary" plant, keeping a fully normal grid; the
    // smaller-spacing "companion" fills the gaps around it (see computeInterplantedLayout).
    const boxIsPrimary = box.spacingIn >= linkedBox.spacingIn;
    const primaryBox = boxIsPrimary ? box : linkedBox;
    const companionBox = boxIsPrimary ? linkedBox : box;
    const { primaryPositions, companionPositions } = computeInterplantedLayout(
      bed,
      newRect,
      primaryBox.spacingIn / 12,
      companionBox.spacingIn / 12
    );
    const untouchedPlants = bed.plants.filter((p) => p.boxId !== box.id && p.boxId !== linkedBox.id);
    const primaryMembers = primaryPositions.map(({ x, y }) => blankPlant(primaryBox.plantName, x, y, true, primaryBox.spacingIn, primaryBox.id));
    const companionMembers = companionPositions.map(({ x, y }) => blankPlant(companionBox.plantName, x, y, true, companionBox.spacingIn, companionBox.id));
    return {
      plantBoxes: (bed.plantBoxes || []).map((bx) => (bx.id === box.id || bx.id === linkedBox.id ? { ...bx, ...newRect } : bx)),
      plants: [...untouchedPlants, ...primaryMembers, ...companionMembers],
    };
  }

  // Drags an entire plant-spacing box as one unit, taking every plant bound to it along for the
  // ride (each keeps its exact position relative to the box). Uses each plant's own captured
  // starting position + the same clamped delta, rather than accumulating per-move, to avoid drift.
  const startPlantBoxDrag = (bedId, boxId, e) => {
    const bed = beds.find((b) => b.id === bedId);
    const box = bed && (bed.plantBoxes || []).find((b) => b.id === boxId);
    if (!bed || !box) return;
    // If this box is linked (merged with a companion box), its partner moves along with it —
    // they always share the same rectangle, so dragging one without the other would break that.
    const linkedBoxId = box.linkedBoxId || null;
    const memberStartPositions = bed.plants
      .filter((p) => p.boxId === boxId || (linkedBoxId && p.boxId === linkedBoxId))
      .map((p) => ({ id: p.id, x: p.x || 0, y: p.y || 0 }));
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    startDragSession(
      e,
      {
        startClientX: clientX,
        startClientY: clientY,
        startBoxX: box.x,
        startBoxY: box.y,
        bedWidthFt: bed.widthFt,
        bedLengthFt: bed.lengthFt,
        boxWidthFt: box.widthFt,
        boxHeightFt: box.heightFt,
        memberStartPositions,
      },
      (state, moveClientX, moveClientY) => {
        const deltaXFt = (moveClientX - state.startClientX) / zoom / FT_TO_PX;
        const deltaYFt = (moveClientY - state.startClientY) / zoom / FT_TO_PX;
        const maxX = Math.max(0, state.bedWidthFt - state.boxWidthFt);
        const maxY = Math.max(0, state.bedLengthFt - state.boxHeightFt);
        const newBoxX = Math.max(0, Math.min(maxX, state.startBoxX + deltaXFt));
        const newBoxY = Math.max(0, Math.min(maxY, state.startBoxY + deltaYFt));
        const clampedDeltaX = newBoxX - state.startBoxX;
        const clampedDeltaY = newBoxY - state.startBoxY;
        const memberMap = new Map(state.memberStartPositions.map((m) => [m.id, m]));
        setBeds((prev) =>
          prev.map((b) =>
            b.id !== bedId
              ? b
              : {
                  ...b,
                  plantBoxes: (b.plantBoxes || []).map((bx) =>
                    bx.id === boxId || bx.id === linkedBoxId ? { ...bx, x: newBoxX, y: newBoxY } : bx
                  ),
                  plants: b.plants.map((p) => {
                    const start = memberMap.get(p.id);
                    return start ? { ...p, x: start.x + clampedDeltaX, y: start.y + clampedDeltaY } : p;
                  }),
                }
          )
        );
      },
      null
    );
  };

  // Resizes an already-placed plant box — anchored at its own top-left corner, clamped so it can't
  // shrink below one spacing unit or grow outside the bed. The box's member plants are regenerated
  // to match the new grid on every move (using the same shared grid math as the live fill-tool
  // preview), so the count updates live as you drag, the same way it did before confirming the
  // original fill. Trade-off worth knowing: since members are regenerated wholesale, any details
  // customized on an individual member (light/water/cultivar, etc.) reset on resize — the box's
  // purpose is a uniform group of one plant type, so this keeps the mechanism simple rather than
  // building more complex position-matching to preserve edits that shouldn't typically exist here.
  const startPlacedBoxResize = (bedId, boxId, e) => {
    const bed = beds.find((b) => b.id === bedId);
    const box = bed && (bed.plantBoxes || []).find((b) => b.id === boxId);
    if (!bed || !box) return;
    const spacingFt = box.spacingIn / 12;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    startDragSession(
      e,
      {
        startClientX: clientX,
        startClientY: clientY,
        startWidthFt: box.widthFt,
        startHeightFt: box.heightFt,
        boxX: box.x,
        boxY: box.y,
        bedWidthFt: bed.widthFt,
        bedLengthFt: bed.lengthFt,
      },
      (state, moveClientX, moveClientY) => {
        const deltaXFt = (moveClientX - state.startClientX) / zoom / FT_TO_PX;
        const deltaYFt = (moveClientY - state.startClientY) / zoom / FT_TO_PX;
        const maxWidthFt = state.bedWidthFt - state.boxX;
        const maxHeightFt = state.bedLengthFt - state.boxY;
        const newWidthFt = Math.min(maxWidthFt, Math.max(spacingFt, state.startWidthFt + deltaXFt));
        const newHeightFt = Math.min(maxHeightFt, Math.max(spacingFt, state.startHeightFt + deltaYFt));
        setBeds((prev) =>
          prev.map((b) => {
            if (b.id !== bedId) return b;
            const { plantBoxes, plants } = regenerateLinkedOrSoloBox(b, boxId, { x: state.boxX, y: state.boxY, widthFt: newWidthFt, heightFt: newHeightFt });
            return { ...b, plantBoxes, plants };
          })
        );
      },
      null
    );
  };

  // Lets an ALREADY-PLACED plant's own handle directly expand it into a filled area — same
  // fill-spacing tool as the sidebar version, just started from the plant's current position
  // instead of from a blank spot, and set to REPLACE that one plant on confirm rather than add
  // alongside it. The mousedown that grabs the handle immediately starts resizing the box too, so
  // it's a single continuous drag gesture rather than "activate, then find a separate handle."
  const startPlantChipFillDrag = (bedId, plantId, e) => {
    const bed = beds.find((b) => b.id === bedId);
    const plant = bed && bed.plants.find((p) => p.id === plantId);
    if (!bed || !plant) return;
    const recommendedSpacingIn = getRecommendedSpacingIn(plant.name) || 12; // sensible fallback for a plant with no spacing on file — adjustable afterward via the tool's own spacing marker
    const startSizeFt = Math.min(recommendedSpacingIn / 12, bed.widthFt, bed.lengthFt);
    const initialBoxX = plant.x || 0;
    const initialBoxY = plant.y || 0;
    setPlantFillTool({
      bedId,
      plantName: plant.name,
      spacingIn: recommendedSpacingIn,
      boxX: initialBoxX,
      boxY: initialBoxY,
      boxWidthFt: startSizeFt,
      boxHeightFt: startSizeFt,
      replacingPlantId: plantId,
    });

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    startDragSession(
      e,
      { startClientX: clientX, startClientY: clientY, startWidthFt: startSizeFt, startHeightFt: startSizeFt, boxX: initialBoxX, boxY: initialBoxY, bedWidthFt: bed.widthFt, bedLengthFt: bed.lengthFt },
      (state, moveClientX, moveClientY) => {
        setPlantFillTool((prev) => {
          if (!prev) return prev;
          const deltaXFt = (moveClientX - state.startClientX) / zoom / FT_TO_PX;
          const deltaYFt = (moveClientY - state.startClientY) / zoom / FT_TO_PX;
          const maxWidthFt = state.bedWidthFt - state.boxX;
          const maxHeightFt = state.bedLengthFt - state.boxY;
          return {
            ...prev,
            boxWidthFt: Math.min(maxWidthFt, Math.max(startSizeFt, state.startWidthFt + deltaXFt)),
            boxHeightFt: Math.min(maxHeightFt, Math.max(startSizeFt, state.startHeightFt + deltaYFt)),
          };
        });
      },
      null,
      { stopPropagation: true }
    );
  };

  // Moving/resizing the LIVE fill-tool's own temporary box (plantFillTool state) while a fill is
  // still being set up, before it's confirmed into an actual bed and plants — not to be confused
  // with startPlacedBoxDrag/startPlacedBoxResize further down, which do the equivalent for an
  // already-placed, persistent plant-spacing box.
  const startPlantBoxMove = (e) => {
    if (!plantFillTool) return;
    const bed = beds.find((b) => b.id === plantFillTool.bedId);
    if (!bed) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    startDragSession(e, { startClientX: clientX, startClientY: clientY, startBoxX: plantFillTool.boxX, startBoxY: plantFillTool.boxY, bedWidthFt: bed.widthFt, bedLengthFt: bed.lengthFt }, (state, moveClientX, moveClientY) => {
      setPlantFillTool((prev) => {
        if (!prev) return prev;
        const deltaXFt = (moveClientX - state.startClientX) / zoom / FT_TO_PX;
        const deltaYFt = (moveClientY - state.startClientY) / zoom / FT_TO_PX;
        const maxX = Math.max(0, state.bedWidthFt - prev.boxWidthFt);
        const maxY = Math.max(0, state.bedLengthFt - prev.boxHeightFt);
        return { ...prev, boxX: Math.min(maxX, Math.max(0, state.startBoxX + deltaXFt)), boxY: Math.min(maxY, Math.max(0, state.startBoxY + deltaYFt)) };
      });
    }, null);
  };

  // Starts resizing the in-progress fill-tool box by its corner handle, keeping it within the bed and snapped to whole plant cells.
  const startPlantBoxResize = (e) => {
    if (!plantFillTool) return;
    const bed = beds.find((b) => b.id === plantFillTool.bedId);
    if (!bed) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const spacingFt = plantFillTool.spacingIn / 12;
    startDragSession(
      e,
      { startClientX: clientX, startClientY: clientY, startWidthFt: plantFillTool.boxWidthFt, startHeightFt: plantFillTool.boxHeightFt, boxX: plantFillTool.boxX, boxY: plantFillTool.boxY, bedWidthFt: bed.widthFt, bedLengthFt: bed.lengthFt },
      (state, moveClientX, moveClientY) => {
        setPlantFillTool((prev) => {
          if (!prev) return prev;
          const deltaXFt = (moveClientX - state.startClientX) / zoom / FT_TO_PX;
          const deltaYFt = (moveClientY - state.startClientY) / zoom / FT_TO_PX;
          const maxWidthFt = state.bedWidthFt - state.boxX;
          const maxHeightFt = state.bedLengthFt - state.boxY;
          return {
            ...prev,
            boxWidthFt: Math.min(maxWidthFt, Math.max(spacingFt, state.startWidthFt + deltaXFt)),
            boxHeightFt: Math.min(maxHeightFt, Math.max(spacingFt, state.startHeightFt + deltaYFt)),
          };
        });
      },
      null,
      { stopPropagation: true }
    );
  };

  // Separate from the box's own resize above: this adjusts the SPACING itself (how much room one
  // plant needs), not the fill area. Dragging it recalculates the grid against the box's current,
  // unchanged dimensions — the two handles control genuinely different things.
  const startPlantUnitResize = (e) => {
    if (!plantFillTool) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    startDragSession(
      e,
      { startClientX: clientX, startClientY: clientY, startSpacingIn: plantFillTool.spacingIn, boxWidthFt: plantFillTool.boxWidthFt, boxHeightFt: plantFillTool.boxHeightFt },
      (state, moveClientX, moveClientY) => {
        setPlantFillTool((prev) => {
          if (!prev) return prev;
          // Uniform in both directions (spacing is a single number, not separate width/height) —
          // use whichever axis was dragged further, so the interaction feels natural regardless of
          // which direction the user happens to drag in.
          const deltaXIn = ((moveClientX - state.startClientX) / zoom / FT_TO_PX) * 12;
          const deltaYIn = ((moveClientY - state.startClientY) / zoom / FT_TO_PX) * 12;
          const deltaIn = Math.abs(deltaXIn) > Math.abs(deltaYIn) ? deltaXIn : deltaYIn;
          const maxSpacingIn = Math.min(state.boxWidthFt, state.boxHeightFt) * 12;
          const MIN_SPACING_IN = 1;
          return { ...prev, spacingIn: Math.min(maxSpacingIn, Math.max(MIN_SPACING_IN, state.startSpacingIn + deltaIn)) };
        });
      },
      null,
      { stopPropagation: true }
    );
  };

  // Saves PlantDetailsModal's edited fields (light/water/temp, cultivar, planting dates, lock
  // state) back onto the plant — target.scope distinguishes a bed-plant from a freestanding one,
  // since they live in different state (beds vs. plants).
  function savePlantDetails(target, details) {
    if (target.scope === "bed") {
      setBeds((prev) =>
        prev.map((bed) =>
          bed.id === target.bedId
            ? { ...bed, plants: bed.plants.map((p) => (p.id === target.plantId ? { ...p, ...details } : p)) }
            : bed
        )
      );
    } else {
      setPlants((prev) => prev.map((p) => (p.id === target.plantId ? { ...p, ...details } : p)));
    }
    setEditingPlant(null);
  }

  // Explicit, button-based way to detach a plant from its box (alongside dragging it past the
  // box's own edge) — the plant stays exactly where it is, just no longer moves with the group.
  function releasePlantFromGroup(bedId, plantId) {
    setBeds((prev) =>
      prev.map((bed) => (bed.id !== bedId ? bed : { ...bed, plants: bed.plants.map((p) => (p.id === plantId ? { ...p, boxId: null } : p)) }))
    );
  }

  // Moves a plant out of its bed onto the open map, just below the bed, keeping all of its settings.
  function ejectPlantFromBed(bedId, plantId) {
    const bed = beds.find((b) => b.id === bedId);
    const ejected = bed && bed.plants.find((p) => p.id === plantId);
    if (!bed || !ejected) return;
    // Land just below the bed's own bounding box, not inside it — a position inside the bed's own
    // area would render directly underneath the bed's opaque shape, effectively invisible even
    // though the plant is genuinely still there in the data.
    const x = bed.x;
    const y = bed.y + bed.lengthFt * FT_TO_PX + 20;
    // Carry over everything the plant had — its light/water/temp settings, cultivar, planting
    // dates, companion notes — not just its name, so moving it out of a bed doesn't quietly erase
    // details already set on it. locked/bed-relative-position/boxId fields don't apply once it's
    // freestanding, so those are dropped rather than carried over.
    const { x: _bx, y: _by, locked: _l, boxId: _boxId, ...rest } = ejected;
    setBeds((prev) =>
      prev.map((b) => {
        if (b.id !== bedId) return b;
        const remainingPlants = b.plants.filter((p) => p.id !== plantId);
        // If this was the last plant in its box, the now-empty box is removed too rather than
        // left behind as an invisible, memberless rectangle.
        const boxStillUsed = ejected.boxId ? remainingPlants.some((p) => p.boxId === ejected.boxId) : true;
        const plantBoxes = ejected.boxId && !boxStillUsed ? (b.plantBoxes || []).filter((box) => box.id !== ejected.boxId) : b.plantBoxes;
        return { ...b, plants: remainingPlants, plantBoxes };
      })
    );
    setPlants((pl) => [...pl, { ...rest, x, y }]);
  }

  // Deletes one plant from a bed, and removes its plant box too if that was the box's last plant.
  function deletePlantFromBed(bedId, plantId) {
    setBeds((prev) =>
      prev.map((bed) => {
        if (bed.id !== bedId) return bed;
        const deleted = bed.plants.find((p) => p.id === plantId);
        const remainingPlants = bed.plants.filter((p) => p.id !== plantId);
        const boxStillUsed = deleted && deleted.boxId ? remainingPlants.some((p) => p.boxId === deleted.boxId) : true;
        const plantBoxes =
          deleted && deleted.boxId && !boxStillUsed ? (bed.plantBoxes || []).filter((box) => box.id !== deleted.boxId) : bed.plantBoxes;
        return { ...bed, plants: remainingPlants, plantBoxes };
      })
    );
  }

  // Turns selection mode on for a bed (clicking a plant dot then toggles selection instead of
  // opening its details) or off — switching to a different bed's selection mode, or turning it off
  // entirely, always clears the current selection, since a selection only makes sense within one
  // bed at a time.
  function toggleSelectionMode(bedId) {
    setSelectionModeBedId((current) => (current === bedId ? null : bedId));
    setSelectedPlantIds(new Set());
  }

  // Toggles one plant in/out of the current selection (click-to-select, as opposed to the
  // marquee-drag selectPlantsInRect below) — adds or removes it from the Set independently of
  // whatever else is currently selected.
  function togglePlantSelection(plantId) {
    setSelectedPlantIds((prev) => {
      const next = new Set(prev);
      if (next.has(plantId)) next.delete(plantId);
      else next.add(plantId);
      return next;
    });
  }

  // Selects every plant in a bed (multi-select mode).
  function selectAllInBed(bedId) {
    const bed = beds.find((b) => b.id === bedId);
    if (!bed) return;
    setSelectedPlantIds(new Set(bed.plants.map((p) => p.id)));
  }

  // Replaces the current selection with whatever plants fall inside a rectangular region (feet,
  // relative to the bed's own origin) — the delegate a marquee/rubber-band drag calls on release.
  function selectPlantsInRect(bedId, minXFt, maxXFt, minYFt, maxYFt) {
    const bed = beds.find((b) => b.id === bedId);
    if (!bed) return;
    const withinBox = bed.plants.filter((p) => (p.x || 0) >= minXFt && (p.x || 0) <= maxXFt && (p.y || 0) >= minYFt && (p.y || 0) <= maxYFt);
    setSelectedPlantIds(new Set(withinBox.map((p) => p.id)));
  }

  // Bulk lock/unlock and delete for whatever's currently multi-selected. Deleting also cleans up
  // any box left with no remaining members, same as the single-plant delete/eject paths do.
  function bulkSetPlantsLocked(bedId, plantIds, locked) {
    setBeds((prev) =>
      prev.map((bed) =>
        bed.id === bedId ? { ...bed, plants: bed.plants.map((p) => (plantIds.has(p.id) ? { ...p, locked } : p)) } : bed
      )
    );
  }

  // Deletes every plant in the given set from a bed, cleaning up any plant boxes left empty.
  function bulkDeletePlants(bedId, plantIds) {
    setBeds((prev) =>
      prev.map((bed) => {
        if (bed.id !== bedId) return bed;
        const remainingPlants = bed.plants.filter((p) => !plantIds.has(p.id));
        const usedBoxIds = new Set(remainingPlants.filter((p) => p.boxId).map((p) => p.boxId));
        const plantBoxes = (bed.plantBoxes || []).filter((box) => usedBoxIds.has(box.id));
        return { ...bed, plants: remainingPlants, plantBoxes };
      })
    );
    setSelectedPlantIds(new Set());
  }

  // Deletes a plant that sits on the open map rather than in a bed.
  function deleteFreestandingPlant(plantId) {
    setPlants((prev) => prev.filter((p) => p.id !== plantId));
  }

  // Moves a freestanding plant into a bed (via the small "-> bed" dropdown on its chip) — drops
  // its old absolute canvas x/y (meaningless once it's bed-relative) in favor of a fresh default
  // grid position within the bed, and always unlocks it, since a freshly-placed plant should be
  // immediately adjustable rather than inheriting a stray locked state.
  function movePlantToBed(plantId, bedId) {
    if (!bedId) return;
    const found = plants.find((p) => p.id === plantId);
    const bed = beds.find((b) => b.id === bedId);
    if (!found || !bed) return;
    const { x: _fx, y: _fy, ...rest } = found;
    const { x, y, crowded } = findFreePositionInBed(bed);
    setCrowdedBedNotice(crowded ? bedId : null);
    setPlants((prev) => prev.filter((p) => p.id !== plantId));
    setBeds((prevBeds) => prevBeds.map((b) => (b.id === bedId ? { ...b, plants: [...b.plants, { ...rest, x, y, locked: false }] } : b)));
  }

  // Deletes a bed — any plants it had don't vanish with it, they become freestanding (a simple
  // staggered offset from the bed's old position, same idea as the eject flow), so removing a bed
  // never silently destroys the plants that were in it.
  function deleteBed(bedId) {
    const bed = beds.find((b) => b.id === bedId);
    if (bed && bed.plants.length) {
      const orphaned = bed.plants.map((p, i) => {
        const { x: _bx, y: _by, locked: _l, ...rest } = p;
        return { ...rest, x: bed.x + 10 + i * 4, y: bed.y + 10 + i * 4 };
      });
      setPlants((pl) => [...pl, ...orphaned]);
    }
    setBeds((prev) => prev.filter((b) => b.id !== bedId));
  }

  // Starts/commits an inline rename (used for both bed-plants and freestanding ones) — an empty
  // trimmed name is treated as "cancel" rather than allowing a plant to be renamed to nothing.
  function startRename(scope, bedId, plantId, currentName) {
    setRenaming({ scope, bedId, plantId, text: currentName });
  }

  // Saves the inline plant rename (ignored if blank) to the right place — a bed plant or a freestanding plant — and exits rename mode.
  function commitRename() {
    if (!renaming) return;
    const name = renaming.text.trim();
    if (name) {
      if (renaming.scope === "bed") {
        setBeds((prev) =>
          prev.map((bed) =>
            bed.id === renaming.bedId
              ? { ...bed, plants: bed.plants.map((p) => (p.id === renaming.plantId ? { ...p, name } : p)) }
              : bed
          )
        );
      } else {
        setPlants((prev) => prev.map((p) => (p.id === renaming.plantId ? { ...p, name } : p)));
      }
    }
    setRenaming(null);
  }

  // Shared plumbing for every drag/resize interaction in the app (bed/plant/zone/image move, bed
  // resize, image resize, viewport resize) — the parts that are truly identical everywhere: mouse vs
  // touch coordinate normalization, and registering/cleaning up the window-level listeners. Each call
  // site still owns its own start-state shape, its move math, and any end-of-drag side effects; only
  // the boilerplate that was previously copy-pasted five times lives here now.
  const dragSessionRef = useRef(null);

  // Window-level mousemove/touchmove listener for the active drag session: converts the event to client coordinates and forwards it to the session's onMove.
  const handleDragSessionMove = useCallback((e) => {
    const session = dragSessionRef.current;
    if (!session) return;
    e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    session.onMove(session.state, clientX, clientY);
  }, []);

  // Window-level mouseup/touchend listener: ends the active drag session, removes the listeners, and calls its onEnd.
  const handleDragSessionEnd = useCallback(() => {
    const session = dragSessionRef.current;
    dragSessionRef.current = null;
    window.removeEventListener("mousemove", handleDragSessionMove);
    window.removeEventListener("mouseup", handleDragSessionEnd);
    window.removeEventListener("touchmove", handleDragSessionMove);
    window.removeEventListener("touchend", handleDragSessionEnd);
    if (session && session.onEnd) session.onEnd(session.state);
  }, [handleDragSessionMove]);

  // e: the originating mousedown/touchstart event. initialState: whatever the caller needs on every
  // move (captured once, at drag start — the same "snapshot the starting values" pattern every one
  // of these systems already used individually). onMove(state, clientX, clientY): run on every move.
  // onEnd(state): run once on release, before the session is cleared. stopPropagation: only some
  // handles (ones nested inside other draggable content, like a resize handle on a bed) need this,
  // to avoid also triggering the parent's own drag.
  function startDragSession(e, initialState, onMove, onEnd, { stopPropagation = false } = {}) {
    e.preventDefault();
    if (stopPropagation) e.stopPropagation();
    dragSessionRef.current = { state: initialState, onMove, onEnd };
    window.addEventListener("mousemove", handleDragSessionMove);
    window.addEventListener("mouseup", handleDragSessionEnd);
    window.addEventListener("touchmove", handleDragSessionMove, { passive: false });
    window.addEventListener("touchend", handleDragSessionEnd);
  }

  // Starts dragging a bed, light zone, landscape feature, image, or freestanding plant around the map; updates its x/y on every move.
  const startDrag = (kind, id, e) => {
    const canvasRect = canvasRef.current.getBoundingClientRect();
    const list = kind === "bed" ? beds : kind === "zone" ? lightZones : kind === "feature" ? siteFeatures : kind === "image" ? backgroundImages : plants;
    const item = list.find((i) => i.id === id);
    if (!item) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    startDragSession(
      e,
      { kind, id, offsetX: (clientX - canvasRect.left) / zoom - item.x, offsetY: (clientY - canvasRect.top) / zoom - item.y },
      (state, moveClientX, moveClientY) => {
        if (!canvasRef.current) return;
        const rect = canvasRef.current.getBoundingClientRect();
        const { kind, id, offsetX, offsetY } = state;
        let x = (moveClientX - rect.left) / zoom - offsetX;
        let y = (moveClientY - rect.top) / zoom - offsetY;
        x = Math.max(0, x);
        y = Math.max(0, y);
        if (kind === "bed") setBeds((prev) => prev.map((b) => (b.id === id ? { ...b, x, y } : b)));
        else if (kind === "zone") setLightZones((prev) => prev.map((z) => (z.id === id ? { ...z, x, y } : z)));
        else if (kind === "feature") setSiteFeatures((prev) => prev.map((f) => (f.id === id ? { ...f, x, y } : f)));
        else if (kind === "image") setBackgroundImages((prev) => prev.map((img) => (img.id === id ? { ...img, x, y } : img)));
        else setPlants((prev) => prev.map((p) => (p.id === id ? { ...p, x, y } : p)));
      },
      (state) => {
        // If a bed the user hasn't manually set was just moved, re-check where it landed relative to the light zones.
        if (state.kind === "bed") {
          setBeds((prev) =>
            prev.map((bed) => {
              if (bed.id !== state.id || bed.sunExposureSource === "manual") return bed;
              const suggestion = suggestSunForBed(bed, lightZones, FT_TO_PX);
              if (suggestion) return { ...bed, sunExposure: suggestion, sunExposureSource: "auto" };
              return { ...bed, sunExposure: "unknown", sunExposureSource: "unset" };
            })
          );
        }
      }
    );
  };

  // Click-and-drag panning of the map — lets a zoomed-in view be adjusted by dragging empty
  // canvas space, instead of only via the browser's own scrollbars. Only triggers when the click
  // target is the canvas itself (e.g. e.target === e.currentTarget below), not a bed, plant,
  // image, or any of their own handles — those all keep their existing drag behavior untouched.
  // Adjusts the container's native scrollLeft/scrollTop directly rather than reimplementing
  // scrolling from scratch, so it stays perfectly in sync with the browser's own scroll state
  // (including the scrollbars themselves, which still work as an alternative any time).
  const startCanvasPan = (e) => {
    if (e.target !== e.currentTarget || canvasDraw) return;
    const el = canvasOuterRef.current;
    if (!el) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    startDragSession(e, { startClientX: clientX, startClientY: clientY, startScrollLeft: el.scrollLeft, startScrollTop: el.scrollTop }, (state, moveClientX, moveClientY) => {
      el.scrollLeft = state.startScrollLeft - (moveClientX - state.startClientX);
      el.scrollTop = state.startScrollTop - (moveClientY - state.startClientY);
    }, null);
  };

  // Resizing a bed by dragging one of its edge handles. Dragging the right/bottom edge changes
  // that dimension directly; dragging the left/top edge changes the dimension AND shifts the bed's
  // position so the opposite edge stays put — standard resize-handle behavior.
  const startResizeDrag = (bedId, edge, e) => {
    const bed = beds.find((b) => b.id === bedId);
    if (!bed) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    startDragSession(
      e,
      { bedId, edge, startClientX: clientX, startClientY: clientY, startWidthFt: bed.widthFt, startLengthFt: bed.lengthFt, startX: bed.x, startY: bed.y },
      (state, moveClientX, moveClientY) => {
        const { bedId, edge, startClientX, startClientY, startWidthFt, startLengthFt, startX, startY } = state;
        const deltaXFt = (moveClientX - startClientX) / zoom / FT_TO_PX;
        const deltaYFt = (moveClientY - startClientY) / zoom / FT_TO_PX;
        const MIN_FT = 1;
        setBeds((prev) =>
          prev.map((bed) => {
            if (bed.id !== bedId) return bed;
            let widthFt = startWidthFt;
            let lengthFt = startLengthFt;
            let x = startX;
            let y = startY;
            if (edge === "right") {
              widthFt = Math.max(MIN_FT, startWidthFt + deltaXFt);
            } else if (edge === "left") {
              // The right edge must stay exactly where it was — derive width from the ACTUAL
              // (post-clamp) x, not the other way around, so hitting the canvas boundary can't
              // silently shift the edge the user isn't even dragging.
              const rightEdgePx = startX + startWidthFt * FT_TO_PX;
              x = Math.max(0, startX + deltaXFt * FT_TO_PX);
              widthFt = Math.max(MIN_FT, (rightEdgePx - x) / FT_TO_PX);
            } else if (edge === "bottom") {
              lengthFt = Math.max(MIN_FT, startLengthFt + deltaYFt);
            } else if (edge === "top") {
              const bottomEdgePx = startY + startLengthFt * FT_TO_PX;
              y = Math.max(0, startY + deltaYFt * FT_TO_PX);
              lengthFt = Math.max(MIN_FT, (bottomEdgePx - y) / FT_TO_PX);
            }
            return { ...bed, widthFt, lengthFt, x: Math.max(0, x), y: Math.max(0, y), approxSqFt: Math.round(widthFt * lengthFt) };
          })
        );
      },
      null,
      { stopPropagation: true }
    );
  };

  // Separate, simpler resize system for background images — proportional only (drag the corner,
  // both dimensions scale together) so a photo can't get stretched out of its real aspect ratio.
  const startImageResize = (imageId, e) => {
    const img = backgroundImages.find((b) => b.id === imageId);
    if (!img) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    startDragSession(
      e,
      { imageId, startClientX: clientX, startWidthPx: img.widthPx, startHeightPx: img.heightPx },
      (state, moveClientX) => {
        // Deliberately horizontal-only — moveClientY is intentionally unused here.
        const { imageId, startClientX, startWidthPx, startHeightPx } = state;
        const deltaX = (moveClientX - startClientX) / zoom;
        const scale = Math.max(0.05, (startWidthPx + deltaX) / startWidthPx);
        setBackgroundImages((prev) =>
          prev.map((img) => (img.id === imageId ? { ...img, widthPx: startWidthPx * scale, heightPx: startHeightPx * scale } : img))
        );
      },
      null,
      { stopPropagation: true }
    );
  };


  // Independent per-edge resize for images, matching a Paint-style box resize — drag the right
  // side and only the width grows (to the right); drag the left side and it grows to the left, etc.
  // Unlike the corner handle above, this can distort the image's proportions on purpose.
  const startImageEdgeResize = (imageId, edge, e) => {
    const img = backgroundImages.find((b) => b.id === imageId);
    if (!img) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    startDragSession(
      e,
      { imageId, edge, startClientX: clientX, startClientY: clientY, startWidthPx: img.widthPx, startHeightPx: img.heightPx, startX: img.x, startY: img.y },
      (state, moveClientX, moveClientY) => {
        const { imageId, edge, startClientX, startClientY, startWidthPx, startHeightPx, startX, startY } = state;
        const deltaX = (moveClientX - startClientX) / zoom;
        const deltaY = (moveClientY - startClientY) / zoom;
        const MIN_PX = 20;
        setBackgroundImages((prev) =>
          prev.map((img) => {
            if (img.id !== imageId) return img;
            let widthPx = startWidthPx;
            let heightPx = startHeightPx;
            let x = startX;
            let y = startY;
            // Independent per-axis checks (not else-if across axes) so a compound corner value like
            // "bottom-right" resizes width AND height together; a plain edge like "right" only matches
            // one of these and leaves the other axis untouched, exactly as before.
            if (edge.includes("right")) {
              widthPx = Math.max(MIN_PX, startWidthPx + deltaX);
            } else if (edge.includes("left")) {
              // The right edge must stay exactly where it was — derive width from the ACTUAL
              // (post-clamp) x, so hitting the canvas boundary can't silently shift the opposite edge.
              const rightEdgePx = startX + startWidthPx;
              x = Math.max(0, startX + deltaX);
              widthPx = Math.max(MIN_PX, rightEdgePx - x);
            }
            if (edge.includes("bottom")) {
              heightPx = Math.max(MIN_PX, startHeightPx + deltaY);
            } else if (edge.includes("top")) {
              const bottomEdgePx = startY + startHeightPx;
              y = Math.max(0, startY + deltaY);
              heightPx = Math.max(MIN_PX, bottomEdgePx - y);
            }
            return { ...img, widthPx, heightPx, x: Math.max(0, x), y: Math.max(0, y) };
          })
        );
      },
      null,
      { stopPropagation: true }
    );
  };

  // Lets you drag "Your land" itself to whatever size/shape you want — a plain screen-pixel resize
  // of the viewport chrome, completely unrelated to zoom or the ft-based content inside it.
  const startViewportResize = (edge, e) => {
    const el = canvasOuterRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    // Real browsers can start a native text-selection drag alongside a mousedown on nearby content,
    // which can visibly interfere with a resize drag in ways a headless test environment doesn't
    // reproduce — disable selection for the duration of the drag as a defensive measure.
    document.body.style.userSelect = "none";
    startDragSession(
      e,
      { edge, startClientX: clientX, startClientY: clientY, startWidth: rect.width, startHeight: rect.height, startLeft: rect.left, startTop: rect.top },
      (state, moveClientX, moveClientY) => {
        const { edge, startClientX, startClientY, startWidth, startHeight, startLeft, startTop } = state;
        // Cap so the handle's corner can never end up past the visible browser window — otherwise
        // you'd have to scroll the whole page just to reach it again to size it back down.
        const maxWidth = window.innerWidth - startLeft - 16;
        const maxHeight = window.innerHeight - startTop - 16;
        if (edge === "right" || edge === "corner") {
          setViewportWidth(Math.min(maxWidth, Math.max(320, startWidth + (moveClientX - startClientX))));
        }
        if (edge === "bottom" || edge === "corner") {
          setViewportHeight(Math.min(maxHeight, Math.max(300, startHeight + (moveClientY - startClientY))));
        }
      },
      () => {
        document.body.style.userSelect = "";
      }
    );
  };

  // The canvas must always be at least large enough that, once scaled by the current zoom,
  // it fills the entire (now fixed-size) "Your land" viewport — otherwise zooming out just
  // shrinks a same-sized canvas into the corner of that fixed box, leaving blank space around
  // it and making the visible grid block's proportions look wrong ("misshapen squares").
  const viewportFillWidth = baseWidth / zoom;
  const activeGridFt = manualGridFt !== null ? manualGridFt : getAdaptiveGridSizeFt(zoom);
  const viewportFillHeight = baseHeight / zoom;

  // Tall enough for the viewport and for the bottom edge (plus a 60px margin) of every bed, plant,
  // light zone, landscape feature and image on the map. Plain loops rather than Math.max(...array):
  // spreading a big array into function arguments overflows the call stack once it gets large
  // enough (a map with tens of thousands of plants), and it builds throwaway arrays on every call.
  const canvasHeight = useMemo(() => {
    let h = Math.max(640, viewportFillHeight);
    for (const b of beds) h = Math.max(h, b.y + b.lengthFt * FT_TO_PX + 60);
    for (const p of plants) h = Math.max(h, p.y + 60);
    for (const z of lightZones) h = Math.max(h, z.y + z.lengthFt * FT_TO_PX + 60);
    for (const f of siteFeatures) h = Math.max(h, f.y + f.lengthFt * FT_TO_PX + 60);
    for (const img of backgroundImages) h = Math.max(h, img.y + img.heightPx + 60);
    return h;
  }, [beds, plants, lightZones, siteFeatures, backgroundImages, viewportFillHeight]);
  // The canvas needs to be as wide as whatever's actually placed on it, not just the viewport —
  // otherwise the reference grid (and the scrollable area) stop short of beds placed far out,
  // which is exactly the "squares don't cover the full land" problem on large properties.
  const contentWidth = useMemo(() => {
    let w = Math.max(baseWidth, viewportFillWidth);
    for (const b of beds) w = Math.max(w, b.x + b.widthFt * FT_TO_PX + 60);
    for (const p of plants) w = Math.max(w, p.x + 100);
    for (const z of lightZones) w = Math.max(w, z.x + z.widthFt * FT_TO_PX + 60);
    for (const f of siteFeatures) w = Math.max(w, f.x + f.widthFt * FT_TO_PX + 60);
    for (const img of backgroundImages) w = Math.max(w, img.x + img.widthPx + 60);
    return w;
  }, [beds, plants, lightZones, siteFeatures, backgroundImages, baseWidth, viewportFillWidth]);

  // The reference grid used to be a CSS/SVG tiled pattern repeated across the whole map, then a
  // single SVG <path> drawing every gridline in one compound shape — both turned out to render
  // fine near the top-left corner of the map but silently stop partway across the rest of it on at
  // least one real machine, even though the underlying width/height numbers were verified correct.
  // A single very long compound path is exactly the kind of shape that has historically tripped up
  // GPU-accelerated vector rasterizers on some driver/platform combinations (the path gets clipped
  // or simply stops being drawn past some internal complexity limit, with no error to show for
  // it) — plain CSS tiling has the same class of failure mode for the same underlying reason (lots
  // of repeated geometry over a large area). Individual <line> elements are about as simple a
  // shape as SVG has, and a browser that can draw one can draw four thousand of them without the
  // same risk, so the grid is now a plain array of separate lines rather than one shape of any
  // kind. Capped at a generous line count so an extreme zoom-out with a tiny manual square size
  // can't generate an unreasonable number of them; past that cap the grid thins out rather than
  // disappearing.
  const gridLines = useMemo(() => {
    const cellPx = FT_TO_PX * activeGridFt * zoom;
    if (!cellPx || cellPx <= 0) return [];
    const w = contentWidth * zoom;
    const h = canvasHeight * zoom;
    const MAX_LINES = 4000;
    let cols = Math.floor(w / cellPx) + 1;
    let rows = Math.floor(h / cellPx) + 1;
    let colStep = cellPx;
    let rowStep = cellPx;
    if (cols + rows > MAX_LINES) {
      const scaleUp = (cols + rows) / MAX_LINES;
      colStep = cellPx * scaleUp;
      rowStep = cellPx * scaleUp;
      cols = Math.floor(w / colStep) + 1;
      rows = Math.floor(h / rowStep) + 1;
    }
    const lines = [];
    for (let i = 0; i <= cols; i++) {
      const x = i * colStep;
      lines.push({ key: `v${i}`, x1: x, y1: 0, x2: x, y2: h });
    }
    for (let j = 0; j <= rows; j++) {
      const y = j * rowStep;
      lines.push({ key: `h${j}`, x1: 0, y1: y, x2: w, y2: y });
    }
    return lines;
  }, [contentWidth, canvasHeight, activeGridFt, zoom]);

  // The grid as a ready-made element, memoized: it can contain up to a few thousand <line>s, and
  // the map re-renders on every mouse-move while dragging a bed/plant/zone. Without this, React
  // would rebuild and diff all those elements on every single move even though the grid itself
  // hasn't changed; with it, React sees the identical element and skips the whole subtree.
  const gridElement = useMemo(
    () => (
      <svg className="absolute top-0 left-0 pointer-events-none" width={contentWidth * zoom} height={canvasHeight * zoom}>
        {gridLines.map((l) => (
          <line key={l.key} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="rgba(120,113,90,0.15)" strokeWidth="1" />
        ))}
      </svg>
    ),
    [gridLines, contentWidth, canvasHeight, zoom]
  );

  // Converts a mouse/touch event's screen position into the canvas's own logical coordinate space
  // (the same space bed.x / zone.x etc. live in), accounting for the current zoom level.
  // Shape-drawing interaction, for both a bed's custom outline and a light zone's outline (see
  // canvasDraw state and the startCanvasDrawFor... functions above): clicking the map overlay adds
  // a new point to the in-progress shape; each already-placed point can also be dragged to adjust
  // it. suppressDrawClickRef exists because dragging a point releases with a mouseup, which would
  // otherwise also register as a click on the overlay underneath and add an unwanted extra point —
  // it's set right after a point-drag ends and consumed (cleared) by the very next overlay click.
  function eventToCanvasPoint(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
  }

  // Adds a point to the in-progress shape where the overlay was clicked (ignoring the click that ends a point-drag).
  function handleDrawOverlayClick(e) {
    if (suppressDrawClickRef.current) {
      suppressDrawClickRef.current = false;
      return;
    }
    if (!canvasDraw) return;
    const point = eventToCanvasPoint(e);
    setCanvasDraw((d) => (d ? { ...d, points: [...d.points, point] } : d));
  }

  // Starts dragging an already-placed shape point so it can be repositioned.
  function startDrawPointDrag(index, e) {
    e.stopPropagation();
    e.preventDefault();
    draggingDrawPointRef.current = index;
    window.addEventListener("mousemove", onDrawPointMove);
    window.addEventListener("mouseup", onDrawPointUp);
    window.addEventListener("touchmove", onDrawPointMove, { passive: false });
    window.addEventListener("touchend", onDrawPointUp);
  }

  // While a shape point is being dragged, moves it to the cursor.
  function onDrawPointMove(e) {
    if (draggingDrawPointRef.current === null) return;
    e.preventDefault();
    const point = eventToCanvasPoint(e);
    const idx = draggingDrawPointRef.current;
    setCanvasDraw((d) => (d ? { ...d, points: d.points.map((p, i) => (i === idx ? point : p)) } : d));
  }

  // Ends a shape-point drag and arms the click-suppression flag so the release isn't treated as a new point.
  function onDrawPointUp() {
    draggingDrawPointRef.current = null;
    suppressDrawClickRef.current = true;
    window.removeEventListener("mousemove", onDrawPointMove);
    window.removeEventListener("mouseup", onDrawPointUp);
    window.removeEventListener("touchmove", onDrawPointMove);
    window.removeEventListener("touchend", onDrawPointUp);
  }

  // Stable-identity versions of every handler passed down to the memoized BedCards (see
  // useStableHandlers for why). Must be called after all of these are defined, and unconditionally.
  const bedHandlers = useStableHandlers({
    commitRename, startRename, addPlantToBed, ejectPlantFromBed, deletePlantFromBed,
    startCanvasDrawForBedShape, duplicateBed, deleteBed, startDrag, startResizeDrag,
    startBedPlantDrag, startPlantBoxDrag, startPlacedBoxResize, mergeBoxes, unmergeBoxes,
    startPlantChipFillDrag, toggleSelectionMode, togglePlantSelection, selectAllInBed,
    selectPlantsInRect, bulkSetPlantsLocked, bulkDeletePlants, clearBedHistory,
  });

  return (
    <div className="min-h-screen bg-stone-100 text-stone-900" style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@600;700&family=Work+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500&display=swap');
        .fraunces { font-family: 'Fraunces', serif; }
        .mono-label { font-family: 'IBM Plex Mono', monospace; }
        .soil-texture { background-image: repeating-linear-gradient(135deg, rgba(255,255,255,0.06) 0px, rgba(255,255,255,0.06) 2px, transparent 2px, transparent 8px); }
      `}</style>

      {editingBed && (
        <EditBedModal
          bed={editingBed}
          onCancel={() => setEditingBed(null)}
          onSave={(values) => saveEditedBed(editingBed.id, values)}
          onDrawShape={() => startCanvasDrawForBedShape(editingBed.id)}
        />
      )}

      {editingFeature && (
        <EditFeatureModal
          feature={editingFeature}
          onCancel={() => setEditingFeature(null)}
          onSave={(id, values) => {
            updateSiteFeature(id, values);
            setEditingFeature(null);
          }}
          onDelete={(id) => {
            deleteSiteFeature(id);
            setEditingFeature(null);
          }}
        />
      )}

      {showYearRollover && (
        <YearRolloverModal
          beds={beds}
          plants={plants}
          onCancel={() => setShowYearRollover(false)}
          onConfirm={archiveYearAndReset}
        />
      )}

      {calibrationSession && (
        <CalibrationModal
          session={calibrationSession}
          onCancel={() => setCalibrationSession(null)}
          onConfirm={finishCalibration}
        />
      )}

      {editingPlant && (() => {
        const found =
          editingPlant.scope === "bed"
            ? beds.find((b) => b.id === editingPlant.bedId)?.plants.find((p) => p.id === editingPlant.plantId)
            : plants.find((p) => p.id === editingPlant.plantId);
        if (!found) return null;
        const neighborPlants =
          editingPlant.scope === "bed"
            ? (beds.find((b) => b.id === editingPlant.bedId)?.plants || []).filter((p) => p.id !== editingPlant.plantId)
            : [];
        const bedName = editingPlant.scope === "bed" ? beds.find((b) => b.id === editingPlant.bedId)?.name : null;
        return (
          <PlantDetailsModal
            plantName={found.name}
            initialValues={found}
            zone={zone}
            neighborPlants={neighborPlants}
            livePlantIds={new Set((editingPlant.scope === "bed" ? beds.find((b) => b.id === editingPlant.bedId)?.plants || [] : []).map((p) => p.id))}
            bedName={bedName}
            yearHistory={yearHistory}
            isBedPlant={editingPlant.scope === "bed"}
            onCancel={() => setEditingPlant(null)}
            onSave={(details) => savePlantDetails(editingPlant, details)}
            onEject={
              editingPlant.scope === "bed"
                ? () => {
                    ejectPlantFromBed(editingPlant.bedId, editingPlant.plantId);
                    setEditingPlant(null);
                  }
                : undefined
            }
            onReleaseFromGroup={
              editingPlant.scope === "bed" && found.boxId
                ? () => {
                    releasePlantFromGroup(editingPlant.bedId, editingPlant.plantId);
                    setEditingPlant(null);
                  }
                : undefined
            }
            onDelete={
              editingPlant.scope === "bed"
                ? () => {
                    deletePlantFromBed(editingPlant.bedId, editingPlant.plantId);
                    setEditingPlant(null);
                  }
                : undefined
            }
          />
        );
      })()}

      <header className="border-b border-stone-300 bg-stone-50 px-6 py-5">
        <div className="max-w-7xl mx-auto flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="fraunces text-2xl md:text-3xl text-stone-900">Homestead Bed Planner</h1>
            <p className="text-stone-500 text-sm mt-1">Beds, plants, and the freedom to edit, move, or delete anything, anytime.</p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={undo}
              disabled={undoStackRef.current.length === 0}
              title="Undo (Ctrl+Z)"
              className="flex items-center gap-1 text-xs border border-stone-300 rounded-lg px-2.5 py-1.5 bg-white hover:bg-stone-100 disabled:opacity-40 disabled:hover:bg-white"
            >
              <Undo2 size={13} /> Undo
            </button>
            <button
              onClick={redo}
              disabled={redoStackRef.current.length === 0}
              title="Redo (Ctrl+Y)"
              className="flex items-center gap-1 text-xs border border-stone-300 rounded-lg px-2.5 py-1.5 bg-white hover:bg-stone-100 disabled:opacity-40 disabled:hover:bg-white"
            >
              <Undo2 size={13} className="-scale-x-100" /> Redo
            </button>
          </div>
        </div>

        <div className="max-w-7xl mx-auto mt-3 flex items-center flex-wrap gap-x-4 gap-y-2">
          <div className="flex items-center gap-1.5">
            <label className="text-xs mono-label text-stone-500">Your zone:</label>
            <select
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              className="text-sm border border-stone-300 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
            >
              {Object.entries(USDA_ZONES).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </div>

          {zone === "international" && (
            <input
              value={zoneCustomText}
              onChange={(e) => setZoneCustomText(e.target.value)}
              placeholder="Describe your climate/region"
              className="text-sm border border-stone-300 rounded-lg px-2 py-1.5 w-48 focus:outline-none focus:ring-2 focus:ring-emerald-600"
            />
          )}

          <div className="flex items-center gap-1.5">
            <span className="text-xs text-stone-400">Don't know it?</span>
            <input
              value={zipInput}
              onChange={(e) => {
                setZipInput(e.target.value);
                if (zipStatus === "error") setZipStatus("idle");
              }}
              onKeyDown={(e) => e.key === "Enter" && lookupZoneByZip()}
              placeholder="ZIP code"
              inputMode="numeric"
              className={`text-sm border rounded-lg px-2 py-1.5 w-24 focus:outline-none focus:ring-2 ${
                zipStatus === "error" ? "border-red-400 focus:ring-red-400" : "border-stone-300 focus:ring-emerald-600"
              }`}
            />
            <button
              type="button"
              onClick={lookupZoneByZip}
              disabled={zipStatus === "loading"}
              className="text-sm border border-stone-300 rounded-lg px-2.5 py-1.5 bg-white hover:bg-stone-50 disabled:opacity-50"
            >
              {zipStatus === "loading" ? "Looking up…" : "Find my zone"}
            </button>
          </div>

          <a
            href="https://planthardiness.ars.usda.gov/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-emerald-700 hover:text-emerald-800 underline"
          >
            Or look it up on the official USDA map ↗
          </a>
        </div>
        {zipStatus === "error" && (
          <p className="max-w-7xl mx-auto text-xs text-red-600 mt-1">
            Couldn't find a zone for that ZIP (US ZIP codes only, and the free lookup service is sometimes unavailable) — try the official USDA map link instead.
          </p>
        )}
      </header>

      <div className="max-w-7xl mx-auto px-3 sm:px-4 md:px-6 pt-4 flex gap-1 border-b border-stone-300">
        <button
          type="button"
          onClick={() => setActiveTab("map")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-t-lg border border-b-0 -mb-px ${
            activeTab === "map" ? "bg-white border-stone-300 text-emerald-700" : "bg-transparent border-transparent text-stone-500 hover:text-stone-700"
          }`}
        >
          <Map size={15} /> Garden map
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("calendar")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-t-lg border border-b-0 -mb-px ${
            activeTab === "calendar" ? "bg-white border-stone-300 text-emerald-700" : "bg-transparent border-transparent text-stone-500 hover:text-stone-700"
          }`}
        >
          <CalendarDays size={15} /> Calendar
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("history")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-t-lg border border-b-0 -mb-px ${
            activeTab === "history" ? "bg-white border-stone-300 text-emerald-700" : "bg-transparent border-transparent text-stone-500 hover:text-stone-700"
          }`}
        >
          <History size={15} /> History
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("journal")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-t-lg border border-b-0 -mb-px ${
            activeTab === "journal" ? "bg-white border-stone-300 text-emerald-700" : "bg-transparent border-transparent text-stone-500 hover:text-stone-700"
          }`}
        >
          <BookOpen size={15} /> Journal
        </button>
      </div>

      {/* Tab router: calendar / history / journal views, otherwise the main planner (sidebar + map) */}
      {activeTab === "calendar" ? (
        <CalendarView beds={beds} plants={plants} />
      ) : activeTab === "history" ? (
        <HistoryView
          yearHistory={yearHistory}
          onDeleteEntry={deleteYearHistoryEntry}
          onUpdateYear={updateYearLabel}
          onUpdateYearNotes={updateYearNotes}
          onUpdatePlantNote={updateHistoryPlantNote}
        />
      ) : activeTab === "journal" ? (
        <JournalView journalEntries={journalEntries} beds={beds} onAddEntry={addJournalEntry} onDeleteEntry={deleteJournalEntry} />
      ) : (
      /* Main planner layout: sidebar of forms on the left, the "Your land" map on the right */
      <div className="mx-auto px-3 sm:px-4 md:px-6 py-4 sm:py-6 flex flex-col sm:flex-row gap-4 sm:gap-6">
        {/* Sidebar — back on the left, in natural order. Note: order alone doesn't change how much
            space each side gets (a fixed-width panel takes the same room either way) — collapsing it
            via the toggle is still what actually reclaims width for Your land. */}
        <div className={`space-y-4 sm:space-y-6 w-full sm:w-64 md:w-72 lg:w-80 sm:flex-shrink-0 order-1 ${showSidebar ? "" : "hidden"}`}>
          {/* Sidebar: Add a bed form */}
          <section className="bg-white border border-stone-300 rounded-xl p-4">
            <h2 className="fraunces text-lg mb-3 flex items-center gap-2">
              <Plus size={18} className="text-emerald-700" /> Add a bed
            </h2>
            <form onSubmit={addBed}>
              <BedFields
                values={bedForm}
                setValues={setBedForm}
                onDrawShape={startCanvasDrawForNewBed}
                hasCustomShape={false}
                nameError={bedNameError}
              />
              <button
                type="submit"
                disabled={bedForm.shape === "custom_points"}
                className="w-full mt-3 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg py-2 text-sm font-medium transition-colors disabled:opacity-40"
              >
                {bedForm.shape === "custom_points" ? "Use \"Draw shape on the map\" above" : "Add bed to the map"}
              </button>
            </form>
          </section>

          {/* Sidebar: Light zones (sun/shade areas painted on the map) */}
          <section className="bg-white border border-stone-300 rounded-xl p-4">
            <h2 className="fraunces text-lg mb-2 flex items-center gap-2">
              <Sun size={18} className="text-emerald-700" /> Light zones
            </h2>
            <p className="text-xs text-stone-500 mb-3">
              Draw where the sun actually falls in your yard. Beds placed inside a zone get their sun exposure
              suggested automatically — you can still change it yourself anytime.
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-xs mono-label text-stone-500 block mb-1">This zone gets</label>
                <select
                  value={zoneForm.sunExposure}
                  onChange={(e) => setZoneForm((f) => ({ ...f, sunExposure: e.target.value }))}
                  className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                >
                  <option value="full_sun">{SUN_EXPOSURES.full_sun}</option>
                  <option value="part_sun">{SUN_EXPOSURES.part_sun}</option>
                  <option value="full_shade">{SUN_EXPOSURES.full_shade}</option>
                </select>
              </div>
              <button
                type="button"
                onClick={startCanvasDrawForNewZone}
                className="w-full flex items-center justify-center gap-2 border border-emerald-700 text-emerald-700 rounded-lg py-2 text-sm font-medium hover:bg-emerald-50"
              >
                <PenTool size={15} />
                Draw this zone on the map
              </button>
              <p className="text-xs text-stone-400">
                Click directly on "Your land" below to place corner points, then click Finish to add it.
              </p>
            </div>
            {lightZones.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {lightZones.map((z) => (
                  <div key={z.id} className={`flex items-center justify-between text-xs rounded-lg border px-2 py-1.5 ${LIGHT_ZONE_STYLES[z.sunExposure].badge}`}>
                    <span>{SUN_EXPOSURES[z.sunExposure]} · ~{z.approxSqFt} sq ft</span>
                    <div className="flex items-center gap-1">
                      <button onClick={() => startCanvasDrawForZoneShape(z.id)} className="hover:text-emerald-700 p-1 -m-1" title="Reshape this zone">
                        <PenTool size={12} />
                      </button>
                      <button onClick={() => deleteLightZone(z.id)} className="hover:text-red-600 p-1 -m-1" title="Delete zone">
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Sidebar: Landscape features (house, trees, paths, water...) */}
          <section className="bg-white border border-stone-300 rounded-xl p-4">
            <h2 className="fraunces text-lg mb-2 flex items-center gap-2">
              <span style={{ fontSize: 18 }}>{SITE_FEATURE_KINDS.path.icon}</span> Landscape features
            </h2>
            <p className="text-xs text-stone-500 mb-3">
              Paths, patios, water features, structures — things on the property that aren't beds and
              can't be planted. Drawn the same way as a custom bed shape, but kept completely separate.
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-xs mono-label text-stone-500 block mb-1">Name</label>
                <input
                  type="text"
                  value={featureForm.name}
                  onChange={(e) => {
                    setFeatureForm((f) => ({ ...f, name: e.target.value }));
                    setFeatureNameError(false);
                  }}
                  placeholder="e.g. Gravel path"
                  className={`w-full border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600 ${featureNameError ? "border-red-400" : "border-stone-300"}`}
                />
                {featureNameError && <p className="text-xs text-red-600 mt-1">A name is needed before drawing — used to label the shape once it's placed.</p>}
              </div>
              <div>
                <label className="text-xs mono-label text-stone-500 block mb-1">Kind</label>
                <select
                  value={featureForm.kind}
                  onChange={(e) => setFeatureForm((f) => ({ ...f, kind: e.target.value }))}
                  className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                >
                  {SITE_FEATURE_KIND_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {SITE_FEATURE_KINDS[k].icon} {SITE_FEATURE_KINDS[k].label}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!featureForm.name.trim()) {
                    setFeatureNameError(true);
                    return;
                  }
                  startCanvasDrawForNewFeature();
                }}
                className="w-full flex items-center justify-center gap-2 border border-stone-500 text-stone-600 rounded-lg py-2 text-sm font-medium hover:bg-stone-50"
              >
                <PenTool size={15} />
                Draw this feature on the map
              </button>
              <p className="text-xs text-stone-400">
                Click directly on "Your land" below to place corner points, then click Finish to add it.
              </p>
            </div>
            {siteFeatures.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {siteFeatures.map((f) => (
                  <div key={f.id} className="flex items-center justify-between text-xs rounded-lg border border-stone-300 bg-stone-50 text-stone-700 px-2 py-1.5">
                    <span>
                      {SITE_FEATURE_KINDS[f.kind].icon} {f.name} · ~{f.approxSqFt} sq ft
                    </span>
                    <div className="flex items-center gap-1">
                      <button onClick={() => setEditingFeature(f)} className="hover:text-emerald-700 p-1 -m-1" title="Edit this feature">
                        <Pencil size={12} />
                      </button>
                      <button onClick={() => startCanvasDrawForFeatureShape(f.id)} className="hover:text-emerald-700 p-1 -m-1" title="Reshape this feature">
                        <PenTool size={12} />
                      </button>
                      <button onClick={() => deleteSiteFeature(f.id)} className="hover:text-red-600 p-1 -m-1" title="Delete this feature">
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Sidebar: Satellite / aerial background images */}
          <section className="bg-white border border-stone-300 rounded-xl p-4">
            <h2 className="fraunces text-lg mb-2 flex items-center gap-2">
              <ImageIcon size={18} className="text-emerald-700" /> Satellite / aerial images
            </h2>
            <p className="text-xs text-stone-500 mb-3">
              Upload one or more screenshots of your property from Google Maps or similar — piece together sections
              if one image doesn't cover it all. Calibrate each to a known real-world distance, then use "Custom —
              draw it yourself" for beds to trace directly over them.
            </p>
            <input ref={imageFileInputRef} type="file" accept="image/*" onChange={handleImageFile} className="hidden" />
            {imageSaveWarning && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2 mb-2">
                {imageSaveWarning}
              </p>
            )}
            <button
              type="button"
              onClick={() => imageFileInputRef.current && imageFileInputRef.current.click()}
              className="w-full flex items-center justify-center gap-2 border border-emerald-700 text-emerald-700 rounded-lg py-2 text-sm font-medium hover:bg-emerald-50"
            >
              <Upload size={15} />
              {backgroundImages.length === 0 ? "Upload an image" : "Upload another image"}
            </button>

            {backgroundImages.length > 0 && (
              <div className="mt-3 space-y-3">
                <button
                  type="button"
                  onClick={() => setShowBackgroundImages((s) => !s)}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-stone-300 hover:bg-stone-50"
                >
                  {showBackgroundImages ? <Eye size={13} /> : <EyeOff size={13} />}
                  {showBackgroundImages ? "All visible" : "All hidden"}
                </button>

                <div className="space-y-2">
                  {backgroundImages.map((bgImg, i) => (
                    <div key={bgImg.id} className="border border-stone-200 rounded-lg p-2.5 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs mono-label text-stone-500">Image {i + 1}</span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setBackgroundImages((prev) => prev.map((im) => (im.id === bgImg.id ? { ...im, locked: !im.locked } : im)))}
                            className={`p-1.5 rounded-full hover:bg-stone-100 ${bgImg.locked ? "text-emerald-700" : "text-stone-500"}`}
                            title={bgImg.locked ? "Unlock to reposition this image" : "Lock this image in place to avoid nudging it by accident"}
                          >
                            {bgImg.locked ? <Lock size={13} /> : <Unlock size={13} />}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const img = new window.Image();
                              img.onload = () =>
                                setCalibrationSession({
                                  dataUrl: bgImg.dataUrl,
                                  naturalWidth: img.naturalWidth,
                                  naturalHeight: img.naturalHeight,
                                  points: [],
                                  referenceFt: "",
                                  existingImageId: bgImg.id,
                                });
                              img.src = bgImg.dataUrl;
                            }}
                            className="text-xs text-stone-500 hover:text-emerald-700 underline"
                          >
                            Recalibrate
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (window.confirm("Remove this image from your map?")) deleteBackgroundImage(bgImg.id);
                            }}
                            className="text-stone-400 hover:text-red-600 p-1 -m-1"
                            title="Remove this image"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                      {bgImg.naturalWidth &&
                        bgImg.naturalHeight &&
                        (bgImg.widthPx > bgImg.naturalWidth * 1.15 || bgImg.heightPx > bgImg.naturalHeight * 1.15) && (
                          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                            This image is stretched beyond its original resolution at its current size — some softness
                            or blurriness here is a real limit of the source photo, not something the app can sharpen.
                            A higher-resolution screenshot (zoom in more before capturing) will look crisper.
                          </p>
                        )}
                      <div>
                        <label className="text-xs mono-label text-stone-500 block mb-1">Opacity</label>
                        <input
                          type="range"
                          min="0.1"
                          max="1"
                          step="0.05"
                          value={bgImg.opacity}
                          onChange={(e) =>
                            setBackgroundImages((prev) =>
                              prev.map((im) => (im.id === bgImg.id ? { ...im, opacity: Number(e.target.value) } : im))
                            )
                          }
                          className="w-full"
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-stone-400">
                  Drag an unlocked image to reposition it. Blue side handles stretch just that one edge; violet
                  corner handles resize width and height together but independently (a free diagonal drag); the
                  small green handle scales the whole image proportionally. Lock it in place once it's right.
                </p>
              </div>
            )}
          </section>

          {/* Sidebar: Add a freestanding plant (not inside any bed) */}
          <section className="bg-white border border-stone-300 rounded-xl p-4">
            <h2 className="fraunces text-lg mb-3 flex items-center gap-2">
              <Sprout size={18} className="text-emerald-700" /> Add a freestanding plant
            </h2>
            <p className="text-xs text-stone-500 mb-3">No bed needed — it'll sit on the open map and you can drag it into a bed later.</p>
            <form onSubmit={addFreestandingPlant} className="flex gap-2">
              <input
                value={plantName}
                onChange={(e) => setPlantName(e.target.value)}
                placeholder="e.g. Elderberry"
                className="flex-1 border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
              <button type="submit" className="bg-stone-800 hover:bg-stone-900 text-white rounded-lg px-3 text-sm font-medium transition-colors">
                Add
              </button>
            </form>
          </section>

          {/* Sidebar: New year — archive this year's layout to history and start fresh */}
          <section className="bg-white border border-stone-300 rounded-xl p-4">
            <h2 className="fraunces text-lg mb-2 flex items-center gap-2">
              <CalendarDays size={18} className="text-emerald-700" /> New year
            </h2>
            <p className="text-xs text-stone-500 mb-3">
              Archive everything currently in your garden and start fresh for the next season — with the option to
              carry specific plants forward.
            </p>
            <button
              type="button"
              onClick={() => setShowYearRollover(true)}
              className="w-full border border-emerald-700 text-emerald-700 rounded-lg py-2 text-sm font-medium hover:bg-emerald-50"
            >
              Start a new year
            </button>
          </section>

          {/* Sidebar: Backup & restore (export/import JSON) */}
          <section className="bg-white border border-stone-300 rounded-xl p-4">
            <h2 className="fraunces text-lg mb-2 flex items-center gap-2">
              <Download size={18} className="text-emerald-700" /> Backup & restore
            </h2>
            <p className="text-xs text-stone-500 mb-3">
              Your garden only lives in this browser. Save a backup file now and then, so you're never one cleared cache away from losing it.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={exportData}
                className="flex-1 flex items-center justify-center gap-1.5 border border-emerald-700 text-emerald-700 rounded-lg py-2 text-sm font-medium hover:bg-emerald-50"
              >
                <Download size={15} /> Export
              </button>
              <button
                type="button"
                onClick={triggerImport}
                className="flex-1 flex items-center justify-center gap-1.5 border border-stone-300 text-stone-700 rounded-lg py-2 text-sm font-medium hover:bg-stone-50"
              >
                <Upload size={15} /> Import
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json"
                onChange={handleImportFile}
                className="hidden"
              />
            </div>
            {importError && <p className="text-xs text-red-600 mt-2">{importError}</p>}
            <button type="button" onClick={clearAllData} className="text-xs text-stone-400 hover:text-red-600 underline mt-3">
              Clear all data
            </button>
          </section>

          {/* Sidebar: Legend explaining colours and warning icons */}
          <section className="bg-white border border-stone-300 rounded-xl p-4">
            <button
              type="button"
              onClick={() => setLegendOpen((o) => !o)}
              className="w-full flex items-center justify-between fraunces text-base"
            >
              Legend
              {legendOpen ? <ChevronDown size={16} className="text-stone-500" /> : <ChevronRight size={16} className="text-stone-500" />}
            </button>
            {legendOpen && (
              <div className="mt-2">
                <div className="mb-3">
                  <div className="text-xs mono-label text-stone-400 mb-1.5 uppercase tracking-wide">Soil type (bed color)</div>
                  <div className="space-y-1.5">
                    {Object.entries(SOIL_TYPES).map(([key, s]) => (
                      <div key={key} className="flex items-center gap-2 text-sm">
                        <span className={`inline-block w-4 h-4 rounded ${s.swatch} border ${s.border}`} />
                        <span className="text-stone-700">{s.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="mb-3">
                  <div className="text-xs mono-label text-stone-400 mb-1.5 uppercase tracking-wide">Yard location (label only)</div>
                  <div className="space-y-1 text-sm text-stone-700">
                    {Object.values(YARD_LOCATIONS).map((label) => (
                      <div key={label} className="flex items-center gap-2">
                        <MapPin size={13} className="text-stone-400" />
                        {label}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="mb-3">
                  <div className="text-xs mono-label text-stone-400 mb-1.5 uppercase tracking-wide">Bed structure (label only)</div>
                  <div className="space-y-1 text-sm text-stone-700">
                    {Object.values(BED_STRUCTURES).map((label) => (
                      <div key={label} className="flex items-center gap-2">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-stone-400" />
                        {label}
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-xs mono-label text-stone-400 mb-1.5 uppercase tracking-wide">Sun exposure (label only)</div>
                  <div className="space-y-1 text-sm text-stone-700">
                    {Object.values(SUN_EXPOSURES).map((label) => (
                      <div key={label} className="flex items-center gap-2">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400" />
                        {label}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>

        {/* Canvas */}
        <div className="flex-1 min-w-0 order-2">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowSidebar((s) => !s)}
                className="flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg border border-stone-300 hover:bg-stone-50 text-stone-600"
                title={showSidebar ? "Hide the sidebar so Your land can use the full width" : "Show the sidebar again"}
              >
                <ChevronRight size={13} className={showSidebar ? "rotate-180" : ""} />
                {showSidebar ? "Hide panel" : "Show panel"}
              </button>
              <h2 className="fraunces text-lg text-stone-700">Your land</h2>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-stone-400 mono-label hidden sm:inline">drag to reposition</span>
              <button
                type="button"
                onClick={() => setShowLightZones((s) => !s)}
                className={`flex items-center gap-1.5 border rounded-lg px-2.5 py-1.5 text-xs font-medium ${
                  showLightZones
                    ? "border-cyan-400 bg-cyan-50 text-cyan-800 hover:bg-cyan-100"
                    : "border-stone-300 bg-white text-stone-500 hover:bg-stone-50"
                }`}
                title={showLightZones ? "Hide light zones" : "Show light zones"}
              >
                {showLightZones ? <Eye size={14} /> : <EyeOff size={14} />}
                Light zones
              </button>
              <div className="flex items-center border border-stone-300 rounded-lg bg-white overflow-hidden">
                <button
                  type="button"
                  onClick={zoomOut}
                  disabled={zoom <= ZOOM_MIN}
                  className="p-1.5 hover:bg-stone-100 disabled:opacity-30 disabled:hover:bg-transparent"
                  title="Zoom out"
                >
                  <ZoomOut size={15} />
                </button>
                <button
                  type="button"
                  onClick={zoomReset}
                  className="px-2 text-xs mono-label text-stone-600 hover:bg-stone-100 border-l border-r border-stone-300 h-full py-1.5"
                  title="Reset zoom to 100%"
                >
                  {zoom < 0.1 ? Math.round(zoom * 1000) / 10 : Math.round(zoom * 100)}%
                </button>
                <button
                  type="button"
                  onClick={zoomIn}
                  disabled={zoom >= ZOOM_MAX}
                  className="p-1.5 hover:bg-stone-100 disabled:opacity-30 disabled:hover:bg-transparent border-r border-stone-300"
                  title="Zoom in"
                >
                  <ZoomIn size={15} />
                </button>
                <button
                  type="button"
                  onClick={zoomToFit}
                  className="px-2 py-1.5 text-xs font-medium hover:bg-stone-100"
                  title="Zoom to fit everything on the map"
                >
                  Fit all
                </button>
              </div>
              <div
                className="flex items-center gap-1 mono-label text-xs text-stone-500 border border-stone-300 rounded-lg px-2 py-1 bg-white"
                title="Square size adjusts the grid's scale directly, independent of zoom — zooming in or out doesn't change it once you've set it yourself"
              >
                <span>Square =</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={activeGridFt}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (v > 0) setManualGridFt(v);
                  }}
                  className="w-12 border border-stone-300 rounded px-1 py-0.5 text-xs text-center focus:outline-none focus:ring-1 focus:ring-emerald-600"
                />
                <span>ft</span>
                {manualGridFt !== null && (
                  <button
                    type="button"
                    onClick={() => setManualGridFt(null)}
                    className="ml-0.5 text-emerald-700 hover:text-emerald-900 underline"
                    title="Go back to automatically adjusting the grid size as you zoom"
                  >
                    Auto
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="relative" style={viewportWidth ? { width: viewportWidth } : undefined}>
          <div
            ref={canvasOuterRef}
            className="relative bg-stone-200 border border-stone-300 rounded-xl overflow-auto"
            style={
              viewportWidth
                ? { width: viewportWidth, height: viewportHeight, minHeight: 300 }
                : { height: "87vh", minHeight: 560 }
            }
          >
            {viewportWidth && (
              <button
                type="button"
                onClick={() => {
                  setViewportWidth(null);
                  setViewportHeight(null);
                }}
                className={`absolute ${canvasDraw ? "top-16" : "top-2"} right-2 z-40 text-xs bg-white border border-stone-300 rounded-lg px-2 py-1 text-stone-500 hover:text-stone-800 hover:bg-stone-50 shadow-sm`}
                title="Go back to the default responsive size"
              >
                Reset size
              </button>
            )}
            {/* Sticky toolbar shown while drawing a shape on the map (confirm / cancel) */}
            {canvasDraw && (
              <div className="sticky top-0 left-0 z-30 flex items-center justify-between gap-2 bg-white border-b border-stone-300 px-3 py-2 text-sm flex-wrap">
                <span className="text-stone-600">
                  {canvasDraw.mode === "edit" ? "Editing shape" : canvasDraw.kind === "zone" ? "Drawing a light zone" : canvasDraw.kind === "feature" ? "Drawing a landscape feature" : "Drawing a bed"} — click to
                  place points{canvasDraw.points.length > 0 ? `, ${canvasDraw.points.length} so far` : ""}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={undoCanvasDrawPoint}
                    disabled={canvasDraw.points.length === 0}
                    className="flex items-center gap-1 text-xs border border-stone-300 rounded-lg px-2.5 py-1.5 hover:bg-stone-50 disabled:opacity-40"
                  >
                    <Undo2 size={13} /> Undo point
                  </button>
                  <button type="button" onClick={cancelCanvasDraw} className="text-xs border border-stone-300 rounded-lg px-2.5 py-1.5 hover:bg-stone-50">
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={finishCanvasDraw}
                    disabled={canvasDraw.points.length < 3}
                    className="flex items-center gap-1 text-xs bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg px-3 py-1.5 disabled:opacity-40"
                  >
                    <Check size={13} /> Finish{canvasDraw.mode === "create" ? "" : " editing"}
                  </button>
                </div>
              </div>
            )}
            <div style={{ width: contentWidth * zoom, height: canvasHeight * zoom, position: "relative" }}>
              {gridElement}
              <div
                ref={canvasRef}
                onMouseDown={startCanvasPan}
                onTouchStart={startCanvasPan}
                className="absolute top-0 left-0"
                style={{
                  width: contentWidth,
                  minHeight: canvasHeight,
                  touchAction: "none",
                  transform: `scale(${zoom})`,
                  transformOrigin: "top left",
                  cursor: canvasDraw ? undefined : "grab",
                }}
              >
            {showBackgroundImages &&
              backgroundImages.map((bgImg) => (
                <div
                  key={bgImg.id}
                  className="absolute"
                  style={{ left: bgImg.x, top: bgImg.y, width: bgImg.widthPx, height: bgImg.heightPx }}
                >
                  <img
                    src={bgImg.dataUrl}
                    alt="Property reference"
                    draggable={false}
                    onMouseDown={bgImg.locked ? undefined : (e) => startDrag("image", bgImg.id, e)}
                    onTouchStart={bgImg.locked ? undefined : (e) => startDrag("image", bgImg.id, e)}
                    className={`absolute inset-0 w-full h-full select-none ${bgImg.locked ? "pointer-events-none" : "cursor-grab active:cursor-grabbing"}`}
                    style={{
                      opacity: bgImg.opacity,
                      WebkitUserDrag: "none",
                      WebkitUserSelect: "none",
                      MozUserSelect: "none",
                      userSelect: "none",
                    }}
                  />
                  {!bgImg.locked && (
                    <>
                      <div
                        onMouseDown={(e) => startImageEdgeResize(bgImg.id, "right", e)}
                        onTouchStart={(e) => startImageEdgeResize(bgImg.id, "right", e)}
                        className="absolute bg-blue-600 border-2 border-white rounded-full shadow"
                        style={{ right: -6, top: "50%", width: 12, height: 24, marginTop: -12, cursor: "ew-resize", transform: `scale(${1 / zoom})` }}
                        title="Drag to stretch width (right edge only)"
                      />
                      <div
                        onMouseDown={(e) => startImageEdgeResize(bgImg.id, "left", e)}
                        onTouchStart={(e) => startImageEdgeResize(bgImg.id, "left", e)}
                        className="absolute bg-blue-600 border-2 border-white rounded-full shadow"
                        style={{ left: -6, top: "50%", width: 12, height: 24, marginTop: -12, cursor: "ew-resize", transform: `scale(${1 / zoom})` }}
                        title="Drag to stretch width (left edge only)"
                      />
                      <div
                        onMouseDown={(e) => startImageEdgeResize(bgImg.id, "bottom", e)}
                        onTouchStart={(e) => startImageEdgeResize(bgImg.id, "bottom", e)}
                        className="absolute bg-blue-600 border-2 border-white rounded-full shadow"
                        style={{ bottom: -6, left: "50%", width: 24, height: 12, marginLeft: -12, cursor: "ns-resize", transform: `scale(${1 / zoom})` }}
                        title="Drag to stretch height (bottom edge only)"
                      />
                      <div
                        onMouseDown={(e) => startImageEdgeResize(bgImg.id, "top", e)}
                        onTouchStart={(e) => startImageEdgeResize(bgImg.id, "top", e)}
                        className="absolute bg-blue-600 border-2 border-white rounded-full shadow"
                        style={{ top: -6, left: "50%", width: 24, height: 12, marginLeft: -12, cursor: "ns-resize", transform: `scale(${1 / zoom})` }}
                        title="Drag to stretch height (top edge only)"
                      />

                      {/* Corner handles: resize width AND height independently at once (a true diagonal
                          drag), unlike the single-axis edge handles above. */}
                      <div
                        onMouseDown={(e) => startImageEdgeResize(bgImg.id, "top-left", e)}
                        onTouchStart={(e) => startImageEdgeResize(bgImg.id, "top-left", e)}
                        className="absolute bg-violet-600 border-2 border-white rounded-full shadow"
                        style={{ left: -6, top: -6, width: 13, height: 13, cursor: "nwse-resize", transform: `scale(${1 / zoom})` }}
                        title="Drag diagonally to resize width and height together (independently, not locked to proportions)"
                      />
                      <div
                        onMouseDown={(e) => startImageEdgeResize(bgImg.id, "top-right", e)}
                        onTouchStart={(e) => startImageEdgeResize(bgImg.id, "top-right", e)}
                        className="absolute bg-violet-600 border-2 border-white rounded-full shadow"
                        style={{ right: -6, top: -6, width: 13, height: 13, cursor: "nesw-resize", transform: `scale(${1 / zoom})` }}
                        title="Drag diagonally to resize width and height together (independently, not locked to proportions)"
                      />
                      <div
                        onMouseDown={(e) => startImageEdgeResize(bgImg.id, "bottom-left", e)}
                        onTouchStart={(e) => startImageEdgeResize(bgImg.id, "bottom-left", e)}
                        className="absolute bg-violet-600 border-2 border-white rounded-full shadow"
                        style={{ left: -6, bottom: -6, width: 13, height: 13, cursor: "nesw-resize", transform: `scale(${1 / zoom})` }}
                        title="Drag diagonally to resize width and height together (independently, not locked to proportions)"
                      />
                      <div
                        onMouseDown={(e) => startImageEdgeResize(bgImg.id, "bottom-right", e)}
                        onTouchStart={(e) => startImageEdgeResize(bgImg.id, "bottom-right", e)}
                        className="absolute bg-violet-600 border-2 border-white rounded-full shadow"
                        style={{ right: -6, bottom: -6, width: 13, height: 13, cursor: "nwse-resize", transform: `scale(${1 / zoom})` }}
                        title="Drag diagonally to resize width and height together (independently, not locked to proportions)"
                      />

                      {/* Proportional handle — sits just inside the corner (not on it) so it doesn't
                          overlap the free-diagonal corner handle above. */}
                      <div
                        onMouseDown={(e) => startImageResize(bgImg.id, e)}
                        onTouchStart={(e) => startImageResize(bgImg.id, e)}
                        className="absolute bg-emerald-600 border-2 border-white rounded-full shadow"
                        style={{
                          right: 6,
                          bottom: 6,
                          width: 14,
                          height: 14,
                          cursor: "nwse-resize",
                          transform: `scale(${1 / zoom})`,
                          transformOrigin: "bottom right",
                        }}
                        title="Drag to resize (keeps the image's proportions)"
                      />
                    </>
                  )}
                </div>
              ))}
            {beds.length === 0 && plants.length === 0 && backgroundImages.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-stone-400 text-sm px-6 text-center pointer-events-none">
                Your map is empty. Add a bed or a freestanding plant on the left to get started.
              </div>
            )}

            {/* Layer: light zones (drawn under beds) */}
            {showLightZones && lightZones.map((zone) => {
              const style = LIGHT_ZONE_STYLES[zone.sunExposure] || LIGHT_ZONE_STYLES.full_sun;
              const boxWidthPx = zone.widthFt * FT_TO_PX;
              const boxHeightPx = zone.lengthFt * FT_TO_PX;
              const polyString = zone.points.map((p) => `${p.x * FT_TO_PX},${p.y * FT_TO_PX}`).join(" ");
              return (
                <div key={zone.id} className="absolute" style={{ left: zone.x, top: zone.y, width: boxWidthPx, height: boxHeightPx }}>
                  <svg className="absolute inset-0 pointer-events-none" width={boxWidthPx} height={boxHeightPx} style={{ overflow: "visible" }}>
                    <polygon
                      points={polyString}
                      className={`${style.fill} opacity-50`}
                      stroke="rgba(30,41,59,0.5)"
                      strokeWidth="2"
                      strokeDasharray="6 4"
                    />
                  </svg>
                  <div
                    onMouseDown={(e) => startDrag("zone", zone.id, e)}
                    onTouchStart={(e) => startDrag("zone", zone.id, e)}
                    className={`absolute top-0 left-0 inline-flex items-center gap-1 text-xs mono-label px-2 py-0.5 rounded-full border cursor-grab active:cursor-grabbing ${style.badge}`}
                  >
                    {SUN_EXPOSURES[zone.sunExposure]}
                    <button
                      onClick={() => deleteLightZone(zone.id)}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="hover:text-red-600 p-0.5 -m-0.5"
                      title="Delete zone"
                    >
                      <X size={10} />
                    </button>
                  </div>
                </div>
              );
            })}

            {/* Landscape features (paths, patios, water features, structures) — hand-drawn shapes
                like a bed, but deliberately styled to look unmistakably non-plantable: a diagonal
                hatch fill (defined per-feature since each SVG <pattern> needs its own unique id)
                over a muted, stone-toned palette, rather than the soil texture and green accents
                beds use or the color washes light zones use. */}
            {/* Layer: landscape site features */}
            {showSiteFeatures && siteFeatures.map((feature) => {
              const kindInfo = SITE_FEATURE_KINDS[feature.kind] || SITE_FEATURE_KINDS.other;
              const boxWidthPx = feature.widthFt * FT_TO_PX;
              const boxHeightPx = feature.lengthFt * FT_TO_PX;
              const polyString = feature.points.map((p) => `${p.x * FT_TO_PX},${p.y * FT_TO_PX}`).join(" ");
              const patternId = `feature-hatch-${feature.id}`;
              return (
                <div key={feature.id} className="absolute" style={{ left: feature.x, top: feature.y, width: boxWidthPx, height: boxHeightPx }}>
                  <svg className="absolute inset-0 pointer-events-none" width={boxWidthPx} height={boxHeightPx} style={{ overflow: "visible" }}>
                    <defs>
                      <pattern id={patternId} patternUnits="userSpaceOnUse" width="10" height="10" patternTransform="rotate(45)">
                        <rect width="10" height="10" fill={kindInfo.accent} fillOpacity="0.15" />
                        <line x1="0" y1="0" x2="0" y2="10" stroke={kindInfo.accent} strokeWidth="3" strokeOpacity="0.55" />
                      </pattern>
                    </defs>
                    <polygon points={polyString} fill={`url(#${patternId})`} stroke={kindInfo.accent} strokeWidth="2" strokeDasharray="4 3" />
                  </svg>
                  <div
                    onMouseDown={(e) => startDrag("feature", feature.id, e)}
                    onTouchStart={(e) => startDrag("feature", feature.id, e)}
                    title={`${feature.name} (${kindInfo.label}) — drag to move`}
                    className="absolute top-0 left-0 inline-flex items-center gap-1 text-xs mono-label px-2 py-0.5 rounded-full border cursor-grab active:cursor-grabbing bg-stone-100 border-stone-400 text-stone-700"
                  >
                    <span>{kindInfo.icon}</span>
                    {feature.name}
                    <button
                      onClick={() => setEditingFeature(feature)}
                      onMouseDown={(e) => e.stopPropagation()}
                      onTouchStart={(e) => e.stopPropagation()}
                      className="hover:text-emerald-700 p-0.5 -m-0.5"
                      title="Edit this feature"
                    >
                      <Pencil size={10} />
                    </button>
                    <button
                      onClick={() => startCanvasDrawForFeatureShape(feature.id)}
                      onMouseDown={(e) => e.stopPropagation()}
                      onTouchStart={(e) => e.stopPropagation()}
                      className="hover:text-emerald-700 p-0.5 -m-0.5"
                      title="Reshape this feature"
                    >
                      <PenTool size={10} />
                    </button>
                    <button
                      onClick={() => deleteSiteFeature(feature.id)}
                      onMouseDown={(e) => e.stopPropagation()}
                      onTouchStart={(e) => e.stopPropagation()}
                      className="hover:text-red-600 p-0.5 -m-0.5"
                      title="Delete this feature"
                    >
                      <X size={10} />
                    </button>
                  </div>
                </div>
              );
            })}

            {/* Layer: beds. MemoBedCard is memoised; handlers come from useStableHandlers so only the dragged bed re-renders */}
            {beds.map((bed) => (
              <MemoBedCard
                key={bed.id}
                bed={bed}
                lightZones={lightZones}
                renaming={renaming}
                setRenaming={setRenaming}
                renameInputRef={renameInputRef}
                commitRename={bedHandlers.commitRename}
                startRename={bedHandlers.startRename}
                bedPlantInputs={bedPlantInputs}
                crowdedNotice={crowdedBedNotice === bed.id}
                setBedPlantInputs={setBedPlantInputs}
                addPlantToBed={bedHandlers.addPlantToBed}
                fillBedInputs={fillBedInputs}
                setFillBedInputs={setFillBedInputs}
                setPlantFillTool={setPlantFillTool}
                ejectPlantFromBed={bedHandlers.ejectPlantFromBed}
                deletePlantFromBed={bedHandlers.deletePlantFromBed}
                setEditingPlant={setEditingPlant}
                setEditingBed={setEditingBed}
                startCanvasDrawForBedShape={bedHandlers.startCanvasDrawForBedShape}
                duplicateBed={bedHandlers.duplicateBed}
                deleteBed={bedHandlers.deleteBed}
                startDrag={bedHandlers.startDrag}
                startResizeDrag={bedHandlers.startResizeDrag}
                startBedPlantDrag={bedHandlers.startBedPlantDrag}
                startPlantBoxDrag={bedHandlers.startPlantBoxDrag}
                startPlacedBoxResize={bedHandlers.startPlacedBoxResize}
                mergeBoxes={bedHandlers.mergeBoxes}
                unmergeBoxes={bedHandlers.unmergeBoxes}
                startPlantChipFillDrag={bedHandlers.startPlantChipFillDrag}
                plantFillTool={plantFillTool}
                selectionModeBedId={selectionModeBedId}
                selectedPlantIds={selectedPlantIds}
                toggleSelectionMode={bedHandlers.toggleSelectionMode}
                togglePlantSelection={bedHandlers.togglePlantSelection}
                selectAllInBed={bedHandlers.selectAllInBed}
                selectPlantsInRect={bedHandlers.selectPlantsInRect}
                bulkSetPlantsLocked={bedHandlers.bulkSetPlantsLocked}
                bulkDeletePlants={bedHandlers.bulkDeletePlants}
                yearHistory={yearHistory}
                clearBedHistory={bedHandlers.clearBedHistory}
                zoom={zoom}
              />
            ))}

            {/* Layer: fill-tool preview — shows where plants would be placed in the target bed */}
            {plantFillTool &&
              (() => {
                const targetBed = beds.find((b) => b.id === plantFillTool.bedId);
                if (!targetBed) return null;
                const spacingFt = plantFillTool.spacingIn / 12;
                const cols = Math.max(1, Math.floor(plantFillTool.boxWidthFt / spacingFt));
                const rows = Math.max(1, Math.floor(plantFillTool.boxHeightFt / spacingFt));
                const cellWFt = plantFillTool.boxWidthFt / cols;
                const cellHFt = plantFillTool.boxHeightFt / rows;
                const boxLeftPx = targetBed.x + plantFillTool.boxX * FT_TO_PX;
                const boxTopPx = targetBed.y + plantFillTool.boxY * FT_TO_PX;
                const boxWidthPx = plantFillTool.boxWidthFt * FT_TO_PX;
                const boxHeightPx = plantFillTool.boxHeightFt * FT_TO_PX;
                // Marker size is 70% of the smaller grid cell dimension, leaving a visible gap
                // between markers so the grid reads clearly rather than as a solid mass.
                const markerSizePx = Math.min(cellWFt, cellHFt) * FT_TO_PX * 0.7;

                // For non-rectangular beds, a marker only counts if its center actually falls
                // inside the bed's real shape — not just its bounding box — so a box placed over a
                // circular or custom bed doesn't get credited with corner area it doesn't have.
                // Overlapping existing plants is allowed on purpose (for companion planting) —
                // surfaced via the plant-box overlap note/coloring instead of being blocked here.
                const markers = [];
                for (let r = 0; r < rows; r++) {
                  for (let c = 0; c < cols; c++) {
                    const cellCenterXFt = plantFillTool.boxX + (c + 0.5) * cellWFt;
                    const cellCenterYFt = plantFillTool.boxY + (r + 0.5) * cellHFt;
                    let fits = true;
                    if (targetBed.shape === "circle_oval") {
                      fits = isInsideEllipse(cellCenterXFt, cellCenterYFt, targetBed.widthFt, targetBed.lengthFt);
                    } else if (targetBed.shape === "custom_points" && targetBed.customPoints && targetBed.customPoints.length >= 3) {
                      fits = isInsidePolygon(cellCenterXFt, cellCenterYFt, targetBed.customPoints);
                    }
                    if (fits) markers.push({ r, c });
                  }
                }
                const count = markers.length;
                // Convert each marker's grid cell into an actual position (feet, relative to the
                // bed's own origin) so a confirmed fill places plants exactly where their preview
                // dots were shown, not just an unpositioned count.
                const positions = markers.map(({ r, c }) => ({
                  x: plantFillTool.boxX + (c + 0.5) * cellWFt,
                  y: plantFillTool.boxY + (r + 0.5) * cellHFt,
                }));

                return (
                  <Fragment>
                    <div
                      onMouseDown={startPlantBoxMove}
                      onTouchStart={startPlantBoxMove}
                      className="absolute border-2 border-emerald-600 bg-emerald-600/10 cursor-grab active:cursor-grabbing z-20"
                      style={{ left: boxLeftPx, top: boxTopPx, width: boxWidthPx, height: boxHeightPx }}
                    >
                      {markers
                        .filter(({ r, c }) => !(r === 0 && c === 0)) // the (0,0) cell is the sample marker below, not a regular dot
                        .map(({ r, c }) => (
                          <div
                            key={`${r}-${c}`}
                            className="absolute rounded-full bg-emerald-600 pointer-events-none"
                            style={{
                              left: (c + 0.5) * cellWFt * FT_TO_PX - markerSizePx / 2,
                              top: (r + 0.5) * cellHFt * FT_TO_PX - markerSizePx / 2,
                              width: markerSizePx,
                              height: markerSizePx,
                            }}
                          />
                        ))}
                      {/* The one plant's spacing footprint, shown at full size (not the smaller dot
                          size) and in a different color, so it reads as a distinct, adjustable
                          control rather than just another marker in the grid. */}
                      <div
                        className="absolute rounded-full bg-blue-600/70 border-2 border-blue-700"
                        style={{ left: 0, top: 0, width: cellWFt * FT_TO_PX, height: cellHFt * FT_TO_PX }}
                      >
                        <div
                          onMouseDown={startPlantUnitResize}
                          onTouchStart={startPlantUnitResize}
                          className="absolute bg-blue-700 border-2 border-white rounded-full shadow"
                          style={{
                            right: -6,
                            bottom: -6,
                            width: 14,
                            height: 14,
                            cursor: "nwse-resize",
                            transform: `scale(${1 / zoom})`,
                            transformOrigin: "bottom right",
                          }}
                          title="Drag to change the spacing itself (how much room one plant needs) — separate from the box's own size"
                        />
                      </div>
                      <div
                        onMouseDown={startPlantBoxResize}
                        onTouchStart={startPlantBoxResize}
                        className="absolute bg-emerald-700 border-2 border-white rounded-full shadow"
                        style={{
                          right: -7,
                          bottom: -7,
                          width: 16,
                          height: 16,
                          cursor: "nwse-resize",
                          transform: `scale(${1 / zoom})`,
                          transformOrigin: "bottom right",
                        }}
                        title="Drag to resize the box — the grid updates to show how many fit"
                      />
                    </div>
                    <div
                      className="absolute z-30 flex items-center gap-2 bg-white border border-stone-300 rounded-lg shadow-md px-3 py-2 text-sm whitespace-nowrap"
                      style={{ left: boxLeftPx, top: boxTopPx + boxHeightPx + 8 }}
                    >
                      <span className="text-stone-700">
                        {count} {plantFillTool.plantName}
                        {count === 1 ? "" : "s"}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          fillBedAtSpacing(
                            plantFillTool.bedId,
                            plantFillTool.plantName,
                            positions,
                            plantFillTool.spacingIn,
                            { x: plantFillTool.boxX, y: plantFillTool.boxY, widthFt: plantFillTool.boxWidthFt, heightFt: plantFillTool.boxHeightFt },
                            plantFillTool.replacingPlantId
                          );
                          setPlantFillTool(null);
                        }}
                        className="bg-emerald-700 hover:bg-emerald-800 text-white rounded px-2 py-1 text-xs"
                      >
                        {plantFillTool.replacingPlantId ? "Fill" : "Add"}
                      </button>
                      <button type="button" onClick={() => setPlantFillTool(null)} className="text-stone-500 hover:text-stone-800 text-xs underline">
                        Cancel
                      </button>
                    </div>
                  </Fragment>
                );
              })()}

            {/* Layer: freestanding plants (not inside a bed) */}
            {plants.map((plant) => {
              const isRenaming = renaming && renaming.scope === "free" && renaming.plantId === plant.id;
              return (
                <div
                  key={plant.id}
                  className="absolute bg-white border border-stone-400 rounded-full shadow-sm flex items-center gap-1.5 pl-3 pr-1.5 py-1 cursor-grab active:cursor-grabbing"
                  style={{ left: plant.x, top: plant.y }}
                  onMouseDown={(e) => startDrag("plant", plant.id, e)}
                  onTouchStart={(e) => startDrag("plant", plant.id, e)}
                >
                  <Sprout size={13} className="text-emerald-700 shrink-0" />
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      value={renaming.text}
                      onChange={(e) => setRenaming((r) => ({ ...r, text: e.target.value }))}
                      onBlur={commitRename}
                      onMouseDown={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      className="w-20 border border-stone-300 rounded px-1 text-xs focus:outline-none"
                    />
                  ) : (
                    <>
                      <span className="text-xs text-stone-800 whitespace-nowrap">
                        {plant.name}
                        {plant.cultivar && <span className="text-stone-500 italic"> ({plant.cultivar})</span>}
                      </span>
                      <button
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => startRename("free", null, plant.id, plant.name)}
                        className="text-stone-400 hover:text-stone-700 shrink-0 p-1 -m-1"
                        title="Rename plant"
                      >
                        <Pencil size={11} />
                      </button>
                    </>
                  )}
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => setEditingPlant({ scope: "free", bedId: null, plantId: plant.id })}
                    className="text-stone-400 hover:text-stone-700 shrink-0 p-1 -m-1"
                    title="Light, water & temperature needs"
                  >
                    <Info size={12} />
                  </button>
                  {beds.length > 0 && (
                    <select
                      onMouseDown={(e) => e.stopPropagation()}
                      onChange={(e) => movePlantToBed(plant.id, e.target.value)}
                      value=""
                      className="text-xs border border-stone-200 rounded bg-stone-50 focus:outline-none"
                      title="Move into a bed"
                    >
                      <option value="">→ bed</option>
                      {beds.map((b) => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                  )}
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => deleteFreestandingPlant(plant.id)}
                    className="text-stone-400 hover:text-red-600 shrink-0 p-1 -m-1"
                    title="Delete plant"
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}

            {/* Layer: freehand/polygon drawing overlay shown while canvasDraw is active */}
            {canvasDraw && (
              <svg
                className="absolute top-0 left-0"
                width={contentWidth}
                height={canvasHeight}
                style={{ overflow: "visible", cursor: "crosshair" }}
                onClick={handleDrawOverlayClick}
              >
                <rect x="0" y="0" width={contentWidth} height={canvasHeight} fill="rgba(15,23,42,0.06)" />
                {canvasDraw.points.length >= 2 && (
                  <polygon
                    points={canvasDraw.points.map((p) => `${p.x},${p.y}`).join(" ")}
                    className={canvasDraw.kind === "zone" ? "fill-cyan-400/30 stroke-cyan-600" : canvasDraw.kind === "feature" ? "fill-stone-400/30 stroke-stone-600" : "fill-emerald-400/30 stroke-emerald-600"}
                    strokeWidth="2"
                    strokeDasharray="6 4"
                  />
                )}
                {canvasDraw.points.map((p, i) => (
                  <circle
                    key={i}
                    cx={p.x}
                    cy={p.y}
                    r="6"
                    className={canvasDraw.kind === "zone" ? "fill-cyan-600" : canvasDraw.kind === "feature" ? "fill-stone-600" : "fill-emerald-600"}
                    stroke="white"
                    strokeWidth="2"
                    style={{ cursor: "grab" }}
                    onMouseDown={(e) => startDrawPointDrag(i, e)}
                    onTouchStart={(e) => startDrawPointDrag(i, e)}
                  />
                ))}
                {canvasDraw.points.length === 0 && (
                  <text x={contentWidth / 2} y={40} textAnchor="middle" className="fill-stone-500 text-sm">
                    Click anywhere on the map to place your first point
                  </text>
                )}
              </svg>
            )}
              </div>
            </div>
          </div>
          <div
            onMouseDown={(e) => startViewportResize("right", e)}
            onTouchStart={(e) => startViewportResize("right", e)}
            className="absolute top-0 bottom-0 right-0 w-3 cursor-ew-resize hover:bg-emerald-600/25 rounded-r-xl z-10"
            title="Drag anywhere along this edge to change just the width"
          />
          <div
            onMouseDown={(e) => startViewportResize("bottom", e)}
            onTouchStart={(e) => startViewportResize("bottom", e)}
            className="absolute left-0 right-0 bottom-0 h-3 cursor-ns-resize hover:bg-emerald-600/25 rounded-b-xl z-10"
            title="Drag anywhere along this edge to change just the height"
          />
          <div
            onMouseDown={(e) => startViewportResize("corner", e)}
            onTouchStart={(e) => startViewportResize("corner", e)}
            className="absolute bottom-1 right-1 w-4 h-4 cursor-nwse-resize flex items-end justify-end z-20"
            title="Drag to resize both width and height at once"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" className="text-stone-400">
              <path d="M11 1L1 11M11 5.5L5.5 11M11 10L10 11" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
            </svg>
          </div>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
