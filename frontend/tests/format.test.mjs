import assert from 'node:assert/strict';
import fs from 'node:fs';
import {uploadProblem, uploadingText, uploadSummary, annualTotals, bboxOf, calendarMatrix, defaultYear, errorText, featureToRow, histogram, insights, lastDay, monthRange, monthValue, platformsFor, yearsOf} from '../src/format.js';

// time windows (inclusive, leap years)
assert.deepEqual(monthRange('2024', '2'), {start: '2024-02-01', end: '2024-02-29'});
assert.deepEqual(monthRange('2025', 2), {start: '2025-02-01', end: '2025-02-28'});
assert.deepEqual(monthRange(2025, 'all'), {start: '2025-01-01', end: '2025-12-31'});
assert.equal(lastDay(2025, 12), 31);

// sensor family -> API platforms
assert.deepEqual(platformsFor('MODIS'), ['Terra', 'Aqua']);
assert.deepEqual(platformsFor('VIIRS'), ['SNPP', 'NOAA20', 'NOAA21']);
assert.deepEqual(platformsFor('All sensors'), []);

// backend feature -> map row
const row = featureToRow({type: 'Feature', id: 'x', geometry: {type: 'Point', coordinates: [123.4, 44.5]},
  properties: {observation_id: 'abc', platform: 'NOAA20', sensor: 'VIIRS', observed_at: '2025-03-01T05:07:00.000Z', frp_mw: 3.2, confidence_raw: 'n', confidence_class: 'nominal', daynight: 'D', scan_km: .39, track_km: .36}});
assert.equal(row.id, 'abc');
assert.equal(row.instrument, 'VIIRS');
assert.equal(row.satellite, 'NOAA20');
assert.equal(row.acq_date, '2025-03-01');
assert.equal(row.acq_time, '0507');
assert.equal(row.frp, 3.2);
assert.deepEqual([row.longitude, row.latitude], [123.4, 44.5]);
assert.equal(featureToRow({geometry: {coordinates: [1, 2]}, properties: {platform: 'Aqua'}}).instrument, 'MODIS');

// bbox of polygons and multipolygons
assert.deepEqual(bboxOf({features: [{geometry: {type: 'Polygon', coordinates: [[[100, 20], [110, 20], [110, 30], [100, 20]]]}}]}), [100, 20, 110, 30]);
assert.deepEqual(bboxOf({features: [{geometry: {type: 'MultiPolygon', coordinates: [[[[1, 2], [3, 2], [3, 5], [1, 2]]], [[[-4, 0], [0, 0], [0, 1], [-4, 0]]]]}}]}), [-4, 0, 3, 5]);
assert.equal(bboxOf({features: []}), null);
assert.equal(bboxOf(null), null);
const provinces = JSON.parse(fs.readFileSync(new URL('../public/data/ADM1.geojson', import.meta.url)));
const yunnan = bboxOf({features: provinces.features.filter(f => f.properties.shapeName.includes('Yunnan'))});
assert(yunnan[0] > 96 && yunnan[2] < 107 && yunnan[1] > 20 && yunnan[3] < 30, 'Yunnan bbox');

// year choice from file coverage
const overview = {years: {archive: [2000, 2026], NRT: [2026, 2026]}, coverage: {archive: [{start: '2000-11-01T00:00:00.000', end: '2026-08-31T00:00:00.000'}, {start: '2012-01-20', end: '2026-07-31'}], NRT: [{start: '2026-08-01', end: '2026-11-14'}]}};
assert.equal(defaultYear(overview), '2025');                 // 2026 is incomplete
assert.equal(defaultYear(overview, 'NRT'), '2026');
assert.equal(defaultYear({coverage: {archive: [{start: '2001-01-01', end: '2024-12-31'}]}}), '2024');
assert.equal(defaultYear({coverage: {archive: [{start: '2023-03-01', end: '2023-06-30'}]}}), '2023');  // only one year
assert.equal(defaultYear({coverage: {archive: []}}), null);
assert.deepEqual(yearsOf(overview).slice(0, 2), ['2026', '2025']);
assert.equal(yearsOf(overview).length, 27);
assert.deepEqual(yearsOf({years: {archive: null}}), []);

// timeline value: harmonized index, or raw detections of one family
const month = {harmonized_index: 12.5, detection_counts_by_platform: {Terra: 4, Aqua: 6, SNPP: 30, NOAA20: null}};
assert.deepEqual(monthValue(month), {value: 12.5, kind: 'index'});
assert.deepEqual(monthValue(month, 'MODIS'), {value: 10, kind: 'detections'});
assert.deepEqual(monthValue(month, 'VIIRS'), {value: 30, kind: 'detections'});
assert.deepEqual(monthValue({harmonized_index: null, detection_counts_by_platform: {SNPP: 7}}), {value: 7, kind: 'detections'});
assert.deepEqual(monthValue({harmonized_index: null, detection_counts_by_platform: {SNPP: null}}), {value: null, kind: 'detections'});
assert.deepEqual(monthValue(null), {value: null, kind: 'none'});

// the shipped full-China report drives the offline showcase: check it end to end
const report = JSON.parse(fs.readFileSync(new URL('../public/data/showcase/calendar.json', import.meta.url)));
const matrix = calendarMatrix(report.rows);
assert.equal(matrix.years[0], 2000);
assert.equal(matrix.years.at(-1), 2025);
assert.equal(matrix.cells[2000][0], null);                    // before Terra
assert.equal(matrix.cells[2000][10].selected_platform, 'Terra');
assert.equal(matrix.cells[2025][2].selected_platform, 'SNPP');
assert(matrix.max > 0);
const totals = annualTotals(report.rows);
assert.equal(totals[0].index, null);                          // 2000 has two months only
const y2005 = totals.find(t => t.year === 2005), y2020 = totals.find(t => t.year === 2020);
assert(y2005.index > 2 * y2005.raw, 'MODIS years are scaled up to the VIIRS scale');
assert.equal(y2020.index, y2020.raw);                         // reference sensor: factor 1
const model = JSON.parse(fs.readFileSync(new URL('../public/data/showcase/model.json', import.meta.url)));
const findings = insights(model);
assert.equal(findings.length, 4);
assert(findings[0].startsWith('Aqua daytime ×2.83') && findings[0].includes('−40.7%'), findings[0]);
assert(findings[3].includes('Aqua night-time') && findings[3].includes('−87.5%'), findings[3]);
assert(model.coefficients.every(c => !('support_regions' in c) && c.support_region_count > 0));
assert.deepEqual(insights(null), []);

// FastAPI error bodies
assert.equal(errorText('Model not found'), 'Model not found');
assert.equal(errorText([{loc: ['body', 'start'], msg: 'Input should be a valid date'}, {loc: ['body'], msg: 'Value error, bad'}]), 'start: Input should be a valid date; Value error, bad');
assert.equal(errorText(undefined), '');

assert.deepEqual(histogram([0, .1, .49, .5, 1, 5], 2, 1), [3, 3]);
// upload helpers: checks before sending, progress text, one-line result
const MB = 1048576;
assert.equal(uploadProblem({name: 'DL_FIRE_SV-C2_704513.zip', size: 5 * MB}), '');
assert.equal(uploadProblem({name: 'fire_archive.CSV', size: 10}), '');
assert.match(uploadProblem({name: 'fire.shp', size: 10}), /only FIRMS \.zip or \.csv/);
assert.match(uploadProblem({name: 'a.zip', size: 0}), /empty/);
assert.match(uploadProblem({name: 'a.zip', size: 300 * MB}), /300 MB is over the server limit of 256 MB/);
assert.equal(uploadProblem({name: 'a.zip', size: 300 * MB}, 512 * MB), '');
assert.equal(uploadingText(0, 0), 'Uploading…');
assert.equal(uploadingText(12 * MB, 28 * MB), 'Uploading… 42% (12 of 28 MB)');
assert.equal(uploadingText(1.5 * MB, 3 * MB), 'Uploading… 50% (1.5 of 3 MB)');
assert.match(uploadingText(28 * MB, 28 * MB), /Upload complete/);
assert.equal(uploadSummary([{name: 'a.zip', valid: 2982}]), 'a.zip: 2,982 detections imported. Re-calibrate the model in Harmonize → Validation.');
assert.equal(uploadSummary([{name: 'a.zip', valid: 0, already: true}]), 'a.zip was already imported.');
assert.match(uploadSummary([{name: 'a.zip', valid: 0}]), /holds no detections/);
assert.equal(uploadSummary([{name: 'a.zip', error: 'This ZIP holds a shapefile'}]), 'a.zip: This ZIP holds a shapefile');
assert.equal(uploadSummary([{name: 'a.zip', valid: 10}, {name: 'b.zip', valid: 5}, {name: 'c.zip', already: true, valid: 0}, {name: 'd.txt', error: 'only FIRMS .zip or .csv files are accepted'}]),
  '2 of 4 files imported · 15 detections. 1 already on the server. Re-calibrate the model in Harmonize → Validation. Refused — d.txt: only FIRMS .zip or .csv files are accepted');

console.log('PASS: time windows, platform filters, feature mapping, bboxes, year defaults, timeline values, showcase report, insights, API errors.');
