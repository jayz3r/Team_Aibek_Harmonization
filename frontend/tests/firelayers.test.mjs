import assert from 'node:assert/strict';
import {FIRE_LAYERS, addFireLayers, linksGeoJSON, rowsGeoJSON, setFireVisibility} from '../src/fireLayers.js';
import {addLandscape} from '../src/landscape.js';
import {addCityLayers} from '../src/cities.js';
import {validateStyleMin} from '@maplibre/maplibre-gl-style-spec';

const style = {version: 8, sources: {}, layers: [{id: 'base', type: 'background', paint: {'background-color': '#293840'}}]};
const map = {
  addSource(id, source) { assert(!style.sources[id], 'duplicate source ' + id); style.sources[id] = source; },
  addLayer(layer, before) { const i = style.layers.findIndex(x => x.id === before); if (i < 0) style.layers.push(layer); else style.layers.splice(i, 0, layer); },
  setLight(light) { style.light = light; },
  setLayoutProperty(id, name, value) { const layer = style.layers.find(l => l.id === id); assert(layer, 'unknown layer ' + id); (layer.layout ||= {})[name] = value; },
};
addLandscape(map); addCityLayers(map); addFireLayers(map);
assert.deepEqual(validateStyleMin(style).map(e => e.message), []);

const ids = style.layers.map(l => l.id);
for (const id of Object.values(FIRE_LAYERS).flat()) assert(ids.includes(id), id);
assert(ids.indexOf('grid-fill') < ids.indexOf('dots') && ids.indexOf('dots') < ids.indexOf('events-core'), 'grid below pixels below events');

setFireVisibility(map, {points: true, heat: false, grid: true, events: false, links: false});
const visible = id => style.layers.find(l => l.id === id).layout.visibility;
assert.equal(visible('dots'), 'visible'); assert.equal(visible('grid-fill'), 'visible');
assert.equal(visible('heat'), 'none'); assert.equal(visible('events-core'), 'none'); assert.equal(visible('links-line'), 'none');
assert.deepEqual(validateStyleMin(style).map(e => e.message), []);

const {lines, ends} = linksGeoJSON([{distance_km: .4, time_delta_minutes: 12, modis_lonlat: [100, 30], viirs_lonlat: [100.003, 30.001]}, {distance_km: 1}]);
assert.equal(lines.features.length, 1);                       // a pair without coordinates is skipped
assert.deepEqual(lines.features[0].geometry.coordinates, [[100, 30], [100.003, 30.001]]);
assert.deepEqual(ends.features.map(f => f.properties.sensor), ['MODIS', 'VIIRS']);
assert.deepEqual(rowsGeoJSON([{longitude: 1, latitude: 2, instrument: 'MODIS'}]).features[0].geometry.coordinates, [1, 2]);
console.log('PASS: fire layer style schema, layer order, visibility groups, link geometry.');
