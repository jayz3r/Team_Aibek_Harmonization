from datetime import date
import json
import uuid

import numpy as np
import pandas as pd
from shapely.geometry import shape, box

from .config import InputError, ConflictError
from .queries import monthly_activity
from .schemas import Window, CalendarQuery
from .store import read_snapshot
from .geo import grid_polygon

LIMITATIONS = [
    "Experimental agreement in recorded activity; Suomi-NPP/reference is not ground truth.",
    "Zero means no qualifying record in the files, not verified absence of burning.",
    "Detection-only files lack clear-sky, valid-observation, overpass and swath masks.",
    "Grid occupancy is not a count of individual fires and is not burned area.",
    "Clouds, orbital drift, season, land cover and detection sensitivity can leave residual bias.",
    "Bootstrap limits describe slope variability, not prediction intervals.",
]


def error_metrics(x, y):
    x, y = np.asarray(x, float), np.asarray(y, float)
    if not len(x):
        return None
    error = x - y
    return {"n": len(x), "mae": float(np.abs(error).mean()), "rmse": float(np.sqrt(np.mean(error ** 2))),
            "aggregate_bias_pct": float(100 * error.sum() / y.sum()) if y.sum() else None}


@read_snapshot
def fit_model(store, request):
    revision = store.revision()
    window = Window(area=request.area, start=date(request.train_start_year, 1, 1),
                    end=date(request.test_year, 12, 31), daynight="both", hotspot_scope=request.hotspot_scope)
    monthly = monthly_activity(store, window)
    if request.reference not in set(monthly.platform):
        raise InputError("Reference platform has no qualifying archived activity in the training area")
    spans = {r["platform"]: r for r in store.spans()}
    ref = monthly[monthly.platform.eq(request.reference)]
    keys = ["month", "daynight", "rx", "ry"]
    coefficients, skipped = [], []
    rng = np.random.default_rng(request.seed)
    for platform in sorted(set(monthly.platform) - {request.reference}):
        src = monthly[monthly.platform.eq(platform)]
        pairs = src[keys + ["active_cell_days"]].merge(ref[keys + ["active_cell_days"]], on=keys,
                          how="outer", suffixes=("_source", "_reference")).fillna(0)
        pairs = pairs.rename(columns={"active_cell_days_source": "x", "active_cell_days_reference": "y"})
        starts = pd.to_datetime(pairs.month + "-01")
        ends = starts + pd.offsets.MonthEnd(0)
        lo = max(pd.Timestamp(spans[platform]["start"]), pd.Timestamp(spans[request.reference]["start"]))
        hi = min(pd.Timestamp(spans[platform]["end"]), pd.Timestamp(spans[request.reference]["end"]))
        pairs = pairs[(starts >= lo) & (ends <= hi)].copy()
        pairs["year"] = pairs.month.str[:4].astype(int)
        for dn in ["D", "N"]:
            part = pairs[pairs.daynight.eq(dn)]
            train = part[part.year.between(request.train_start_year, request.train_end_year)].copy()
            support = train.groupby(["rx", "ry"])[["x", "y"]].sum()
            support = support[(support.x > 0) & (support.y > 0)].index
            train = train.set_index(["rx", "ry"]).loc[lambda d: d.index.isin(support)].reset_index()
            test = part[part.year.eq(request.test_year)].set_index(["rx", "ry"])
            test = test.loc[test.index.isin(support)].reset_index()
            x, y = train.x.to_numpy(float), train.y.to_numpy(float)
            if len(train) < request.min_train_rows or train.year.nunique() < 2 or np.dot(x, x) == 0:
                skipped.append({"platform": platform, "daynight": dn, "reason": "insufficient_training_overlap"})
                continue
            slope = float(np.dot(x, y) / np.dot(x, x))
            train["xx"], train["xy"] = x * x, x * y
            year_sums = train.groupby("year")[["xx", "xy"]].sum().to_numpy()
            boot = []
            for _ in range(request.bootstrap_samples):
                xx, xy = year_sums[rng.integers(0, len(year_sums), len(year_sums))].sum(axis=0)
                if xx > 0:
                    boot.append(float(xy / xx))
            before, after = error_metrics(test.x, test.y), error_metrics(slope * test.x, test.y)
            warnings = []
            if after is None or after["aggregate_bias_pct"] is None or after["n"] < 12:
                warnings.append("insufficient_holdout_data")
            else:
                if after["rmse"] >= before["rmse"]:
                    warnings.append("rmse_not_improved")
                if after["mae"] > before["mae"]:
                    warnings.append("mae_worsened")
                if abs(after["aggregate_bias_pct"]) > 30:
                    warnings.append("large_residual_bias")
            if train.year.nunique() < 3:
                warnings.append("short_training_history")
            coefficients.append({"platform": platform, "daynight": dn, "slope": slope,
                "slope_ci95": np.quantile(boot, [.025, .975]).tolist(), "train_rows": len(train),
                "train_years": int(train.year.nunique()), "train_start": train.month.min(), "train_end": train.month.max(),
                "test_rows": len(test), "before": before, "after": after,
                "validation_status": "warning" if warnings else "experimental_agreement_improved",
                "warnings": warnings, "support_regions": [list(map(int, item)) for item in support.tolist()]})
    if not coefficients:
        raise InputError("No source has enough overlap; import at least two years of reference and source data")
    result = {"id": uuid.uuid4().hex, "revision": revision, "method": "year_block_bootstrap_nonnegative_origin_slope_v1",
        "reference": request.reference, "config": request.model_dump(mode="json"),
        "grid_km": store.settings.grid_km, "region_km": store.settings.region_km,
        "quality_policy": {"MODIS_min_confidence": 30, "VIIRS": ["nominal", "high"]},
        "coefficients": coefficients, "skipped": skipped, "limitations": LIMITATIONS,
        "support_definition": "Union of positive source/reference region-month records; regions selected on training only",
        "span_definition": "First/last valid archived detections in uploaded files; not verified observation coverage"}
    with store.db() as c:
        if store.revision() != revision:
            raise ConflictError("Dataset changed while fitting; fit again on the new revision")
        c.execute("INSERT INTO models(id,revision,payload) VALUES (?,?,?)", [result["id"], revision, json.dumps(result)])
    return result


def _geometry(area):
    return shape(area.polygon) if area.polygon else box(*area.bounds())


@read_snapshot
def calendar(store, request: CalendarQuery):
    model = store.get_model(request.model_id) if request.model_id else None
    if model:
        from .schemas import Area
        if model["stale"]:
            raise ConflictError("Calibration is stale after ingestion; create a new model")
        if request.processing != "archive" or model["config"]["hotspot_scope"] != request.hotspot_scope:
            raise InputError("Calibration applies only to archive data with its original hotspot_scope")
        if not _geometry(Area(**model["config"]["area"])).covers(_geometry(request.area)):
            raise InputError("Requested AOI exceeds calibration area; fit a model for this area first")
    reference = model["reference"] if model else "SNPP"
    coef = {(c["platform"], c["daynight"]): c for c in model["coefficients"]} if model else {}
    spans = {r["platform"]: (pd.Timestamp(r["start"]).date(), pd.Timestamp(r["end"]).date())
             for r in store.spans(request.processing)}
    monthly = monthly_activity(store, request)
    periods = pd.period_range(request.start, request.end, freq="M")
    selection = []
    priorities = list(dict.fromkeys([reference, "NOAA20", "NOAA21", "Aqua", "Terra", "SNPP"]))
    for period in periods:
        lo, hi = max(period.start_time.date(), request.start), min(period.end_time.date(), request.end)
        available = [p for p in priorities if p in spans and spans[p][0] <= lo and spans[p][1] >= hi]
        chosen = (available[0] if available else None) if request.platform == "auto" else request.platform
        if chosen and chosen not in available:
            chosen = None
        selection.append(chosen)
    modes = ["D", "N"] if request.daynight == "both" else [request.daynight]
    # Fix spatial support over the entire requested series, even when the selected satellite changes.
    common_support = {}
    used_platforms = sorted(set(selection) - {None})
    for dn in modes:
        supports = [set(map(tuple, coef[(p, dn)]["support_regions"]))
                    for p in used_platforms if p != reference and (p, dn) in coef]
        common_support[dn] = set.intersection(*supports) if supports else None
        if common_support[dn] is not None:
            geom = _geometry(request.area)
            common_support[dn] = {region for region in common_support[dn]
                                  if geom.intersects(shape(grid_polygon(*region, store.settings.region_km)))}
    rows = []
    for period, selected in zip(periods, selection):
        month = str(period)
        part = monthly[monthly.month.eq(month)]
        lo, hi = max(period.start_time.date(), request.start), min(period.end_time.date(), request.end)
        raw = {p: (int(part.loc[part.platform.eq(p), "active_cell_days"].sum())
                   if spans[p][0] <= hi and spans[p][1] >= lo else None) for p in spans}
        partial_spans = [p for p in spans if raw[p] is not None and not (spans[p][0] <= lo and spans[p][1] >= hi)]
        detected = {p: (int(part.loc[part.platform.eq(p), "detection_count"].sum()) if raw[p] is not None else None)
                    for p in spans}
        flags = []
        complete = request.start <= period.start_time.date() and request.end >= period.end_time.date()
        if not complete:
            flags.append("partial_requested_month")
        total_index = 0.0
        supported_count = 0
        supported_detections = 0
        components = []
        index_ok = model is not None and selected is not None
        if selected is None:
            flags.append("no_complete_file_span")
        if model is None:
            flags.append("not_calibrated")
        for dn in modes:
            sub = part[part.platform.eq(selected) & part.daynight.eq(dn)] if selected else part.iloc[:0]
            sup = common_support[dn]
            if sup is not None:
                sub = sub.loc[[tuple(v) in sup for v in sub[["rx", "ry"]].to_numpy()]]
                if not sup:
                    index_ok = False
                    flags.append("no_common_spatial_support")
            count = int(sub.active_cell_days.sum())
            supported_count += count
            supported_detections += int(sub.detection_count.sum())
            c = coef.get((selected, dn))
            factor = 1.0 if selected == reference else (c["slope"] if c else None)
            if selected != reference and c is None:
                index_ok = False
                flags.append("missing_calibration")
            if c:
                if c["warnings"]:
                    flags.append("validation_warning")
                if month < c["train_start"] or month > f"{model['config']['test_year']}-12":
                    flags.append("historical_extrapolation" if month < c["train_start"] else "outside_validation_period")
                    if not request.allow_extrapolation:
                        index_ok = False
            components.append({"daynight": dn, "raw_supported_cell_days": count, "slope": factor,
                               "validation_warnings": c["warnings"] if c else []})
            if factor is not None:
                total_index += count * factor
        if selected and raw[selected] == 0:
            flags.append("no_records_coverage_unknown")
        if selected and raw[selected] > supported_count:
            flags.append("partial_spatial_support")
        rows.append({"month": month, "selected_platform": selected,
                     "raw_by_platform": raw, "detection_counts_by_platform": detected,
                     "partial_span_platforms": partial_spans, "raw_selected_cell_days": raw.get(selected),
                     "supported_cell_days": supported_count if selected else None,
                     "excluded_cell_days": raw[selected] - supported_count if selected else None,
                     "supported_detections": supported_detections if selected else None,
                     "harmonized_index": float(total_index) if index_ok else None,
                     "complete_requested_month": complete, "flags": sorted(set(flags)), "components": components})
    return {"rows": rows, "meta": {"revision": store.revision(), "model_id": request.model_id,
        "reference": reference, "unit": f"{reference}_equivalent_occupied_cell_day_periods",
        "daynight": request.daynight, "timezone": "UTC", "grid_km": store.settings.grid_km,
        "aoi_rule": "analysis_cell_center_in_area", "selected_platforms": used_platforms,
        "common_support_region_counts": {dn: len(v) if v is not None else None for dn, v in common_support.items()},
        "selection_rule": "One stream per month from file-wide spans, never fallback because AOI has zero detections",
        "historical_extrapolation_enabled": request.allow_extrapolation,
        "limitations": LIMITATIONS}}


@read_snapshot
def seasonality(store, request):
    if not request.model_id:
        raise InputError("Seasonality requires a model_id for a consistent indicator")
    # A single calendar call makes baseline and target share the SAME spatial support.
    full = CalendarQuery(**request.model_dump(exclude={"baseline_start_year", "baseline_end_year", "min_baseline_years"}))
    full.start = date(request.baseline_start_year, 1, 1)
    result = calendar(store, full)
    baseline, target = [], []
    for row in result["rows"]:
        yr, mo = map(int, row["month"].split("-"))
        if request.baseline_start_year <= yr <= request.baseline_end_year:
            if row["harmonized_index"] is not None and row["complete_requested_month"]:
                baseline.append((yr, mo, row["harmonized_index"]))
        if str(request.start)[:7] <= row["month"] <= str(request.end)[:7]:
            row = dict(row)
            row["complete_requested_month"] = (request.start <= pd.Period(row["month"]).start_time.date()
                                                  and request.end >= pd.Period(row["month"]).end_time.date())
            target.append(row)
    seasonal = []
    for month in range(1, 13):
        values = np.array([v for _, mo, v in baseline if mo == month], dtype=float)
        enough = len(values) >= request.min_baseline_years
        seasonal.append({"month": month, "baseline_years": len(values),
                         "mean": float(values.mean()) if enough else None,
                         "std": float(values.std(ddof=1)) if enough else None,
                         "median": float(np.median(values)) if enough else None,
                         "p95": float(np.quantile(values, .95)) if enough else None})
    for row in target:
        stats = seasonal[int(row["month"][5:7]) - 1]
        value = row["harmonized_index"]
        row.update({"baseline_mean": stats["mean"], "baseline_years": stats["baseline_years"],
                    "anomaly": None, "anomaly_pct": None, "z_score": None, "classification": "insufficient_baseline"})
        if not row["complete_requested_month"]:
            row["classification"] = "partial_month"
        elif value is None:
            row["classification"] = "unavailable_index"
        elif stats["mean"] is not None:
            row["anomaly"] = value - stats["mean"]
            row["anomaly_pct"] = 100 * row["anomaly"] / stats["mean"] if stats["mean"] else None
            row["z_score"] = row["anomaly"] / stats["std"] if stats["std"] else None
            z = row["z_score"]
            row["classification"] = "zero_baseline_variance" if z is None else ("unusually_high" if z >= 2 else "unusually_low" if z <= -2 else "typical")
    high_months = sorted([s for s in seasonal if s["mean"] is not None and s["mean"] > 0], key=lambda s: -s["mean"])[:3]
    return {"seasonal_profile": seasonal, "anomalies": target,
            "historically_active_months": [s["month"] for s in high_months],
            "meta": {**result["meta"], "baseline": [request.baseline_start_year, request.baseline_end_year],
                     "not_a_forecast": True, "anomaly_rule": "Descriptive z-score +/-2 against prior calendar-month years; not a significance test"}}
