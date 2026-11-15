import pandas as pd
import pytest
from pydantic import ValidationError

from app.config import InputError
from app.events import cluster_labels, fire_events, summarize_events
from app.schemas import EventQuery
from conftest import observation, import_rows


def frame(rows):
    """Minimal detection_frame-like table for the pure clustering functions."""
    return pd.DataFrame([{"platform": p, "observed_at": pd.Timestamp(t), "longitude": lon, "latitude": lat,
                          "daynight": "D", "confidence_class": "nominal", "frp_mw": frp}
                         for p, t, lon, lat, frp in rows])


def test_links_need_both_distance_and_time():
    f = frame([("Aqua", "2023-01-01 05:00", 100.000, 30, 10.0),
               ("SNPP", "2023-01-01 05:10", 100.001, 30, 3.0),    # ~100 m, 10 min -> same event
               ("SNPP", "2023-01-06 05:10", 100.001, 30, 4.0),    # same place, 5 days later -> new event
               ("Terra", "2023-01-01 05:05", 100.500, 30, 7.0)])  # ~48 km away -> new event
    labels = cluster_labels(f, distance_km=1.5, gap_hours=36)
    assert labels[0] == labels[1]
    assert len({labels[0], labels[2], labels[3]}) == 3


def test_single_linkage_chains_and_radius_splits():
    f = frame([("SNPP", "2023-01-01 05:00", 100 + i * 0.01, 0, 1.0) for i in range(4)])  # ~1.11 km steps
    assert len(set(cluster_labels(f, distance_km=1.5, gap_hours=36))) == 1
    assert len(set(cluster_labels(f, distance_km=0.5, gap_hours=36))) == 4


def test_summary_reports_sensor_agreement_without_summing_frp():
    f = frame([("Aqua", "2023-01-01 05:00", 100.000, 30, 10.0),
               ("SNPP", "2023-01-01 05:10", 100.001, 30, 3.0),
               ("NOAA20", "2023-01-02 05:00", 100.002, 30, 25.0)])
    event, = summarize_events(f, cluster_labels(f, 1.5, 36))
    assert event["agreement"] == "both"
    assert event["detections"] == 3 and event["modis_detections"] == 1 and event["viirs_detections"] == 2
    assert event["detections_by_platform"] == {"Aqua": 1, "NOAA20": 1, "SNPP": 1}
    assert event["frp_max_mw"] == 25.0 and event["frp_max_modis_mw"] == 10.0 and event["frp_max_viirs_mw"] == 25.0
    assert event["active_days"] == 2 and event["duration_hours"] == 24.0
    assert event["first_seen"] == "2023-01-01T05:00:00Z" and event["last_seen"] == "2023-01-02T05:00:00Z"


def test_empty_frame_is_not_an_error():
    f = frame([])
    assert len(cluster_labels(f)) == 0 and summarize_events(f, []) == []


def test_events_endpoint_logic_on_stored_detections(store, tmp_path):
    rows = [observation("Aqua", date="2023-01-01", time="0500", longitude=100, latitude=30),
            observation("SNPP", date="2023-01-01", time="0510", longitude=100.001, latitude=30),
            observation("SNPP", date="2023-01-01", time="0510", longitude=100.002, latitude=30),
            observation("SNPP", date="2023-01-06", time="0510", longitude=100.001, latitude=30),
            observation("Terra", date="2023-01-01", time="0300", longitude=101, latitude=31),
            observation("SNPP", date="2023-01-01", time="0510", longitude=100.003, latitude=30, confidence="l")]
    import_rows(store, tmp_path, rows)
    out = fire_events(store, EventQuery(start="2023-01-01", end="2023-01-31", daynight="both"))
    assert out["type"] == "FeatureCollection"
    assert out["meta"]["input_points"] == 5  # the low-confidence pixel is excluded by default
    assert out["summary"]["events"] == 3
    assert out["summary"]["events_by_agreement"] == {"both": 1, "modis_only": 1, "viirs_only": 1}
    assert out["summary"]["detections_in_both_pct"] == 60.0
    top = out["features"][0]
    assert top["properties"]["detections"] == 3 and top["properties"]["agreement"] == "both"
    assert top["geometry"]["coordinates"] == pytest.approx([100.001, 30.0])
    only_big = fire_events(store, EventQuery(start="2023-01-01", end="2023-01-31", daynight="both", min_detections=2))
    assert len(only_big["features"]) == 1 and only_big["summary"]["events"] == 3
    viirs = fire_events(store, EventQuery(start="2023-01-01", end="2023-01-31", daynight="both",
                                          platforms=["SNPP"], quality_only=False))
    assert viirs["meta"]["input_points"] == 4
    assert viirs["summary"]["events_by_agreement"] == {"both": 0, "modis_only": 0, "viirs_only": 2}


def test_event_window_is_limited():
    with pytest.raises(ValidationError):
        EventQuery(start="2023-01-01", end="2023-03-01")


def test_too_many_points_is_a_clear_error(monkeypatch):
    import app.events as events
    monkeypatch.setattr(events, "MAX_POINTS", 2)
    f = frame([("SNPP", "2023-01-01 05:00", 100 + i, 0, 1.0) for i in range(3)])
    with pytest.raises(InputError):
        cluster_labels(f)
