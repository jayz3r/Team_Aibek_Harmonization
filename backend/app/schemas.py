from datetime import date
from typing import Literal, Any

import numpy as np
from pydantic import BaseModel, Field, ConfigDict, model_validator
from shapely.geometry import shape

Platform = Literal["Terra", "Aqua", "SNPP", "NOAA20", "NOAA21"]
Processing = Literal["archive", "NRT", "RT", "URT", "unknown"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Area(StrictModel):
    bbox: tuple[float, float, float, float] | None = Field(
        default=None, description="[west, south, east, north], WGS84. No antimeridian crossing.")
    polygon: dict[str, Any] | None = Field(
        default=None, description="GeoJSON Polygon or MultiPolygon geometry, [longitude, latitude].")

    @model_validator(mode="after")
    def validate_area(self):
        if self.bbox is not None and self.polygon is not None:
            raise ValueError("Use either bbox or polygon, not both")
        if self.polygon:
            try:
                g = shape(self.polygon)
                if g.geom_type not in ("Polygon", "MultiPolygon") or not g.is_valid or g.is_empty:
                    raise ValueError()
                from shapely import get_coordinates
                coords = get_coordinates(g)
                if len(coords) > 2000 or not np.isfinite(coords).all():
                    raise ValueError()
                b = g.bounds
                if b[2] - b[0] > 180:
                    raise ValueError()
            except Exception as exc:
                raise ValueError("Invalid Polygon/MultiPolygon; max 2000 vertices, no dateline crossing") from exc
        else:
            b = self.bbox or (-180, -90, 180, 90)
        w, s, e, n = b
        if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
            raise ValueError("Invalid WGS84 bounds")
        return self

    def bounds(self):
        return shape(self.polygon).bounds if self.polygon else (self.bbox or (-180, -90, 180, 90))


class Window(StrictModel):
    area: Area = Field(default_factory=Area)
    start: date
    end: date
    daynight: Literal["D", "N", "both"] = "D"
    processing: Processing = "archive"
    hotspot_scope: Literal["all", "vegetation"] = "all"

    @model_validator(mode="after")
    def valid_dates(self):
        if self.start > self.end or (self.end - self.start).days > 366 * 40:
            raise ValueError("start must precede end; maximum interval is 40 years")
        return self


class DetectionQuery(Window):
    platforms: list[Platform] = Field(default_factory=list, max_length=5)
    quality_only: bool = True
    limit: int = Field(default=1000, ge=1, le=10000)
    offset: int = Field(default=0, ge=0, le=10_000_000)


class GridQuery(Window):
    platform: Platform = "SNPP"
    limit: int = Field(default=5000, ge=1, le=20000)
    offset: int = Field(default=0, ge=0)


class CalibrationRequest(StrictModel):
    area: Area = Field(default_factory=Area)
    reference: Platform = "SNPP"
    train_start_year: int = Field(default=2013, ge=2000, le=2100)
    train_end_year: int = Field(default=2024, ge=2001, le=2100)
    test_year: int = Field(default=2025, ge=2002, le=2100)
    hotspot_scope: Literal["all", "vegetation"] = "all"
    min_train_rows: int = Field(default=24, ge=3, le=10000)
    bootstrap_samples: int = Field(default=200, ge=30, le=1000)
    seed: int = 42

    @model_validator(mode="after")
    def separate_test(self):
        if not self.train_start_year < self.train_end_year < self.test_year:
            raise ValueError("Need at least two training years and a later, untouched test year")
        return self


class CalendarQuery(Window):
    model_id: str | None = None
    platform: Literal["auto", "Terra", "Aqua", "SNPP", "NOAA20", "NOAA21"] = "auto"
    allow_extrapolation: bool = False


class SeasonalQuery(CalendarQuery):
    baseline_start_year: int = Field(default=2013, ge=2000, le=2100)
    baseline_end_year: int = Field(default=2024, ge=2000, le=2100)
    min_baseline_years: int = Field(default=3, ge=3, le=30)

    @model_validator(mode="after")
    def baseline_before_target(self):
        if self.baseline_start_year > self.baseline_end_year or self.baseline_end_year >= self.start.year:
            raise ValueError("Baseline must end before the first target year (no leakage)")
        return self


class MatchQuery(Window):
    modis_platform: Literal["Terra", "Aqua"] = "Aqua"
    viirs_platform: Literal["SNPP", "NOAA20", "NOAA21"] = "SNPP"
    distance_km: float = Field(default=1.0, gt=0, le=10)
    time_minutes: int = Field(default=30, ge=1, le=180)
    max_pairs: int = Field(default=10000, ge=1, le=50000)

    @model_validator(mode="after")
    def small_window(self):
        if (self.end - self.start).days > 30:
            raise ValueError("Matching supports at most 31 calendar days; narrow the region/time")
        return self


class EventQuery(Window):
    """Fuse MODIS and VIIRS pixels into space-time clusters ("fire events")."""
    platforms: list[Platform] = Field(default_factory=list, max_length=5,
                                      description="Empty list = every platform in the files.")
    quality_only: bool = True
    distance_km: float = Field(default=1.5, gt=0, le=10, description="Link pixels closer than this.")
    gap_hours: float = Field(default=36.0, ge=1, le=240, description="...and observed within this time gap.")
    min_detections: int = Field(default=1, ge=1, le=1000, description="Hide smaller events in the response.")
    limit: int = Field(default=2000, ge=1, le=5000, description="Largest events first.")

    @model_validator(mode="after")
    def small_window(self):
        if (self.end - self.start).days > 30:
            raise ValueError("Event fusion supports at most 31 calendar days; narrow the region/time")
        return self


class FirmsRequest(StrictModel):
    source: Literal["MODIS_NRT", "MODIS_SP", "VIIRS_SNPP_NRT", "VIIRS_SNPP_SP",
                    "VIIRS_NOAA20_NRT", "VIIRS_NOAA20_SP", "VIIRS_NOAA21_NRT", "VIIRS_NOAA21_SP"]
    area: Area
    start: date | None = None
    days: int = Field(default=1, ge=1, le=5)

    @model_validator(mode="after")
    def only_bbox(self):
        if self.area.polygon or self.area.bbox is None:
            raise ValueError("FIRMS import needs a bbox")
        return self
