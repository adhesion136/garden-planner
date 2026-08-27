import { useState, useEffect, useRef, useCallback } from "react";
import {
  Trash2, Plus, X, ArrowUpRightFromCircle, Sprout, MapPin,
  PenTool, Undo2, RotateCcw, Check, Edit3, Copy, ChevronDown, ChevronRight, Pencil,
  ZoomIn, ZoomOut, Download, Upload, Info, AlertTriangle, Sun,
} from "lucide-react";

const STORAGE_KEY = "garden-planner-v1";
const FT_TO_PX = 14;
const EDITOR_FT_TO_PX = 20;
const EDITOR_WIDTH = 520;
const EDITOR_HEIGHT = 380;

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

const YARD_LOCATIONS = {
  front: "Front yard",
  back: "Back yard",
  side: "Side yard",
  middle: "Middle / interior of yard",
  container: "Container / patio",
  indoor: "Indoor",
  unknown: "Unknown",
};

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

const SUN_EXPOSURES = {
  full_sun: "Full sun (6+ hrs direct)",
  part_sun: "Part sun / part shade (3-6 hrs)",
  full_shade: "Full shade (<3 hrs)",
  unknown: "Unknown / not tracked yet",
};

const BED_SHAPES = {
  rectangle: "Rectangle",
  circle_oval: "Circle / oval",
  irregular: "Irregular (quick estimate)",
  custom_points: "Custom — draw it yourself",
};

const USDA_ZONES = (() => {
  const zones = { unset: "Not set yet", international: "International / not sure (describe below)" };
  for (let z = 1; z <= 13; z++) {
    zones[`${z}a`] = `Zone ${z}a`;
    zones[`${z}b`] = `Zone ${z}b`;
  }
  return zones;
})();

const WATER_NEEDS = {
  low: "Low (drought-tolerant)",
  medium: "Medium (regular watering)",
  high: "High (keep consistently moist)",
  unknown: "Unknown / not tracked yet",
};

const TEMP_PREFERENCES = {
  cold_hardy: "Cold-hardy",
  average: "Average / no special needs",
  heat_loving: "Heat-loving",
  frost_tender: "Frost-tender (protect from cold)",
  unknown: "Unknown / not tracked yet",
};

let idCounter = 1;
const nextId = () => `id-${Date.now()}-${idCounter++}`;

const LIGHT_ZONE_STYLES = {
  full_sun: { fill: "fill-amber-300", badge: "bg-amber-100 text-amber-800 border-amber-300" },
  part_sun: { fill: "fill-orange-300", badge: "bg-orange-100 text-orange-800 border-orange-300" },
  full_shade: { fill: "fill-slate-400", badge: "bg-slate-200 text-slate-800 border-slate-400" },
};

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

function lightMismatch(bedSunExposure, plantLight) {
  if (!bedSunExposure || !plantLight) return null;
  if (bedSunExposure === "unknown" || plantLight === "unknown") return null;
  if (bedSunExposure === plantLight) return null;
  return `This bed gets ${SUN_EXPOSURES[bedSunExposure]}, but this plant prefers ${SUN_EXPOSURES[plantLight]}.`;
}

function migratePlant(plant) {
  if (plant.light && plant.water && plant.temp && plant.cultivar !== undefined) return plant;
  return {
    ...plant,
    light: plant.light || "unknown",
    water: plant.water || "unknown",
    temp: plant.temp || "unknown",
    cultivar: plant.cultivar || "",
  };
}

function migrateBed(bed) {
  const migratedPlants = (bed.plants || []).map(migratePlant);
  if (bed.soilType && bed.bedStructure && bed.sunExposure && bed.shape && bed.sunExposureSource) {
    return bed.plants === migratedPlants ? bed : { ...bed, plants: migratedPlants };
  }
  const legacyMap = { clay: "clay", mixed: "mixed", loam: "loamy" };
  const sunExposure = bed.sunExposure || "unknown";
  return {
    ...bed,
    soilType: bed.soilType || legacyMap[bed.soilZone] || "unknown",
    yardLocation: bed.yardLocation || "unknown",
    bedStructure: bed.bedStructure || "unknown",
    sunExposure,
    // Existing beds that already had a real value are assumed to be the user's own choice (manual, locked).
    // Beds still on "Unknown" are left open for the light-zone auto-suggestion to fill in.
    sunExposureSource: bed.sunExposureSource || (sunExposure === "unknown" ? "unset" : "manual"),
    shape: bed.shape || "rectangle",
    approxSqFt: bed.approxSqFt || Math.round((bed.widthFt || 1) * (bed.lengthFt || 1)),
    customPoints: bed.customPoints || null,
    plants: migratedPlants,
  };
}

function polygonAreaFt(pointsFt) {
  let sum = 0;
  for (let i = 0; i < pointsFt.length; i++) {
    const a = pointsFt[i];
    const b = pointsFt[(i + 1) % pointsFt.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum / 2);
}

function normalizePoints(pointsPx) {
  if (pointsPx.length === 0) return { points: [], widthFt: 1, lengthFt: 1, approxSqFt: 1 };
  const xs = pointsPx.map((p) => p.x);
  const ys = pointsPx.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const pointsFt = pointsPx.map((p) => ({
    x: Math.round(((p.x - minX) / EDITOR_FT_TO_PX) * 10) / 10,
    y: Math.round(((p.y - minY) / EDITOR_FT_TO_PX) * 10) / 10,
  }));
  const widthFt = Math.max(1, Math.round(((maxX - minX) / EDITOR_FT_TO_PX) * 10) / 10);
  const lengthFt = Math.max(1, Math.round(((maxY - minY) / EDITOR_FT_TO_PX) * 10) / 10);
  const approxSqFt = Math.max(1, Math.round(polygonAreaFt(pointsFt)));
  return { points: pointsFt, widthFt, lengthFt, approxSqFt };
}

// Turns a working bed-form-like object into final stored dimensions.
function computeDimensions(v) {
  if (v.shape === "custom_points" && v.customShape) {
    return {
      widthFt: v.customShape.widthFt,
      lengthFt: v.customShape.lengthFt,
      approxSqFt: v.customShape.approxSqFt,
      customPoints: v.customShape.points,
    };
  }
  if (v.shape === "irregular") {
    const approxSqFt = Math.max(1, Number(v.approxSqFt) || 1);
    const side = Math.sqrt(approxSqFt);
    return { widthFt: side, lengthFt: side, approxSqFt, customPoints: null };
  }
  const widthFt = Math.max(1, Number(v.width) || 1);
  const lengthFt = Math.max(1, Number(v.length) || 1);
  return { widthFt, lengthFt, approxSqFt: Math.round(widthFt * lengthFt), customPoints: null };
}

function bedToFormValues(bed) {
  return {
    name: bed.name,
    shape: bed.shape,
    width: bed.widthFt,
    length: bed.lengthFt,
    approxSqFt: bed.approxSqFt,
    customShape:
      bed.shape === "custom_points" && bed.customPoints
        ? { points: bed.customPoints, widthFt: bed.widthFt, lengthFt: bed.lengthFt, approxSqFt: bed.approxSqFt }
        : null,
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
  customShape: null,
  soilType: "unknown",
  yardLocation: "unknown",
  bedStructure: "unknown",
  sunExposure: "unknown",
  sunExposureSource: "unset",
});

function ShapeEditor({ initialPointsFt, onCancel, onSave }) {
  const editorRef = useRef(null);
  const draggingIndexRef = useRef(null);
  const suppressClickRef = useRef(false);
  const [points, setPoints] = useState(() =>
    (initialPointsFt || []).map((p) => ({ x: p.x * EDITOR_FT_TO_PX + 20, y: p.y * EDITOR_FT_TO_PX + 20 }))
  );

  const getLocalPos = (e) => {
    const rect = editorRef.current.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const handleBackgroundClick = (e) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const pos = getLocalPos(e);
    setPoints((prev) => [...prev, pos]);
  };

  const startPointDrag = (index, e) => {
    e.stopPropagation();
    e.preventDefault();
    draggingIndexRef.current = index;
    window.addEventListener("mousemove", onPointMove);
    window.addEventListener("mouseup", onPointUp);
    window.addEventListener("touchmove", onPointMove, { passive: false });
    window.addEventListener("touchend", onPointUp);
  };

  const onPointMove = (e) => {
    if (draggingIndexRef.current === null) return;
    e.preventDefault();
    const pos = getLocalPos(e);
    const rect = editorRef.current.getBoundingClientRect();
    pos.x = Math.max(0, Math.min(rect.width, pos.x));
    pos.y = Math.max(0, Math.min(rect.height, pos.y));
    const idx = draggingIndexRef.current;
    setPoints((prev) => prev.map((p, i) => (i === idx ? pos : p)));
  };

  const onPointUp = () => {
    draggingIndexRef.current = null;
    suppressClickRef.current = true;
    window.removeEventListener("mousemove", onPointMove);
    window.removeEventListener("mouseup", onPointUp);
    window.removeEventListener("touchmove", onPointMove);
    window.removeEventListener("touchend", onPointUp);
  };

  const undoLast = () => setPoints((prev) => prev.slice(0, -1));
  const clearAll = () => setPoints([]);

  const canSave = points.length >= 3;
  const liveStats = canSave ? normalizePoints(points) : null;
  const polyString = points.map((p) => `${p.x},${p.y}`).join(" ");

  return (
    <div className="fixed inset-0 bg-stone-900/60 flex items-start sm:items-center justify-center z-50 p-2 sm:p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full p-4 sm:p-5 my-4 sm:my-8">
        <h3 className="fraunces text-xl flex items-center gap-2 mb-1">
          <PenTool size={18} className="text-emerald-700" /> Draw your bed shape
        </h3>
        <p className="text-xs text-stone-500 mb-3">
          Click to drop a point, then click again to keep adding corners. Drag any point to adjust it. You need at least 3 points to save.
        </p>

        <div className="overflow-x-auto -mx-1 px-1 pb-1">
          <div
            ref={editorRef}
            onClick={handleBackgroundClick}
            className="relative bg-stone-100 border border-stone-300 rounded-lg overflow-hidden mx-auto"
            style={{
              width: EDITOR_WIDTH,
              height: EDITOR_HEIGHT,
              backgroundImage:
                "linear-gradient(rgba(120,113,90,0.15) 1px, transparent 1px), linear-gradient(90deg, rgba(120,113,90,0.15) 1px, transparent 1px)",
              backgroundSize: `${EDITOR_FT_TO_PX * 2}px ${EDITOR_FT_TO_PX * 2}px`,
              cursor: "crosshair",
              touchAction: "none",
            }}
          >
            <svg width="100%" height="100%" className="absolute inset-0 pointer-events-none">
              {points.length >= 2 && (
                <polygon points={polyString} className="fill-emerald-700/25 stroke-emerald-700" strokeWidth="2" />
              )}
            </svg>
            {points.map((p, i) => (
              <div
                key={i}
                onMouseDown={(e) => startPointDrag(i, e)}
                onTouchStart={(e) => startPointDrag(i, e)}
                className="absolute w-3.5 h-3.5 -ml-2 -mt-2 rounded-full bg-emerald-700 border-2 border-white shadow cursor-grab active:cursor-grabbing"
                style={{ left: p.x, top: p.y }}
                title={`Point ${i + 1}`}
              />
            ))}
            {points.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-stone-400 text-sm pointer-events-none">
                Click anywhere to place your first point
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
          <div className="flex gap-2">
            <button onClick={undoLast} disabled={points.length === 0} className="flex items-center gap-1 text-xs border border-stone-300 rounded-lg px-3 py-1.5 hover:bg-stone-50 disabled:opacity-40">
              <Undo2 size={13} /> Undo point
            </button>
            <button onClick={clearAll} disabled={points.length === 0} className="flex items-center gap-1 text-xs border border-stone-300 rounded-lg px-3 py-1.5 hover:bg-stone-50 disabled:opacity-40">
              <RotateCcw size={13} /> Clear all
            </button>
          </div>
          <div className="mono-label text-xs text-stone-500">
            {liveStats ? `~${liveStats.approxSqFt} sq ft · ${liveStats.widthFt}ft × ${liveStats.lengthFt}ft box` : `${points.length} point${points.length === 1 ? "" : "s"} — need 3+`}
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onCancel} className="text-sm px-4 py-2 rounded-lg border border-stone-300 hover:bg-stone-50">
            Cancel
          </button>
          <button
            onClick={() => canSave && onSave(normalizePoints(points))}
            disabled={!canSave}
            className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-40"
          >
            <Check size={15} /> Save shape
          </button>
        </div>
      </div>
    </div>
  );
}

// Shared field set used by both the "Add a bed" sidebar form and the edit modal.
function BedFields({ values, setValues, onOpenShapeEditor, nameError }) {
  const [showMore, setShowMore] = useState(false);
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
          onChange={(e) => set({ shape: e.target.value, customShape: e.target.value === "custom_points" ? values.customShape : null })}
          className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
        >
          {Object.entries(BED_SHAPES).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        {values.shape !== "custom_points" && (
          <p className="text-xs text-stone-400 mt-1">
            Circle/oval and quick-estimate shapes show as an approximate outline. Pick "Custom" to place exact points instead.
          </p>
        )}
      </div>

      {values.shape === "custom_points" ? (
        <div>
          <button
            type="button"
            onClick={onOpenShapeEditor}
            className="w-full flex items-center justify-center gap-2 border border-emerald-700 text-emerald-700 rounded-lg py-2 text-sm font-medium hover:bg-emerald-50"
          >
            <PenTool size={15} />
            {values.customShape ? "Edit your drawn shape" : "Open shape editor"}
          </button>
          {values.customShape && (
            <p className="text-xs text-stone-500 mt-1.5">
              ~{values.customShape.approxSqFt} sq ft · {values.customShape.widthFt}ft × {values.customShape.lengthFt}ft box · {values.customShape.points.length} points
            </p>
          )}
        </div>
      ) : values.shape === "irregular" ? (
        <div>
          <label className="text-xs mono-label text-stone-500 block mb-1">Approx. size (sq ft)</label>
          <input
            type="number"
            min="1"
            value={values.approxSqFt}
            onChange={(e) => set({ approxSqFt: e.target.value })}
            className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
          />
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

function PlantDetailsModal({ plantName, initialValues, onCancel, onSave }) {
  const [light, setLight] = useState(initialValues.light || "unknown");
  const [water, setWater] = useState(initialValues.water || "unknown");
  const [temp, setTemp] = useState(initialValues.temp || "unknown");
  const [cultivar, setCultivar] = useState(initialValues.cultivar || "");

  return (
    <div className="fixed inset-0 bg-stone-900/60 flex items-start sm:items-center justify-center z-50 p-2 sm:p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-4 sm:p-5 my-4 sm:my-8">
        <h3 className="fraunces text-xl flex items-center gap-2 mb-1">
          <Sprout size={18} className="text-emerald-700" /> {plantName}
        </h3>
        <p className="text-xs text-stone-500 mb-3">Plant-specific needs, separate from the bed it's sitting in.</p>
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
              {Object.entries(SUN_EXPOSURES).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs mono-label text-stone-500 block mb-1">Water needs</label>
            <select
              value={water}
              onChange={(e) => setWater(e.target.value)}
              className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
            >
              {Object.entries(WATER_NEEDS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs mono-label text-stone-500 block mb-1">Temperature preference</label>
            <select
              value={temp}
              onChange={(e) => setTemp(e.target.value)}
              className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
            >
              {Object.entries(TEMP_PREFERENCES).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onCancel} className="text-sm px-4 py-2 rounded-lg border border-stone-300 hover:bg-stone-50">
            Cancel
          </button>
          <button
            onClick={() => onSave({ light, water, temp, cultivar: cultivar.trim() })}
            className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white"
          >
            <Check size={15} /> Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

function EditBedModal({ bed, onCancel, onSave, onOpenShapeEditor }) {
  const [values, setValues] = useState(() => bedToFormValues(bed));
  return (
    <div className="fixed inset-0 bg-stone-900/60 flex items-start sm:items-center justify-center z-50 p-2 sm:p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-4 sm:p-5 my-4 sm:my-8">
        <h3 className="fraunces text-xl flex items-center gap-2 mb-3">
          <Edit3 size={18} className="text-emerald-700" /> Edit bed
        </h3>
        <BedFields values={values} setValues={setValues} onOpenShapeEditor={() => onOpenShapeEditor(values, setValues)} />
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

export default function GardenPlanner() {
  const [beds, setBeds] = useState([]);
  const [plants, setPlants] = useState([]);
  const [zone, setZone] = useState("unset");
  const [zoneCustomText, setZoneCustomText] = useState("");
  const [zipInput, setZipInput] = useState("");
  const [zipStatus, setZipStatus] = useState("idle");
  const [lightZones, setLightZones] = useState([]);
  const [zoneForm, setZoneForm] = useState({ sunExposure: "full_sun", customShape: null }); // idle | loading | error
  const [loaded, setLoaded] = useState(false);
  const [bedForm, setBedForm] = useState(blankFormValues());
  const [bedNameError, setBedNameError] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [baseWidth, setBaseWidth] = useState(800);
  const canvasOuterRef = useRef(null);
  const importInputRef = useRef(null);
  const [importError, setImportError] = useState("");
  const [plantName, setPlantName] = useState("");
  const [bedPlantInputs, setBedPlantInputs] = useState({});
  const [shapeEditorSession, setShapeEditorSession] = useState(null); // { onSave: fn, initialPoints: [] } | null
  const [editingBed, setEditingBed] = useState(null); // bed object or null
  const [editingPlant, setEditingPlant] = useState(null); // { scope: 'bed'|'free', bedId, plantId } | null
  const [renaming, setRenaming] = useState(null); // { scope: 'bed'|'free', bedId, plantId, text }
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const renameInputRef = useRef(null);

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
        }
      } catch (e) {
        // no saved data yet
      }
      setLoaded(true);
    })();
  }, []);

  const persist = useCallback(async (nextBeds, nextPlants, nextZone, nextZoneCustomText, nextLightZones) => {
    try {
      await window.storage.set(
        STORAGE_KEY,
        JSON.stringify({
          beds: nextBeds,
          plants: nextPlants,
          zone: nextZone,
          zoneCustomText: nextZoneCustomText,
          lightZones: nextLightZones,
        })
      );
    } catch (e) {
      console.error("Could not save garden data", e);
    }
  }, []);

  useEffect(() => {
    if (!loaded) return;
    persist(beds, plants, zone, zoneCustomText, lightZones);
  }, [beds, plants, zone, zoneCustomText, lightZones, loaded, persist]);

  useEffect(() => {
    if (bedForm.name.trim()) setBedNameError(false);
  }, [bedForm.name]);

  useEffect(() => {
    if (renaming && renameInputRef.current) renameInputRef.current.focus();
  }, [renaming]);

  useEffect(() => {
    const el = canvasOuterRef.current;
    if (!el) return;
    const measure = () => setBaseWidth(el.clientWidth || 800);
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const zoomIn = () => setZoom((z) => Math.min(2, Math.round((z + 0.15) * 100) / 100));
  const zoomOut = () => setZoom((z) => Math.max(0.5, Math.round((z - 0.15) * 100) / 100));
  const zoomReset = () => setZoom(1);

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
    };
    setBeds((b) => [...b, newBed]);
    setBedForm((f) => ({ ...blankFormValues(), soilType: f.soilType, yardLocation: f.yardLocation, bedStructure: f.bedStructure, sunExposure: f.sunExposure, sunExposureSource: f.sunExposureSource, shape: f.shape }));
  }

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

  function openShapeEditorForZoneForm() {
    setShapeEditorSession({
      initialPoints: zoneForm.customShape?.points || [],
      onSave: (result) => {
        setZoneForm((f) => ({ ...f, customShape: result }));
        setShapeEditorSession(null);
      },
    });
  }

  function addLightZone(e) {
    e.preventDefault();
    if (!zoneForm.customShape) return;
    const n = lightZones.length;
    const newZone = {
      id: nextId(),
      sunExposure: zoneForm.sunExposure,
      points: zoneForm.customShape.points,
      widthFt: zoneForm.customShape.widthFt,
      lengthFt: zoneForm.customShape.lengthFt,
      approxSqFt: zoneForm.customShape.approxSqFt,
      x: 30 + (n % 3) * 30,
      y: 30 + Math.floor(n / 3) * 30,
    };
    setLightZones((prev) => [...prev, newZone]);
    setZoneForm((f) => ({ ...f, customShape: null }));
  }

  function deleteLightZone(id) {
    setLightZones((prev) => prev.filter((z) => z.id !== id));
  }

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

  function exportData() {
    const payload = {
      exportedAt: new Date().toISOString(),
      app: "Homestead Bed Planner",
      version: 3,
      beds,
      plants,
      zone,
      zoneCustomText,
      lightZones,
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

  function triggerImport() {
    setImportError("");
    if (importInputRef.current) importInputRef.current.click();
  }

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
        setImportError("");
      } catch (err) {
        setImportError("Couldn't read that file — it may not be a valid backup.");
      }
    };
    reader.readAsText(file);
  }

  function duplicateBed(bedId) {
    setBeds((prev) => {
      const bed = prev.find((b) => b.id === bedId);
      if (!bed) return prev;
      const copy = {
        ...bed,
        id: nextId(),
        name: `${bed.name} (copy)`,
        x: bed.x + 26,
        y: bed.y + 26,
        plants: bed.plants.map((p) => ({ ...p, id: nextId() })),
      };
      return [...prev, copy];
    });
  }

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
      },
    ]);
    setPlantName("");
  }

  function addPlantToBed(bedId) {
    const name = (bedPlantInputs[bedId] || "").trim();
    if (!name) return;
    setBeds((prev) =>
      prev.map((bed) =>
        bed.id === bedId
          ? { ...bed, plants: [...bed.plants, { id: nextId(), name, light: "unknown", water: "unknown", temp: "unknown", cultivar: "" }] }
          : bed
      )
    );
    setBedPlantInputs((prev) => ({ ...prev, [bedId]: "" }));
  }

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

  function ejectPlantFromBed(bedId, plantId) {
    setBeds((prev) => {
      let ejected = null;
      const nextBeds = prev.map((bed) => {
        if (bed.id !== bedId) return bed;
        const found = bed.plants.find((p) => p.id === plantId);
        if (found) ejected = found;
        return { ...bed, plants: bed.plants.filter((p) => p.id !== plantId) };
      });
      if (ejected) {
        const bed = prev.find((b) => b.id === bedId);
        setPlants((pl) => [...pl, { id: ejected.id, name: ejected.name, x: (bed?.x || 0) + 10, y: (bed?.y || 0) + 10 }]);
      }
      return nextBeds;
    });
  }

  function deletePlantFromBed(bedId, plantId) {
    setBeds((prev) => prev.map((bed) => (bed.id === bedId ? { ...bed, plants: bed.plants.filter((p) => p.id !== plantId) } : bed)));
  }

  function deleteFreestandingPlant(plantId) {
    setPlants((prev) => prev.filter((p) => p.id !== plantId));
  }

  function movePlantToBed(plantId, bedId) {
    if (!bedId) return;
    setPlants((prev) => {
      const found = prev.find((p) => p.id === plantId);
      if (found) {
        setBeds((beds) =>
          beds.map((bed) => (bed.id === bedId ? { ...bed, plants: [...bed.plants, { id: found.id, name: found.name }] } : bed))
        );
      }
      return prev.filter((p) => p.id !== plantId);
    });
  }

  function deleteBed(bedId) {
    setBeds((prev) => {
      const bed = prev.find((b) => b.id === bedId);
      if (bed && bed.plants.length) {
        setPlants((pl) => [
          ...pl,
          ...bed.plants.map((p, i) => ({ id: p.id, name: p.name, x: bed.x + 10 + i * 4, y: bed.y + 10 + i * 4 })),
        ]);
      }
      return prev.filter((b) => b.id !== bedId);
    });
  }

  function startRename(scope, bedId, plantId, currentName) {
    setRenaming({ scope, bedId, plantId, text: currentName });
  }

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

  // Opens the shape editor for the "Add a bed" sidebar form.
  function openShapeEditorForAddForm() {
    setShapeEditorSession({
      initialPoints: bedForm.customShape?.points || [],
      onSave: (result) => {
        setBedForm((f) => ({ ...f, customShape: result }));
        setShapeEditorSession(null);
      },
    });
  }

  // Opens the shape editor for the edit-bed modal's draft values.
  function openShapeEditorForEditDraft(values, setValues) {
    setShapeEditorSession({
      initialPoints: values.customShape?.points || [],
      onSave: (result) => {
        setValues((v) => ({ ...v, customShape: result }));
        setShapeEditorSession(null);
      },
    });
  }

  // Opens the shape editor directly from a bed's quick pen icon on the map.
  function openShapeEditorForBed(bedId) {
    const bed = beds.find((b) => b.id === bedId);
    if (!bed) return;
    setShapeEditorSession({
      initialPoints: bed.customPoints || [],
      onSave: (result) => {
        setBeds((prev) =>
          prev.map((b) =>
            b.id === bedId ? { ...b, widthFt: result.widthFt, lengthFt: result.lengthFt, approxSqFt: result.approxSqFt, customPoints: result.points } : b
          )
        );
        setShapeEditorSession(null);
      },
    });
  }

  const startDrag = (kind, id, e) => {
    e.preventDefault();
    const canvasRect = canvasRef.current.getBoundingClientRect();
    const list = kind === "bed" ? beds : kind === "zone" ? lightZones : plants;
    const item = list.find((i) => i.id === id);
    if (!item) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    dragRef.current = {
      kind,
      id,
      offsetX: (clientX - canvasRect.left) / zoom - item.x,
      offsetY: (clientY - canvasRect.top) / zoom - item.y,
    };
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragEnd);
    window.addEventListener("touchmove", onDragMove, { passive: false });
    window.addEventListener("touchend", onDragEnd);
  };

  const onDragMove = (e) => {
    if (!dragRef.current || !canvasRef.current) return;
    e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const canvasRect = canvasRef.current.getBoundingClientRect();
    const { kind, id, offsetX, offsetY } = dragRef.current;
    let x = (clientX - canvasRect.left) / zoom - offsetX;
    let y = (clientY - canvasRect.top) / zoom - offsetY;
    x = Math.max(0, x);
    y = Math.max(0, y);
    if (kind === "bed") setBeds((prev) => prev.map((b) => (b.id === id ? { ...b, x, y } : b)));
    else if (kind === "zone") setLightZones((prev) => prev.map((z) => (z.id === id ? { ...z, x, y } : z)));
    else setPlants((prev) => prev.map((p) => (p.id === id ? { ...p, x, y } : p)));
  };

  const onDragEnd = () => {
    const finished = dragRef.current;
    dragRef.current = null;
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragEnd);
    window.removeEventListener("touchmove", onDragMove);
    window.removeEventListener("touchend", onDragEnd);

    // If a bed the user hasn't manually set was just moved, re-check where it landed relative to the light zones.
    if (finished && finished.kind === "bed") {
      setBeds((prev) =>
        prev.map((bed) => {
          if (bed.id !== finished.id || bed.sunExposureSource === "manual") return bed;
          const suggestion = suggestSunForBed(bed, lightZones, FT_TO_PX);
          if (suggestion) return { ...bed, sunExposure: suggestion, sunExposureSource: "auto" };
          return { ...bed, sunExposure: "unknown", sunExposureSource: "unset" };
        })
      );
    }
  };

  const canvasHeight = Math.max(640, ...beds.map((b) => b.y + b.lengthFt * FT_TO_PX + 60), ...plants.map((p) => p.y + 60), 0);

  return (
    <div className="min-h-screen bg-stone-100 text-stone-900" style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@600;700&family=Work+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500&display=swap');
        .fraunces { font-family: 'Fraunces', serif; }
        .mono-label { font-family: 'IBM Plex Mono', monospace; }
        .soil-texture { background-image: repeating-linear-gradient(135deg, rgba(255,255,255,0.06) 0px, rgba(255,255,255,0.06) 2px, transparent 2px, transparent 8px); }
        .land-grid {
          background-image: linear-gradient(rgba(120,113,90,0.15) 1px, transparent 1px), linear-gradient(90deg, rgba(120,113,90,0.15) 1px, transparent 1px);
          background-size: ${FT_TO_PX * 4}px ${FT_TO_PX * 4}px;
        }
      `}</style>

      {shapeEditorSession && (
        <ShapeEditor
          initialPointsFt={shapeEditorSession.initialPoints}
          onCancel={() => setShapeEditorSession(null)}
          onSave={shapeEditorSession.onSave}
        />
      )}

      {editingBed && (
        <EditBedModal
          bed={editingBed}
          onCancel={() => setEditingBed(null)}
          onSave={(values) => saveEditedBed(editingBed.id, values)}
          onOpenShapeEditor={openShapeEditorForEditDraft}
        />
      )}

      {editingPlant && (() => {
        const found =
          editingPlant.scope === "bed"
            ? beds.find((b) => b.id === editingPlant.bedId)?.plants.find((p) => p.id === editingPlant.plantId)
            : plants.find((p) => p.id === editingPlant.plantId);
        if (!found) return null;
        return (
          <PlantDetailsModal
            plantName={found.name}
            initialValues={found}
            onCancel={() => setEditingPlant(null)}
            onSave={(details) => savePlantDetails(editingPlant, details)}
          />
        );
      })()}

      <header className="border-b border-stone-300 bg-stone-50 px-6 py-5">
        <div className="max-w-7xl mx-auto flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="fraunces text-2xl md:text-3xl text-stone-900">Homestead Bed Planner</h1>
            <p className="text-stone-500 text-sm mt-1">Beds, plants, and the freedom to edit, move, or delete anything, anytime.</p>
          </div>
          <div className="mono-label text-xs text-stone-500 border border-stone-300 rounded px-3 py-1.5 bg-white">
            1 ft = {FT_TO_PX}px on the map
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

      <div className="max-w-7xl mx-auto px-3 sm:px-4 md:px-6 py-4 sm:py-6 flex flex-col sm:flex-row gap-4 sm:gap-6">
        {/* Sidebar */}
        <div className="space-y-4 sm:space-y-6 w-full sm:w-64 md:w-72 lg:w-80 sm:flex-shrink-0">
          <section className="bg-white border border-stone-300 rounded-xl p-4">
            <h2 className="fraunces text-lg mb-3 flex items-center gap-2">
              <Plus size={18} className="text-emerald-700" /> Add a bed
            </h2>
            <form onSubmit={addBed}>
              <BedFields values={bedForm} setValues={setBedForm} onOpenShapeEditor={openShapeEditorForAddForm} nameError={bedNameError} />
              <button type="submit" className="w-full mt-3 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg py-2 text-sm font-medium transition-colors">
                Add bed to the map
              </button>
            </form>
          </section>

          <section className="bg-white border border-stone-300 rounded-xl p-4">
            <h2 className="fraunces text-lg mb-2 flex items-center gap-2">
              <Sun size={18} className="text-emerald-700" /> Light zones
            </h2>
            <p className="text-xs text-stone-500 mb-3">
              Draw where the sun actually falls in your yard. Beds placed inside a zone get their sun exposure
              suggested automatically — you can still change it yourself anytime.
            </p>
            <form onSubmit={addLightZone} className="space-y-3">
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
                onClick={openShapeEditorForZoneForm}
                className="w-full flex items-center justify-center gap-2 border border-emerald-700 text-emerald-700 rounded-lg py-2 text-sm font-medium hover:bg-emerald-50"
              >
                <PenTool size={15} />
                {zoneForm.customShape ? "Edit your drawn zone" : "Draw this zone on the map"}
              </button>
              {zoneForm.customShape && (
                <p className="text-xs text-stone-500">
                  ~{zoneForm.customShape.approxSqFt} sq ft · {zoneForm.customShape.points.length} points
                </p>
              )}
              <button
                type="submit"
                disabled={!zoneForm.customShape}
                className="w-full bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg py-2 text-sm font-medium transition-colors disabled:opacity-40"
              >
                Add zone to the map
              </button>
            </form>
            {lightZones.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {lightZones.map((z) => (
                  <div key={z.id} className={`flex items-center justify-between text-xs rounded-lg border px-2 py-1.5 ${LIGHT_ZONE_STYLES[z.sunExposure].badge}`}>
                    <span>{SUN_EXPOSURES[z.sunExposure]} · ~{z.approxSqFt} sq ft</span>
                    <button onClick={() => deleteLightZone(z.id)} className="hover:text-red-600 p-1 -m-1" title="Delete zone">
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

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
          </section>

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
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <h2 className="fraunces text-lg text-stone-700">Your land</h2>
            <div className="flex items-center gap-2">
              <span className="text-xs text-stone-400 mono-label hidden sm:inline">drag to reposition</span>
              <div className="flex items-center border border-stone-300 rounded-lg bg-white overflow-hidden">
                <button
                  type="button"
                  onClick={zoomOut}
                  disabled={zoom <= 0.5}
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
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  type="button"
                  onClick={zoomIn}
                  disabled={zoom >= 2}
                  className="p-1.5 hover:bg-stone-100 disabled:opacity-30 disabled:hover:bg-transparent"
                  title="Zoom in"
                >
                  <ZoomIn size={15} />
                </button>
              </div>
            </div>
          </div>
          <div
            ref={canvasOuterRef}
            className="relative bg-stone-200 border border-stone-300 rounded-xl overflow-auto"
            style={{ maxHeight: "65vh" }}
          >
            <div style={{ width: baseWidth * zoom, height: canvasHeight * zoom, position: "relative" }}>
              <div
                ref={canvasRef}
                className="absolute top-0 left-0 land-grid"
                style={{ width: baseWidth, minHeight: canvasHeight, touchAction: "none", transform: `scale(${zoom})`, transformOrigin: "top left" }}
              >
            {beds.length === 0 && plants.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-stone-400 text-sm px-6 text-center">
                Your map is empty. Add a bed or a freestanding plant on the left to get started.
              </div>
            )}

            {lightZones.map((zone) => {
              const style = LIGHT_ZONE_STYLES[zone.sunExposure] || LIGHT_ZONE_STYLES.full_sun;
              const boxWidthPx = zone.widthFt * FT_TO_PX;
              const boxHeightPx = zone.lengthFt * FT_TO_PX;
              const polyString = zone.points.map((p) => `${p.x * FT_TO_PX},${p.y * FT_TO_PX}`).join(" ");
              return (
                <div key={zone.id} className="absolute" style={{ left: zone.x, top: zone.y, width: boxWidthPx, height: boxHeightPx }}>
                  <svg className="absolute inset-0 pointer-events-none" width={boxWidthPx} height={boxHeightPx} style={{ overflow: "visible" }}>
                    <polygon points={polyString} className={`${style.fill} opacity-40`} stroke="rgba(0,0,0,0.25)" strokeWidth="1.5" />
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

            {beds.map((bed) => {
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
              const shapeRadius =
                bed.shape === "circle_oval" ? "50%" : bed.shape === "irregular" ? "58% 42% 63% 37% / 41% 55% 45% 59%" : "0.6rem";
              const sizeLabel =
                bed.shape === "custom_points" || bed.shape === "irregular"
                  ? `~${bed.approxSqFt} sq ft`
                  : bed.shape === "circle_oval"
                  ? `⌀${bed.widthFt}ft × ${bed.lengthFt}ft`
                  : `${bed.widthFt}ft × ${bed.lengthFt}ft`;
              const boxWidthPx = Math.max(170, bed.widthFt * FT_TO_PX);
              const boxHeightPx = Math.max(100, bed.lengthFt * FT_TO_PX);
              const polyString = isCustom ? bed.customPoints.map((p) => `${p.x * FT_TO_PX},${p.y * FT_TO_PX}`).join(" ") : "";

              return (
                <div key={bed.id} className="absolute" style={{ left: bed.x, top: bed.y, width: boxWidthPx, minHeight: boxHeightPx }}>
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
                    <div
                      onMouseDown={(e) => startDrag("bed", bed.id, e)}
                      onTouchStart={(e) => startDrag("bed", bed.id, e)}
                      className={`flex items-center justify-between px-2.5 py-1.5 cursor-grab active:cursor-grabbing ${isCustom ? "text-stone-900 bg-white/70 backdrop-blur-sm" : soil.text}`}
                    >
                      <div>
                        <div className="fraunces text-sm leading-tight">{bed.name}</div>
                        <div className="mono-label text-xs opacity-80">{sizeLabel} · {soil.label}</div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => setEditingBed(bed)} onMouseDown={(e) => e.stopPropagation()} className="opacity-80 hover:opacity-100 p-1.5 -m-1.5 rounded-full hover:bg-black/10" title="Edit bed details">
                          <Edit3 size={14} />
                        </button>
                        {bed.shape === "custom_points" && (
                          <button onClick={() => openShapeEditorForBed(bed.id)} onMouseDown={(e) => e.stopPropagation()} className="opacity-80 hover:opacity-100 p-1.5 -m-1.5 rounded-full hover:bg-black/10" title="Edit shape">
                            <PenTool size={14} />
                          </button>
                        )}
                        <button onClick={() => duplicateBed(bed.id)} onMouseDown={(e) => e.stopPropagation()} className="opacity-80 hover:opacity-100 p-1.5 -m-1.5 rounded-full hover:bg-black/10" title="Duplicate bed">
                          <Copy size={14} />
                        </button>
                        <button onClick={() => deleteBed(bed.id)} onMouseDown={(e) => e.stopPropagation()} className="opacity-80 hover:opacity-100 hover:text-red-500 p-1.5 -m-1.5 rounded-full hover:bg-black/10" title="Delete bed">
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>

                    <div className="bg-white/95 flex-1 p-2 flex flex-col gap-1.5">
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
                      <div className="flex flex-wrap gap-1.5">
                        {bed.plants.map((p) => {
                          const isRenaming = renaming && renaming.scope === "bed" && renaming.bedId === bed.id && renaming.plantId === p.id;
                          const mismatchReason = lightMismatch(bed.sunExposure, p.light);
                          return (
                            <span key={p.id} className={`inline-flex items-center gap-1 border rounded-full px-2 py-0.5 text-xs ${soil.chip}`}>
                              {mismatchReason && (
                                <span title={mismatchReason} className="inline-flex text-amber-600 shrink-0">
                                  <AlertTriangle size={12} />
                                </span>
                              )}
                              {isRenaming ? (
                                <input
                                  ref={renameInputRef}
                                  value={renaming.text}
                                  onChange={(e) => setRenaming((r) => ({ ...r, text: e.target.value }))}
                                  onBlur={commitRename}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") commitRename();
                                    if (e.key === "Escape") setRenaming(null);
                                  }}
                                  className="w-20 bg-white/80 border border-stone-300 rounded px-1 text-xs focus:outline-none"
                                />
                              ) : (
                                <>
                                  {p.name}
                                  {p.cultivar && <span className="text-stone-500 italic">({p.cultivar})</span>}
                                  <button onClick={() => startRename("bed", bed.id, p.id, p.name)} title="Rename plant" className="hover:text-stone-900 p-1 -m-1">
                                    <Pencil size={10} />
                                  </button>
                                </>
                              )}
                              <button
                                onClick={() => setEditingPlant({ scope: "bed", bedId: bed.id, plantId: p.id })}
                                title="Light, water & temperature needs"
                                className="hover:text-stone-900 p-1 -m-1"
                              >
                                <Info size={11} />
                              </button>
                              <button onClick={() => ejectPlantFromBed(bed.id, p.id)} title="Move out to the open map" className="hover:text-stone-900 p-1 -m-1">
                                <ArrowUpRightFromCircle size={11} />
                              </button>
                              <button onClick={() => deletePlantFromBed(bed.id, p.id)} title="Delete plant" className="hover:text-red-600 p-1 -m-1">
                                <X size={12} />
                              </button>
                            </span>
                          );
                        })}
                        {bed.plants.length === 0 && <span className="text-xs text-stone-400 italic">No plants yet</span>}
                      </div>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          addPlantToBed(bed.id);
                        }}
                        className="flex gap-1 mt-auto pt-1"
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
                    </div>
                  </div>
                </div>
              );
            })}

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
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
