from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated
import csv
import hmac
import io
import json
import uuid

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.security import APIKeyHeader
from fastapi.staticfiles import StaticFiles

from .config import Settings, InputError, ConflictError, NotFoundError
from .events import fire_events
from .firms import import_firms
from .harmonize import fit_model, calendar, seasonality, LIMITATIONS
from .ingest import ingest_file
from .jobs import JobRunner
from .matching import match_observations
from .queries import detections_geojson, detection_frame, grid_geojson, json_records
from .schemas import (DetectionQuery, GridQuery, CalibrationRequest, CalendarQuery, SeasonalQuery, MatchQuery,
                      EventQuery, FirmsRequest)
from .store import Store

VERSION = "1.1.0"


def compact_model(model):
    """Model without the (large) per-coefficient region lists; used by the UI."""
    if model is None:
        return None
    out = {key: value for key, value in model.items() if key != "coefficients"}
    out["coefficients"] = [
        {**{key: value for key, value in c.items() if key != "support_regions"},
         "support_region_count": len(c.get("support_regions", []))}
        for c in model.get("coefficients", [])]
    return out


def create_app(settings=None):
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app):
        app.state.store = Store(settings)
        app.state.jobs = JobRunner(app.state.store)
        try:
            yield
        finally:
            app.state.jobs.close()
            app.state.store.close()

    app = FastAPI(title="MODIS–VIIRS Harmonization API", version=VERSION, lifespan=lifespan,
        description="FIRMS ingestion, equal-area activity indicators, held-out calibration, calendars and anomalies. All times UTC. Research prototype.")
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins,
                       allow_credentials=False, allow_methods=["GET", "POST"], allow_headers=["Content-Type", "X-API-Key"])

    header = APIKeyHeader(name="X-API-Key", auto_error=False)

    def authenticate(key: Annotated[str | None, Depends(header)]):
        if settings.api_key and not hmac.compare_digest((key or "").encode(), settings.api_key.encode()):
            raise HTTPException(401, "Invalid or missing X-API-Key")

    @app.exception_handler(InputError)
    async def bad_input(_, exc):
        return JSONResponse(status_code=422, content={"detail": str(exc)})

    @app.exception_handler(ConflictError)
    async def conflict(_, exc):
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(NotFoundError)
    async def missing(_, exc):
        return JSONResponse(status_code=404, content={"detail": str(exc.args[0]) if exc.args else "Not found"})

    @app.get("/health", tags=["system"])
    def health(request: Request):
        return {"status": "ok", "revision": request.app.state.store.revision(), "version": VERSION}

    router = APIRouter(prefix="/api/v1", dependencies=[Depends(authenticate)])

    @router.get("/methodology", tags=["system"])
    def methodology():
        return {"grid_km": settings.grid_km, "region_km": settings.region_km,
                "projection": "Spherical cylindrical equal-area, standard parallel 30 degrees, R=6371.0088 km",
                "quality": {"MODIS": ">=30", "VIIRS": "nominal or high", "probabilities_equivalent": False},
                "limitations": LIMITATIONS}

    @router.get("/overview", tags=["system"])
    def overview(request: Request):
        """Everything a client needs to boot: data extent, latest model, enabled features."""
        store = request.app.state.store
        with store.lock:
            revision = store.revision()
            spans = {"archive": store.spans("archive"), "NRT": store.spans("NRT")}
            statuses = {row["status"]: int(row["n"]) for row in
                        store.records("SELECT status, count(*) AS n FROM datasets GROUP BY status")}
            model = compact_model(store.latest_model())
        every = spans["archive"] + spans["NRT"]
        bounds = [min(r["west"] for r in every), min(r["south"] for r in every),
                  max(r["east"] for r in every), max(r["north"] for r in every)] if every else None
        years = {name: ([int(min(r["start"] for r in rows)[:4]), int(max(r["end"] for r in rows)[:4])] if rows else None)
                 for name, rows in spans.items()}
        return {"status": "ok", "version": VERSION, "revision": revision,
                "datasets": {"ready": statuses.get("ready", 0), "by_status": statuses},
                "detections": {name: int(sum(r["detections"] for r in rows)) for name, rows in spans.items()},
                "coverage": spans, "bounds": bounds, "years": years, "latest_model": model,
                "capabilities": {"firms_live": bool(settings.firms_map_key), "auth_required": bool(settings.api_key),
                                 "demo_sample": settings.demo_sample.is_file()},
                "grid_km": settings.grid_km, "region_km": settings.region_km,
                "definition": "Observed file spans/bounds, NOT clear-sky/overpass coverage"}

    @router.post("/demo/load", status_code=202, tags=["data"])
    def demo_load(request: Request):
        """Import the bundled REAL sample (NE China, 1x1 degree) and fit a model on it, as one job."""
        sample = settings.demo_sample
        if not sample.is_file():
            raise HTTPException(404, "Bundled sample examples/china_sample.csv is missing")
        store = request.app.state.store

        def process(progress):
            imported = ingest_file(store, sample, "china_sample.csv (bundled real excerpt)", progress)
            model = fit_model(store, CalibrationRequest())
            return {"dataset_id": imported["dataset_id"], "already_imported": imported["already_imported"],
                    "id": model["id"], "model_id": model["id"], "revision": store.revision(),
                    "note": "Real 123-124 E, 44-45 N excerpt; not the full-China validation model"}

        return request.app.state.jobs.submit("demo", process)

    @router.get("/datasets", tags=["data"])
    def datasets(request: Request):
        rows = request.app.state.store.records("SELECT * FROM datasets ORDER BY created_at")
        for row in rows:
            if isinstance(row["audit"], str):
                row["audit"] = json.loads(row["audit"])
        return {"datasets": rows, "revision": request.app.state.store.revision()}

    @router.get("/coverage", tags=["data"])
    def coverage(request: Request):
        store = request.app.state.store
        return {"archive": store.spans("archive"), "NRT": store.spans("NRT"),
                "definition": "Observed file spans/bounds, NOT clear-sky/overpass coverage", "revision": store.revision()}

    @router.post("/datasets/upload", status_code=202, tags=["data"])
    def upload(request: Request, file: Annotated[UploadFile, File(description="FIRMS CSV or ZIP; max 256 MiB")]):
        name = Path(file.filename or "upload.csv").name
        suffix = Path(name).suffix.lower()
        if suffix not in [".csv", ".zip"]:
            raise InputError("Only .csv and .zip are supported")
        directory = settings.data_dir / "uploads"
        directory.mkdir(exist_ok=True)
        path = directory / f"{uuid.uuid4().hex}{suffix}"
        try:
            size = 0
            with path.open("wb") as handle:
                while block := file.file.read(1024 * 1024):
                    size += len(block)
                    if size > settings.max_upload_bytes:
                        raise HTTPException(413, "Upload exceeds 256 MiB")
                    handle.write(block)
            if size == 0:
                raise InputError("Empty upload")

            def process(progress):
                try:
                    return ingest_file(request.app.state.store, path, name, progress)
                finally:
                    path.unlink(missing_ok=True)

            return request.app.state.jobs.submit("ingest", process)
        except Exception:
            path.unlink(missing_ok=True)
            raise
        finally:
            file.file.close()

    @router.post("/ingest/firms", status_code=202, tags=["data"])
    def firms(body: FirmsRequest, request: Request):
        if not settings.firms_map_key:
            raise HTTPException(503, "FIRMS_MAP_KEY is not configured; CSV/ZIP imports remain available")
        return request.app.state.jobs.submit("firms", lambda progress: import_firms(request.app.state.store, body, progress))

    @router.get("/jobs/{job_id}", tags=["jobs"])
    def get_job(job_id: str, request: Request):
        return request.app.state.jobs.get(job_id)

    @router.post("/detections/query", tags=["map"])
    def detections(body: DetectionQuery, request: Request):
        return detections_geojson(request.app.state.store, body)

    @router.post("/grid/query", tags=["map"])
    def grid(body: GridQuery, request: Request):
        return grid_geojson(request.app.state.store, body)

    @router.post("/harmonization/calibrate", status_code=202, tags=["harmonization"])
    def calibrate(body: CalibrationRequest, request: Request):
        return request.app.state.jobs.submit("calibration", lambda _: fit_model(request.app.state.store, body))

    @router.get("/harmonization/models", tags=["harmonization"])
    def models(request: Request):
        store = request.app.state.store
        rows = store.records("SELECT id,created_at,revision FROM models ORDER BY created_at DESC")
        for row in rows:
            row["stale"] = row["revision"] != store.revision()
        return {"models": rows}

    @router.get("/harmonization/models/{model_id}", tags=["harmonization"])
    def model(model_id: str, request: Request, compact: bool = False):
        payload = request.app.state.store.get_model(model_id)
        return compact_model(payload) if compact else payload

    @router.post("/harmonization/matches", tags=["harmonization"])
    def matches(body: MatchQuery, request: Request):
        return match_observations(request.app.state.store, body)

    @router.post("/harmonization/events", tags=["harmonization"])
    def events(body: EventQuery, request: Request):
        """MODIS + VIIRS pixels fused into space-time clusters, with per-sensor agreement."""
        return fire_events(request.app.state.store, body)

    @router.post("/analytics/calendar", tags=["analytics"])
    def calendar_route(body: CalendarQuery, request: Request):
        return calendar(request.app.state.store, body)

    @router.post("/analytics/seasonality", tags=["analytics"])
    def seasonal_route(body: SeasonalQuery, request: Request):
        return seasonality(request.app.state.store, body)

    def csv_response(frame, filename):
        import pandas as pd
        # Excel/LibreOffice formula injection protection for externally supplied text fields.
        def generate():
            buffer = io.StringIO()
            writer = csv.writer(buffer)
            writer.writerow(list(frame.columns))
            yield buffer.getvalue()
            for row in frame.itertuples(index=False, name=None):
                buffer.seek(0)
                buffer.truncate(0)
                writer.writerow([("'" + v if v.lstrip().startswith(("=", "+", "-", "@")) else v)
                                 if isinstance(v, str) else ("" if v is None or pd.isna(v) else v) for v in row])
                yield buffer.getvalue()
        return StreamingResponse(generate(), media_type="text/csv; charset=utf-8",
                                 headers={"Content-Disposition": f'attachment; filename="{filename}"'})

    @router.post("/exports/detections.csv", tags=["exports"])
    def export_detections(body: DetectionQuery, request: Request):
        # Same explicit pagination as the map endpoint; no silent truncation of a whole-AOI export.
        frame = detection_frame(request.app.state.store, body)
        frame["observed_at"] = frame.observed_at.dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        return csv_response(frame, "detections.csv")

    @router.post("/exports/calendar.csv", tags=["exports"])
    def export_calendar(body: CalendarQuery, request: Request):
        import pandas as pd
        rows = calendar(request.app.state.store, body)["rows"]
        frame = pd.DataFrame(rows).drop(columns=["raw_by_platform", "detection_counts_by_platform", "components", "partial_span_platforms"], errors="ignore")
        frame["flags"] = frame["flags"].apply(lambda v: ";".join(v))
        return csv_response(frame, "burning_activity_calendar.csv")

    app.include_router(router)

    # Single-port mode: after `npm run build` the React app is served by this same process.
    dist = settings.frontend_dist
    if dist is not None and (dist / "index.html").is_file():
        app.mount("/", StaticFiles(directory=str(dist), html=True), name="frontend")
    else:
        @app.get("/", include_in_schema=False)
        def root():
            return {"service": "MODIS–VIIRS Harmonization API", "version": VERSION, "docs": "/docs",
                    "health": "/health",
                    "frontend": "Not built. Run `npm run dev` in ../frontend (http://localhost:5173), "
                                "or `npm run build` there and restart this server to serve it here."}
    return app


app = create_app(Settings.from_env())
