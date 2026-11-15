import json
import pandas as pd
from shapely.geometry import shape
from shapely import intersects_xy, prepare

from .geo import grid_polygon
from .store import read_snapshot


def spatial_frame(store, sql, params, area):
    """sql uses inside_aoi only for polygon requests; bbox predicates are pushed down."""
    with store.db() as c:
        if area.polygon:
            geom = shape(area.polygon)
            prepare(geom)
            # DuckDB 2 requires a fully consumed result before registering a UDF.
            c.execute("SELECT 1").fetchall()
            c.create_function("inside_aoi", lambda lon, lat: bool(intersects_xy(geom, lon, lat)),
                              ["DOUBLE", "DOUBLE"], "BOOLEAN")
        try:
            return c.execute(sql, params).fetchdf()
        finally:
            if area.polygon:
                c.remove_function("inside_aoi")


def conditions(window, table="activity", platforms=None):
    date_col = "date" if table == "activity" else "CAST(observed_at AS DATE)"
    w, s, e, n = window.area.bounds()
    clauses = [f"{date_col} BETWEEN ? AND ?", "processing=?", "longitude BETWEEN ? AND ?", "latitude BETWEEN ? AND ?"]
    params = [window.start, window.end, window.processing, w, e, s, n]
    if window.daynight != "both":
        clauses.append("daynight=?")
        params.append(window.daynight)
    if window.hotspot_scope == "vegetation":
        clauses.append("hotspot_type=0")
    if platforms:
        clauses.append("platform IN (" + ",".join("?" for _ in platforms) + ")")
        params.extend(platforms)
    if window.area.polygon:
        clauses.append("inside_aoi(longitude,latitude)")
    return " AND ".join(clauses), params


def detection_frame(store, request, limit=None, offset=None):
    where, params = conditions(request, "detections", request.platforms)
    if request.quality_only:
        where += " AND quality_pass"
    limit = limit if limit is not None else request.limit
    offset = offset if offset is not None else request.offset
    return spatial_frame(store, f"""SELECT observation_id,dataset_id,source_member,
        platform,sensor,observed_at,latitude,longitude,brightness_k,brightness_channel,
        background_k,scan_km,track_km,frp_mw,confidence_raw,confidence_class,quality_pass,
        version,processing,hotspot_type,daynight
        FROM detections WHERE {where} ORDER BY observed_at,observation_id LIMIT ? OFFSET ?""",
        params + [limit, offset], request.area)


def json_records(frame):
    return json.loads(frame.to_json(orient="records", date_format="iso", double_precision=12))


@read_snapshot
def detections_geojson(store, request):
    frame = detection_frame(store, request, limit=request.limit + 1)
    has_more = len(frame) > request.limit
    features = []
    for row in json_records(frame.head(request.limit)):
        lon, lat = row.pop("longitude"), row.pop("latitude")
        row["observed_at"] += "Z"
        features.append({"type": "Feature", "id": row["observation_id"],
                         "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": row})
    return {"type": "FeatureCollection", "features": features,
            "meta": {"revision": store.revision(), "has_more": has_more, "offset": request.offset,
                     "next_offset": request.offset + request.limit if has_more else None,
                     "unit": "detected_pixels_not_unique_fires", "timezone": "UTC"}}


def monthly_activity(store, request):
    where, params = conditions(request)
    factor = store.settings.region_km / store.settings.grid_km
    return spatial_frame(store, f"""SELECT platform,strftime(date,'%Y-%m') AS month,daynight,
        CAST(floor(gx/{factor}) AS INTEGER) AS rx,CAST(floor(gy/{factor}) AS INTEGER) AS ry,
        count(DISTINCT (date,gx,gy)) AS active_cell_days,
        sum(detection_count) AS detection_count
        FROM activity WHERE {where} GROUP BY platform,month,daynight,rx,ry
        ORDER BY month,platform,daynight,rx,ry""", params, request.area)


@read_snapshot
def grid_geojson(store, request):
    where, params = conditions(request, platforms=[request.platform])
    frame = spatial_frame(store, f"""SELECT gx,gy,count(DISTINCT (date,daynight)) AS active_cell_days,
        sum(detection_count) AS detection_count,max(frp_max_mw) AS frp_max_mw
        FROM activity WHERE {where} GROUP BY gx,gy ORDER BY gx,gy LIMIT ? OFFSET ?""",
        params + [request.limit + 1, request.offset], request.area)
    has_more = len(frame) > request.limit
    features = []
    for row in json_records(frame.head(request.limit)):
        features.append({"type": "Feature", "id": f"{row['gx']}:{row['gy']}",
                         "geometry": grid_polygon(row["gx"], row["gy"], store.settings.grid_km), "properties": row})
    return {"type": "FeatureCollection", "features": features,
            "meta": {"grid_km": store.settings.grid_km, "aoi_rule": "cell_center_in_area",
                     "has_more": has_more, "next_offset": request.offset + request.limit if has_more else None,
                     "unit": "occupied_cell_day_periods", "not_burned_area": True}}
