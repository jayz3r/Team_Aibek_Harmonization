import Papa from 'papaparse';

export const regions = [
  {name: 'China', sub: 'Our first chapter', center: [104, 34], zoom: 3.5},
  {name: 'Yunnan', sub: 'Mountains & forests', center: [101.5, 25], zoom: 6},
  {name: 'Sichuan', sub: 'The western highlands', center: [102.5, 29.5], zoom: 6},
  {name: 'Heilongjiang', sub: 'The northern forests', center: [128, 48], zoom: 5},
  {name: 'Guangxi', sub: 'Southern landscapes', center: [108.3, 23.8], zoom: 6},
  {name: 'World', sub: 'A connected perspective', center: [25, 20], zoom: 1.5},
];
export const WORLD = regions[5];

// Synthetic points for the offline showcase only. They are NOT NASA measurements.
export const demo = Array.from({length: 720}, (_, i) => {
  const r = regions[1 + i % 4];
  return {
    id: `demo-${i}`,
    longitude: r.center[0] + Math.sin(i * 23.71) * 2.6,
    latitude: r.center[1] + Math.cos(i * 13.13) * 1.8,
    instrument: i % 3 === 0 ? 'MODIS' : 'VIIRS',
    acq_date: `2024-${String(1 + i % 12).padStart(2, '0')}-${String(1 + i % 28).padStart(2, '0')}`,
    acq_time: String(i * 37 % 2400).padStart(4, '0'),
    frp: Math.round((5 + (i * 17 % 130)) * 10) / 10,
    confidence: i % 3 === 0 ? String(40 + i % 60) : ['l', 'n', 'h'][i % 3],
    daynight: i % 2 ? 'N' : 'D',
    satellite: i % 3 === 0 ? 'Terra' : 'Suomi NPP',
    brightness: 310 + i % 80,
    region: r.name,
  };
});

const MODIS_NAMES = new Set(['T', 'A', 'TERRA', 'AQUA']);
const isDate = text => /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text)) && new Date(text).toISOString().slice(0, 10) === text;

/**
 * Sensor family of a FIRMS row. Some exports carry instrument=SNPP (a satellite name) or no
 * instrument at all, so the satellite and the VIIRS-only bright_ti4 column are checked too.
 */
export function instrumentOf(row) {
  const instrument = String(row.instrument || '').trim().toUpperCase();
  if (instrument === 'MODIS' || instrument === 'VIIRS') return instrument;
  const satellite = String(row.satellite || '').trim().toUpperCase();
  if (MODIS_NAMES.has(satellite)) return 'MODIS';
  if (satellite || instrument) return 'VIIRS';
  return row.bright_ti4 ? 'VIIRS' : 'MODIS';
}

/** Browser-only import (offline mode). Large archives belong on the backend. */
export function parseCSV(text) {
  const result = Papa.parse(text, {header: true, skipEmptyLines: 'greedy', transformHeader: h => h.trim().toLowerCase()});
  const fields = result.meta?.fields || [];
  if (!['latitude', 'longitude', 'acq_date'].every(k => fields.includes(k))) throw Error('Required columns: latitude, longitude, acq_date.');
  let rejected = 0;
  const rows = result.data.flatMap((r, i) => {
    const latitude = Number(r.latitude), longitude = Number(r.longitude);
    const date = String(r.acq_date || '').trim();
    if (!String(r.latitude ?? '').trim() || !String(r.longitude ?? '').trim() || !Number.isFinite(latitude) || !Number.isFinite(longitude)
      || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || !isDate(date)) {
      rejected++;
      return [];
    }
    const frp = r.frp != null && String(r.frp).trim() !== '' && Number.isFinite(Number(r.frp)) ? Number(r.frp) : null;
    return [{...r, id: `import-${i}`, latitude, longitude, acq_date: date, instrument: instrumentOf(r),
      daynight: String(r.daynight || '').trim().toUpperCase(), frp}];
  });
  if (!rows.length) throw Error('No valid observations found.');
  return {rows, rejected};
}
