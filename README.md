# Homestead Bed Planner

A garden planner for homesteaders and gardeners: draw beds in real dimensions, trace them from a
satellite photo of your own property, track companion planting and crop rotation, plan a
zone-aware planting calendar, and keep a year-over-year journal — all running entirely in your
browser, with your data saved locally on your own device.

## Running it

**`index.html` is the whole app.** It's a single self-contained file — React, styling, and all
the app logic are bundled inline, with no build step and no server required. Open it directly in
a browser, or serve it via GitHub Pages (see below) for a link you can share.

Data is saved to the browser's local storage on whatever device you're using it from. It doesn't
sync between devices or browsers, and clearing site data/browser storage will erase it — exporting
a backup (JSON, via the app's own Export button) is the way to move data between devices or keep a
safety copy.

## Source

`garden_planner.jsx` is the React source the app is built from. It's a single large component —
no separate build tooling is included in this repo yet; `index.html` is the pre-built,
ready-to-run output. If you want to modify the app, this is the file to edit and rebuild from.

`FEATURES.md` has the full running list of what's been built, phase by phase.

## Getting a shareable link (GitHub Pages)

1. Push this repo to GitHub (see below if you haven't yet).
2. On GitHub, go to the repo's **Settings → Pages**.
3. Under "Build and deployment," set **Source** to "Deploy from a branch," pick your main branch
   and the `/ (root)` folder, then save.
4. GitHub will publish the site at `https://<your-username>.github.io/<repo-name>/` within a
   couple of minutes — that's the link to share for user testing.

## Pushing this checkpoint to GitHub

From this folder:

```bash
git init
git add .
git commit -m "Checkpoint: satellite image tracing, resize systems, performance pass"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

(Create the empty repo on GitHub first if it doesn't exist yet — no README/license/gitignore
needed there, since this folder already has one.)
