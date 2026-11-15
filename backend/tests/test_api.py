import io
import time
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.geo import grid_centers
from app.ingest import ingest_file
from conftest import observation


@pytest.fixture
def client(tmp_path):
    # frontend_dist=None keeps "/" deterministic even when ../frontend/dist has been built.
    with TestClient(create_app(Settings(data_dir=tmp_path / "api", frontend_dist=None))) as c:
        yield c


def wait_job(client, job_id, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        r = client.get(f"/api/v1/jobs/{job_id}")
        assert r.status_code == 200
        job = r.json()
        if job["status"] not in ("queued", "running"):
            return job
        time.sleep(.01)
    pytest.fail("Background job did not finish")


def test_upload_map_grid_export_and_openapi(client):
    data = pd.DataFrame([observation(), observation(time="1210")]).to_csv(index=False).encode()
    r = client.post("/api/v1/datasets/upload", files={"file": ("sample.csv", data, "text/csv")})
    assert r.status_code == 202
    job = wait_job(client, r.json()["job_id"])
    assert job["status"] == "succeeded", job
    assert len(client.get("/api/v1/datasets").json()["datasets"]) == 1
    q = {"start": "2023-01-01", "end": "2023-01-31", "limit": 1}
    r = client.post("/api/v1/detections/query", json=q)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["meta"]["has_more"]
    assert out["features"][0]["properties"]["observed_at"].endswith("Z")
    q["offset"] = out["meta"]["next_offset"]
    assert client.post("/api/v1/detections/query", json=q).json()["meta"]["has_more"] is False
    r = client.post("/api/v1/grid/query", json={"start": "2023-01-01", "end": "2023-01-31"})
    assert r.status_code == 200 and r.json()["features"][0]["properties"]["active_cell_days"] == 1
    r = client.post("/api/v1/exports/detections.csv", json=q)
    assert r.status_code == 200 and "observation_id" in r.text
    assert client.get("/health").json()["revision"] == 1
    assert "/api/v1/analytics/calendar" in client.get("/openapi.json").json()["paths"]


def test_polygon_clipping(client, tmp_path):
    rows = [observation(longitude=100, latitude=30), observation(longitude=100.8, latitude=30.8)]
    p = tmp_path / "poly.csv"
    pd.DataFrame(rows).to_csv(p, index=False)
    ingest_file(client.app.state.store, p)
    area = {"polygon": {"type": "Polygon", "coordinates": [[[99, 29], [101, 29], [99, 31], [99, 29]]]}}
    r = client.post("/api/v1/detections/query", json={"start": "2023-01-01", "end": "2023-01-31", "area": area})
    assert r.status_code == 200, r.text
    assert len(r.json()["features"]) == 1  # boundary included, second point outside triangle


@pytest.mark.parametrize("body", [
    {"start": "2023-02-01", "end": "2023-01-01"},
    {"start": "2023-01-01", "end": "2023-01-31", "area": {"bbox": [100, 30, 90, 40]}},
    {"start": "2023-01-01", "end": "2023-01-31", "platforms": ["anything"]},
    {"start": "2023-01-01", "end": "2023-01-31", "limit": 1000000},
])
def test_request_validation(client, body):
    assert client.post("/api/v1/detections/query", json=body).status_code == 422


def test_invalid_job_is_reported(client):
    r = client.post("/api/v1/datasets/upload", files={"file": ("wrong.csv", b"wrong,columns\n1,2", "text/csv")})
    assert wait_job(client, r.json()["job_id"])["status"] == "failed"
    assert client.get("/health").json()["revision"] == 0


def test_api_key_required_when_configured(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path / "secure", api_key="secret-example"))) as c:
        assert c.get("/health").status_code == 200
        assert c.get("/api/v1/datasets").status_code == 401
        assert c.get("/api/v1/datasets", headers={"X-API-Key": "secret-example"}).status_code == 200


def test_live_import_without_key_and_unknown_job(client):
    assert client.post("/api/v1/ingest/firms", json={"source": "MODIS_NRT", "area": {"bbox": [70, 30, 80, 40]}}).status_code == 503
    assert client.get("/api/v1/jobs/no-such-job").status_code == 404


def test_temporal_leakage_config_is_rejected(client):
    assert client.post("/api/v1/harmonization/calibrate", json={"train_end_year": 2025, "test_year": 2025}).status_code == 422
    assert client.post("/api/v1/analytics/seasonality", json={"start": "2024-01-01", "end": "2024-12-31", "baseline_end_year": 2024}).status_code == 422


def test_overview_boots_a_client(client):
    empty = client.get("/api/v1/overview").json()
    assert empty["revision"] == 0 and empty["bounds"] is None and empty["latest_model"] is None
    assert empty["years"] == {"archive": None, "NRT": None}
    assert empty["capabilities"] == {"firms_live": False, "auth_required": False, "demo_sample": True}
    rows = [observation(date="2022-05-01"), observation(date="2023-01-01", longitude=101, latitude=31)]
    data = pd.DataFrame(rows).to_csv(index=False).encode()
    r = client.post("/api/v1/datasets/upload", files={"file": ("sample.csv", data, "text/csv")})
    assert wait_job(client, r.json()["job_id"])["status"] == "succeeded"
    full = client.get("/api/v1/overview").json()
    assert full["revision"] == 1 and full["datasets"]["ready"] == 1
    assert full["detections"] == {"archive": 2, "NRT": 0}
    assert full["years"]["archive"] == [2022, 2023]
    west, south, east, north = full["bounds"]
    assert west == 101 < east and south < north == 31


def test_demo_sample_loads_and_calibrates_in_one_job(client):
    r = client.post("/api/v1/demo/load")
    assert r.status_code == 202
    job = wait_job(client, r.json()["job_id"], seconds=120)
    assert job["status"] == "succeeded", job
    model_id = job["result"]["model_id"]
    overview = client.get("/api/v1/overview").json()
    assert overview["latest_model"]["id"] == model_id and overview["latest_model"]["stale"] is False
    assert all("support_regions" not in c and c["support_region_count"] > 0
               for c in overview["latest_model"]["coefficients"])
    full = client.get(f"/api/v1/harmonization/models/{model_id}").json()
    assert "support_regions" in full["coefficients"][0]
    compact = client.get(f"/api/v1/harmonization/models/{model_id}", params={"compact": "true"}).json()
    assert "support_regions" not in compact["coefficients"][0]
    q = {"start": "2025-01-01", "end": "2025-12-31", "model_id": model_id}
    rows = client.post("/api/v1/analytics/calendar", json=q).json()["rows"]
    assert len(rows) == 12 and any(row["harmonized_index"] is not None for row in rows)
    events = client.post("/api/v1/harmonization/events",
                         json={"start": "2025-03-01", "end": "2025-03-31", "daynight": "both"})
    assert events.status_code == 200, events.text
    body = events.json()
    assert body["summary"]["events"] >= 1
    assert body["summary"]["detections"] == body["meta"]["input_points"]
    matches = client.post("/api/v1/harmonization/matches",
                          json={"start": "2025-03-01", "end": "2025-03-07", "daynight": "both"}).json()
    assert all(len(pair["modis_lonlat"]) == 2 and len(pair["viirs_lonlat"]) == 2 for pair in matches["pairs"])


def test_events_validation_and_unknown_model(client):
    assert client.post("/api/v1/harmonization/events",
                       json={"start": "2023-01-01", "end": "2023-03-01"}).status_code == 422
    assert client.post("/api/v1/harmonization/events",
                       json={"start": "2023-01-01", "end": "2023-01-31"}).json()["summary"]["events"] == 0
    r = client.get("/api/v1/harmonization/models/no-such-model")
    assert r.status_code == 404 and r.json()["detail"] == "Model not found"
    assert client.post("/api/v1/analytics/calendar",
                       json={"start": "2023-01-01", "end": "2023-01-31", "model_id": "nope"}).status_code == 404


def test_root_explains_itself_until_the_frontend_is_built(client):
    body = client.get("/").json()
    assert body["docs"] == "/docs" and "npm run" in body["frontend"]


def test_built_frontend_is_served_next_to_the_api(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>FireBridge</title>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log('ok')", encoding="utf-8")
    with TestClient(create_app(Settings(data_dir=tmp_path / "ui", frontend_dist=dist))) as c:
        assert "FireBridge" in c.get("/").text
        assert c.get("/assets/app.js").status_code == 200
        assert c.get("/health").json()["status"] == "ok"
        assert c.get("/api/v1/overview").status_code == 200
        assert c.get("/docs").status_code == 200
