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

## Plant-Spacing / Fill-Bed at Recommended Spacing
The feature that got tabled twice during the original build — finally built.
- Every plant in `PLANT_REFERENCE` (~30 plants) now has a recommended spacing figure (inches between plants), using standard intensive/raised-bed spacing rather than open-field row spacing, since this app is built around defined beds
- Each bed has a new "Fill bed at recommended spacing" tool: type a plant name, see its recommended spacing pulled automatically, see a live preview of exactly how many will be added, and fill the bed in one click. The spacing is fully editable, so a plant with no data on file (or your own preferred spacing) still works — the tool clearly says so and requires an explicit number before it'll let you fill
- Critically, this is shape-aware, not just bounding-box math: rectangle beds get an exact grid count, but circle/oval and custom hand-drawn beds compute real point-in-shape fitting (ellipse and polygon math respectively), so an oval or irregular bed doesn't get credited with corner area it doesn't actually have
- Verified this precisely, not just "a number appears": confirmed a rectangle bed gives the exact expected grid count, confirmed a circle bed's count is genuinely lower than its bounding rectangle and lands within the correct ellipse-area ratio (~78.5%), and confirmed a triangular custom bed's count matches its expected ~50% share of its bounding square — proving the shape-awareness is real math, not a fallback to the simple case
- Batch-added plants use the exact same underlying shape as a manually-added plant (factored into one shared `blankPlant` helper), so they're indistinguishable to every other part of the app — verified directly by filling a bed with Basil and then adding a manual Tomato, confirming the companion-planting indicator correctly recognized both together

## Correction: Plant-Spacing Actually Works Differently Than Described
Important correction, worth being upfront about: the write-up above described a simple text-based calculator (type a plant, see a count, click Fill). That description was wrong for what's actually in the app — not because the feature was rebuilt since, but because the actual shipped file never included a more advanced version that already existed in the source code. The rebuild step that produces the downloadable HTML had not been rerun since this more advanced tool was written, so every file handed over up to this point was missing it entirely.

**What it actually does now, verified fresh:**
- Pick a plant and its recommended spacing in the sidebar (as before), then click "Show on map"
- A single box appears directly on the bed, on the canvas — sized to exactly one plant's spacing footprint
- Drag the box's edges to grow or shrink it, clamped so it can never leave the bed's own bounds (verified precisely: an extreme drag attempt correctly stopped at the exact clamped pixel position, not partway or unclamped)
- As it resizes, the box visually fills with small dot markers — one per plant that actually fits at the current size — updating live, and it's shape-aware: a circular or custom-shaped bed correctly shows fewer markers than a rectangle of the same bounding size would, using the same validated ellipse/polygon math as the rest of the app
- Add or Cancel confirms or discards the whole operation

Verified end-to-end: initial box size, a precise resize with exact expected marker count (169, matching hand-calculated grid math), boundary clamping to the exact pixel, the actual batch-add producing the exact right count, Cancel adding nothing, and a circular bed's count landing within the correct ~78.5% ellipse-area ratio of its bounding rectangle.

## Fixes: Modal Cutoff, and Independent Spacing Control
Two real issues, fixed:
- **Modal top/bottom cutoff on desktop-sized screens.** All four modals in the app used a common CSS pattern (`items-start sm:items-center`) that switches to vertical centering above the mobile breakpoint. When a modal's content is taller than the viewport, centering it creates a well-documented flexbox problem: the overflow above center becomes unreachable by scrolling, no matter how much padding or `overflow-y-auto` is set on the container. Fixed by using `items-start` consistently at every screen size — modals now always anchor at the top of the scrollable area, so any overflow extends downward where normal scrolling reaches it. This is a pure CSS-rendering behavior my test environment can't fully simulate on its own, so real-browser confirmation matters here more than usual.
- **Independent spacing control in the fill-bed box tool.** The box's own corner handle (controls the fill area) was the only interactive element — there was no way to adjust the spacing itself once looking at the box, without going back to the sidebar. Added a second, visually distinct marker (blue, at the box's first grid cell) with its own resize handle: dragging it changes the spacing value directly, recalculating the grid against the box's current, unchanged size. Verified this precisely: grew the box to a known size (169 markers), then dragged the spacing handle alone and confirmed the box's own width, height, AND position stayed completely unchanged while the count correctly recalculated to the exact expected value for the new spacing (16) — and confirmed the final Add action uses that spacing-adjusted count, not the original.

## Plants Are Now Individually Positioned Within Beds
A real architectural change, not a small tweak: plants inside a bed were a flat list (like a shopping list) with no individual position — that was a deliberate early design decision, but it turned out not to match what was actually wanted. Traced a screenshot carefully (comparing exact icon structure against the code) to confirm the real request before touching anything this size.
- Every plant within a bed now has its own x/y position (feet, relative to the bed's own origin) and is individually draggable, directly reusing the same drag pattern already proven for freestanding plants — clamped so a plant can't be dragged outside its own bed
- All the existing per-plant actions (rename, light/water/temp details, move to open map, delete) still work exactly as before; each one correctly stops the drag from also firing when you click it
- New plants get a sensible default position automatically (a loose grid, generous enough to avoid overlaps) so nothing needs manual placement unless you want to move it
- The fill-bed-at-spacing tool got a real upgrade from this: it now places each plant at its exact calculated grid position — precisely where its preview dot was shown — instead of just adding an unpositioned count. Verified exactly: filled a small area expecting a 2x2 grid, and got exactly 4 plants at the 4 precise expected grid-cell centers, not just "4 plants somewhere"
- Old saved data (plants with no position at all) migrates automatically with sensible, non-overlapping default positions — verified directly with a three-plant legacy bed, confirming no crash and three genuinely distinct positions, not everything stacked at one spot

## Direct Plant-to-Fill Dragging
The more direct way to fill a bed: instead of going through the sidebar tool, any individual plant already on the bed now has its own small handle — drag it and that one plant expands into however many fit the dragged area, at its recommended spacing, replacing the original. Both paths exist side by side; the sidebar tool is unchanged for anyone who prefers picking a plant name before it's on the bed.
- Reuses the exact same live-preview machinery as the sidebar tool (grid of dots, shape-aware fitting, the independent spacing-adjustment marker) — just started from an existing plant's position instead of a blank spot, and confirmed as a replace rather than an add
- The original plant is hidden during the drag (its live preview already shows what will happen) and only actually replaced on explicit confirm — Cancel leaves it completely untouched
- The confirm button reads "Fill" instead of "Add" in this mode, since it's replacing rather than adding alongside
- Verified precisely: added a single plant normally, dragged its handle to grow a 2x2 area, confirmed, and got exactly 4 plants total (not 5) at 4 distinct positions — proving the original was genuinely replaced, not left behind. Separately verified Cancel leaves the original plant at its exact original position and count, untouched

## Dots, Locking, Persistent Details Popup, and Undo/Redo
This round started with a genuine environment reset (all working tooling and test files wiped), and uncovered a large amount of unfinished, uncompiled work already sitting in the source from earlier in this same session — matching what had actually been asked for, but never verified or shipped. Rather than rebuild it from scratch, the work here was mostly forensic: read it carefully, find what was actually broken, fix it, and verify everything by hand.

- **A real, severe bug**: a duplicated/malformed code block was breaking the entire file's compilation — nothing in this area could have been working, since the file couldn't even build. Fixed.
- **Dot rendering**: plants within a bed now render as small dots instead of named pill chips — the name is still available via hover/title text for now, ready to swap for a plant image later without changing the interaction model.
- **Lock-after-fill**: plants created via either fill tool (sidebar or direct-drag) come out locked by default; a locked plant resists dragging and shows a lock icon. Manually-added single plants stay unlocked, since placing them fresh is the point.
- **Click for persistent details**: clicking any plant dot (locked or not) opens its details popup, which stays open until explicitly closed — including the lock/unlock toggle (reusing the same toggle style already built for background images). For an unlocked plant, this required distinguishing a genuine click from a drag-release (tracked via total pointer movement, already built in) so dragging a plant doesn't also pop its details open.
- **Undo/redo**: found and fixed a real, subtle bug in logic that already existed — the original code performed side effects (applying a snapshot, updating other state) *inside* a React state-updater function, which must stay pure; this silently corrupted the second operation in any undo/redo chain (undo worked, the very next redo didn't). Rewrote it using refs as the source of truth for the undo/redo stacks, with a plain counter only to trigger re-renders for the button states. Verified thoroughly: a three-step add-bed sequence, two undos, one redo, a genuinely new change, and confirmed that new change permanently cleared the old redo history rather than leaving it silently reachable. Available via on-screen Undo/Redo buttons and Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z).
- Every one of these was verified hands-on, not by code review alone — real clicks, drags, and timed waits past the save/history debounce, checking exact before/after state each time.

## Fix: Plant Disappearing After "Move to Open Map"
Traced precisely rather than guessed: the plant wasn't actually being lost. `ejectPlantFromBed` positioned the newly-freestanding plant at (bed.x + 10, bed.y + 10) — a spot that falls *inside* the bed's own bounding box for any normal-sized bed, so the freed plant rendered directly underneath the bed's own opaque shape. It was genuinely still there in the data; it was just hidden behind the bed visually. Fixed by positioning it just below the bed instead, clear of its bounding box — verified precisely: for a default 4x8ft bed, the plant now lands at y=156, confirmed outside the bed's y-range of [24,136].

Found and fixed two more instances of the same underlying pattern while in there:
- The same eject function, and the "move a freestanding plant into a bed" dropdown, were both only carrying over a plant's id/name — silently dropping any light/water/temp settings, cultivar, planting dates, or companion notes already set on it. Both now carry over everything. Verified with a real custom cultivar ("Jalapeno") surviving an eject.
- "Move into a bed" had no position logic at all, meaning multiple plants moved into the same bed this way would all land exactly on top of each other at (0,0). Now gets the same sensible default-grid positioning new plants already get. Verified two plants moved into the same bed land at genuinely distinct positions, neither at (0,0).
- A bed being deleted while it still has plants got the same field-completeness fix for its orphaned-to-freestanding plants.

Also clarified: the "Elderberry" text some users notice isn't anything auto-populated — it's just placeholder/example text in the empty "Add a freestanding plant" field, the same pattern as "e.g. Front bed 2" for bed names. It never becomes a real plant unless something is actually typed and submitted.

## Multi-Select for Bulk Plant Actions
Directly addresses the pain point of unlocking many fill-created plants one at a time. Each bed with plants now has a "Select multiple" toggle:
- While active, clicking any plant dot toggles its selection (shown with a blue ring and checkmark) instead of opening its details — dragging is disabled during selection so there's no ambiguity between selecting and moving
- A small toolbar shows the current count, a "Select all" shortcut, and bulk Unlock / Lock / Delete actions
- Selection mode stays open after a bulk action (in case more selections/actions are wanted) rather than auto-closing — an explicit "Done" exits it and returns to normal click/drag behavior
- Verified precisely: filled a bed with 9 locked plants, selected all, unlocked all 9 in a single action; separately selected a specific 2-plant subset (leaving a third untouched), bulk-deleted just those two, and confirmed the third plant was completely unaffected and normal dragging resumed correctly once selection mode was closed

## Drag-to-Select (Marquee Selection)
Selection mode now supports dragging a box around plants instead of clicking each one individually — the standard "rubber-band select" pattern from file managers and design tools. Drag across empty space within a bed while in selection mode, and every plant inside the box gets selected (replacing whatever was selected before); clicking individual dots still works on top of that to fine-tune the selection. Also fixed a real bug caught during testing: the first version called a bulk-selection function from inside a different state variable's update callback, which is an anti-pattern React explicitly warns against — the same class of bug as the earlier undo/redo issue, caught and fixed here before shipping rather than after. Verified precisely: drew a box around two of three plants, confirmed exactly those two were selected (not the third), then confirmed clicking the third directly still correctly added it to the selection on top.

Also clarified for the record: the code has no seed or demo data anywhere — `plants` starts as a plain empty array on every fresh load. A plant appearing on repeat visits (elderberry or otherwise) is genuinely saved data sitting in that browser's local storage from earlier use, not something the app is recreating. It can be removed directly now with select-multiple — drag a box around it (or click it) and delete.

## Fix: Plant Dot Shrinking After Fill, and a Real "Clear All Data" Option
Two real issues:
- **Dots shrinking after confirming a fill.** Traced precisely: the live preview sizes its dots proportionally to spacing (a wide-spacing plant like elderberry shows a big dot), but the actual placed plant always rendered at a fixed 16x16px regardless of spacing — so anything wider than about 19in spacing visibly shrank the moment it was placed. Fixed by storing the actual spacing used (not just the plant name) on every plant, and sizing its dot from that stored value using the same formula the preview already uses, clamped so tightly-spaced plants (carrots at 3in) stay clickable and very wide ones (elderberry at 96in) don't dominate the bed. Verified precisely: a Tomato (24in) now renders at exactly 19.6px — matching the formula exactly, not the old fixed size — and a Carrot (3in) correctly clamps to the 10px minimum instead of becoming nearly invisible.
- **A genuine "Clear all data" option**, since the recurring old-test-data question turned out to be real saved browser data with no built-in way to wipe it in one step. It's a plain reset of everything persisted (beds, plants, zones, year history, journal, images), gated behind a confirmation, and — because it goes through the same state updates as everything else — it's covered by undo like any other action. Verified precisely: added a bed, cleared everything, confirmed it was genuinely gone from both the screen and the saved data, then undid the clear and confirmed the bed came back exactly as it was.

## Interplanting: Filling a Second Plant Type Without Overlapping the First
Both fill paths (the sidebar tool and dragging directly from an existing plant's own handle) now check against every other plant already in the bed before placing a new one — any grid cell that would land too close to an existing plant is skipped automatically. "Too close" is based on each plant's own stored spacing, treating every plant as needing a personal-space radius of half its spacing, so the check adapts sensibly whether the two plants are similar in size or very different (e.g. tightly-spaced carrots next to much-wider-spaced basil).

This applies to the live preview too, not just the final result — the dot count you see while dragging already reflects what will and won't fit around what's already planted, so there's no surprise at confirm time.

The one deliberate exception: dragging a plant's own handle to expand it into more of itself correctly ignores that one plant's own original position, so it doesn't block its own expansion.

Verified precisely: densely filled a 2x2ft area with carrots, then tried filling the same overlapping area with basil and confirmed every added basil plant was checked by exact distance against every carrot with zero overlaps — not just "fewer plants got added," but genuinely zero collisions, mathematically confirmed. Separately confirmed a plant expanding into itself still gets a full, unobstructed grid rather than being short by one for blocking its own prior spot.

## Plant-Spacing Boxes: Bound Groups, and Companion-Planting Overlap
A real redesign of how a fill operation's plants relate to each other, built and tested in stages:

- Plants created by a fill operation are now bound to a persistent, visible box — dragging the box moves every plant in it together, each keeping its exact position relative to the box (computed from captured starting positions each drag, not accumulated deltas, to avoid drift).
- A plant can be pulled out of its box two ways: drag it past the box's own edge (auto-detaches the moment it crosses the boundary) or use an explicit "Release from group" button in its details popup, shown only when it's currently in a box. Both leave every other plant in the box untouched.
- The overlap-avoidance check added last turn is removed — boxes can now freely overlap, since that's exactly what's needed for companion planting.
- Overlapping boxes are shown with a color and a note instead: green for traditionally good companions, red for traditionally avoided pairings, amber when there's no data either way — reusing the same color language already used elsewhere for companion warnings, so it doesn't introduce a new visual meaning.
- Deleting, ejecting, or bulk-deleting the last plant in a box correctly removes the now-empty box too, rather than leaving an invisible orphaned rectangle behind. Duplicating a bed regenerates box ids and correctly remaps its plants to them.

Verified precisely at every stage rather than just visually: confirmed a box's own stored spacing/plant-name are correct on creation and every plant shares its id; dragged a box and confirmed both it and 25 member plants moved by the exact same delta with positions preserved relative to each other; detached one plant by dragging it past its box's bounds and confirmed the other members and the box itself were completely unaffected; used the explicit release button and confirmed the plant didn't move and stayed locked; and tested all three overlap-color cases (Tomato+Basil for green, Tomato+Potato for red, Tomato+Kale for amber) each in isolation, confirming the exact border color and note text for each.

## Fix: Plant-Spacing Box Was Hard to See and Hard to Grab
Real usability issue, now fixed:
- The box's default border was a subtle, semi-transparent gray that could blend into the bed's own textured background — changed to a clearer blue, matching the same "blue = spacing-related tool" color already used elsewhere (the spacing marker and the plant-expand handle). Added a very subtle background tint too, so the box's extent reads at a glance without needing to spot the border line specifically.
- The deeper issue: dragging the box only worked by clicking empty space inside it — which stops being reliable the moment the box is packed edge-to-edge with plant dots, since those render on top and intercept the click first. Added a small, dedicated handle (matching the style of every other handle in the app) that's always present and always clickable, independent of how densely the box is filled.

Verified precisely: densely filled a box with 144 carrots (leaving no meaningful empty space inside it), then dragged it via the new handle — twice in a row, confirming it isn't a one-time fix that breaks after the first use — and confirmed the plant count stayed exactly correct across both drags.

## Plant-Spacing Box: Now Resizable, Not Just Movable
A box's amount of plants can now be adjusted after the fact, not just its position. A second handle (green, bottom-right, matching the resize-handle color already used in the fill tool) grows or shrinks the box, regenerating its member plants to match the new area at the same spacing — live, the same way the count updated live before the original fill was ever confirmed.

- Growing recomputes the grid and adds plants to fill the new space; shrinking removes the plants that no longer fit. Both are clamped — a box can't grow past its bed's own edge, and can't shrink below one spacing unit (so it can never disappear to zero plants).
- Extracted the grid-position math into one shared function used by both the live fill-tool preview and this resize, rather than keeping two separate copies of the same logic that could quietly drift apart.
- A real trade-off worth naming plainly: since the box's members are regenerated as a set on resize, any individual customization on a member plant (a custom cultivar, adjusted light/water needs) resets. A plant already pulled out of the box (detached) is a separate, independent plant by that point and is completely unaffected by any later resize of the box it used to belong to — verified directly, including confirming its exact position and id stayed untouched.

Verified precisely: grew a box and confirmed the plant count increased to exactly match the new grid area; shrank a box with a detached plant sitting nearby and confirmed the bound plants correctly decreased while the detached one didn't move or change at all; and tested both extremes deliberately — an oversized drag correctly clamped to the bed's own exact width, and an undersized drag correctly clamped to exactly one spacing unit, never reaching zero plants.

## Code Annotation Pass
Went through the source file adding explanatory comments throughout, for readability rather than any behavior change:
- A file-level header at the top explaining the app's architecture: the two coordinate systems in use (feet vs. canvas pixels, and why mixing them up is the easy bug to introduce), how plant-spacing boxes work, the persistence/undo model, and the overall file layout
- Every previously-uncommented top-level function and component now has one — geometry helpers, date/calendar math, companion/rotation matching, bed/plant migration, all four view tabs (Calendar, History, Journal, Gantt), four of the five modals, and BedCard
- A thorough pass through the main component's internals: persist/undo-redo, zoom controls, bed creation and editing, canvas shape-drawing, export/import, image calibration, journal and year-history functions, plant selection and bulk actions, deletion, renaming, the shared drag-session infrastructure, and the shape-drawing point interactions

One real finding along the way, flagged rather than silently fixed: `pointInPolygon` and `isInsidePolygon` turned out to be identical implementations under two different names. Since this was scoped as annotation, not refactoring, that's noted directly in a comment for a future cleanup pass, rather than merged now and risking a missed call site during what's supposed to be a purely additive, behavior-preserving change.

Verified after every batch of edits (not just once at the end): the file compiles cleanly throughout, and the full existing test suite still passes with no new failures — confirming this was genuinely comments-only, nothing about how the app actually behaves changed.

## Click-and-Drag Map Panning, and a 1ft Default Grid
Two real navigation fixes:
- **Click-and-drag panning.** The map previously only supported the browser's own scrollbars for adjusting your view when zoomed in. Now dragging any empty area of the canvas (not on a bed, plant, image, or their handles — those all keep working exactly as before) pans the view, the standard interaction from any map or design tool. It adjusts the browser's own scroll position directly rather than reimplementing scrolling, so the scrollbars themselves still work too, as an alternative. Also enables touch-drag panning on mobile/tablet, which wasn't available before since native touch-scrolling was already disabled on the canvas for other drag interactions to work correctly.
- **1ft default grid**, instead of the adaptive grid's own starting point of 5ft at the default zoom level (a 1ft square only renders at 14px on screen at that zoom — below the adaptive logic's own 45px legibility threshold, which is why it was skipping straight to 5ft). The "Auto" button is still there to switch back to the zoom-adaptive grid at any time.

Verified precisely: confirmed the grid's actual rendered size is exactly 14px x 14px on load (matching 1ft at the default zoom), and tested the pan feature with an exact-pixel check — dragging 30px left and 20px up moved the scroll position by exactly 30 and 20, respectively. Also specifically verified that dragging a bed itself still only moves the bed and does not also trigger the canvas to pan underneath it.

## Merging Companion-Planted Boxes for Proper Interplanted Spacing
When two plant-spacing boxes overlap and are traditionally compatible companions (not a "bad" pairing), a small purple button now appears offering to merge them. Merging:
- Grows both boxes to cover their full combined area
- Computes a proper interplanted layout: the plant with the larger spacing (the "primary") keeps a completely normal grid of its own, unaffected by the merge; the plant with the smaller spacing (the "companion") gets positioned in the gaps between the primary's plants, filtered so it's never closer to a primary plant than half of each one's own spacing added together — the same "personal space" concept already used elsewhere in the app for distance checks
- Links the two boxes going forward: resizing or dragging either one later automatically keeps the other in sync and re-spaces both correctly, rather than needing to re-merge by hand every time
- A linked pair renders as one shared outline (solid purple) rather than two redundant, exactly-overlapping ones, with a single set of move/resize handles that control both at once

An "Unmerge" button breaks the link at any time — the current layout stays exactly as it is, it just stops staying in sync afterward.

This involved a genuinely new kind of relationship between two boxes (rather than a one-time layout calculation), so it was tested in real depth: the core interplanting math was unit-tested directly with precise distance measurements before any UI was built — confirming the primary plant's grid is completely untouched by the merge, and that no companion plant ever lands closer than the required minimum distance to a primary one. The full flow was then tested end-to-end — merging, resizing one half of a merged pair and confirming both regenerate correctly and stay properly spaced, and unmerging and confirming the boxes become fully independent again immediately afterward. Also specifically tested a real edge case: deleting one entire box out of a merged pair (removing all its plants) leaves the surviving box completely functional, correctly stops showing it as merged, and can still be resized normally on its own.

One real bug caught and fixed during this build, worth being transparent about: while adding the new interplanting function, an editing mistake briefly deleted the existing `computeGridPositions` function entirely, even though it's used in several other places throughout the app. This was caught immediately by a direct test before it ever reached a delivered file — compiling cleanly isn't the same as actually running correctly, which is why hands-on testing matters even for changes that look straightforward.

## Click-Outside-to-Close for All Modals
Every popup in the app (plant details, image calibration, year rollover, edit bed) can now be dismissed by clicking the darkened area outside it, using its existing Cancel behavior. Specifically verified clicking inside the modal's own content does NOT close it — only the backdrop itself does.

## New Plants No Longer Stack on Existing Ones
Found the real cause: placing a newly-added plant in a bed was cycling through a fixed grid based purely on how many plants were already there, with no check on where plants had actually ended up. Since plants get moved, deleted, or placed off-grid over time, that count-based position could easily land right on top of (or directly behind) an existing plant. Added a proper check against actual current positions that skips forward to the next open spot. Verified directly by placing an existing plant exactly where the old logic would have dropped the next one, then confirming a newly-added plant correctly skipped past it.

## Fix: Plant Box Move/Resize/Merge Handles Could Get Silently Blocked by Plant Dots
Found and fixed a real bug: the small handles on a plant-spacing box (drag-to-move, drag-to-resize, and the merge/unmerge buttons) had no explicit stacking priority over the plant dots inside the box. Since dots render after boxes, a dot landing near a handle's corner — a common occurrence in a filled grid, especially right in that top or bottom corner — could silently sit on top of it and intercept the click meant for the handle. This defeated the entire point of those handles, which were specifically built to guarantee a clickable spot regardless of how densely a box is packed. Fixed by giving all four handles explicit priority so they always stay clickable no matter what's underneath. Verified the fix is correctly present in a densely-packed 144-plant box.

## Two Critical Fixes: Ghost-Linked Plants, and Merge Overflow

**Fix: unrelated plants moving with an unlinked box.** Found the real cause of "plant boxes getting connected" — the code that carries a linked pair's plants along on a drag had a subtle bug: when a box ISN'T linked to anything, its `linkedBoxId` is `null`, but the filter that collects "which plants move with this drag" was matching `null` against `null` — meaning ANY individually-added plant in the bed (which also has a `null` box id, since it doesn't belong to any box) got swept along by dragging ANY unlinked box's handle. This explains exactly what was seen: a single onion added on its own, with no box or outline of its own, got dragged along with the tomato box purely because both happened to have a `null` box reference. Fixed to only carry a plant along when there's a genuine linked partner, verified directly by confirming a freestanding plant now stays completely put when an unrelated box is dragged.

**Fix: merge overflow.** The interplanted layout's companion grid was offset using the plant's *nominal* spacing, but the underlying grid math actually redistributes cell size evenly to fill the box exactly — so the real spacing usually differs slightly from nominal, and the offset both misaligned with the actual gaps and pushed positions past the box's own far edge. Rebuilt this more simply: both plant types now compute their grid over the identical rectangle, with proper spacing enforced entirely by a minimum-distance check rather than a manually-offset second grid. This can no longer produce a position outside the box by construction. Verified with an exact bounds check across every member plant after a merge, and confirmed the plant count scales up sensibly as the merged area grows.

## Fix: Second Plant Landing Under the First, and Related Placement Problems
Traced a report of a newly-added plant appearing "under the first" and seeming stuck on the left of the bed. Reproduced the first symptom directly, and found three real problems:

- **Placement ignored what was actually in the bed.** New plants were placed on a fixed 1.5ft grid, which (a) never used the right-hand stretch of a bed (a 4ft bed only got columns at 0.75ft and 2.25ft), (b) treated the empty gaps *inside* a filled plant box as free space, and (c) when nothing was free, fell back to an index-based spot that landed directly on top of existing plants. Replaced with a fine scan of the whole bed that returns the first spot that's inside the bed's real shape, outside every plant box's area (gaps included), and clear of every existing plant. If the bed is genuinely full, it now picks the least crowded spot and shows a note under the add form ("No open space left in this bed...") instead of silently stacking the plant.
- **Loose plants could get buried under a box's plants.** Resizing or merging a box regenerates its plants, which re-adds them to the end of the plant list — and things later in the list draw on top. So resizing a box after adding a loose plant could hide that plant beneath the box's locked dots, making it impossible to grab (clicks opened the locked dots' details instead). Plants that belong to a box now always draw first, so a loose plant always sits on top.
- **Fills on freehand-drawn beds ignored the bed's shape.** Custom-shaped beds store their outline as `customPoints`, but the fill grid and its live preview both checked a `points` field that doesn't exist — so the shape check silently never ran and plants were placed outside the outline. Both now use `customPoints`. Verified with a triangular bed: filled plants only appear inside the triangle.

One thing that's geometry rather than a bug, worth knowing: a plant box can only slide as far as its own size allows within the bed — a box 2.5ft wide in a 4ft-wide bed has only about 1.5ft of travel, which can feel "stuck" toward one side. Shrinking the box (green corner handle) frees up room to move it.

Tested: five sequential adds all land at least 0.9ft apart and reach the right side of a 4ft bed; the full-bed notice appears and no plant is lost; loose plants draw above box members even when they come first in the data; placement on a circular bed stays inside the circle; and a triangle fill stays inside the triangle. One existing test (marquee selection) had a hard-coded selection rectangle tuned to the old placement positions, so it was adjusted to match — the selection logic itself was unaffected.

## Root-Cause Fix: Beds Were Drawn Larger Than Their Real Size
The real reason plants (and boxes) seemed stuck on the left side of a bed: each bed was drawn with a minimum size of 170×100px, but plants and boxes are limited to the bed's actual dimensions. A default 4ft-wide bed is only 56px at true scale, so it was drawn 170px wide while nothing could move past 56px — exactly the left third. Beds under about 7ft long had the same problem vertically. The minimum dated from when the bed's name label lived inside it; the label sits outside now, so beds are drawn at exactly true scale (a 4ft bed is now 4 grid squares wide at the 1ft grid). This also keeps satellite-image tracing and light-zone detection honest, since both already used the true dimensions. The "No plants yet" caption is hidden on beds too narrow to fit it.

Why earlier tests missed this: they checked the numbers the app stored, not what was actually drawn on screen. Added a test that checks rendered geometry — every bed's drawn size equals its true size, and a plant dragged as far right as possible lands exactly on the drawn bed's right edge. Confirmed it fails against the old behavior (170px drawn vs. a 56px limit) and passes now.

## Calendar and Companion Planting: One Entry Per Kind of Plant, Not Per Plant
A bed filled with 144 carrots used to produce 144 identical calendar events, 144 Gantt rows, and a companion-planting note reading "Carrot, Carrot, Carrot..." 144 times. These now group plants by name plus cultivar, so identical plants collapse into a single entry with a count (e.g. "Carrot ×12"), while a plant explicitly labeled as a different cultivar still gets its own line ("Carrot (Nantes) ×3").

- **Calendar list view:** one event per variety per phase (start indoors / plant outside / harvest). Plants only merge when name, cultivar, location, and the actual date text all match — so a plant with its own custom dates still appears separately rather than being silently absorbed.
- **Gantt view:** one row per variety per location with an identical timeline; the cultivar now shows in the visible row label (it previously appeared only in the hover text), since cultivars now get their own rows.
- **"Not yet scheduled" list and the Gantt's "unscheduled" note:** collapsed the same way.
- **Companion planting:** the plant details panel, the hover warning on a plant's dot, and the box-overlap note all group neighbors by variety with counts instead of repeating each plant (and the box-overlap note no longer repeats a plant name when two same-plant boxes overlap).

Deliberately left alone: the new-year rollover screen, which still lists every individual plant, since that's where you choose which specific plants to keep.

Tested with 30 plants: 12 plain carrots + 3 "Nantes" carrots collapse to two entries (×12 and ×3) rather than fifteen, 8 basil + 2 "Genovese" basil become two lines, 15 undated plants become three lines, and the Gantt shrinks from 17 rows to 3.

## Fix: Crop Rotation Warnings Citing Impossible or Meaningless History
Crop-rotation warnings ("Grew Tomato (also a nightshade) here in 2031") could cite history that made no sense. Reproduced with tests, and found three real flaws:

- **Future-dated archives were treated as real history.** An archive's year label is free text with no validation, and nothing checked that the year had actually happened. An archive labeled with a future year produced warnings like "grew here in 2031." Rotation checks now ignore any archive whose year hasn't happened yet, the History tab flags such an entry with an explanation, and the new-year dialog now refuses to save a future-year label.
- **Kept plants warned about themselves.** Starting a new year keeps chosen plants (perennials by default) in the bed, and the archive stores a copy of them with the same ids — so every kept plant found its own archived copy and warned "you grew this here last year." A plant still sitting in the bed was never rotated out, so it no longer counts as rotation history.
- **History was ordered by when it was archived, not which growing year it was for.** An older season archived late outranked a newer one, so the warning cited the wrong year. Now sorted by growing year (archive date only breaks ties).

Also added: history year labels are now editable in place (pencil icon on the History tab) so a bad label can be corrected instead of having to delete the whole snapshot, and the new-year dialog's default label is now the season actually being closed out (this year from June on, last year January–May) — it previously always assumed last year, and before that always this year, so archives made in different versions of the app may be labeled inconsistently. Old archives stay in your saved data across versions; the History tab is where to review, correct, or delete them.

Rotation matches beds by NAME, so a new bed that reuses the name of an old test bed will pick up that old bed's history — the per-bed "clear history" control and the History tab's delete are the tools for that.

Tested: a kept plant no longer warns about itself (hover text and details panel); a genuine conflict still warns; a 2031-labeled entry is ignored, flagged, and once relabeled to a real past year starts working; out-of-order archives cite the newest growing year; the new-year dialog defaults sensibly, blocks future years, and still allows free text.
## Fix: "Your Land" Background Grid Only Covering a Corner Square
The reference grid on the map was drawn as a CSS `background-image` (a repeating gradient) on a plain `<div>` sized to the full scrollable map area. That works fine for a small map, but a raster CSS background tiled across a very large scrollable surface is a known trouble spot in browsers — the compositor can rasterize only the region near the origin and never fill in the rest as you scroll or as the map grows, which matches exactly what was reported: the grid appears as a solid square near the top-left corner and just stops, with no lines anywhere else, even though the map area itself is much bigger.

Replaced the CSS-tiled div with an SVG `<pattern>`: the same grid square repeated via `patternUnits="userSpaceOnUse"`, filled into a single `<rect>` that covers the whole map. SVG patterns are tiled by the vector renderer itself rather than by the same raster-compositor path, so they don't have this "only near the origin" failure mode regardless of how large the land area gets.

Verified in a scripted render of the full app: the grid's underlying `<rect>` correctly resizes to match the real, measured size of the map viewport (not just the 800×640 fallback used before any measurement happens), and a full interaction pass (opening the app, adding a bed) produced zero console errors. This one is hard to fully prove from an automated test alone, since it comes down to how a real browser paints a large tiled surface — please take a look at a property with beds spread out over a wider area (or zoomed out to see the whole land) and let me know if any blank patches remain.

## Follow-up: the SVG-pattern grid fix wasn't enough — grid now drawn as explicit lines
The SVG `<pattern>` swap above turned out to have the same problem as the CSS version it replaced: at 200% zoom the grid filled the map fine, but zooming back down below 100% lost the squares again over most of the map, same as before. Confirmed against your screenshot (the grid lines really do stop partway across the map, well short of the actual container edge).

Root cause: both a CSS `background-image` repeated via `background-size` and an SVG `<pattern>` repeated via `patternUnits` ask the browser to *tile a small piece across a big area* — and browsers cap how many times they'll reliably do that within one paint, especially once the tile gets small (which is exactly what happens zooming out: the square gets smaller in pixels, so more tiles are needed to cover the same visible area, and it's more likely to hit that cap). At 200% the tile is big enough that the whole map only needs a handful of tiles, so it never hits the cap.

Fixed properly this time by not tiling anything: the grid is now a fixed list of exact line coordinates (computed from the map's real size and the current square size), drawn as one SVG path. There's no repeating fill for a renderer to give up on partway through — just as many lines as the visible map actually needs, however zoomed in or out you are. Capped at 4000 lines as a safety net (thins the grid rather than freezing the page if you zoom out extremely far with a tiny manual square size).

Verified by scripting a zoom-out (down past 100%, matching what you reported) against the actual delivered file and checking the grid's rightmost line lands at the true edge of the map container, not partway across — it does, and the same check at the original zoom level still passes too, with zero console errors either way.

## Follow-up #2: Grid Now Drawn as Separate Lines Instead of One Combined Shape
Tested the explicit-gridlines fix above with your exact exported data (both backup files) in a real browser here, at the same window size shown in your screenshot — the grid came back correctly full-width every time, and the console stayed clean, so I could not reproduce the cutoff with your data on this end.

Since the numbers are verifiably correct (checked directly: the grid's underlying shape does span the full map) but it's still failing specifically on your machine, the most likely remaining explanation is a rendering limitation in your particular Chrome/Windows/GPU combination — some real-world browsers have trouble rendering one very long, complex compound shape (which is what the single `<path>` from the last fix was: potentially thousands of "move/line" instructions combined into one shape) even when the numbers behind it are correct, and give up partway through instead of erroring.

Changed the grid from one combined path to a plain list of separate line elements — one per grid line, however many are needed, with no single shape more complex than a straight line. This removes that entire class of failure regardless of exactly what was tripping it up.

I still can't reproduce the original issue myself (verified again with your exact data), so this is a targeted fix for a specific category of rendering bug rather than one I watched fail and confirmed fixed. If it still cuts off after this, the useful next thing to check is whether hardware acceleration is toggled on/off for Chrome (chrome://settings → System) — if you can, please note your Chrome version and GPU/graphics driver too. I know that's an annoying ask, and appreciate you sticking with it.

## 2026-10-21 — Performance + full code comments
- **Faster dragging:** dragging a bed with many plants went from ~95 ms to ~27 ms per mouse move (8 beds × 120 plants). Beds are now memoised (`MemoBedCard`) with stable handlers (`useStableHandlers`), fuzzy plant-name matching is cached, per-plant companion/rotation/light warnings are computed once per bed, and canvas sizing uses plain loops instead of `Math.max(...spread)`.
- **Grid:** background grid is a single memoised SVG of `<line>` elements (capped at 4,000 lines). Verified to span the full map in Chromium with your exported data; still unconfirmed on your own Chrome — if it still cuts off, send your Chrome version and whether hardware acceleration is on.
- **Comments:** doc comments on all constants/functions/components, inline notes on every state/ref, and `{/* … */}` section comments on the sidebar sections, map layers and tab router.

## 2026-10-22 — Wheel zoom + draw-toolbar overlap fix
- **Mouse-wheel zoom** over "Your land": scroll up to zoom in, down to zoom out, anchored on the cursor so the spot under the pointer stays put. Range matches the +/- buttons (3%–200%). Click-drag still pans.
- **Reset size button** no longer sits on top of the Finish / Cancel / Undo toolbar while drawing or editing a shape.

## 2026-10-22 — Seed inventory + succession planting (new "Seeds" tab)
- **Seed inventory:** add packets with crop, variety, supplier, amount + unit, and the "packed for" year. Edit the on-hand amount inline; delete with confirmation. Packets more than ~3 seasons old get an "older seed — test germination" note.
- **Succession planner (per packet):** repeated sowings spaced a few weeks apart, computed from your zone's average frost dates and the crop's timing. First sowing = earliest outdoor date; last sowing = the latest date the crop can still mature before first fall frost (with grace for frost-tolerant crops). Each row shows start-indoors date (for transplants), sow/plant-out date and harvest window.
- Defaults per crop (e.g. radish weekly, lettuce every 2 wks, carrot every 3) — override weeks between sowings, max sowings, days to maturity, or the first sowing date.
- Cool-season crops (lettuce, spinach, cilantro, radish, pea) skip mid-summer sowings and resume for a fall crop.
- Optional "used per sowing" amount → shows total needed vs. on hand, and what's left as you tick sowings off.
- Saved with the rest of the garden and included in Backup & restore (backup format v7; older backups still import). Not part of undo/redo.
- Plan year defaults to next year once September arrives; change it at the top of the tab.

## 2026-10-22 — Seeds: edit packets + sowing dates on the Calendar
- **Edit seeds:** each packet has an Edit button that opens every field (crop, variety, supplier, amount, unit, packed-for year, notes) with Save / Cancel. The on-hand amount can still be changed inline without opening the form. The "Add packet" button is now "Add seeds".
- **Calendar:** tick "Show these sowing dates on the Calendar tab" in a packet's succession plan and its sowings appear in the Calendar's List view as blue "Sow seeds" events (plus "Start indoors" events for transplanted crops; done sowings are marked ✓). New "Sow seeds" filter chip in the legend. The Gantt view doesn't include seeds yet.
- The plan year is now shared between the Seeds and Calendar tabs.

## 2026-10-22 — Harvest totals (Journal tab)
- **Structured harvest amounts:** logging a harvest now asks "How much" — a number plus a unit (lb, oz, kg, g, count, bunch, gallon, quart, pint). Shown on each entry.
- **Harvest totals panel** above the journal list: pick a year (or all years) and group **by plant** or **by bed**. Weights are combined within a system (oz into lb, g into kg; pints/quarts into gallons); different kinds (e.g. lb vs count) are shown side by side rather than mixed. Plant/bed names match regardless of capitalisation. A bottom row gives the overall total.
- Older harvest entries that only have free text (e.g. "3 lbs tomatoes") stay in the journal but aren't counted; the panel says how many were skipped.

## 2026-10-22 — Edit journal entries
- Every journal entry has a pencil (Edit) button: change its type, date, bed, plant, harvest amount + unit, expense amount, and notes, then Save or Cancel. Editing an older free-text harvest and giving it an amount makes it count in Harvest totals.

## 2026-10-22 — Pantry & preservation tracker (new "Pantry" tab)
- Track what's been put up: item name, the crop it came from (optional), method (canned, jam/jelly, pickled, frozen, dried, fermented, root cellar, other), how many + unit (jar, half-pint, pint, quart, bag, container, lb, item), date made, where it's stored, notes.
- **Use one / add one** buttons (− / +) on each item; items at zero show as "used up" (hidden unless "Show used up" is ticked).
- **Best-by tracking:** each item gets an estimated best-by date from its method (e.g. 12 months for canned/frozen, 6 fermented, 4 root cellar), or enter your own. Items within 30 days are flagged "use soon", past-date items "past best-by"; the list sorts soonest first. These are quality windows, not food-safety guarantees.
- Filter by method, search by name/crop/location/notes, and edit any field inline.
- **Harvested vs. preserved:** per crop, for a chosen year, shows Journal harvest totals next to how much was preserved that year (counts what was made, not what's left).
- Saved with the garden and included in Backup & restore (backup format v8; older backups still import). Not part of undo/redo.

## 2026-10-22 — Bed measurements limited to 2 decimals
- Bed width/length now display with at most 2 decimals (e.g. 4.07ft × 8.33ft instead of 4.0714285ft). Drag-resizing a bed rounds to 2 decimals as it goes, the edit form rounds on save, and beds saved earlier with long fractions are tidied when the garden loads.

## 2026-10-22 — Two-decimal limit extended to all garden measurements
- Everything produced by dragging is now kept to 2 decimals: bed position and size, spacing-box position/size/spacing, plant positions after moving them or a box, and freestanding items (plants, light zones, features, images). Spacing shown on a box tooltip is formatted to 2 decimals.
- On load, existing beds and their spacing boxes are tidied to 2 decimals as well (plant positions generated by fill tools are left as they are so spacing stays even).

## 2026-10-22 — Drag a bed from anywhere inside it
- Beds can now be moved by clicking and dragging empty space inside the bed (and its border), not only the name label. Dragging a plant, a spacing box or any handle still does its own thing, and in "Select multiple" mode dragging inside the bed still draws a selection rectangle. The bed's inside shows a grab cursor.

## 2026-10-23 — "No plants yet" centred in empty beds
- The "No plants yet" note now sits in the middle of an empty bed (rectangles, circles/ovals and custom shapes) instead of at the top. The bed's inside now fills the whole bed, which also makes dragging from anywhere inside it work right to the bottom edge.

## 2026-10-23 — Click inside a bed to keep its details open
- Clicking (or starting a drag) anywhere inside a bed now pins its title and details card open. It stays until you click somewhere outside that bed — empty map, another bed, or the sidebar. Clicking another bed switches to that one. The ⓘ button still toggles the pin by hand, and hovering still previews the details as before.

## 2026-10-23 — Native & invasive designations
- Every plant can be marked **Native**, **Non-native**, **Spreads aggressively** or **Invasive**. A built-in reference list (Michigan / Great Lakes: native wildflowers, grasses, edibles and trees; common garden crops; aggressive spreaders like mint; and invasives like garlic mustard, buckthorn, barberry and autumn olive) gives a starting answer from the plant's name — the longest matching name wins, so "mountain mint" is native while plain "mint" spreads aggressively.
- **Per-plant override:** the plant details window has a "Native / invasive status" dropdown (Automatic, or pick one). It shows the reference result and a one-line explanation.
- **On the map:** plant dots are colour-coded (teal native, amber aggressive, red invasive; ordinary plants stay green) and the tooltip names the status. Freestanding plants colour their sprout icon the same way. The bed details card shows "N of M native", "N invasive" and "N spreads aggressively" pills when there's something to report.
- The sidebar Legend explains the dot colours.
- The reference list is a starting point only; native ranges and invasive listings vary by state, so check local sources for anything important.

## Region-aware native & invasive designations
- The native/invasive reference now depends on where you garden. Pick **Your state** in the header, or enter a ZIP code (it fills in the state offline, even if the zone lookup fails).
- The state maps to one of nine regions (Northeast, Midwest, Northern Plains, Southeast, South Central, Rockies, Southwest, Pacific NW, California). Each plant entry lists the regions it applies to, e.g. garlic mustard is invasive in the Northeast/Midwest/Southeast/PNW, kudzu in the Southeast, Himalayan blackberry in the PNW/California. Mint, comfrey, etc. are flagged "spreads aggressively" everywhere.
- Alaska, Hawaii, and non-US users have no regional list yet, so only the everywhere entries apply; per-plant overrides always work.
- State is saved and included in backups (backup format version 9).

### Invasive list accuracy pass
- Checked the invasive entries against the Washington, Utah, Colorado, New York (Part 575), Tennessee and California (Cal-IPC) lists. Fixed regions (e.g. dame's rocket no longer flagged in WA/TN/NY; scotch broom no longer in the Southeast; Johnsongrass/giant reed/tamarisk widened to the West; Japanese honeysuckle removed from the PNW/CA).
- Creeping Jenny, creeping Charlie and ground ivy moved from invasive to "spreads aggressively" (none appear on those state lists).
- Added Northeast/Mid-Atlantic species from NY's list: mile-a-minute, porcelain berry, wineberry, mugwort, lesser celandine, swallow-worts, wintercreeper, Chinese silver grass, golden bamboo, cogongrass, Chinese yam.
- Not yet checked state-by-state: the Midwest (MIPN), Florida/Georgia, Texas, the Northern Plains, the Desert Southwest and New England lists.

### Invasive list accuracy pass 2
- Also checked Michigan, Ohio, Minnesota, Florida, Georgia, Arizona, New Mexico, Connecticut, North Dakota and Texas references. Added Midwest, Rocky Mountain, Southwest and Southeast species (Siberian elm, princess tree, leafy spurge, common tansy, myrtle spurge, oxeye daisy, fountain grass, buffelgrass, chinaberry, Brazilian pepper, etc.); dame's rocket no longer flagged in the Northern Plains; teasel widened to the Southwest.
- Still unchecked: Nevada, Oklahoma, Arkansas, Louisiana, South Dakota, Nebraska, Kansas, and most remaining Southeast and New England states individually.

### Invasive list accuracy pass 3 (broad state sweep)
- Additional lists consulted: Virginia, South Carolina, Pennsylvania, Massachusetts (partial), Indiana, Wisconsin, Arkansas, Kentucky, Kansas, South Dakota, Idaho, Nevada, Alaska, Oregon (news only). Added wisterias, sericea lespedeza, Japanese hops, chocolate vine, sweet autumn clematis, privets, etc.; creeping Jenny is now invasive in the East but "spreads aggressively" elsewhere (a name can now carry several region rules).
- Not obtained: Montana, Wyoming, Oregon's full list, North/Alabama/Mississippi/Louisiana/Oklahoma full lists, NJ/MD/DE/WV/ME/NH/VT/RI/IL/IA/MO individually. Hawaii and Alaska have no regional list.

### Invasive list accuracy pass 4
- Added Oregon, Montana, Wyoming, North Carolina, Louisiana, Maine, Vermont, New Hampshire, Massachusetts, New Jersey, Illinois, Nebraska, Maryland, Iowa, Oklahoma and West Virginia lists. New entries include the Pacific Northwest garden escapes (gorse, Herb Robert, yellow archangel, old man's beard, spurge laurel, English hawthorn), Northeast ornamentals (sycamore/Amur maple, silver lace vine, cypress spurge, sea buckthorn, ornamental jewelweed, coltsfoot), Southeast landscape plants (elephant ear, monkey grass, Cherokee rose, thorny olive, photinia), St. John's wort and houndstongue in the Mountain West, plus the giant/Bohemian/Himalayan knotweeds and poison hemlock. Ground ivy and creeping Charlie are now invasive in the Northeast and Southeast; scotch broom added to the Northeast and Southeast; cup plant is native in the Midwest/Plains/South but invasive in the Northeast.
- Still without a readable official list: Alabama, Mississippi, Missouri, Rhode Island, Delaware, Hawaii (and Alaska's garden species). Those states fall back to the regional list.
- Montana's official list (supplied by Kim) confirmed the Rocky Mountain entries; added tall buttercup and blueweed.
- Wyoming's list (supplied by Kim) matched; added mullein, burdock, black henbane, Palmer amaranth.
- Oregon list (Wikipedia, supplied by Kim): added French/Spanish broom, marram grass, evergreen blackberry, crack willow, fennel, yellow toadflax. Cornflower was on that list but isn't on Oregon's official noxious list, so left alone.
- Alabama list (EDDMapS, supplied by Kim): added air potato, ardisias, beautyberries, Chinese elm, paper mulberry, trifoliate orange, Macartney rose, torpedograss, tropical soda apple, beach vitex, milk thistle, maiden grass.
- Missouri list (Missouri Invasive Plant Council, supplied by Kim): added beefsteak plant/perilla/shiso, birdsfoot trefoil, Japanese chaff flower; the rest was already covered.
- Delaware list (supplied by Kim): added Japanese pachysandra, orange/tawny daylily, Chinese fountaingrass, black jetbead and invasive viburnums for the Northeast. Left off very common ornamentals Delaware ranks low (Japanese maple, daffodil, kousa dogwood, snowdrop) since they aren't treated as invasive across the region.
- Double-check pass: garlic mustard / Brazilian pepper now fall back to 'spreads aggressively' (not 'non-native') when no region is set; added natives whose names contain crop words (partridge pea, pearly everlasting, sweet pepperbush, wild onion, marsh marigold, wild mint, skunk cabbage, squirrel corn...). Verified: 300 entries, no duplicate keys, all region codes valid.
- A recognised-but-out-of-region name (e.g. marsh marigold with no state set) no longer falls back to a short crop word like 'marigold' and gets labelled non-native.
- Kudzu is now flagged invasive everywhere (including no state set / outside the US).
- Bamboo (and golden bamboo) are now flagged invasive everywhere. Lucky bamboo (a houseplant) and clumping bamboos (e.g. Fargesia) are excluded; heavenly/sacred bamboo (nandina) keep their regional rules.
- Heavenly/sacred bamboo (nandina) is not a true bamboo: invasive in the regions where it's listed, otherwise just non-native.
- Bed title pill now appears only on hover or when the bed is pinned (click inside), like the details card; it no longer clutters the map.
