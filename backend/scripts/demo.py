"""Import the small REAL China excerpt and fit a model for a local demo."""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import Settings
from app.store import Store
from app.ingest import ingest_file
from app.harmonize import fit_model, calendar, seasonality
from app.schemas import CalibrationRequest, CalendarQuery, SeasonalQuery


def main():
    settings = Settings.from_env()
    store = Store(settings)
    try:
        result = ingest_file(store, ROOT / "examples" / "china_sample.csv")
        model = fit_model(store, CalibrationRequest())
        request = CalendarQuery(start="2002-01-01", end="2025-12-31", model_id=model["id"], allow_extrapolation=True)
        for filename, content in [
            ("demo_model.json", model),
            ("demo_calendar.json", calendar(store, request)),
            ("demo_calendar_request.json", request.model_dump(mode="json")),
        ]:
            (settings.data_dir / filename).write_text(json.dumps(content, indent=2), encoding="utf-8")
        print(json.dumps({"dataset_id": result["dataset_id"], "model_id": model["id"],
                          "calendar_request": str(settings.data_dir / "demo_calendar_request.json"),
                          "note": "Real 123–124 E, 44–45 N excerpt; not the full-China validation model"}, indent=2))
        print("Run: uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1")
    finally:
        store.close()


if __name__ == "__main__":
    main()
