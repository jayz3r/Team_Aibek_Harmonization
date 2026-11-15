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


# ---- FIRMS Archive Download ZIPs as people actually have them ---------------------------------------

def _zip(path, members):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in members:
            z.writestr(name, data)
    return path


def _csv(rows):
    return pd.DataFrame(rows).to_csv(index=False)


def test_firms_download_zip_with_archive_nrt_and_readme(store, tmp_path):
    nrt = pd.DataFrame([observation(date="2023-03-01", version="2.0NRT")]).drop(columns=["type"]).to_csv(index=False)
    path = _zip(tmp_path / "DL_FIRE_SV-C2_1.zip", [("fire_archive_SV-C2_1.csv", _csv([observation("N", version="")])),
                                                    ("fire_nrt_SV-C2_1.csv", nrt), ("Readme.txt", "text")])
    result = ingest_file(store, path)
    assert [m["valid_rows"] for m in result["members"]] == [1, 1]
    # A blank version is classified from the member name; NRT files have no `type` column.
    assert [m["processing"] for m in result["members"]] == [["archive"], ["NRT"]]
    assert sorted(store.frame("SELECT platform FROM detections").platform) == ["SNPP", "SNPP"]


@pytest.mark.parametrize("code,platform", [("N", "SNPP"), ("N20", "NOAA20"), ("1", "NOAA20"), ("N21", "NOAA21"), ("2", "NOAA21")])
def test_viirs_satellite_codes_used_by_firms(code, platform):
    f, audit = normalize(pd.DataFrame([observation(code)]), "x.csv")
    assert f.platform.tolist() == [platform] and audit["invalid_rows"] == 0


def test_time_with_colon_is_accepted():
    f, _ = normalize(pd.DataFrame([observation(time="04:32")]), "x.csv")
    assert f.observed_at.iloc[0].strftime("%H:%M") == "04:32"


def test_macos_resource_forks_and_hidden_files_are_ignored(store, tmp_path):
    path = _zip(tmp_path / "mac.zip", [("data/fire_archive_SV-C2_1.csv", _csv([observation()])),
                                       ("__MACOSX/data/._fire_archive_SV-C2_1.csv", b"\x00\x05\x16\x07binary"),
                                       ("data/._other.csv", b"\x00\x01"), (".DS_Store", b"\x00")])
    result = ingest_file(store, path)
    assert [m["member"] for m in result["members"]] == ["data/fire_archive_SV-C2_1.csv"]
    assert len(store.frame("SELECT * FROM detections")) == 1


def test_header_only_and_zero_byte_members_import_as_empty(store, tmp_path):
    header = ",".join(observation().keys()) + "\n"
    path = _zip(tmp_path / "empty.zip", [("fire_archive_M-C61_1.csv", header), ("fire_nrt_M-C61_1.csv", "")])
    result = ingest_file(store, path)
    assert sum(m.get("valid_rows", 0) for m in result["members"]) == 0
    assert store.records("SELECT status FROM datasets") == [{"status": "ready"}]


@pytest.mark.parametrize("members,needle", [
    ([("fire_1.shp", b"x"), ("fire_1.dbf", b"x"), ("Readme.txt", "t")], "shapefile"),
    ([("fire_1.json", "[]")], "JSON"),
    ([("inner.zip", b"PK")], "inner FIRMS ZIP"),
    ([("Readme.txt", "t")], "no CSV"),
])
def test_zip_without_csv_explains_what_to_do(store, tmp_path, members, needle):
    with pytest.raises(InputError, match=needle):
        ingest_file(store, _zip(tmp_path / "x.zip", members))


@pytest.mark.parametrize("content", [b"<html>Session expired</html>", b"PK\x03\x04 truncated"])
def test_damaged_zip_is_an_input_error_not_a_crash(store, tmp_path, content):
    path = tmp_path / "bad.zip"
    path.write_bytes(content)
    with pytest.raises(InputError, match="not a readable ZIP"):
        ingest_file(store, path)
    assert store.records("SELECT count(*) AS n FROM observations") == [{"n": 0}]


@pytest.mark.parametrize("content,needle", [(b"\xff\xfe\x00\x01lat\x00\x9f\x92", "UTF-8"),
                                            (b"a,b\n1,2\n1,2,3,4,5\n", "regular CSV")])
def test_unreadable_csv_member_names_the_file(store, tmp_path, content, needle):
    with pytest.raises(InputError, match=needle):
        ingest_file(store, _zip(tmp_path / "x.zip", [("fire_archive_M-C61_1.csv", content)]))


def test_progress_is_reported_per_chunk(store, tmp_path):
    seen = []
    path = tmp_path / "many.csv"
    pd.DataFrame([observation(time=f"{h:02d}00") for h in range(6)]).to_csv(path, index=False)
    ingest_file(store, path, progress=seen.append)       # the fixture store reads 2 rows per chunk
    assert [p["input_rows"] for p in seen][:3] == [2, 4, 6]


def test_save_upload_limits_and_names(tmp_path):
    from app.config import Settings, UploadTooLarge
    from app.ingest import save_upload
    settings = Settings(data_dir=tmp_path / "db", max_upload_bytes=10)
    with pytest.raises(InputError, match="Only .csv and .zip"):
        save_upload(io.BytesIO(b"x"), "notes.txt", settings)
    with pytest.raises(InputError, match="Empty upload"):
        save_upload(io.BytesIO(b""), "a.zip", settings)
    with pytest.raises(UploadTooLarge):
        save_upload(io.BytesIO(b"x" * 11), "a.zip", settings)
    assert not list((tmp_path / "db" / "uploads").glob("*"))
    path, name = save_upload(io.BytesIO(b"x" * 10), "C:\\Users\\me\\..\\DL_FIRE.ZIP", settings)
    assert name == "DL_FIRE.ZIP" and path.parent == tmp_path / "db" / "uploads" and path.suffix == ".zip"
