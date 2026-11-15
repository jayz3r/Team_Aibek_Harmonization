from pathlib import Path
from contextlib import contextmanager
import hashlib
import json
import re
import uuid
import zipfile
import zlib

import numpy as np
import pandas as pd

from .config import InputError, UploadTooLarge
from .geo import grid_coordinates

PLATFORMS = {
    "T": "Terra", "TERRA": "Terra", "A": "Aqua", "AQUA": "Aqua",
    "N": "SNPP", "SNPP": "SNPP", "S-NPP": "SNPP", "SUOMI-NPP": "SNPP",
    "N20": "NOAA20", "NOAA20": "NOAA20", "NOAA-20": "NOAA20", "J1": "NOAA20",
    "N21": "NOAA21", "NOAA21": "NOAA21", "NOAA-21": "NOAA21", "J2": "NOAA21",
    # Older FIRMS VIIRS exports label NOAA-20 as "1" (JPSS-1); "2" follows the same convention.
    "NPP": "SNPP", "1": "NOAA20", "JPSS-1": "NOAA20", "JPSS1": "NOAA20",
    "2": "NOAA21", "JPSS-2": "NOAA21", "JPSS2": "NOAA21",
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
    # FIRMS writes 0432 / 432; some converters write 04:32.
    acq_time = text("acq_time").str.replace(":", "", regex=False)
    latitude, longitude, time = num("latitude"), num("longitude"), pd.to_numeric(acq_time, errors="coerce")
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


def _skipped_member(name):
    """Archive bookkeeping that only looks like data: macOS resource forks, hidden files."""
    parts = name.replace("\\", "/").split("/")
    return "__MACOSX" in parts or parts[-1].startswith(".")


def _no_csv_message(names):
    lower = [n.lower() for n in names]
    if any(n.endswith((".shp", ".dbf", ".shx")) for n in lower):
        return ("This ZIP holds a shapefile, not CSV. On the FIRMS Archive Download page "
                "request the same area again in CSV format and upload that ZIP.")
    if any(n.endswith((".json", ".geojson")) for n in lower):
        return "This ZIP holds JSON, not CSV. Request the FIRMS download in CSV format."
    if any(n.endswith(".zip") for n in lower):
        return "This ZIP only contains other ZIP files. Unpack it once and upload the inner FIRMS ZIP."
    return "The ZIP contains no CSV files. Upload a FIRMS archive download (fire_archive_*.csv / fire_nrt_*.csv)."


@contextmanager
def csv_members(path, settings):
    if path.suffix.lower() == ".csv":
        if path.stat().st_size > settings.max_uncompressed_bytes:
            raise InputError("CSV exceeds uncompressed size limit")
        with path.open("rb") as f:
            yield [(path.name, f)]
    elif path.suffix.lower() == ".zip":
        try:
            archive = zipfile.ZipFile(path)
        except (zipfile.BadZipFile, OSError):
            raise InputError("The file is not a readable ZIP archive (damaged or incomplete download)") from None
        with archive as z:
            everything = [x for x in z.infolist() if not x.is_dir()]
            if len(z.infolist()) > 100:
                raise InputError("ZIP has more than 100 members; upload the FIRMS download as it is")
            members = [x for x in everything if x.filename.lower().endswith(".csv") and not _skipped_member(x.filename)]
            if not members:
                raise InputError(_no_csv_message([x.filename for x in everything]))
            if len(members) > 32:
                raise InputError("ZIP must contain at most 32 CSV files")
            if any(x.flag_bits & 0x1 for x in members):
                raise InputError("The ZIP is password-protected; upload an unencrypted archive")
            if sum(x.file_size for x in everything) > settings.max_uncompressed_bytes:
                raise InputError("ZIP exceeds uncompressed size limit")
            if any(x.file_size / max(1, x.compress_size) > 300 for x in members):
                raise InputError("ZIP compression ratio exceeds limit")
            # Stream member bytes, never extract paths onto the filesystem.
            opened = []
            try:
                for x in members:
                    try:
                        opened.append((x.filename, z.open(x)))
                    except (NotImplementedError, RuntimeError, zipfile.BadZipFile):
                        raise InputError(f"{x.filename}: unsupported or damaged ZIP entry; re-create the ZIP with standard compression") from None
                yield opened
            finally:
                for _, f in opened:
                    f.close()
    else:
        raise InputError("Supported uploads: FIRMS .csv and .zip containing CSV files")


def save_upload(stream, filename, settings):
    """Copy an uploaded file object into data_dir/uploads under a random name.

    Returns (path, display_name). Raises InputError for a wrong type, an empty or an oversized file;
    nothing is left on disk in that case.
    """
    # Keep only the last path part, whichever slash the client used; it is a label, never a path.
    name = re.split(r"[\\/]", str(filename or "upload.csv"))[-1][:200] or "upload.csv"
    suffix = Path(name).suffix.lower()
    if suffix not in [".csv", ".zip"]:
        raise InputError("Only .csv and .zip are supported")
    directory = settings.data_dir / "uploads"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{uuid.uuid4().hex}{suffix}"
    try:
        size = 0
        with path.open("wb") as handle:
            while block := stream.read(1024 * 1024):
                size += len(block)
                if size > settings.max_upload_bytes:
                    raise UploadTooLarge(f"Upload exceeds {max(1, settings.max_upload_bytes // (1024 * 1024))} MiB; upload a smaller area or period")
                handle.write(block)
        if size == 0:
            raise InputError("Empty upload")
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return path, name


def _read_chunks(handle, name, chunk_rows):
    """Yield string-typed chunks; turn parser failures into messages a user can act on."""
    try:
        yield from pd.read_csv(handle, dtype=str, chunksize=chunk_rows, encoding="utf-8-sig")
    except pd.errors.EmptyDataError:
        return  # a 0-byte member: FIRMS never sends one, other tools do
    except pd.errors.ParserError:
        raise InputError(f"{name}: not a regular CSV table (broken quoting or ragged rows)") from None
    except UnicodeDecodeError:
        raise InputError(f"{name}: not UTF-8 text; FIRMS CSV files are plain UTF-8") from None
    except (zipfile.BadZipFile, EOFError, zlib.error):
        raise InputError(f"{name}: the ZIP entry is damaged (incomplete download?)") from None


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
                for chunk in _read_chunks(handle, name, store.settings.chunk_rows):
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
                    if progress:  # per chunk, so a single large CSV still shows movement
                        progress({"input_rows": total, "members_completed": len(audits)})
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
