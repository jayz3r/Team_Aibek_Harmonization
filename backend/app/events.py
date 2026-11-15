"""Cross-sensor fire events: MODIS and VIIRS pixels fused into space-time clusters.

A detection is one satellite pixel. One fire is usually seen as many pixels, by several
satellites, on several overpasses. This module links pixels that are close in space AND
time (single-linkage connected components) and reports, for every cluster, which sensor
families saw it. It is the object-level counterpart of the gridded activity index.
"""
import numpy as np
import pandas as pd
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

from .config import InputError
from .geo import EARTH_KM

MAX_POINTS = 60000
MAX_LINKS = 4_000_000
MODIS_PLATFORMS = ("Terra", "Aqua")

LIMITATIONS = [
    "An event is a space-time cluster of detected pixels, not a confirmed or uniquely identified fire.",
    "Single linkage can chain neighbouring fires into one event; lower distance_km/gap_hours to split them.",
    "VIIRS (375 m) resolves small/cool fires that MODIS (1 km) cannot: 'viirs_only' is expected, not an error.",
    "'modis_only'/'viirs_only' also arise from overpass time, cloud and swath gaps; no observation masks are used.",
    "FRP is never summed across pixels, overpasses or sensors; only maxima are reported.",
]


def _unit_vectors(frame):
    lat, lon = np.deg2rad(frame.latitude.to_numpy(float)), np.deg2rad(frame.longitude.to_numpy(float))
    return np.column_stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])


def cluster_labels(frame, distance_km=1.5, gap_hours=36.0):
    """Label every row with an event id (0..k-1). Rows are linked when both thresholds hold."""
    n = len(frame)
    if n == 0:
        return np.zeros(0, dtype="int64")
    if n > MAX_POINTS:
        raise InputError(f"Event fusion is limited to {MAX_POINTS} input points; narrow AOI or date range")
    vectors = _unit_vectors(frame)
    tree = cKDTree(vectors)
    radius = 2 * np.sin(distance_km / (2 * EARTH_KM))
    # count_neighbors counts ordered pairs including self-pairs; cheap guard before materialising them.
    if (int(tree.count_neighbors(tree, radius)) - n) // 2 > MAX_LINKS:
        raise InputError("Too many neighbouring detections to fuse; narrow AOI, dates or distance_km")
    pairs = tree.query_pairs(radius, output_type="ndarray")
    if len(pairs):
        seconds = frame.observed_at.to_numpy(dtype="datetime64[s]").astype("int64")
        pairs = pairs[np.abs(seconds[pairs[:, 0]] - seconds[pairs[:, 1]]) <= gap_hours * 3600]
    graph = coo_matrix((np.ones(len(pairs), dtype=bool), (pairs[:, 0], pairs[:, 1])), shape=(n, n))
    _, labels = connected_components(graph, directed=False)
    return labels.astype("int64")


def _iso(value):
    return pd.Timestamp(value).strftime("%Y-%m-%dT%H:%M:%SZ")


def _number(value):
    return None if value is None or pd.isna(value) else float(value)


def summarize_events(frame, labels):
    """One record per event, largest first. ``frame`` needs the detection_frame columns."""
    if not len(frame):
        return []
    f = frame.reset_index(drop=True).copy()
    f["event"] = labels
    f["is_modis"] = f.platform.isin(MODIS_PLATFORMS)
    f["is_night"] = f.daynight.eq("N")
    f["is_high"] = f.confidence_class.eq("high")
    f["day"] = f.observed_at.dt.strftime("%Y-%m-%d")
    f["frp_modis"] = f.frp_mw.where(f.is_modis)
    f["frp_viirs"] = f.frp_mw.where(~f.is_modis)
    grouped = f.groupby("event", sort=False)
    table = grouped.agg(
        detections=("longitude", "size"), modis=("is_modis", "sum"), night=("is_night", "sum"),
        high=("is_high", "sum"), longitude=("longitude", "mean"), latitude=("latitude", "mean"),
        west=("longitude", "min"), south=("latitude", "min"), east=("longitude", "max"), north=("latitude", "max"),
        first=("observed_at", "min"), last=("observed_at", "max"), active_days=("day", "nunique"),
        frp_max=("frp_mw", "max"), frp_max_modis=("frp_modis", "max"), frp_max_viirs=("frp_viirs", "max"))
    platforms = f.groupby(["event", "platform"], sort=False).size().unstack(fill_value=0)
    table = table.sort_values(["detections", "first"], ascending=[False, True])
    events = []
    for rank, (event, row) in enumerate(table.iterrows(), start=1):
        modis, total = int(row.modis), int(row.detections)
        viirs = total - modis
        counts = {name: int(value) for name, value in platforms.loc[event].items() if value}
        events.append({
            "event_id": rank, "detections": total, "modis_detections": modis, "viirs_detections": viirs,
            "agreement": "both" if modis and viirs else ("modis_only" if modis else "viirs_only"),
            "platforms": sorted(counts), "detections_by_platform": counts,
            "first_seen": _iso(row["first"]), "last_seen": _iso(row["last"]),
            "duration_hours": round((row["last"] - row["first"]).total_seconds() / 3600, 2),
            "active_days": int(row.active_days), "night_share": round(float(row.night) / total, 3),
            "high_confidence_share": round(float(row.high) / total, 3),
            "frp_max_mw": _number(row.frp_max), "frp_max_modis_mw": _number(row.frp_max_modis),
            "frp_max_viirs_mw": _number(row.frp_max_viirs),
            "longitude": float(row.longitude), "latitude": float(row.latitude),
            "bbox": [float(row.west), float(row.south), float(row.east), float(row.north)],
        })
    return events


def events_summary(events):
    kinds = {"both": 0, "modis_only": 0, "viirs_only": 0}
    pixels = {"both": 0, "modis_only": 0, "viirs_only": 0}
    for event in events:
        kinds[event["agreement"]] += 1
        pixels[event["agreement"]] += event["detections"]
    total, detections = len(events), sum(pixels.values())
    return {"events": total, "detections": detections,
            "modis_detections": sum(e["modis_detections"] for e in events),
            "viirs_detections": sum(e["viirs_detections"] for e in events),
            "events_by_agreement": kinds, "detections_by_agreement": pixels,
            "both_events_pct": round(100 * kinds["both"] / total, 2) if total else None,
            "detections_in_both_pct": round(100 * pixels["both"] / detections, 2) if detections else None,
            "pixels_per_event": round(detections / total, 2) if total else None,
            "multi_day_events": sum(e["active_days"] > 1 for e in events)}


def fuse(frame, request):
    """Pure part of the endpoint: detections frame -> GeoJSON FeatureCollection."""
    labels = cluster_labels(frame, request.distance_km, request.gap_hours)
    events = summarize_events(frame, labels)
    summary = events_summary(events)
    kept = [e for e in events if e["detections"] >= request.min_detections]
    features = []
    for event in kept[:request.limit]:
        properties = dict(event)
        lon, lat = properties.pop("longitude"), properties.pop("latitude")
        features.append({"type": "Feature", "id": event["event_id"],
                         "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": properties})
    return {"type": "FeatureCollection", "features": features, "summary": summary,
            "meta": {"method": "single_linkage_space_time_components_v1",
                     "distance_km": request.distance_km, "gap_hours": request.gap_hours,
                     "min_detections": request.min_detections, "returned": len(features),
                     "matching_min_detections": len(kept), "truncated": len(kept) > len(features),
                     "geometry": "mean pixel-centre position; bbox is the pixel-centre extent",
                     "unit": "space_time_clusters_of_detected_pixels", "timezone": "UTC",
                     "limitations": LIMITATIONS}}


def fire_events(store, request):
    # Imported here so the pure functions above stay importable without the database layer.
    from .queries import detection_frame
    from .schemas import DetectionQuery
    with store.lock:
        query = DetectionQuery(**request.model_dump(exclude={"distance_km", "gap_hours", "min_detections", "limit"}))
        frame = detection_frame(store, query, limit=MAX_POINTS + 1, offset=0)
        revision = store.revision()
    if len(frame) > MAX_POINTS:
        raise InputError(f"Event fusion is limited to {MAX_POINTS} input points; narrow AOI or date range")
    result = fuse(frame, request)
    result["meta"]["revision"] = revision
    result["meta"]["input_points"] = len(frame)
    return result
