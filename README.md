# FireBridge — Harmonization of MODIS and VIIRS Hot Spots

A project for the NASA Space Apps Challenge, topic **Harmonization of MODIS and VIIRS Hot Spots**.
The backend (FastAPI + DuckDB) and the frontend (React + MapLibre) now run as a single application.

```
FireBridge/
  backend/    API: FIRMS import, 10 km grid, calibration, calendar, seasonality, events
  frontend/   Map and the "harmonization lab"
  start.bat   Start both servers on Windows
  start.sh    The same for macOS / Linux
```

## Getting started

You need **Python 3.12** and **Node.js 22.12+** (or 20.19+).

**Window 1: backend**

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate            # Windows;  macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

**Window 2: frontend**

```bash
cd frontend
npm ci
npm run dev
```

Open the address that Vite prints (usually <http://localhost:5173>). Vite forwards
`/api` and `/health` to the backend itself, so no CORS setup is needed. A **LIVE API · REV …**
badge should appear in the header.

With an empty database, click the badge → **Load real sample + calibrate**: a real data excerpt
(17,075 detections, northeast China, 2001–2026) is loaded and a model is trained. You can load your
own FIRMS archives (CSV or ZIP) in the same place with the **Upload FIRMS CSV / ZIP** button; after
the upload, open **Harmonize → Validation → Re-calibrate**.

`start.bat` / `start.sh` do the same thing with one command (they install dependencies on first run).

### One port for the jury demo

```bash
cd frontend && npm run build      # creates frontend/dist
cd ../backend && uvicorn app.main:app --port 8000 --workers 1
```

The whole application now opens at <http://localhost:8000>, and the API documentation is at `/docs`.

### Loading your own data from NASA FIRMS

1. On the [FIRMS Archive Download](https://firms.modaps.eosdis.nasa.gov/download/) page, create a request: country or area, period, product (MODIS, VIIRS S-NPP, NOAA-20, NOAA-21), format **CSV**.
2. Download the ZIP from the link in the email. You do not need to unpack it.
3. In the app, click the status badge in the header → **Upload FIRMS CSV / ZIP** and choose one or several archives.
4. After the upload, open **Harmonize → Validation → Re-calibrate**.

The model needs both MODIS and VIIRS data for several shared years. The limit for a single file is 256 MB (`MAX_UPLOAD_MB`).

### Deploying on Render

| Field | Value |
|---|---|
| Root Directory | `backend` |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn app.main:app --host 0.0.0.0 --port $PORT --workers 1` |
| Variable `PYTHON_VERSION` | `3.12.8` |
| Variable `AUTOLOAD_DEMO` (optional) | `1`: an empty database loads the bundled sample and trains a model on startup |

The server serves the interface from `frontend/dist`, so after changing anything in `frontend/src`, run `npm run build` and commit `frontend/dist`.

The free tier has 512 MB of memory, and the disk is wiped on restart. Upload large archives (a whole country over many years) when running locally.

### If the backend is not running

The frontend does not crash: the badge shows **OFFLINE SHOWCASE**, the map shows synthetic points
(labelled as a demo), and the lab shows a precomputed report from this backend on the full
China archives (15.6 million detections, 2000–2025). This is a safety net in case something fails during the demo.

## What the application can do

| Where | What |
|---|---|
| Timeline at the bottom | Year and month; the bars show the harmonized activity index, and the strip under each bar shows the source satellite of that month |
| **Pixels / Density** | Raw MODIS (orange) and VIIRS (light) detections, filters by sensor, day/night, archive/NRT |
| **Grid 10 km** | Equal-area grid, the unit from which the index is built; satellite selection |
| **Events** | Pixels from all satellites merged into space-time clusters; color shows who saw them (both families / VIIRS only / MODIS only) |
| Scene settings → **Draw area** | Your own area of interest: the map, calendar and anomalies are computed for it |
| **Harmonize → Burning calendar** | Burning calendar for all years, comparison of the raw series against the harmonized one, flags, CSV |
| **Harmonize → Seasonality** | Seasonal profile, deviations of the selected year (z-score), most active months |
| **Harmonize → Validation** | Coefficients with confidence intervals, error before/after on the held-out year, an honest list of limitations, a re-train button |
| **Harmonize → Sensor agreement** | MODIS–VIIRS pixel matching by distance and time, share of events seen by both sensors |
| Status badge → data panel | File upload to the server, import of fresh NASA FIRMS data, coverage by satellite, CSV export |

To import fresh data from NASA FIRMS, get a free MAP_KEY, copy
`backend/.env.example` to `backend/.env`, add `FIRMS_MAP_KEY=...` and restart the server.
The key stays on the server.

## Testing

```bash
cd backend  && pip install -r requirements-dev.txt && python -m pytest -q
cd frontend && npm test
```

What was checked when this version was built, and what you still need to run yourself, is described in
[CHANGES.md](CHANGES.md).

## Documentation

- [backend/README.md](backend/README.md): API, data, limitations
- [backend/docs/methodology.md](backend/docs/methodology.md): the harmonization method
- [backend/docs/frontend.md](backend/docs/frontend.md): the API contract for the frontend
- [backend/reports/VALIDATION.md](backend/reports/VALIDATION.md): results on the full China archives
- [frontend/README.md](frontend/README.md): how the interface is organized
