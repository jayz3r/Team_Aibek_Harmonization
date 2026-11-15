// MapLibre sources and layers for fire data: raw pixels, 10 km activity grid,
// fused cross-sensor events and MODIS–VIIRS co-observation links.
export const EMPTY = {type: 'FeatureCollection', features: []};
export const AGREEMENT_COLOR = {both: '#ff9a3d', modis_only: '#e6a488', viirs_only: '#f4ecd0'};
export const GRID_STOPS = [[1, '#5a3d42'], [3, '#96503f'], [8, '#d9713f'], [20, '#f6a54c'], [50, '#ffd98a'], [120, '#fff6d6']];

export const FIRE_LAYERS = {
  points: ['glow', 'dots'],
  heat: ['heat'],
  grid: ['grid-fill', 'grid-line'],
  events: ['events-halo', 'events-core'],
  links: ['links-line', 'links-ends'],
};

export function addFireLayers(m) {
  for (const id of ['fires', 'grid', 'events', 'links', 'link-ends']) m.addSource(id, {type: 'geojson', data: EMPTY});

  m.addLayer({id: 'grid-fill', type: 'fill', source: 'grid', layout: {visibility: 'none'}, paint: {
    'fill-color': ['interpolate', ['linear'], ['get', 'active_cell_days'], ...GRID_STOPS.flat()],
    'fill-opacity': ['interpolate', ['linear'], ['zoom'], 3, .82, 9, .5],
  }});
  m.addLayer({id: 'grid-line', type: 'line', source: 'grid', minzoom: 6, layout: {visibility: 'none'},
    paint: {'line-color': '#1b2a31', 'line-width': .6, 'line-opacity': .7}});

  m.addLayer({id: 'heat', type: 'heatmap', source: 'fires', layout: {visibility: 'none'}, paint: {
    'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 2, 10, 8, 28],
    'heatmap-opacity': .75,
    'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', .3, '#875151', .6, '#e79a78', 1, '#fff0c4'],
  }});
  m.addLayer({id: 'glow', type: 'circle', source: 'fires', paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 5, 8, 15],
    'circle-color': '#eeb197', 'circle-opacity': .12, 'circle-blur': .7,
  }});
  m.addLayer({id: 'dots', type: 'circle', source: 'fires', paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 2.2, 8, 5, 12, 7],
    'circle-color': ['match', ['get', 'instrument'], 'MODIS', '#f0a070', '#f4ecd0'],
    'circle-stroke-color': ['match', ['get', 'instrument'], 'MODIS', '#7a3f2a', '#8d8566'],
    'circle-stroke-width': .7, 'circle-opacity': .95,
  }});

  m.addLayer({id: 'links-line', type: 'line', source: 'links', layout: {visibility: 'none', 'line-cap': 'round'},
    paint: {'line-color': '#ffd98a', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1, 12, 3], 'line-opacity': .9}});
  m.addLayer({id: 'links-ends', type: 'circle', source: 'link-ends', layout: {visibility: 'none'}, paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.5, 12, 6],
    'circle-color': ['match', ['get', 'sensor'], 'MODIS', '#f0a070', '#f4ecd0'],
    'circle-stroke-color': '#ffd98a', 'circle-stroke-width': 1.2,
  }});

  m.addLayer({id: 'events-halo', type: 'circle', source: 'events', layout: {visibility: 'none'}, paint: {
    'circle-radius': ['interpolate', ['linear'], ['sqrt', ['get', 'detections']], 1, 9, 6, 22, 20, 44],
    'circle-color': ['match', ['get', 'agreement'], 'both', AGREEMENT_COLOR.both, 'modis_only', AGREEMENT_COLOR.modis_only, AGREEMENT_COLOR.viirs_only],
    'circle-opacity': .22, 'circle-blur': .5,
  }});
  m.addLayer({id: 'events-core', type: 'circle', source: 'events', layout: {visibility: 'none'}, paint: {
    'circle-radius': ['interpolate', ['linear'], ['sqrt', ['get', 'detections']], 1, 3.5, 6, 9, 20, 18],
    'circle-color': ['match', ['get', 'agreement'], 'both', AGREEMENT_COLOR.both, 'modis_only', AGREEMENT_COLOR.modis_only, AGREEMENT_COLOR.viirs_only],
    'circle-stroke-color': '#1b2a31', 'circle-stroke-width': 1, 'circle-opacity': .95,
  }});
}

export function setFireVisibility(m, visible) {
  for (const [group, ids] of Object.entries(FIRE_LAYERS)) {
    for (const id of ids) m.setLayoutProperty(id, 'visibility', visible[group] ? 'visible' : 'none');
  }
}

/** matches endpoint -> a line per candidate pair plus both pixel centres. */
export function linksGeoJSON(pairs) {
  const lines = [], ends = [];
  for (const pair of pairs || []) {
    if (!pair.modis_lonlat || !pair.viirs_lonlat) continue;
    const properties = {distance_km: pair.distance_km, time_delta_minutes: pair.time_delta_minutes};
    lines.push({type: 'Feature', properties, geometry: {type: 'LineString', coordinates: [pair.modis_lonlat, pair.viirs_lonlat]}});
    ends.push({type: 'Feature', properties: {...properties, sensor: 'MODIS'}, geometry: {type: 'Point', coordinates: pair.modis_lonlat}});
    ends.push({type: 'Feature', properties: {...properties, sensor: 'VIIRS'}, geometry: {type: 'Point', coordinates: pair.viirs_lonlat}});
  }
  return {lines: {type: 'FeatureCollection', features: lines}, ends: {type: 'FeatureCollection', features: ends}};
}

export const rowsGeoJSON = rows => ({
  type: 'FeatureCollection',
  features: rows.map(r => ({type: 'Feature', geometry: {type: 'Point', coordinates: [r.longitude, r.latitude]}, properties: r})),
});
