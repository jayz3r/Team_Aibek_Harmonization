import argparse
import json
from pathlib import Path

from .config import Settings
from .store import Store
from .ingest import ingest_file
from .harmonize import fit_model
from .schemas import CalibrationRequest


def main():
    parser = argparse.ArgumentParser(description="Offline FIRMS import and reproducible calibration")
    parser.add_argument("--data-dir", type=Path, default=None)
    sub = parser.add_subparsers(dest="command", required=True)
    imp = sub.add_parser("import")
    imp.add_argument("paths", nargs="+", type=Path)
    cal = sub.add_parser("calibrate")
    cal.add_argument("--config", type=Path, help="CalibrationRequest JSON")
    cal.add_argument("--output", type=Path, default=Path("model.json"))
    sub.add_parser("inspect")
    args = parser.parse_args()
    settings = Settings.from_env()
    if args.data_dir:
        settings.data_dir = args.data_dir
    store = Store(settings)
    try:
        if args.command == "import":
            for path in args.paths:
                result = ingest_file(store, path, progress=lambda p: print(json.dumps(p), flush=True))
                print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
        elif args.command == "calibrate":
            config = json.loads(args.config.read_text()) if args.config else {}
            model = fit_model(store, CalibrationRequest(**config))
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(model, indent=2), encoding="utf-8")
            print(json.dumps({"model_id": model["id"], "output": str(args.output), "strata": len(model["coefficients"])}))
        else:
            print(json.dumps({"revision": store.revision(), "archive": store.spans(), "NRT": store.spans("NRT")}, indent=2))
    finally:
        store.close()


if __name__ == "__main__":
    main()
