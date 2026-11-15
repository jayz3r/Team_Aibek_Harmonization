import numpy as np
from shapely.geometry import shape
from shapely import intersects_xy

EARTH_KM = 6371.0088
COS30 = np.cos(np.deg2rad(30))


def grid_coordinates(longitude, latitude, grid_km=10.0):
    x = EARTH_KM * np.deg2rad(longitude) * COS30
    y = EARTH_KM * np.sin(np.deg2rad(latitude)) / COS30
    return np.floor(x / grid_km).astype("int32"), np.floor(y / grid_km).astype("int32")


def grid_centers(gx, gy, grid_km=10.0):
    lon = np.rad2deg((np.asarray(gx) + 0.5) * grid_km / (EARTH_KM * COS30))
    lat = np.rad2deg(np.arcsin(np.clip((np.asarray(gy) + 0.5) * grid_km * COS30 / EARTH_KM, -1, 1)))
    return np.clip(lon, -180, 180), lat


def grid_polygon(gx, gy, grid_km=10.0):
    xs = [gx, gx + 1, gx + 1, gx, gx]
    ys = [gy, gy, gy + 1, gy + 1, gy]
    lon = np.clip(np.rad2deg(np.asarray(xs) * grid_km / (EARTH_KM * COS30)), -180, 180)
    lat = np.rad2deg(np.arcsin(np.clip(np.asarray(ys) * grid_km * COS30 / EARTH_KM, -1, 1)))
    return {"type": "Polygon", "coordinates": [list(map(list, zip(lon.tolist(), lat.tolist())))]}


def filter_area(frame, area, lon="longitude", lat="latitude"):
    if frame.empty:
        return frame
    w, s, e, n = area.bounds()
    mask = frame[lon].between(w, e) & frame[lat].between(s, n)
    if area.polygon:
        mask &= intersects_xy(shape(area.polygon), frame[lon].to_numpy(), frame[lat].to_numpy())
    return frame.loc[mask].copy()
