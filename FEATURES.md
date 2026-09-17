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
- The "Your land" viewport is a fixed-size window by default (87% of screen height, 560px minimum), but is now manually resizable — a drag handle in the bottom-right corner (same convention as a resizable browser textarea) lets you reshape it to whatever width and height you want, verified precisely to match the actual drag distance. A minimum size is enforced (320×300px) so it can't be shrunk to something unusable. A "Reset size" button appears once you've resized it, to go back to the default responsive behavior. This exists because the default shape has no deep functional reason for being wider than tall — it's just a side effect of a fixed vertical percentage combined with an unconstrained width, which structurally favors wide properties over tall ones on typical widescreen monitors
- Fixed a real bug where resizing the viewport larger than the visible browser window would push its corner (and the resize handle on it) off-screen, requiring scrolling the whole page just to reach it again to size back down. The resize is now capped so the corner can never leave the visible window, accounting for how far down the page the viewport actually starts — verified directly with an intentionally extreme drag attempt, and confirmed a follow-up resize afterward still works correctly
- Fixed a second, separate bug in the same feature: an accidental "max-width: 100%" style capped the viewport at its layout parent's width (roughly what's left after the sidebar) rather than the actual screen edge — meaning once you shrank it, you could never drag it wider again past that parent's width, no matter how far right you dragged. Verified by reproducing the exact scenario: shrank to 500px, then successfully widened back to 1100px, past the original starting width, with nothing silently capping it
- Fixed a third, real usability bug: the right/bottom edge handles only existed as small 40px segments centered on each edge, not the full edge length — meaning trying to grab the edge anywhere else (most of it) landed on the scrollable canvas underneath instead and did nothing. The handles now span the FULL right and bottom edges, so you can grab anywhere along them, not just a small centered strip — verified directly by clicking near the top and near the bottom of the right edge (not the center) and confirming both correctly resize the width
- Fixed the actual root cause of the persistent "can't resize back to the right" bug: the handles' positioning wrapper had no explicit width, so it defaulted to filling its layout parent's full width rather than shrinking to match the box after a manual resize. Once you shrank the box, the wrapper stayed at its old, wider size — meaning the resize handles stayed positioned at the OLD edge, floating disconnected in empty space well to the right of the box you could actually see, rather than at its real edge. The wrapper now explicitly tracks the box's width whenever it's been manually resized, keeping the handles correctly attached to the true visible edge. Worth noting honestly: this specific class of bug (a CSS box-model mismatch between a parent and child's actual rendered size) is exactly the kind of thing automated testing in a non-browser environment structurally cannot fully verify, unlike the state and logic-level checks used elsewhere — the fix is verified at the level that's checkable (the wrapper's width now explicitly mirrors the box's width in the underlying state), but real-browser confirmation is what actually closes the loop here
- Sidebar is collapsible ("Hide panel" / "Show panel" button next to the Your Land heading) and sits on the left, in its original position. The page's overall width cap was also removed for this tab, so wide monitors get real additional room for Your land — note that repositioning the panel alone doesn't reclaim space either way (a fixed-width sidebar takes the same room regardless of which side it's on); collapsing it entirely is what actually matters — previously it used a max-height that let the box collapse to fit whatever content/zoom currently produced, so zooming out on a small garden would shrink the whole panel and shift the rest of the page up around it. Now the frame stays put; only what's visible inside it changes with zoom
- The canvas itself now always resizes to at least fill that fixed viewport at whatever zoom level you're currently at — previously it was only ever sized for 100% zoom (or the current bed layout), so zooming out shrank the same-sized canvas into a corner of the fixed frame, leaving blank space around it and making the visible grid block look like a misshapen rectangle instead of a clean, viewport-filling grid
- The reference grid lines no longer disappear below ≈50% zoom — they were being shrunk via the same CSS transform as everything else, and a 1px line shrunk past a certain point becomes thinner than a real screen pixel and vanishes. The grid now lives on its own non-transformed layer with its line spacing calculated directly from the zoom level, so the lines always stay a crisp, visible 1px at any zoom — only the spacing between them changes
- The reference grid is now adaptive rather than a fixed 4ft — it automatically switches to a coarser or finer square size as you zoom, using the standard "1-2-5" sequence (1, 2, 5, 10, 20, 50, 100ft... up to 20,000ft) that maps and technical drawings use for round, legible scale steps. A fixed grid either turns to visual noise when zoomed out far enough to see a large farm (squares smaller than a screen pixel) or feels too coarse zoomed in on a small bed — verified directly across the full range: 5ft squares at 100% zoom, escalating to 200ft when zoomed out to 3%, dropping to 2ft when zoomed in to 200%, always staying at a comfortably visible on-screen size
- The "Square = Xft" legend next to the zoom controls is now directly editable — type any value to override the automatic sizing, independent of zoom (adjusting it never changes your current zoom level, verified directly). An "Auto" button appears once you've overridden it, to go back to the automatic zoom-adaptive behavior; the manual value persists correctly through further zooming until you explicitly reset it
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


## Code Optimization Pass
- Memoized `canvasHeight`/`contentWidth` with `useMemo` — these previously recalculated on every single render, including ones triggered by completely unrelated state changes (a keystroke in an unrelated field, a hover, a modal open) anywhere else in the component. Verified as a pure performance win with zero behavioral change across the full regression suite.
- Deduplicated all five separate drag/resize systems (bed move, bed resize, image proportional resize, image edge/corner resize, viewport resize) — previously ~25 near-identical `addEventListener`/`removeEventListener` pairs, each hand-copied with the same mouse/touch coordinate normalization boilerplate. Now share one `startDragSession` utility for the genuinely identical plumbing, while every per-system quirk was preserved exactly: which handles call `stopPropagation` and which don't, the image proportional resize's deliberate horizontal-only math, the bed sun-exposure recalculation that runs on drag-end, and the viewport resize's unique text-selection-disabling defensive fix.
- Migrated one system at a time, running the full targeted regression suite after each before touching the next. Every test produced results with exact numerical parity to the pre-refactor behavior — same pixel values on the trickiest cases (diagonal image resize, the viewport wrapper-width-sync fix). The five old per-system refs (`dragRef`, `resizeRef`, `imageResizeRef`, `imageEdgeResizeRef`, `viewportResizeRef`) are gone, fully replaced by one shared session ref.
- Net result: the file is shorter despite adding the shared utility itself, confirming the actual duplicated boilerplate removed was larger than the net reduction shows.

## Second Optimization Pass
- Fixed redundant re-sorting in rotation warnings: `getRotationWarning` used to re-sort the same `yearHistory` array from scratch for every single plant in every bed, on every render. Now sorted once per BedCard render (memoized) and reused across all its plants' checks. Verified with the full rotation-warning test suite, including the core "most recent match wins" correctness check — identical results to before.
- Debounced the auto-save (persist) path: it previously fired a full JSON.stringify-and-write on every single state change, including every intermediate step of an active drag. Measured concretely: with two realistic background images loaded, one second of dragging spent ~300ms just on stringify calls, before the actual storage write cost. Now debounced (500ms of no further changes before writing), with a safety-net flush on tab hide/close so a save in flight is never silently lost to the delay.
  - Verified a 15-step rapid drag collapses into exactly 1 save instead of 15
  - Verified the final settled state still saves correctly
  - Verified the safety-net flush fires immediately (not waiting the full debounce) when the tab is hidden mid-drag, with the correct pending data
  - Verified no duplicate save happens after a flush, and no wasteful save happens when nothing is pending
  - Along the way, found and fixed a related instability: `persist`'s own identity was tied to `imageSaveWarning`, so setting that warning gave `persist` a new reference, which cascaded into the debounce effect resetting itself an extra time right when a save had just failed. Removed the unnecessary dependency — React already bails out of a re-render when a value is unchanged, so the guard was never needed.

## Position-Clamp Investigation
Those "expected clamp" test cases turned out not to be fine as-is — a genuine bug was hiding behind them. When dragging a bed's or image's left/top edge far enough to hit the canvas boundary (position clamped to 0), the width/height was still computed independently of that clamp, meaning the OPPOSITE edge — the one the user isn't even touching — would silently jump too. Concretely proven: dragging a bed's left edge from x=24 with a 70px drag (only ~24px of room available) caused the right edge to shift by 46px, even though a left-edge drag should always keep the right edge perfectly fixed.
- Fixed in both bed resize and image edge resize: width/height is now derived from the actual (post-clamp) position, using the untouched edge as a fixed invariant, instead of computing size and position independently and only clamping position at the end.
- Verified precisely: a modest drag well within bounds grows the correct amount and keeps the opposite edge exactly fixed (the normal case); a drag that intentionally exceeds the available room still clamps position to 0, but now correctly derives a smaller size increase so the untouched edge stays exactly where it was — proven with exact pixel math, not just "no crash."
- The diagonal corner case was verified on both axes independently in the same test: X hitting the clamp and correctly deriving width from it, while Y (with more room) behaves normally with no clamping — confirming the fix generalizes correctly rather than being a special-cased patch for one direction.
- The three tests that were previously "passing" by accepting the clamp as an unexplained given now assert the actual correct invariant and pass for the right reason.

## Companion Planting Performance
Found by looking closely at the same hot loop where the rotation-warning fix lived — companion planting had the analogous issue, plus a compounding one underneath it.
- `matchCompanionKey`, `matchPlantFamily`, and `matchPlantReference` were all rebuilding `Object.keys(...)` from scratch on every single call, even though the underlying data (`COMPANION_DATA`, `PLANT_FAMILIES`, `PLANT_REFERENCE`) are fixed constants that never change. Hoisted each to a module-level constant computed once. Zero risk, zero behavior change — purely internal.
- `neighbors = bed.plants.filter(...)` ran once per plant in the render loop, meaning a bed with n plants did O(n²) array-allocation work just to build each plant's "everyone else" list. Restructured `getCompanionRelations` to optionally exclude a plant by its own id internally — but only when an id is actually present, so the one other caller (the plant details modal, which passes a plant with no id) is completely unaffected and needed no changes.
- This one got proper scrutiny before shipping, since it changes a shared function's behavior: verified good/bad companion detection both still work correctly, verified the trickiest case directly — two plants with the identical name in the same bed — doesn't cause a plant to see itself as its own neighbor or otherwise corrupt the indicators, and separately verified the other call site (the details modal) still works unchanged.