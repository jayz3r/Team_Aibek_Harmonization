"""Run after demo.py, with API stopped. Starts uvicorn, checks real HTTP, then stops it."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

import httpx

ROOT = Path(__file__).resolve().parents[1]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--data-dir", type=Path, default=Path("data"))
    p.add_argument("--output", type=Path, default=Path("reports/http_smoke.json"))
    p.add_argument("--port", type=int, default=8765)
    args = p.parse_args()
    model = json.loads((args.data_dir / "demo_model.json").read_text())
    env = {**os.environ, "DATA_DIR": str(args.data_dir.resolve())}
    headers = {"X-API-Key": env["API_KEY"]} if env.get("API_KEY") else {}
    checks = []
    with tempfile.TemporaryFile() as log:
        process = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
                                    "--port", str(args.port), "--workers", "1"], cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{args.port}", timeout=60, trust_env=False, headers=headers) as c:
                for _ in range(200):
                    if process.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(log.read().decode())
                    try:
                        if c.get("/health").status_code == 200:
                            break
                    except httpx.ConnectError:
                        pass
                    time.sleep(.1)
                else:
                    raise RuntimeError("Uvicorn did not become ready")
                for path in ["/health", "/docs", "/openapi.json", "/api/v1/overview", "/api/v1/datasets", "/api/v1/coverage",
                             "/api/v1/harmonization/models", f"/api/v1/harmonization/models/{model['id']}?compact=true"]:
                    t = time.perf_counter()
                    r = c.get(path)
                    r.raise_for_status()
                    checks.append({"route": path, "status": r.status_code, "seconds": round(time.perf_counter() - t, 3)})
                q = {"start": "2025-01-01", "end": "2025-12-31", "model_id": model["id"]}
                march = {"start": "2025-03-01", "end": "2025-03-31", "daynight": "both"}
                queries = [
                    ("/api/v1/detections/query", {**march, "limit": 50}),
                    ("/api/v1/grid/query", march),
                    ("/api/v1/analytics/calendar", q),
                    ("/api/v1/analytics/seasonality", q),
                    ("/api/v1/harmonization/matches", {**march, "max_pairs": 50000}),
                    ("/api/v1/harmonization/events", march),
                    ("/api/v1/exports/calendar.csv", q),
                    ("/api/v1/exports/detections.csv", {**march, "limit": 10000}),
                ]
                for path, body in queries:
                    t = time.perf_counter()
                    r = c.post(path, json=body)
                    r.raise_for_status()
                    check = {"route": path, "status": r.status_code, "seconds": round(time.perf_counter() - t, 3), "bytes": len(r.content)}
                    if "csv" not in path:
                        result = r.json()
                        for name in ["features", "rows", "pairs"]:
                            if name in result:
                                check["result_rows"] = len(result[name])
                        if "summary" in result:
                            check["summary"] = result["summary"]
                    checks.append(check)
                with (ROOT / "examples/china_sample.csv").open("rb") as f:
                    r = c.post("/api/v1/datasets/upload", files={"file": ("china_sample.csv", f, "text/csv")})
                r.raise_for_status()
                for _ in range(200):
                    job = c.get("/api/v1/jobs/" + r.json()["job_id"]).json()
                    if job["status"] not in ["queued", "running"]:
                        break
                    time.sleep(.05)
                assert job["status"] == "succeeded" and job["result"]["already_imported"], job
                checks.append({"route": "/api/v1/datasets/upload", "status": 202, "job_status": job["status"], "idempotent": True})
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps({"dataset": "17,075 real sample rows", "transport": "uvicorn TCP on loopback", "checks": checks}, indent=2))
            print(json.dumps({"passed": len(checks), "output": str(args.output), "checks": checks}, indent=2))
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == "__main__":
    main()
