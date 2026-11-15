// Pure helpers shared by the UI and the Node tests (no DOM, no map, no network).

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const PLATFORMS = ['Terra', 'Aqua', 'SNPP', 'NOAA20', 'NOAA21'];
export const MODIS = ['Terra', 'Aqua'];
export const VIIRS = ['SNPP', 'NOAA20', 'NOAA21'];
export const PLATFORM_LABEL = {Terra: 'Terra · MODIS', Aqua: 'Aqua · MODIS', SNPP: 'Suomi NPP · VIIRS', NOAA20: 'NOAA-20 · VIIRS', NOAA21: 'NOAA-21 · VIIRS'};
export const PLATFORM_COLOR = {Terra: '#d98a6a', Aqua: '#eeb79e', SNPP: '#f6edd2', NOAA20: '#b9d6d2', NOAA21: '#8fb7c9'};

const pad = n => String(n).padStart(2, '0');

export function lastDay(year, month) {
  return new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
}

/** Inclusive UTC date window for a year and a month ('all' = whole year). */
export function monthRange(year, month) {
  const y = Number(year);
  if (month === 'all' || month == null) return {start: `${y}-01-01`, end: `${y}-12-31`};
  const m = Number(month);
  return {start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(lastDay(y, m))}`};
}

export function fmt(value, digits = 0) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString('en-US', {maximumFractionDigits: digits, minimumFractionDigits: digits});
}

export function compact(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const n = Number(value), a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e4) return Math.round(n / 1e3) + 'k';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

export function signed(value, digits = 1, suffix = '%') {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(digits) + suffix;
}

/** Platforms sent to the API for a sensor-family filter; [] means "all". */
export function platformsFor(sensor) {
  return sensor === 'MODIS' ? MODIS : sensor === 'VIIRS' ? VIIRS : [];
}

export function sensorOf(platform) {
  return MODIS.includes(platform) ? 'MODIS' : 'VIIRS';
}

/** Backend GeoJSON feature -> the flat row shape used by the map, detail card and CSV export. */
export function featureToRow(feature) {
  const p = feature.properties || {};
  const [longitude, latitude] = feature.geometry.coordinates;
  const iso = String(p.observed_at || '');
  return {
    id: p.observation_id || feature.id, longitude, latitude,
    instrument: p.sensor || sensorOf(p.platform), satellite: p.platform,
    acq_date: iso.slice(0, 10), acq_time: iso.slice(11, 13) + iso.slice(14, 16),
    frp: p.frp_mw ?? null, confidence: p.confidence_raw ?? '', confidence_class: p.confidence_class,
    daynight: p.daynight, scan_km: p.scan_km ?? null, track_km: p.track_km ?? null,
    brightness: p.brightness_k ?? null, processing: p.processing, hotspot_type: p.hotspot_type ?? null,
    quality_pass: p.quality_pass,
  };
}

/** [west, south, east, north] of any GeoJSON FeatureCollection, or null when empty. */
export function bboxOf(collection) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const visit = c => {
    if (typeof c[0] === 'number') {
      if (c[0] < w) w = c[0];
      if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1];
      if (c[1] > n) n = c[1];
    } else c.forEach(visit);
  };
  for (const f of collection?.features || []) if (f.geometry?.coordinates) visit(f.geometry.coordinates);
  return Number.isFinite(w) && w < e && s < n ? [w, s, e, n].map(v => Math.round(v * 1e5) / 1e5) : null;
}

/** Last calendar year that the archive files cover completely (falls back to the last year). */
export function defaultYear(overview, processing = 'archive') {
  const spans = overview?.coverage?.[processing] || [];
  if (!spans.length) return null;
  const end = spans.map(s => String(s.end).slice(0, 10)).sort().at(-1);
  const start = spans.map(s => String(s.start).slice(0, 10)).sort()[0];
  const year = Number(end.slice(0, 4));
  if (processing !== 'archive') return String(year);
  return String(end >= `${year}-12-31` || year - 1 < Number(start.slice(0, 4)) ? year : year - 1);
}

export function yearsOf(overview, processing = 'archive') {
  const range = overview?.years?.[processing];
  if (!range) return [];
  const out = [];
  for (let y = range[1]; y >= range[0]; y--) out.push(String(y));
  return out;
}

/** Monthly value shown on the timeline: harmonized index, or raw pixel detections of a sensor family. */
export function monthValue(row, sensor = 'All sensors') {
  if (!row) return {value: null, kind: 'none'};
  if (sensor === 'All sensors' && row.harmonized_index != null) return {value: row.harmonized_index, kind: 'index'};
  const wanted = platformsFor(sensor);
  const counts = row.detection_counts_by_platform || {};
  let total = 0, any = false;
  for (const [platform, n] of Object.entries(counts)) {
    if (n == null || (wanted.length && !wanted.includes(platform))) continue;
    total += n;
    any = true;
  }
  return {value: any ? total : null, kind: 'detections'};
}

/** rows[] of the calendar endpoint -> {years, cells[year][0..11], max} for the heatmap. */
export function calendarMatrix(rows, field = 'harmonized_index') {
  const cells = {};
  let max = 0;
  for (const row of rows || []) {
    const [y, m] = row.month.split('-').map(Number);
    (cells[y] ||= Array(12).fill(null))[m - 1] = row;
    if (row[field] != null && row[field] > max) max = row[field];
  }
  return {years: Object.keys(cells).map(Number).sort((a, b) => a - b), cells, max};
}

/** Per-year totals of the raw selected-sensor series and of the harmonized series (complete years only). */
export function annualTotals(rows) {
  const years = {};
  for (const row of rows || []) {
    const y = Number(row.month.slice(0, 4));
    const t = (years[y] ||= {year: y, raw: 0, index: 0, months: 0, indexMonths: 0, platforms: new Set()});
    if (row.raw_selected_cell_days != null) {
      t.raw += row.supported_cell_days ?? row.raw_selected_cell_days;
      t.months++;
    }
    if (row.harmonized_index != null) {
      t.index += row.harmonized_index;
      t.indexMonths++;
    }
    if (row.selected_platform) t.platforms.add(row.selected_platform);
  }
  return Object.values(years).sort((a, b) => a.year - b.year).map(t => ({
    year: t.year, raw: t.months === 12 ? t.raw : null, index: t.indexMonths === 12 ? t.index : null,
    platforms: [...t.platforms],
  }));
}

const FLAGS = {
  historical_extrapolation: 'Coefficient applied before its training period (experimental extrapolation)',
  outside_validation_period: 'Coefficient applied after the validated period',
  validation_warning: 'This sensor/day-night coefficient failed a validation check',
  partial_spatial_support: 'Some activity lies outside the common calibrated area and is excluded',
  no_common_spatial_support: 'No calibrated area in common for this request',
  no_complete_file_span: 'No satellite file covers this whole month',
  no_records_coverage_unknown: 'No records — absence of burning is NOT confirmed',
  not_calibrated: 'No model applied: raw counts only',
  missing_calibration: 'No coefficient for this sensor/day-night stratum',
  partial_requested_month: 'Month only partly inside the requested dates',
};
export const flagLabel = flag => FLAGS[flag] || flag.replaceAll('_', ' ');

const WARNINGS = {
  large_residual_bias: 'large residual bias',
  rmse_not_improved: 'RMSE not improved',
  mae_worsened: 'MAE got worse',
  insufficient_holdout_data: 'too little held-out data',
  short_training_history: 'short training history',
};
export const warningLabel = w => WARNINGS[w] || w.replaceAll('_', ' ');

/** Short, honest, auto-generated findings for the pitch. */
export function insights(model) {
  if (!model?.coefficients?.length) return [];
  const out = [];
  const scored = model.coefficients.filter(c => c.before && c.after);
  const improved = scored.filter(c => !c.warnings.length)
    .map(c => ({c, gain: 100 * (1 - c.after.rmse / c.before.rmse)}))
    .sort((a, b) => b.gain - a.gain);
  const dn = c => (c.daynight === 'D' ? 'daytime' : 'night-time');
  if (improved.length) {
    const {c, gain} = improved[0];
    out.push(`${c.platform} ${dn(c)} ×${c.slope.toFixed(2)} → ${model.reference}-equivalent: held-out RMSE −${gain.toFixed(1)}% ` +
      `(${c.before.rmse.toFixed(1)} → ${c.after.rmse.toFixed(1)}), bias ${signed(c.before.aggregate_bias_pct)} → ${signed(c.after.aggregate_bias_pct)}.`);
  }
  const modisDay = scored.filter(c => MODIS.includes(c.platform) && c.daynight === 'D');
  if (modisDay.length) {
    const mean = modisDay.reduce((s, c) => s + c.slope, 0) / modisDay.length;
    out.push(`One MODIS daytime active cell-day corresponds to about ${mean.toFixed(1)} ${model.reference} cell-days: ` +
      'the 375 m VIIRS pixels see small and cool fires that 1 km MODIS misses.');
  }
  const viirs = scored.filter(c => VIIRS.includes(c.platform));
  if (viirs.length) {
    const spread = Math.max(...viirs.map(c => Math.abs(1 - c.slope)));
    out.push(`VIIRS on ${[...new Set(viirs.map(c => c.platform))].join(' / ')} agrees with ${model.reference} within ${(100 * spread).toFixed(0)}% — ` +
      'the same instrument design keeps the record continuous across satellites.');
  }
  const failing = scored.filter(c => c.warnings.includes('large_residual_bias'));
  if (failing.length) {
    out.push(`Not hidden: ${failing.map(c => `${c.platform} ${dn(c)}`).join(', ')} keep${failing.length === 1 ? 's' : ''} a residual bias up to ` +
      `${signed(failing.map(c => c.after.aggregate_bias_pct).sort((a, b) => a - b)[0])}. A single scale factor cannot restore fires MODIS never detected.`);
  }
  return out;
}

/** FastAPI error body -> one readable line. */
export function errorText(detail) {
  if (detail == null) return '';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail.map(d => (d?.msg ? `${(d.loc || []).filter(x => x !== 'body').join('.')}: ${d.msg}`.replace(/^: /, '') : String(d))).join('; ');
  }
  return JSON.stringify(detail);
}

export function histogram(values, bins, max) {
  const out = Array(bins).fill(0);
  for (const v of values) out[Math.min(bins - 1, Math.max(0, Math.floor((v / max) * bins)))]++;
  return out;
}

export function spanYears(spans) {
  if (!spans?.length) return null;
  const start = spans.map(s => String(s.start).slice(0, 10)).sort()[0];
  const end = spans.map(s => String(s.end).slice(0, 10)).sort().at(-1);
  return {start, end};
}

/** Fraction of the year elapsed for a YYYY-MM-DD date; used to place coverage bars. */
export function yearFraction(date) {
  const d = new Date(String(date).slice(0, 10) + 'T00:00:00Z');
  const y = d.getUTCFullYear();
  return y + (d - Date.UTC(y, 0, 1)) / (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1));
}
