from pathlib import Path
import calendar as month_calendar

import pandas as pd
import pytest

from app.config import Settings
from app.geo import grid_centers
from app.ingest import ingest_file
from app.store import Store


@pytest.fixture
def store(tmp_path):
    s = Store(Settings(data_dir=tmp_path / "db", chunk_rows=2))
    yield s
    s.close()


def observation(satellite="SNPP", date="2023-01-01", time="1200", gx=1001, gy=301, **kwargs):
    lon, lat = grid_centers(gx, gy)
    modis = satellite in ("Terra", "Aqua", "T", "A")
    row = dict(latitude=float(lat), longitude=float(lon), satellite=satellite,
               instrument="MODIS" if modis else "VIIRS", confidence="80" if modis else "n",
               acq_date=date, acq_time=time, brightness=330, bright_t31=290,
               scan=1 if modis else .375, track=1 if modis else .375,
               version="6.1" if modis else "2", frp=8, daynight="D", type=0)
    row.update(kwargs)
    return row


def import_rows(store, tmp_path, rows, name="sample.csv"):
    path = tmp_path / name
    pd.DataFrame(rows).to_csv(path, index=False)
    return ingest_file(store, path)


def calibration_rows(test_source_cells=1, source_start=2019, reference_start=2020):
    rows = []
    for year in range(source_start, 2024):
        for month in range(1, 13):
            for day in [1, month_calendar.monthrange(year, month)[1]]:
                date = f"{year}-{month:02d}-{day:02d}"
                for gx in range(1001, 1001 + (test_source_cells if year == 2023 else 1)):
                    rows.append(observation("Aqua", date=date, gx=gx))
                if year >= reference_start:
                    for gx in [1001, 1002]:
                        rows.append(observation("SNPP", date=date, gx=gx))
    return rows


@pytest.fixture
def calibrated(store, tmp_path):
    from app.harmonize import fit_model
    from app.schemas import CalibrationRequest
    store.settings.chunk_rows = 1000
    import_rows(store, tmp_path, calibration_rows())
    model = fit_model(store, CalibrationRequest(train_start_year=2020, train_end_year=2022,
                                               test_year=2023, bootstrap_samples=30))
    return store, model
