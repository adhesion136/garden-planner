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
- Bed shapes: Rectangle, Circle/oval, Irregular (quick sq ft estimate), Custom (hand-drawn polygon, drawn directly on the live map — not a separate modal/blank grid)
- Custom shapes can be drawn for a brand-new bed, or reshaped later on an existing bed, both directly on "Your land" with existing beds/zones visible for context; a sticky toolbar (Undo point / Cancel / Finish) stays visible while drawing regardless of scroll
- Full edit modal for any bed (all fields)
- Duplicate a bed (copies all fields + all its plants)
- Delete a bed (plants inside get ejected to freestanding, not deleted)
- Drag to reposition; zoom in/out (50%–200%) with pan-scrollable canvas
- **Bed card shows just its outline/shape by default** (name, size, plant chips) — soil/location/structure/sun badges, the add-plant form, and edit/duplicate/delete/shape-edit buttons are tucked behind a small ⓘ toggle, revealed on hover or by pinning it open with a click
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

## Known limitation / natural next step
- History exists, but nothing yet *compares* this year's beds against past years to warn about repeat plant families in the same bed (the "true rotation warning" piece). That's a reasonable next build once you want it.
