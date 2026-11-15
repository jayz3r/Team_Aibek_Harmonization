from pathlib import Path
from contextlib import contextmanager
import hashlib
import json
import re
import uuid
import zipfile

import numpy as np
import pandas as pd

from .config import InputError
from .geo import grid_coordinates

PLATFORMS = {
    "T": "Terra", "TERRA": "Terra", "A": "Aqua", "AQUA": "Aqua",
    "N": "SNPP", "SNPP": "SNPP", "S-NPP": "SNPP", "SUOMI-NPP": "SNPP",
    "N20": "NOAA20", "NOAA20": "NOAA20", "NOAA-20": "NOAA20", "J1": "NOAA20",
    "N21": "NOAA21", "NOAA21": "NOAA21", "NOAA-21": "NOAA21", "J2": "NOAA21",
}
REQUIRED = {"latitude", "longitude", "acq_date", "acq_time", "satellite", "confidence", "daynight"}


def normalize(raw, member, grid_km=10.0):
    d = raw.copy()
    d.columns = [str(x).strip().lower().lstrip("\ufeff") for x in d.columns]
    if d.columns.duplicated().any() or not REQUIRED.issubset(d.columns):
        raise InputError(f"{member}: missing/duplicate CSV columns; required: {sorted(REQUIRED)}")
    text = lambda name: d.get(name, pd.Series("", index=d.index)).fillna("").astype(str).str.strip()
    num = lambda name: pd.to_numeric(text(name), errors="coerce")
    platform = text("satellite").str.upper().map(PLATFORMS)
    sensor = pd.Series(np.where(platform.isin(["Terra", "Aqua"]), "MODIS", "VIIRS"), index=d.index)
    latitude, longitude, time = num("latitude"), num("longitude"), num("acq_time")
    dates = pd.to_datetime(text("acq_date"), format="%Y-%m-%d", errors="coerce")
    daynight = text("daynight").str.upper()
    valid_time = time.notna() & (time == np.floor(time)) & (time // 100).between(0, 23) & (time % 100).between(0, 59)
    valid_coords = latitude.between(-90, 90) & longitude.between(-180, 180)
    instrument = text("instrument").str.upper()
    instrument_ok = instrument.eq("") | (sensor.eq("MODIS") & instrument.eq("MODIS")) | (
        sensor.eq("VIIRS") & instrument.isin(["VIIRS", "SNPP"]))
    valid = valid_time & valid_coords & dates.notna() & platform.notna() & daynight.isin(["D", "N"]) & instrument_ok
    conf_raw = text("confidence").str.lower()
    conf_num = pd.to_numeric(conf_raw, errors="coerce")
    viirs_class = conf_raw.map({"l": "low", "n": "nominal", "h": "high", "low": "low", "nominal": "nominal", "high": "high"})
    modis_class = pd.Series(np.select([conf_num.ge(80), conf_num.ge(30), conf_num.ge(0)],
                                     ["high", "nominal", "low"], default="unknown"), index=d.index)
    modis_class = modis_class.where(conf_num.between(0, 100), "unknown")
    confidence = modis_class.where(sensor.eq("MODIS"), viirs_class.fillna("unknown"))
    version = text("version").str.slice(0, 40)
    upper = version.str.upper()
    processing = pd.Series("unknown", index=d.index)
    processing.loc[version.str.fullmatch(r"\d+(?:\.\d+)*")] = "archive"
    for kind in ["RT", "NRT", "URT"]:
        processing.loc[upper.str.endswith(kind)] = kind
    # Some legitimate FIRMS exports omit version but identify the processing stream in the member name.
    if "archive" in member.lower():
        processing.loc[version.eq("")] = "archive"
    elif "nrt" in member.lower():
        processing.loc[version.eq("")] = "NRT"
    hotspot_type = num("type")
    hotspot_type = hotspot_type.where(hotspot_type.isin([0, 1, 2, 3])).astype("Int64")
    brightness = num("bright_ti4") if "bright_ti4" in d else num("brightness")
    background = num("bright_ti5") if "bright_ti5" in d else (num("brightness_2") if "brightness_2" in d else num("bright_t31"))
    f = pd.DataFrame({
        "platform": platform, "sensor": sensor,
        "observed_at": dates + pd.to_timedelta((time.where(valid_time, 0) // 100) * 60 + time.where(valid_time, 0) % 100, unit="m"),
        "latitude": latitude, "longitude": longitude,
        "brightness_k": brightness.where(brightness.gt(0) & np.isfinite(brightness)),
        "brightness_channel": np.where(sensor.eq("MODIS"), "MODIS_21_22", "VIIRS_I4"),
        "background_k": background.where(background.gt(0) & np.isfinite(background)),
        "scan_km": num("scan").where(lambda s: s.gt(0) & np.isfinite(s)),
        "track_km": num("track").where(lambda s: s.gt(0) & np.isfinite(s)),
        "frp_mw": num("frp").where(lambda s: s.ge(0) & np.isfinite(s)),
        "confidence_raw": conf_raw.str.slice(0, 40), "confidence_class": confidence,
        "quality_pass": confidence.isin(["nominal", "high"]),
        "version": version, "processing": processing, "hotspot_type": hotspot_type, "daynight": daynight,
    }).loc[valid].copy()
    f["gx"], f["gy"] = grid_coordinates(f.longitude, f.latitude, grid_km)
    audit = {"input_rows": len(d), "valid_rows": len(f), "invalid_rows": int((~valid).sum()),
             "quality_rows": int(f.quality_pass.sum()), "unknown_confidence_rows": int(confidence.eq("unknown").sum()),
             "unknown_type_rows": int(hotspot_type.isna().sum()),
             "invalid_coordinate_rows": int((~valid_coords).sum()), "invalid_time_rows": int((~valid_time | dates.isna()).sum()),
             "unknown_platform_rows": int(platform.isna().sum()), "instrument_mismatch_rows": int((~instrument_ok).sum())}
    return f, audit


def sha256_file(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        while block := f.read(1024 * 1024):
            h.update(block)
    return h.hexdigest()


@contextmanager
def csv_members(path, settings):
    if path.suffix.lower() == ".csv":
        if path.stat().st_size > settings.max_uncompressed_bytes:
            raise InputError("CSV exceeds uncompressed size limit")
        with path.open("rb") as f:
            yield [(path.name, f)]
    elif path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as z:
            members = [x for x in z.infolist() if x.filename.lower().endswith(".csv") and not x.is_dir()]
            if not members or len(z.infolist()) > 100 or len(members) > 32:
                raise InputError("ZIP must contain 1–32 CSV files, at most 100 members")
            if sum(x.file_size for x in z.infolist()) > settings.max_uncompressed_bytes:
                raise InputError("ZIP exceeds uncompressed size limit")
            if any(x.file_size / max(1, x.compress_size) > 300 for x in members):
                raise InputError("ZIP compression ratio exceeds limit")
            # Stream member bytes, never extract paths onto the filesystem.
            opened = [(x.filename, z.open(x)) for x in members]
            try:
                yield opened
            finally:
                for _, f in opened:
                    f.close()
    else:
        raise InputError("Supported uploads: FIRMS .csv and .zip containing CSV files")


def ingest_file(store, path: Path, display_name=None, progress=None):
    digest = sha256_file(path)
    existing = store.records("SELECT id,audit FROM datasets WHERE sha256=? AND status='ready'", [digest])
    if existing:
        return {"dataset_id": existing[0]["id"], "already_imported": True, "revision": store.revision()}
    dataset_id = uuid.uuid4().hex
    with store.db() as c:
        c.execute("INSERT INTO datasets(id,name,sha256,status) VALUES (?,?,?,'importing')",
                  [dataset_id, display_name or path.name, digest])
    audits, total = [], 0
    try:
        with csv_members(path, store.settings) as members:
            for name, handle in members:
                audit = {"member": name, "columns": [], "platforms": [], "processing": [], "start": None, "end": None}
                for chunk in pd.read_csv(handle, dtype=str, chunksize=store.settings.chunk_rows, encoding="utf-8-sig"):
                    total += len(chunk)
                    if total > store.settings.max_rows:
                        raise InputError("Dataset exceeds row limit")
                    norm, counts = normalize(chunk, name, store.settings.grid_km)
                    audit["columns"] = list(chunk.columns)
                    for key, value in counts.items():
                        audit[key] = audit.get(key, 0) + value
                    audit["platforms"] = sorted(set(audit["platforms"]) | set(norm.platform.unique()))
                    audit["processing"] = sorted(set(audit["processing"]) | set(norm.processing.unique()))
                    if norm.empty:
                        continue
                    lo, hi = norm.observed_at.min().isoformat(), norm.observed_at.max().isoformat()
                    audit["start"] = min(audit["start"] or lo, lo)
                    audit["end"] = max(audit["end"] or hi, hi)
                    norm.insert(0, "source_member", name)
                    norm.insert(0, "dataset_id", dataset_id)
                    columns = ",".join(norm.columns)
                    with store.db() as c:
                        c.register("incoming", norm)
                        try:
                            c.execute(f"""INSERT INTO observations(observation_id,{columns})
                                SELECT md5(concat_ws('|',platform,CAST(observed_at AS VARCHAR),
                                    CAST(latitude AS VARCHAR),CAST(longitude AS VARCHAR))), * FROM incoming""")
                        finally:
                            c.unregister("incoming")
                audits.append(audit)
                if progress:
                    progress({"input_rows": total, "members_completed": len(audits)})
        if total and not sum(a.get("valid_rows", 0) for a in audits):
            raise InputError("No valid observations; inspect platform, time, coordinates and instrument columns")
        with store.db() as c:
            c.execute("UPDATE datasets SET audit=? WHERE id=?", [json.dumps(audits), dataset_id])
        store.refresh(dataset_id)
        return {"dataset_id": dataset_id, "already_imported": False, "revision": store.revision(), "members": audits}
    except Exception:
        with store.db() as c:
            c.execute("DELETE FROM observations WHERE dataset_id=?", [dataset_id])
            c.execute("UPDATE datasets SET status='failed' WHERE id=?", [dataset_id])
        raise
