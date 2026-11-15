"""Reproduce reports from the four ORIGINAL archives. Run while the API is stopped."""
import argparse
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import Settings
from app.store import Store
from app.ingest import ingest_file
from app.harmonize import fit_model, calendar, seasonality
from app.schemas import CalibrationRequest, CalendarQuery, SeasonalQuery


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("--output", type=Path, default=Path("reports/reproduced"))
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    s = Store(Settings(data_dir=args.data_dir))
    try:
        started = time.perf_counter()
        for name in ["MODISCHINA.zip", "SUOMIVIIRSCHINA.zip", "J1VIIRSCHINa.zip", "J2VIIRSCHINA.zip"]:
            print("Importing", name, flush=True)
            ingest_file(s, args.input_dir / name, progress=lambda v: print(v, flush=True))
        ingest_seconds = time.perf_counter() - started
        started = time.perf_counter()
        model = fit_model(s, CalibrationRequest())
        fit_seconds = time.perf_counter() - started
        counts = s.records("SELECT count(*) AS canonical_rows, sum(CASE WHEN quality_pass THEN 1 ELSE 0 END) AS quality_rows FROM detections")[0]
        counts["input_rows"] = s.records("SELECT count(*) AS n FROM observations")[0]["n"]
        counts["grid_cell_day_periods"] = s.records("SELECT count(DISTINCT (platform,processing,date,daynight,gx,gy)) AS n FROM activity")[0]["n"]
        counts["ingestion_seconds"] = ingest_seconds
        counts["calibration_seconds"] = fit_seconds
        results = {
            "china_calibration.json": model,
            "china_calendar_2000_2025.json": calendar(s, CalendarQuery(start="2000-11-01", end="2025-12-31", model_id=model["id"], allow_extrapolation=True)),
            "china_seasonality_2025.json": seasonality(s, SeasonalQuery(start="2025-01-01", end="2025-12-31", model_id=model["id"])),
            "input_audit.json": {"counts": counts, "datasets": s.records("SELECT * FROM datasets"), "archive_spans": s.spans(),
                                 "nrt_spans": s.spans("NRT"), "ingestion_seconds": ingest_seconds, "calibration_seconds": fit_seconds},
        }
        for name, content in results.items():
            (args.output / name).write_text(json.dumps(content, indent=2), encoding="utf-8")
        print("Saved reports to", args.output, "model_id:", model["id"])
    finally:
        s.close()


if __name__ == "__main__":
    main()
