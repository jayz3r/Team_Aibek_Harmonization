# FireBridge — Earth Observatory (frontend)

React 19 + Vite 7 + MapLibre GL 5. No chart library: the charts are plain SVG.

## How it talks to the backend

All requests go to the page's own origin: `/health` and `/api/v1/...`.

- `npm run dev` / `npm run preview`: `vite.config.js` proxies those paths to `http://127.0.0.1:8000`
  (override with `VITE_BACKEND_URL`).
- After `npm run build` the FastAPI server serves `dist/` itself, so the origin is the same.
- A different address or an API key can be entered in the Data panel (stored in the browser), or
  fixed at build time with `VITE_API_URL`.

On start the app calls `/health` and `/api/v1/overview`. If that fails it switches to the offline
showcase and retries every 20 seconds; when the data revision on the server changes it reloads.

## Source map

| File | Role |
|---|---|
| `src/App.jsx` | State, map set-up, queries, layout |
| `src/api.js` | API client: errors, job polling, uploads, CSV downloads |
| `src/format.js` | Pure helpers: date windows, feature mapping, calendar matrix, insights |
| `src/fireLayers.js` | Map sources/layers: pixels, density, 10 km grid, events, links |
| `src/Analytics.jsx` | Harmonization lab: calendar, seasonality, validation, sensor agreement |
| `src/DataPanel.jsx` | Connection, datasets, upload, live FIRMS import, filters, export |
| `src/charts.jsx` | SVG charts |
| `src/data.js` | Region presets, synthetic demo points, browser-only CSV import |
| `src/landscape.js`, `src/cities.js` | Terrain, satellite basemap, region highlight, 3D city views |
| `public/data/showcase/` | Precomputed full-China results for offline mode (`scripts/make-showcase.py` rebuilds them from `backend/reports`) |

## Behaviour worth knowing

- **Area of interest.** A drawn rectangle, or the bounding box of a selected province, is sent as
  `area.bbox` with every query. "China", "World", "Loaded data" and city views send no area.
- **Pixels.** Up to 30,000 detections per view (three pages of 10,000, ordered by time). When
  more exist the counter says so; use the grid, a month, or a smaller area.
- **Timeline.** One calendar request per year. Bars show the harmonized index; with a MODIS or
  VIIRS filter they show raw detections of that family, because the index is not per sensor.
- **Model.** The latest model fitted on the current data revision is used automatically for
  archive data. It is never sent with near real-time data.
- **Events and links** work on one month at most (backend limit of 31 days).
- **Offline.** Synthetic points are labelled as such; analytics show the precomputed report.

## Tests

`npm test` runs `tests/*.test.mjs` with Node's test runner: geometry and style validation of all
map layers, date windows, API client behaviour against a stubbed `fetch`, and consistency of the
bundled showcase report.

## Credits

Base map: OpenFreeMap / OpenStreetMap. Terrain: Mapterhorn. Satellite: Sentinel-2 cloudless 2020 by
EOX (CC BY 4.0), not matched to fire dates. Boundaries: geoBoundaries, display only. Fire data:
NASA FIRMS (MODIS Collection 6.1, VIIRS 375 m).
