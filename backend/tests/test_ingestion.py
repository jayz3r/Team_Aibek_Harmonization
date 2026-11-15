import io
import zipfile

import numpy as np
import pandas as pd
import pytest

from app.config import InputError
from app.geo import grid_coordinates
from app.ingest import normalize, ingest_file
from app.queries import monthly_activity
from app.schemas import Window
from conftest import observation, import_rows


def test_normalizes_aliases_and_utc():
    f, audit = normalize(pd.DataFrame([observation("N", time="5", instrument="SNPP")]), "x.csv")
    assert f.platform.iloc[0] == "SNPP"
    assert f.sensor.iloc[0] == "VIIRS"
    assert f.observed_at.iloc[0].strftime("%H:%M") == "00:05"
    assert audit["valid_rows"] == 1


@pytest.mark.parametrize("change", [{"latitude": 95}, {"longitude": -181}, {"acq_time": "1260"},
                                    {"acq_time": "2400"}, {"acq_time": "1.5"}, {"acq_date": "nonsense"},
                                    {"satellite": "UNKNOWN"}, {"instrument": "MODIS"}, {"daynight": "X"}])
def test_rejects_invalid_observations(change):
    f, audit = normalize(pd.DataFrame([observation(**change)]), "x.csv")
    assert len(f) == 0 and audit["invalid_rows"] == 1


def test_sensor_specific_confidence():
    rows = [observation("Aqua", confidence="29"), observation("Aqua", confidence="30"),
            observation("Aqua", confidence="101"), observation(confidence="l"),
            observation(confidence="nominal"), observation(confidence="h")]
    f, _ = normalize(pd.DataFrame(rows), "x.csv")
    assert f.quality_pass.tolist() == [False, True, False, False, True, True]
    assert f.brightness_channel.tolist() == ["MODIS_21_22"] * 3 + ["VIIRS_I4"] * 3


def test_grid_floor_at_negative_coordinates():
    gx, gy = grid_coordinates(np.array([-.001]), np.array([-.001]))
    assert gx[0] == -1 and gy[0] == -1


def test_exact_duplicate_archive_preference_and_idempotency(store, tmp_path):
    row = observation(version="2.0NRT", frp=4)
    a = import_rows(store, tmp_path, [row, row, row], "nrt.csv")
    b = import_rows(store, tmp_path, [observation(version="2", frp=7)], "archive.csv")
    data = store.records("SELECT processing,frp_mw FROM detections")
    assert data == [{"processing": "archive", "frp_mw": 7.0}]
    # Original observations remain available for provenance.
    assert len(store.frame("SELECT * FROM observations")) == 4
    revision = store.revision()
    again = ingest_file(store, tmp_path / "archive.csv")
    assert again["already_imported"] and again["dataset_id"] == b["dataset_id"]
    assert store.revision() == revision


def test_nearby_viirs_pixels_are_not_deduplicated(store, tmp_path):
    import_rows(store, tmp_path, [observation(), observation(longitude=104.001)])
    assert len(store.frame("SELECT * FROM detections")) == 2


def test_cell_occupancy_does_not_count_types_or_revisits_twice(store, tmp_path):
    import_rows(store, tmp_path, [observation(time="1200", type=0), observation(time="1230", type=2),
                                  observation(time="2300", type=None, daynight="N")])
    q = Window(start="2023-01-01", end="2023-01-31", daynight="both")
    f = monthly_activity(store, q)
    assert f.active_cell_days.sum() == 2  # one day + one night stratum
    assert f.detection_count.sum() == 3
    q.hotspot_scope = "vegetation"
    assert monthly_activity(store, q).detection_count.sum() == 1


def test_zip_streams_without_extracting_member_paths(store, tmp_path):
    path = tmp_path / "data.zip"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("../escape.csv", pd.DataFrame([observation()]).to_csv(index=False))
    ingest_file(store, path)
    assert not (tmp_path.parent / "escape.csv").exists()
    assert len(store.frame("SELECT * FROM detections")) == 1


def test_failed_import_keeps_previous_snapshot(store, tmp_path):
    import_rows(store, tmp_path, [observation()])
    revision = store.revision()
    path = tmp_path / "broken.zip"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("first.csv", pd.DataFrame([observation(date="2023-02-01")]).to_csv(index=False))
        z.writestr("bad.csv", "something,wrong\n1,2\n")
    with pytest.raises(InputError):
        ingest_file(store, path)
    assert store.revision() == revision
    assert len(store.frame("SELECT * FROM detections")) == 1
    assert len(store.frame("SELECT * FROM observations")) == 1
