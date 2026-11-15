import pytest

from app.config import ConflictError, InputError
from app.harmonize import fit_model, calendar, seasonality
from app.schemas import CalibrationRequest, CalendarQuery, SeasonalQuery, MatchQuery, Area
from app.matching import match_observations
from conftest import observation, import_rows, calibration_rows


def test_known_slope_and_holdout(calibrated):
    store, model = calibrated
    c = model["coefficients"][0]
    assert c["platform"] == "Aqua"
    assert c["slope"] == 2.0
    assert c["slope_ci95"] == [2.0, 2.0]
    assert c["after"]["rmse"] == 0 and c["before"]["rmse"] == 2.0
    assert c["train_rows"] == 36 and c["test_rows"] == 12


def test_held_out_values_do_not_affect_fit(store, tmp_path):
    store.settings.chunk_rows = 1000
    import_rows(store, tmp_path, calibration_rows(test_source_cells=3))
    model = fit_model(store, CalibrationRequest(train_start_year=2020, train_end_year=2022,
                                              test_year=2023, bootstrap_samples=30))
    c = model["coefficients"][0]
    assert c["slope"] == 2.0
    assert c["after"]["aggregate_bias_pct"] == 200.0
    assert "large_residual_bias" in c["warnings"]


def test_calendar_does_not_sum_satellites(calibrated):
    store, model = calibrated
    result = calendar(store, CalendarQuery(start="2023-01-01", end="2023-12-31", model_id=model["id"]))
    assert len(result["rows"]) == 12
    assert all(r["selected_platform"] == "SNPP" and r["harmonized_index"] == 4.0 for r in result["rows"])
    assert result["rows"][0]["raw_by_platform"] == {"Aqua": 2, "SNPP": 4} or result["rows"][0]["raw_by_platform"] == {"SNPP": 4, "Aqua": 2}


def test_extrapolation_requires_explicit_opt_in(calibrated):
    store, model = calibrated
    q = CalendarQuery(start="2019-01-01", end="2019-12-31", model_id=model["id"])
    result = calendar(store, q)
    assert all(r["harmonized_index"] is None for r in result["rows"])
    assert all("historical_extrapolation" in r["flags"] for r in result["rows"])
    q.allow_extrapolation = True
    assert all(r["harmonized_index"] == 4 for r in calendar(store, q)["rows"])


def test_no_aoi_detections_does_not_trigger_sensor_fallback(calibrated):
    store, model = calibrated
    q = CalendarQuery(start="2023-01-01", end="2023-01-31", model_id=model["id"], area=Area(bbox=[0, 0, 1, 1]))
    row = calendar(store, q)["rows"][0]
    assert row["selected_platform"] == "SNPP" and row["harmonized_index"] == 0
    assert "no_records_coverage_unknown" in row["flags"]


def test_source_index_without_training_spatial_support_is_missing(calibrated):
    store, model = calibrated
    q = CalendarQuery(start="2023-01-01", end="2023-01-31", model_id=model["id"],
                      platform="Aqua", area=Area(bbox=[0, 0, 1, 1]))
    row = calendar(store, q)["rows"][0]
    assert row["harmonized_index"] is None
    assert "no_common_spatial_support" in row["flags"]


def test_platform_before_its_file_span_is_null(calibrated):
    store, model = calibrated
    q = CalendarQuery(start="2019-01-01", end="2019-01-31", model_id=model["id"], allow_extrapolation=True)
    assert calendar(store, q)["rows"][0]["raw_by_platform"]["SNPP"] is None


def test_stale_model_is_rejected(calibrated, tmp_path):
    store, model = calibrated
    import_rows(store, tmp_path, [observation(date="2024-01-01")], "new.csv")
    with pytest.raises(ConflictError):
        calendar(store, CalendarQuery(start="2023-01-01", end="2023-12-31", model_id=model["id"]))


def test_nrt_does_not_silently_receive_archive_calibration(calibrated):
    store, model = calibrated
    with pytest.raises(InputError):
        calendar(store, CalendarQuery(start="2023-01-01", end="2023-12-31", processing="NRT", model_id=model["id"]))


def test_seasonality_zero_variance_and_partial_month(calibrated):
    store, model = calibrated
    q = SeasonalQuery(start="2023-01-05", end="2023-02-28", model_id=model["id"],
                      baseline_start_year=2020, baseline_end_year=2022)
    r = seasonality(store, q)
    assert r["anomalies"][0]["classification"] == "partial_month"
    assert r["anomalies"][1]["classification"] == "zero_baseline_variance"
    assert r["anomalies"][1]["z_score"] is None


def test_matching_many_to_many_crosses_midnight(store, tmp_path):
    rows = [observation("Aqua", date="2023-01-01", time="2355", longitude=100, latitude=30),
            observation("SNPP", date="2023-01-02", time="0005", longitude=100.001, latitude=30),
            observation("SNPP", date="2023-01-02", time="0006", longitude=100.002, latitude=30),
            observation("SNPP", date="2023-01-02", time="0100", longitude=100, latitude=30)]
    import_rows(store, tmp_path, rows)
    out = match_observations(store, MatchQuery(start="2023-01-01", end="2023-01-02", daynight="both"))
    assert out["summary"]["candidate_pairs"] == 2
    assert out["summary"]["unmatched_viirs_points"] == 1
    assert out["pairs"][0]["time_delta_minutes"] == 10
    assert out["pairs"][0]["modis_lonlat"] == [100.0, 30.0]
    assert out["pairs"][0]["viirs_lonlat"] == [100.001, 30.0]
    assert out["summary"]["matched_modis_pct"] == 100.0
    assert len(store.frame("SELECT * FROM detections")) == 4
