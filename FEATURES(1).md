# Homestead Bed Planner — Feature List

*Last verified against actual code: this session, via a full audit (ESLint no-undef scan + full function/component/state inventory + regression test suite). Re-check this list every couple of build iterations.*

**Audit note:** this pass caught and fixed a real crash bug (a leftover render block referencing a component and state variable that had already been deleted in an earlier refactor) plus a handful of harmless dead imports/constants. Going forward, every audit runs ESLint's `no-undef` rule against the source as a systematic check for this exact class of bug, not just a manual code read.

## Tabs
- **Garden map** — the main workspace (beds, plants, sidebar tools)
- **Calendar** — planting/harvest timeline (List + Gantt views)
- **History** — year-by-year archive

---

## Garden Map Tab

### Beds
- Create beds with: name, shape, soil type, yard location, bed structure, sun exposure
- Bed shapes: Rectangle, Circle/oval, Custom (hand-drawn polygon, drawn directly on the live map — not a separate modal/blank grid). "Irregular" (a quick sq-ft-only estimate) was removed as redundant with Custom; any bed still saved with that old shape auto-migrates to Rectangle on load, keeping its existing dimensions
- Custom shapes can be drawn for a brand-new bed, or reshaped later on an existing bed, both directly on "Your land" with existing beds/zones visible for context; a sticky toolbar (Undo point / Cancel / Finish) stays visible while drawing regardless of scroll
- Full edit modal for any bed (all fields)
- Duplicate a bed (copies all fields + all its plants)
- Delete a bed (plants inside get ejected to freestanding, not deleted)
- Drag to reposition; zoom in/out (3%–200%, proportional stepping so it scales smoothly across that whole range) with pan-scrollable canvas — the wide low end is meant for large properties (multiple acres), not just small yards
- "Fit all" button snaps the zoom to whatever level shows every bed, plant, and light zone on screen at once
- The canvas (and its reference grid) now actually grows to cover wherever your beds/plants/zones really are, in both directions — previously the grid stayed capped at screen-width even when content extended past it, so beds placed far out on a large property visually fell outside the grid entirely
- The "Your land" viewport itself is now a genuinely fixed-size window (82% of screen height, 520px minimum — expanded from an earlier 65%/400px to give large properties and detailed satellite images room to work without forcing heavy zooming) — previously it used a max-height that let the box collapse to fit whatever content/zoom currently produced, so zooming out on a small garden would shrink the whole panel and shift the rest of the page up around it. Now the frame stays put; only what's visible inside it changes with zoom
- The canvas itself now always resizes to at least fill that fixed viewport at whatever zoom level you're currently at — previously it was only ever sized for 100% zoom (or the current bed layout), so zooming out shrank the same-sized canvas into a corner of the fixed frame, leaving blank space around it and making the visible grid block look like a misshapen rectangle instead of a clean, viewport-filling grid
- The reference grid lines no longer disappear below ≈50% zoom — they were being shrunk via the same CSS transform as everything else, and a 1px line shrunk past a certain point becomes thinner than a real screen pixel and vanishes. The grid now lives on its own non-transformed layer with its line spacing calculated directly from the zoom level, so the lines always stay a crisp, visible 1px at any zoom — only the spacing between them changes
- A "Square = 4ft" legend sits next to the zoom controls — replaces an old header badge ("1 ft = 14px on the map") that became inaccurate once zoom was added. The new label is always true regardless of zoom level, since each grid square represents a fixed 4 real feet no matter how big or small it renders on screen
- **Bed card shows just its outline/shape by default** (name, size, plant chips) — soil/location/structure/sun badges, the add-plant form, and edit/duplicate/delete/shape-edit buttons are tucked behind a small ⓘ toggle, revealed on hover or by pinning it open with a click
- Circle/oval beds use extra interior padding (16%, matching the largest rectangle that actually fits inside a circle) so plant chips near the edges don't get visually clipped by the curved boundary — a flex-wrap layout doesn't know about the curve, so without this the corners of the bounding box get cut off even though they're outside the circle
- That details panel renders as a fully separate floating card below the bed, not stacked inside its own shape — fixes a real bug where showing details on a circle/oval bed made the box taller and distorted the circle into an oval, since border-radius:50% is relative to whatever size the box currently is. The bed's own shape now never changes size regardless of hover/pin state — verified across all four shape types (rectangle, circle/oval, irregular, and custom hand-drawn)
- Bed name/size/drag-handle also moved completely outside the shape now, as a floating label above it — previously this lived inside the shape's own header bar and could get cramped or visually cut off on small or oddly-shaped beds. The shape's interior is now dedicated purely to showing plants
- Beds can now be resized directly by dragging — four small handles (top/bottom/left/right) appear on Rectangle and Circle/oval beds when hovering or pinned. Dragging the right or bottom handle grows/shrinks that dimension directly; dragging the left or top handle does the same while shifting the bed's position so the *opposite* edge stays anchored in place, like resizing a shape in a design tool. Position is clamped so a bed can't get dragged off the edge of the map. (Irregular and custom hand-drawn shapes aren't included — they don't have a simple width/length to drag the same way.)
- Sun exposure has a "manual vs auto" lock system: unset until you touch it, auto-tracks light zones until you manually override, then stays locked to your choice forever (even shown as a small "(auto)" tag when live-tracked)

### Light zones
- Draw sun/shade zones directly on the map, in the same live in-context drawing mode as custom bed shapes (no modal)
- Existing zones can be reshaped after the fact via a "Reshape this zone" button — not just repositioned by dragging
- Each zone tagged Full sun / Part sun / Full shade, rendered as a colored translucent overlay *behind* beds, with a dashed border so its outline reads as a distinct layer from a bed's solid border
- Zone colors use a cool blue family (cyan/blue/indigo) deliberately kept separate from the warm soil-type palette, so a zone never visually blends into or gets mistaken for a bed's soil color
- Beds inside a zone auto-suggest their sun exposure (only when not manually overridden)
- Hint icon (ⓘ) appears on a bed if its manual sun exposure disagrees with what the zones currently suggest
- Toggle button (next to zoom controls) to show/hide zone overlays on the map without deleting them — useful once beds start crowding the view

### Plants (freestanding or inside a bed)
- Add/rename/move/delete freely; move between beds or eject to freestanding
- Per-plant details modal includes:
  - **Cultivar/variety** (free text)
  - **Light / Water / Temperature** needs — each has a "Recommended (based on plant type)" option that live-resolves from a built-in reference table (~30 plants) and updates if you rename the plant; manual picks always override
  - **Planting & harvest timing** — auto-suggested start-indoors/plant-outside/harvest-window dates based on plant type + your zone's rough average frost dates (clearly labeled as an estimate); editable, and once edited your version sticks permanently
  - **Companion planting** — built-in traditional good/bad pairings (~40 plants: vegetables, herbs, flowers), flags real conflicts/matches with neighbors *actually in the same bed*, plus your own free-text notes and a per-plant "don't warn me" dismiss toggle
- Warning icons on plant chips: amber (light mismatch vs. bed), red (bad companion nearby), green check (good companion nearby)

### Zone & climate
- USDA hardiness zone selector (1a–13b) in the header, plus "International/not sure" with free-text description
- ZIP code lookup (via a free public API) to auto-fill your zone, with a fallback link to the official USDA map if the lookup ever fails

### New year / rollover
- "Start a new year" — archives a full snapshot of the current garden (beds + plants + zone) into History under a year label (defaults to *last* year, since you're closing out what you had)
- Lets you check off specific plants to carry forward into the new season; perennials are pre-checked by default
- Everything unchecked is cleared from live beds; bed structures themselves are never deleted by this

### Backup & restore
- Export the whole garden (beds, plants, zone, light zones, year history) as a downloadable `.json` file
- Import a previous export back in, with a confirmation prompt and a clear error if the file isn't a valid backup

---

## Calendar Tab
- **List view** — plants grouped by month, by event type (Start indoors / Plant outside / Harvest)
- **Gantt view** — one row per plant, 52-week columns (month-labeled), colored bars per phase
- Click a legend category (Start indoors / Plant outside / Harvest) to highlight it and fade everything else, in both views at once; "All" clears the filter
- Hovering a Gantt cell shows the specific plant, cultivar, and location — not just the category
- "Unscheduled" section for dates that couldn't be parsed to a month
- "Not yet scheduled" section for plants with no planting/harvest info entered at all — nothing is silently hidden

---

## History Tab
- One card per archived year: bed-by-bed and freestanding plant lists as they were at archive time
- **Year-level notes** (free text, e.g. "dry summer, aphids were bad")
- **Per-plant notes** (e.g. "produced tons of fruit, some blossom end rot") — click the pencil icon on any historical plant
- Delete an old history entry if needed

---

### Rotation warnings
- Each plant in a bed is now checked against that same-named bed's history: if anything from the same botanical family (nightshades, brassicas, legumes, cucurbits, alliums, umbellifers, etc.) grew there in a past year, an orange warning icon appears on the plant chip
- Checks the most recent matching year, not just an exact repeat of the same plant — e.g. planting peppers where tomatoes grew last year still warns, since both are nightshades
- Matches beds by name across years (the only way to link a live bed to its History entries), so renaming a bed between seasons breaks the link — a reasonable limitation given beds don't otherwise have a persistent identity across archiving
- Framed as common garden guidance (soil depletion / pest buildup risk), not an absolute rule
- Per-plant dismiss toggle in the plant's details modal ("Crop rotation" section, same place/pattern as the companion-planting dismiss) — for when you're rotating away from a family on purpose and don't want the reminder
- "Clear this bed's rotation history" button appears in a bed's details panel whenever history actually exists for that bed name — removes just that one bed's records from every archived year, leaving other beds in those same years untouched. Asks for confirmation first, since it spans potentially several years of data at once
