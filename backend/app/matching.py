import numpy as np
from scipy.spatial import cKDTree

from .config import InputError
from .geo import EARTH_KM
from .queries import detection_frame, json_records
from .schemas import DetectionQuery
from .store import read_snapshot


def unit_vectors(frame):
    lat, lon = np.deg2rad(frame.latitude.to_numpy()), np.deg2rad(frame.longitude.to_numpy())
    return np.column_stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])


@read_snapshot
def match_observations(store, request):
    q = DetectionQuery(**request.model_dump(exclude={"modis_platform", "viirs_platform", "distance_km", "time_minutes", "max_pairs"}),
                       platforms=[request.modis_platform, request.viirs_platform])
    frame = detection_frame(store, q, limit=50001, offset=0)
    if len(frame) > 50000:
        raise InputError("Matching is limited to 50000 input points; narrow AOI or date range")
    src = frame[frame.platform.eq(request.modis_platform)].reset_index(drop=True)
    tgt = frame[frame.platform.eq(request.viirs_platform)].reset_index(drop=True)
    matches, matched_src, matched_tgt, target_counts = [], set(), set(), {}
    if len(src) and len(tgt):
        sv, tv = unit_vectors(src), unit_vectors(tgt)
        tree = cKDTree(tv)
        radius = 2 * np.sin(request.distance_km / (2 * EARTH_KM))
        st = src.observed_at.to_numpy(dtype="datetime64[s]").astype("int64")
        tt = tgt.observed_at.to_numpy(dtype="datetime64[s]").astype("int64")
        for i, vector in enumerate(sv):
            candidates = tree.query_ball_point(vector, radius)
            for j in sorted(candidates):
                delta = abs(st[i] - tt[j]) / 60
                if delta > request.time_minutes:
                    continue
                if len(matches) >= request.max_pairs:
                    raise InputError("Candidate pair limit exceeded; narrow AOI, time or matching radius")
                dist = 2 * EARTH_KM * np.arcsin(min(1, np.linalg.norm(vector - tv[j]) / 2))
                matches.append({"modis_id": src.observation_id.iloc[i], "viirs_id": tgt.observation_id.iloc[j],
                                "distance_km": float(dist), "time_delta_minutes": float(delta),
                                # [longitude, latitude] of both pixel centres, so a map can draw the link.
                                "modis_lonlat": [float(src.longitude.iloc[i]), float(src.latitude.iloc[i])],
                                "viirs_lonlat": [float(tgt.longitude.iloc[j]), float(tgt.latitude.iloc[j])]})
                matched_src.add(i)
                matched_tgt.add(j)
                target_counts[j] = target_counts.get(j, 0) + 1
    return {"pairs": matches, "summary": {"modis_points": len(src), "viirs_points": len(tgt),
        "matched_modis_points": len(matched_src), "matched_viirs_points": len(matched_tgt),
        "unmatched_modis_points": len(src) - len(matched_src), "unmatched_viirs_points": len(tgt) - len(matched_tgt),
        "ambiguous_viirs_points": sum(v > 1 for v in target_counts.values()), "candidate_pairs": len(matches),
        "matched_modis_pct": round(100 * len(matched_src) / len(src), 2) if len(src) else None,
        "matched_viirs_pct": round(100 * len(matched_tgt) / len(tgt), 2) if len(tgt) else None},
        "meta": {"method": "many_to_many_geodesic_centroid_time_candidates",
                 "modis_platform": request.modis_platform, "viirs_platform": request.viirs_platform,
                 "radius_km": request.distance_km, "window_minutes": request.time_minutes,
                 "limitations": ["Candidates are not confirmed identical fires or exact footprint intersections.",
                                 "Unmatched detections are not necessarily false alarms or missed fires.",
                                 "VIIRS FRP is not summed across candidates; no duplicate energy estimate is inferred."]}}
