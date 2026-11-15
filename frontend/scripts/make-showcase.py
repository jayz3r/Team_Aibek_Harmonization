"""Rebuild frontend/public/data/showcase/*.json from backend/reports (the precomputed full-China run).

Run from the project root after reproducing the reports:  python frontend/scripts/make-showcase.py
The files let the UI show real full-archive results when the backend is offline.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPORTS = ROOT / "backend" / "reports"
TARGET = ROOT / "frontend" / "public" / "data" / "showcase"


def load(name):
    return json.loads((REPORTS / name).read_text(encoding="utf-8"))


def main():
    TARGET.mkdir(parents=True, exist_ok=True)
    model = load("china_calibration.json")
    for c in model["coefficients"]:
        c["support_region_count"] = len(c.pop("support_regions", []))
    model["stale"] = False
    calendar = load("china_calendar_2000_2025.json")
    for row in calendar["rows"]:
        row.pop("components", None)
    audit = load("input_audit.json")
    counts = audit["counts"]
    summary = {"input_rows": counts["input_rows"], "canonical_rows": counts["canonical_rows"],
               "quality_rows": int(counts["quality_rows"]), "archive_spans": counts["archive_spans"],
               "nrt_spans": counts["nrt_spans"]}
    outputs = {"model": model, "calendar": calendar, "seasonality": load("china_seasonality_2025.json"), "audit": summary}
    for name, content in outputs.items():
        path = TARGET / f"{name}.json"
        path.write_text(json.dumps(content, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        print(f"{path.relative_to(ROOT)}  {path.stat().st_size / 1024:.0f} kB")


if __name__ == "__main__":
    main()
