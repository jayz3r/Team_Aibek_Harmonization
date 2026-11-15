"""Refresh docs/openapi.json from the code. Run from the backend folder: python scripts/export_openapi.py"""
import json
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import Settings
from app.main import create_app


def main():
    with tempfile.TemporaryDirectory() as tmp:
        schema = create_app(Settings(data_dir=Path(tmp), frontend_dist=None)).openapi()
    target = ROOT / "docs" / "openapi.json"
    target.write_text(json.dumps(schema, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {target} with {len(schema['paths'])} paths")


if __name__ == "__main__":
    main()
