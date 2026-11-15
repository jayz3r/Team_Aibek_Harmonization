import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import maplibregl from 'maplibre-gl';
import {Activity, ArrowUpRight, Flame, Globe2, Info, Layers, LocateFixed, Maximize2, Minus, Pause, Play, Plus, Search, Upload, X} from 'lucide-react';
import Papa from 'papaparse';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import './analytics.css';
import Analytics from './Analytics.jsx';
import DataPanel from './DataPanel.jsx';
import {FireAPI, saveBlob, windowQuery} from './api.js';
import {addCityLayers, cities, connectBuildings} from './cities.js';
import {demo, parseCSV, regions, WORLD} from './data.js';
import {AGREEMENT_COLOR, EMPTY, GRID_STOPS, addFireLayers, linksGeoJSON, rowsGeoJSON, setFireVisibility} from './fireLayers.js';
import {MONTHS, MONTHS_LONG, PLATFORMS, PLATFORM_COLOR, PLATFORM_LABEL, bboxOf, compact, defaultYear, featureToRow, flagLabel, fmt, monthRange, monthValue, platformsFor, yearsOf, uploadProblem, uploadingText, uploadSummary} from './format.js';
import {addLandscape, rectangle, regionShape} from './landscape.js';

const api = new FireAPI();
const PAGE = 10000, MAX_PAGES = 3, GRID_PAGE = 20000, GRID_PAGES = 2;
const PICK_LAYERS = ['events-core', 'dots', 'grid-fill', 'urban-buildings']; // top-most first
const NO_AGREEMENT = {key: '', loading: false, error: '', matches: null, events: null};
const NO_PIXELS = {rows: [], loading: false, truncated: false, error: ''};
const AGREEMENT_TEXT = {both: 'Seen by MODIS and VIIRS', modis_only: 'MODIS only', viirs_only: 'VIIRS only'};

const parseMaybe = value => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
};

export default function App() {
  const spot = useRef(), host = useRef(), map = useRef(), localFile = useRef(), serverFile = useRef();
  const drawing = useRef(false), anchor = useRef(null), urban = useRef(null), sequence = useRef(0), context = useRef('');

  // ---- scene -------------------------------------------------------------
  const [ready, setReady] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [entered, setEntered] = useState(false), [panel, setPanel] = useState(null), [tab, setTab] = useState('calendar');
  const [region, setRegion] = useState(regions[0]), [city, setCity] = useState(null), [search, setSearch] = useState('');
  const [spotlight, setSpotlight] = useState(false), [radius, setRadius] = useState(20), [sceneOpen, setSceneOpen] = useState(false);
  const [scale, setScale] = useState(''), [buildings, setBuildings] = useState(true), [orbit, setOrbit] = useState(false), [cityZoom, setCityZoom] = useState(false);
  const [basemap, setBasemap] = useState('atlas'), [relief, setRelief] = useState(true), [exaggeration, setExaggeration] = useState(1.5), [tilted, setTilted] = useState(true);
  const [highlight, setHighlight] = useState(true), [boundaries, setBoundaries] = useState(null);
  const [customArea, setCustomArea] = useState(null), [areaKind, setAreaKind] = useState(null), [drawMode, setDrawMode] = useState(false);
  const [building, setBuilding] = useState(null), [selected, setSelected] = useState(null);

  // ---- data --------------------------------------------------------------
  const [backend, setBackend] = useState({status: 'checking', overview: null, error: ''});
  const [rows, setRows] = useState(demo), [source, setSource] = useState('Demo observations');
  const [sensor, setSensor] = useState('All sensors'), [night, setNight] = useState('All'), [processing, setProcessing] = useState('archive'), [qualityOnly, setQualityOnly] = useState(true);
  const [year, setYear] = useState('2024'), [month, setMonth] = useState('all'), [playing, setPlaying] = useState(false);
  const [layers, setLayers] = useState({points: true, heat: false, grid: false, events: false, links: false});
  const [pixels, setPixels] = useState(NO_PIXELS), [yearCal, setYearCal] = useState(null);
  const [gridChoice, setGridChoice] = useState('auto'), [grid, setGrid] = useState({data: null, loading: false, truncated: false, error: ''});
  const [agreeParams, setAgreeParams] = useState({modis: 'Aqua', viirs: 'SNPP', distance: 1, minutes: 30, eventKm: 1.5, gapHours: 36});
  const [agreement, setAgreement] = useState(NO_AGREEMENT);
  const [busy, setBusy] = useState(null), [jobText, setJobText] = useState('');

  const live = backend.status === 'live', overview = backend.overview, model = overview?.latest_model || null;
  const revision = overview?.revision ?? -1;
  const daynight = night === 'All' ? 'both' : night;
  const setLayer = (name, on) => setLayers(old => ({...old, [name]: on}));

  // ---- backend connection ------------------------------------------------
  const connect = useCallback(async () => {
    try {
      await api.health();
      const next = await api.overview();
      setBackend({status: 'live', overview: next, error: ''});
      return next;
    } catch (e) {
      setBackend({status: 'offline', overview: null, error: e.message});
      return null;
    }
  }, []);
  const latest = useRef(backend);
  latest.current = backend;
  useEffect(() => {
    connect();
    const timer = setInterval(async () => {
      const now = latest.current;
      if (now.status !== 'live') { connect(); return; }
      try {
        const health = await api.health();
        if (health.revision !== now.overview.revision) connect();
      } catch { connect(); }
    }, 20000);
    return () => clearInterval(timer);
  }, [connect]);

  // ---- time window -------------------------------------------------------
  const localYears = useMemo(() => [...new Set(rows.map(r => r.acq_date.slice(0, 4)))].sort(), [rows]);
  const liveYears = useMemo(() => yearsOf(overview, processing), [overview, processing]);
  useEffect(() => {
    // Pick a sensible year whenever the data context changes (offline <-> live, archive <-> NRT).
    const key = live ? 'live:' + processing : 'offline';
    const options = live ? liveYears : localYears;
    if (live && !options.length) return; // nothing in this stream yet: decide once data arrives
    if (context.current !== key || (year !== 'all' && !options.includes(year)) || (live && year === 'all')) {
      context.current = key;
      setYear(live ? defaultYear(overview, processing) || options[0] : options.at(-1) || 'all');
      setMonth('all');
    }
  }, [live, processing, liveYears, localYears]); // eslint-disable-line react-hooks/exhaustive-deps
  const range = useMemo(() => (year === 'all' ? null : monthRange(year, month)), [year, month]);
  const monthChosen = month !== 'all';
  const windowLabel = `${monthChosen ? MONTHS_LONG[Number(month) - 1] : 'Full year'}${year === 'all' ? '' : ' ' + year}`;

  // ---- area of interest --------------------------------------------------
  const loadedRegion = useMemo(() => {
    const b = live ? overview?.bounds : null;
    return b ? {name: 'Loaded data', sub: 'Extent of the imported satellite files', center: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], zoom: 4, bounds: b} : null;
  }, [live, overview]);
  const regionList = useMemo(() => (loadedRegion ? [loadedRegion, ...regions] : regions), [loadedRegion]);
  const focusArea = useMemo(() => {
    if (customArea) return customArea;
    if (region.bounds) return rectangle({lng: region.bounds[0], lat: region.bounds[1]}, {lng: region.bounds[2], lat: region.bounds[3]}) || EMPTY;
    return boundaries ? regionShape(boundaries.country, boundaries.provinces, region.name) : EMPTY;
  }, [customArea, region, boundaries]);
  const bbox = useMemo(() => {
    if (customArea && areaKind === 'drawn') return bboxOf(customArea);
    if (city || region.bounds || ['China', 'World'].includes(region.name) || !boundaries) return null;
    return bboxOf(regionShape(boundaries.country, boundaries.provinces, region.name));
  }, [customArea, areaKind, city, region, boundaries]);
  const bboxKey = bbox ? bbox.join() : '';
  const aoiLabel = bbox ? `${areaKind === 'drawn' ? 'custom area' : region.name} (${bbox.map(v => v.toFixed(2)).join(', ')})` : 'all loaded data';

  // ---- offline rows ------------------------------------------------------
  const filtered = useMemo(() => rows.filter(r => (sensor === 'All sensors' || r.instrument === sensor) && (year === 'all' || r.acq_date.startsWith(year))
    && (month === 'all' || Number(r.acq_date.slice(5, 7)) === Number(month)) && (night === 'All' || r.daynight === night)), [rows, sensor, year, month, night]);
  const localCounts = useMemo(() => Array.from({length: 12}, (_, i) => rows.filter(r => (year === 'all' || r.acq_date.startsWith(year)) && Number(r.acq_date.slice(5, 7)) === i + 1
    && (sensor === 'All sensors' || r.instrument === sensor) && (night === 'All' || r.daynight === night)).length), [rows, year, sensor, night]);
  const shown = live ? pixels.rows : filtered;

  // ---- live pixels -------------------------------------------------------
  const wantPixels = layers.points || layers.heat;
  useEffect(() => {
    if (!live || !range || !wantPixels) { setPixels(NO_PIXELS); return undefined; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setPixels(old => ({...old, loading: true, error: ''}));
      try {
        const all = [];
        let offset = 0, more = false;
        for (let page = 0; page < MAX_PAGES; page++) {
          const out = await api.detections(windowQuery({...range, bbox, daynight, processing,
            extra: {platforms: platformsFor(sensor), quality_only: qualityOnly, limit: PAGE, offset}}), controller.signal);
          for (const feature of out.features) all.push(featureToRow(feature));
          more = out.meta.has_more;
          if (!more) break;
          offset = out.meta.next_offset;
        }
        setPixels({rows: all, loading: false, truncated: more, error: ''});
      } catch (e) {
        if (!controller.signal.aborted) setPixels({rows: [], loading: false, truncated: false, error: e.message});
      }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [live, revision, range, bboxKey, daynight, processing, sensor, qualityOnly, wantPixels]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- live calendar of the selected year (timeline + headline) ----------
  const modelId = model && !model.stale && processing === 'archive' ? model.id : null;
  useEffect(() => {
    if (!live || year === 'all' || !liveYears.includes(year)) { setYearCal(null); return undefined; }
    const controller = new AbortController();
    (async () => {
      const query = extra => windowQuery({start: `${year}-01-01`, end: `${year}-12-31`, bbox, daynight, processing, extra});
      try {
        let out;
        try {
          out = await api.calendar(query({allow_extrapolation: true, ...(modelId ? {model_id: modelId} : {})}), controller.signal);
        } catch (e) {
          // e.g. the area lies outside the calibrated area: fall back to raw counts.
          if (!modelId || e.status !== 422) throw e;
          out = await api.calendar(query({}), controller.signal);
        }
        if (!controller.signal.aborted) setYearCal(out);
      } catch { if (!controller.signal.aborted) setYearCal(null); }
    })();
    return () => controller.abort();
  }, [live, revision, year, liveYears, bboxKey, daynight, processing, modelId]); // eslint-disable-line react-hooks/exhaustive-deps

  const bars = useMemo(() => {
    if (!live) return localCounts.map(value => ({value, kind: 'detections', row: null}));
    const byMonth = Array(12).fill(null);
    for (const row of yearCal?.rows || []) byMonth[Number(row.month.slice(5, 7)) - 1] = row;
    return byMonth.map(row => ({...monthValue(row, sensor), row}));
  }, [live, localCounts, yearCal, sensor]);
  const barMax = Math.max(1, ...bars.map(b => b.value || 0));
  const headline = useMemo(() => {
    if (!live) return {value: filtered.length, kind: 'local'};
    const used = monthChosen ? [bars[Number(month) - 1]] : bars;
    const known = used.filter(b => b && b.value != null);
    return {value: known.length ? known.reduce((s, b) => s + b.value, 0) : null, kind: known[0]?.kind || 'none', partial: known.length < used.length};
  }, [live, filtered.length, bars, month, monthChosen]);

  // ---- 10 km activity grid -----------------------------------------------
  const autoPlatform = useMemo(() => {
    const picked = (monthChosen ? [bars[Number(month) - 1]?.row] : bars.map(b => b.row)).map(r => r?.selected_platform).filter(Boolean);
    if (picked.length) return [...picked].sort((a, b) => picked.filter(p => p === b).length - picked.filter(p => p === a).length)[0];
    const available = (overview?.coverage?.[processing] || []).map(s => s.platform);
    return ['SNPP', 'NOAA20', 'NOAA21', 'Aqua', 'Terra'].find(p => available.includes(p)) || 'SNPP';
  }, [bars, month, monthChosen, overview, processing]);
  const gridPlatform = gridChoice === 'auto' ? autoPlatform : gridChoice;
  useEffect(() => {
    if (!live || !range || !layers.grid) { setGrid({data: null, loading: false, truncated: false, error: ''}); return undefined; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setGrid(old => ({...old, loading: true, error: ''}));
      try {
        const features = [];
        let offset = 0, more = false;
        for (let page = 0; page < GRID_PAGES; page++) {
          const out = await api.grid(windowQuery({...range, bbox, daynight, processing, extra: {platform: gridPlatform, limit: GRID_PAGE, offset}}), controller.signal);
          features.push(...out.features);
          more = out.meta.has_more;
          if (!more) break;
          offset = out.meta.next_offset;
        }
        setGrid({data: {type: 'FeatureCollection', features}, loading: false, truncated: more, error: ''});
      } catch (e) {
        if (!controller.signal.aborted) setGrid({data: null, loading: false, truncated: false, error: e.message});
      }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [live, revision, range, bboxKey, daynight, processing, gridPlatform, layers.grid]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- sensor agreement: pixel links and fused events (one month at most) -
  const windowKey = live && range && monthChosen ? [range.start, range.end, bboxKey, processing, qualityOnly, revision].join('|') : '';
  useEffect(() => { setAgreement(old => (old.key === windowKey ? old : NO_AGREEMENT)); }, [windowKey]);
  async function runAgreement(params, want = {matches: true, events: true}) {
    if (!windowKey) return;
    const run = ++sequence.current;
    setAgreeParams(params);
    setAgreement(old => ({...(old.key === windowKey ? old : NO_AGREEMENT), key: windowKey, loading: true, error: ''}));
    const base = {...range, bbox, daynight: 'both', processing};
    try {
      const [matches, events] = await Promise.all([
        want.matches ? api.matches(windowQuery({...base, extra: {modis_platform: params.modis, viirs_platform: params.viirs, distance_km: params.distance, time_minutes: params.minutes, max_pairs: 20000}})) : null,
        want.events ? api.events(windowQuery({...base, extra: {distance_km: params.eventKm, gap_hours: params.gapHours, quality_only: qualityOnly, limit: 3000}})) : null,
      ]);
      if (run !== sequence.current) return;
      setAgreement(old => ({key: windowKey, loading: false, error: '', matches: matches || old.matches, events: events || old.events}));
    } catch (e) {
      if (run !== sequence.current) return;
      setAgreement(old => ({...old, key: windowKey, loading: false, error: e.message}));
      if (!want.matches) { setLayer('events', false); setNotice(e.message); }
    }
  }
  useEffect(() => {
    if (!live || !layers.events || !windowKey) return undefined;
    if (agreement.key === windowKey && (agreement.events || agreement.loading || agreement.error)) return undefined;
    const timer = setTimeout(() => runAgreement(agreeParams, {matches: false, events: true}), 350);
    return () => clearTimeout(timer);
  }, [live, layers.events, windowKey, agreement.key, agreement.events, agreement.loading, agreement.error]); // eslint-disable-line react-hooks/exhaustive-deps
  function toggleEvents() {
    if (layers.events) { setLayer('events', false); return; }
    if (!monthChosen) {
      const peak = bars.reduce((best, b, i) => ((b.value || 0) > (bars[best].value || 0) ? i : best), 0);
      setMonth(String(peak + 1));
      setPlaying(false);
      setNotice(`Events are fused one month at a time. Showing ${MONTHS_LONG[peak]} ${year}, the most active month.`);
    }
    setLayer('events', true);
  }

  // ---- map ---------------------------------------------------------------
  useEffect(() => {
    let m;
    try {
      m = new maplibregl.Map({container: host.current, style: {version: 8, sources: {}, layers: [{id: 'base', type: 'background', paint: {'background-color': '#293840'}}]},
        center: [104, 34], zoom: 3.5, pitch: 45, bearing: -12, maxPitch: 75});
    } catch {
      setError('3D maps require WebGL. Open in a browser with hardware acceleration enabled.');
      return undefined;
    }
    map.current = m;
    m.on('moveend', () => {
      const canvas = m.getCanvas();
      try {
        const a = m.unproject([canvas.clientWidth / 2 - 40, canvas.clientHeight / 2]), b = m.unproject([canvas.clientWidth / 2 + 40, canvas.clientHeight / 2]);
        const measured = a.distanceTo(b);
        const distance = measured > 1 ? measured : 80 * 40075016.686 * Math.cos(m.getCenter().lat * Math.PI / 180) / (512 * 2 ** m.getZoom());
        setScale(Number.isFinite(distance) ? (distance >= 1000 ? '≈ ' + (distance / 1000).toFixed(1) + ' km' : '≈ ' + Math.round(distance) + ' m') : '');
      } catch { setScale(''); }
    });
    m.on('load', () => {
      addLandscape(m);
      addCityLayers(m);
      urban.current = connectBuildings(m);
      addFireLayers(m);
      setReady(true);
    });
    m.on('zoomend', () => setCityZoom(m.getZoom() >= 14));
    m.on('dragstart', () => setOrbit(false));
    m.on('rotatestart', e => { if (e.originalEvent) setOrbit(false); });
    for (const id of ['dots', 'events-core', 'grid-fill']) {
      m.on('mouseenter', id, () => { if (!drawing.current) m.getCanvas().style.cursor = 'pointer'; });
      m.on('mouseleave', id, () => { if (!drawing.current) m.getCanvas().style.cursor = ''; });
    }
    m.on('click', e => {
      if (drawing.current) {
        if (!anchor.current) { anchor.current = e.lngLat; setNotice('Click the opposite corner of your area.'); return; }
        const area = rectangle(anchor.current, e.lngLat);
        if (!area) { setNotice('Choose a larger area, less than half the globe wide.'); return; }
        setCustomArea(area); setAreaKind('drawn'); setCity(null); setHighlight(true); setDrawMode(false);
        drawing.current = false; anchor.current = null;
        m.getCanvas().style.cursor = ''; m.doubleClickZoom.enable();
        setNotice('Custom area selected: map, calendar and analytics now use it. It is an area of interest, not a fire perimeter.');
        return;
      }
      if (!m.getLayer('dots')) return;
      const hits = m.queryRenderedFeatures(e.point, {layers: PICK_LAYERS});
      const hit = PICK_LAYERS.map(id => hits.find(f => f.layer.id === id)).find(Boolean);
      if (!hit) return;
      const p = hit.properties;
      if (hit.layer.id === 'urban-buildings') { setSelected(null); setBuilding(p); return; }
      setBuilding(null); setOrbit(false);
      if (hit.layer.id === 'dots') {
        setSelected({kind: 'pixel', ...p});
        m.flyTo({center: [Number(p.longitude), Number(p.latitude)], zoom: Math.max(m.getZoom(), 7), pitch: 50, duration: 1700});
      } else if (hit.layer.id === 'events-core') {
        setSelected({kind: 'event', ...p, lngLat: hit.geometry.coordinates});
      } else setSelected({kind: 'cell', ...p});
    });
    m.on('mousemove', e => {
      if (drawing.current && anchor.current) {
        const area = rectangle(anchor.current, e.lngLat);
        if (area) m.getSource('focus-area')?.setData(area);
      }
    });
    m.on('error', e => setError(e.sourceId?.includes('dem') ? 'Elevation tiles unavailable. Try turning off Relief.' : 'Some map tiles could not load. Check your connection.'));
    return () => { urban.current?.destroy(); m.remove(); };
  }, []);

  useEffect(() => {
    if (!ready) return undefined;
    const canvas = map.current.getCanvas(), light = spot.current;
    let frame = 0;
    const hide = () => { light.style.opacity = '0'; };
    const move = e => {
      if (!spotlight || !entered || panel || drawMode || e.pointerType === 'touch') { hide(); return; }
      const bounds = canvas.getBoundingClientRect();
      const x = e.clientX - bounds.left, y = e.clientY - bounds.top;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { light.style.transform = `translate3d(${x - radius}px,${y - radius}px,0)`; light.style.opacity = '1'; });
    };
    canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerleave', hide); window.addEventListener('blur', hide);
    hide();
    return () => { cancelAnimationFrame(frame); hide(); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerleave', hide); window.removeEventListener('blur', hide); };
  }, [ready, spotlight, radius, entered, panel, drawMode]);

  useEffect(() => {
    const abort = new AbortController();
    Promise.all(['ADM0', 'ADM1'].map(level => fetch(`${import.meta.env.BASE_URL}data/${level}.geojson`, {signal: abort.signal}).then(r => { if (!r.ok) throw Error('boundary'); return r.json(); })))
      .then(([country, provinces]) => setBoundaries({country, provinces}))
      .catch(e => { if (e.name !== 'AbortError') setNotice('Region boundaries unavailable. You can still draw a custom area.'); });
    return () => abort.abort();
  }, []);

  useEffect(() => {
    if (!ready) return;
    const m = map.current;
    m.setLayoutProperty('base', 'visibility', basemap === 'atlas' ? 'visible' : 'none');
    m.setLayoutProperty('satellite', 'visibility', basemap === 'satellite' ? 'visible' : 'none');
    for (const id of ['urban-land', 'urban-water', 'water-edge', 'urban-rivers']) m.setLayoutProperty(id, 'visibility', basemap === 'atlas' ? 'visible' : 'none');
  }, [ready, basemap]);
  useEffect(() => { if (ready) map.current.setTerrain(relief ? {source: 'terrain-dem', exaggeration} : null); }, [ready, relief, exaggeration]);
  useEffect(() => {
    if (!ready) return;
    const area = highlight && !spotlight ? focusArea : EMPTY;
    map.current.getSource('focus-area').setData(area);
    urban.current?.setFocus(area);
  }, [ready, focusArea, highlight, drawMode, spotlight]);
  useEffect(() => { if (ready) map.current.setLayoutProperty('urban-buildings', 'visibility', buildings ? 'visible' : 'none'); }, [ready, buildings]);
  useEffect(() => {
    if (!ready || !orbit) return undefined;
    const m = map.current;
    m.stop();
    const center = m.getCenter(), zoom = m.getZoom(), pitch = m.getPitch();
    let frame, last = 0, bearing = m.getBearing();
    const spin = t => { if (last) { bearing += (t - last) * .003; m.jumpTo({center, zoom, pitch, bearing}); } last = t; frame = requestAnimationFrame(spin); };
    frame = requestAnimationFrame(spin);
    return () => cancelAnimationFrame(frame);
  }, [ready, orbit]);
  useEffect(() => {
    if (!ready) return undefined;
    const markers = cities.map((c, i) => {
      const el = document.createElement('button');
      el.className = 'city-pin';
      el.setAttribute('aria-label', 'Explore ' + c.name);
      el.textContent = String(i + 1).padStart(2, '0');
      el.addEventListener('click', () => visitCity(c));
      return new maplibregl.Marker({element: el}).setLngLat(c.center).addTo(map.current);
    });
    return () => markers.forEach(marker => marker.remove());
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- fire data -> map --------------------------------------------------
  useEffect(() => { if (ready) { map.current.getSource('fires').setData(rowsGeoJSON(shown)); setSelected(s => (s?.kind === 'pixel' ? null : s)); } }, [ready, shown]);
  useEffect(() => { if (ready) map.current.getSource('grid').setData(layers.grid && grid.data ? grid.data : EMPTY); }, [ready, layers.grid, grid.data]);
  useEffect(() => { if (ready) map.current.getSource('events').setData(layers.events && agreement.events ? agreement.events : EMPTY); }, [ready, layers.events, agreement.events]);
  useEffect(() => {
    if (!ready) return;
    const data = layers.links && agreement.matches ? linksGeoJSON(agreement.matches.pairs) : {lines: EMPTY, ends: EMPTY};
    map.current.getSource('links').setData(data.lines);
    map.current.getSource('link-ends').setData(data.ends);
  }, [ready, layers.links, agreement.matches]);
  useEffect(() => { if (ready) setFireVisibility(map.current, {...layers, grid: layers.grid && live, events: layers.events && live, links: layers.links && live}); }, [ready, layers, live]);

  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => setMonth(m => (m === 'all' || Number(m) === 12 ? '1' : String(Number(m) + 1))), live ? 2200 : 1300);
    return () => clearInterval(timer);
  }, [playing, live]);
  useEffect(() => {
    const listener = e => { if (e.key === 'Escape') { cancelDrawing(); setPanel(null); setSelected(null); setBuilding(null); setOrbit(false); } };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- navigation --------------------------------------------------------
  function cancelDrawing() {
    drawing.current = false; anchor.current = null; setDrawMode(false);
    if (map.current) { map.current.getCanvas().style.cursor = ''; map.current.doubleClickZoom.enable(); }
  }
  function startDrawing() {
    setSpotlight(false); setOrbit(false);
    if (drawMode) { cancelDrawing(); return; }
    setSelected(null); setHighlight(true); setDrawMode(true);
    drawing.current = true; anchor.current = null;
    map.current.getCanvas().style.cursor = 'crosshair'; map.current.doubleClickZoom.disable();
    setNotice('Click two opposite corners on the map. Escape cancels.');
  }
  function visitCity(c) {
    cancelDrawing(); setCity(c); setBuilding(null); setSelected(null); setRegion({...c});
    setCustomArea(rectangle({lng: c.center[0] - .018, lat: c.center[1] - .013}, {lng: c.center[0] + .018, lat: c.center[1] + .013})); setAreaKind('city');
    setHighlight(true); setBuildings(true); setTilted(true); setEntered(true); setPanel(null); setOrbit(false);
    map.current?.flyTo({center: c.center, zoom: c.zoom, pitch: 55, bearing: c.bearing, duration: 3000});
  }
  function fly(r) {
    setCity(null); setBuilding(null); setOrbit(false); cancelDrawing(); setCustomArea(null); setAreaKind(null); setRegion(r); setPanel(null); setSelected(null);
    const view = {pitch: tilted ? 55 : 0, bearing: tilted ? -12 : 0, duration: 2000};
    if (r.bounds) map.current?.fitBounds([[r.bounds[0], r.bounds[1]], [r.bounds[2], r.bounds[3]]], {...view, padding: 110, maxZoom: 8.5});
    else map.current?.flyTo({...view, center: r.center, zoom: r.zoom});
  }
  function boundsRegion(next) {
    const b = next?.bounds;
    return b ? {name: 'Loaded data', sub: 'Extent of the imported satellite files', center: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], zoom: 4, bounds: b} : null;
  }
  function enter() { setEntered(true); fly(loadedRegion || regions[0]); }
  function openLab(which = 'calendar') { setTab(which); setPanel('analytics'); }
  function pickMonth(row) {
    const [y, m] = row.month.split('-');
    if (!liveYears.includes(y)) return;
    setYear(y); setMonth(String(Number(m))); setPlaying(false); setEntered(true);
    setNotice(`${MONTHS_LONG[Number(m) - 1]} ${y} is now on the map.`);
  }

  // ---- data actions ------------------------------------------------------
  async function job(kind, start, describe) {
    setBusy(kind); setJobText('Queued…');
    try {
      const {job_id: id} = await start();
      const result = await api.waitForJob(id, {onProgress: j => setJobText(describe(j))});
      const next = await connect();
      return {result, next};
    } catch (e) {
      setNotice(e.message);
      return null;
    } finally { setBusy(null); setJobText(''); }
  }
  const importing = j => (j.status === 'queued' ? 'Queued…' : j.result?.input_rows ? `Importing… ${fmt(j.result.input_rows)} rows read` : 'Importing…');
  // One or several FIRMS files (the four products come as four ZIPs): checked in the browser, sent one by one.
  async function uploadToServer(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    const limit = overview?.limits?.max_upload_bytes || 256 * 1048576;
    const results = [];
    let imported = false;
    setBusy('upload');
    try {
      for (const [i, file] of files.entries()) {
        const label = files.length > 1 ? `File ${i + 1} of ${files.length} · ${file.name} · ` : '';
        const problem = uploadProblem(file, limit);
        if (problem) { results.push({name: file.name, error: problem}); continue; }
        try {
          setJobText(label + 'Uploading…');
          const {job_id: id} = await api.upload(file, {onProgress: (sent, total) => setJobText(label + uploadingText(sent, total))});
          const result = await api.waitForJob(id, {onProgress: j => setJobText(label + importing(j))});
          const valid = (result.members || []).reduce((s, m) => s + (m.valid_rows || 0), 0);
          results.push({name: file.name, valid, already: !!result.already_imported});
          imported = imported || (!result.already_imported && valid > 0);
        } catch (error) {
          results.push({name: file.name, error: error.message});
        }
      }
      const next = results.some(r => !r.error) ? await connect() : null;
      setNotice(uploadSummary(results));
      const target = imported ? boundsRegion(next) : null;
      if (target) { setEntered(true); fly(target); }
    } finally { setBusy(null); setJobText(''); }
  }
  async function loadDemo() {
    const done = await job('demo', () => api.loadDemo(), j => (j.result?.input_rows ? `Importing… ${fmt(j.result.input_rows)} rows read` : 'Importing the sample and fitting the model…'));
    if (!done) return;
    setNotice('Real sample loaded (north-east China, 2001–2026) and a model fitted on it.');
    const target = boundsRegion(done.next);
    if (target) { setEntered(true); fly(target); }
  }
  async function importFirms(body) {
    const done = await job('firms', () => api.importFirms(body), importing);
    if (!done) return;
    const valid = (done.result.members || []).reduce((s, m) => s + (m.valid_rows || 0), 0);
    setNotice(done.result.already_imported ? 'FIRMS returned data that is already imported.' : `${fmt(valid)} detections imported from NASA FIRMS.`);
    if (body.source.endsWith('_NRT') && valid) setProcessing('NRT');
  }
  async function calibrate() {
    const done = await job('calibrate', () => api.calibrate({}), () => 'Fitting the model on overlapping years…');
    if (done) setNotice(`Model fitted: ${done.result.coefficients.length} sensor/day-night coefficients, tested on ${done.result.config.test_year}.`);
  }
  async function importLocal(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = parseCSV(await file.text());
      setCity(null); setBuilding(null); setOrbit(false); setCustomArea(null); setAreaKind(null); setRegion(WORLD);
      setRows(parsed.rows); setSource(file.name); setYear(parsed.rows.map(r => r.acq_date.slice(0, 4)).sort().at(-1)); setMonth('all');
      setPlaying(false); setSensor('All sensors'); setNight('All'); setPanel(null);
      setNotice(`${parsed.rows.length.toLocaleString()} observations loaded. ${parsed.rejected} invalid rows skipped.`);
      const bounds = new maplibregl.LngLatBounds();
      parsed.rows.forEach(r => bounds.extend([r.longitude, r.latitude]));
      map.current?.fitBounds(bounds, {padding: 90, maxZoom: 8, duration: 1800});
    } catch (err) { setNotice(err.message); }
    e.target.value = '';
  }
  function restoreDemo() {
    setRows(demo); setSource('Demo observations'); setYear('2024'); setMonth('all'); setSensor('All sensors'); setNight('All'); setPlaying(false); setPanel(null);
    fly(regions[0]);
  }
  async function download() {
    try {
      if (!live) { saveBlob(new Blob([Papa.unparse(filtered)], {type: 'text/csv'}), 'firebridge-observations.csv'); return; }
      if (!range) return;
      const query = windowQuery({...range, bbox, daynight, processing, extra: {platforms: platformsFor(sensor), quality_only: qualityOnly, limit: PAGE, offset: 0}});
      saveBlob(await api.csv('/exports/detections.csv', query), `firebridge-detections-${range.start}_${range.end}.csv`);
      if (pixels.truncated) setNotice('Exported the first 10,000 detections of this view. Narrow the area or month for a complete file.');
    } catch (e) { setNotice(e.message); }
  }

  const loading = pixels.loading || grid.loading || agreement.loading;
  const ctx = {api, backend, live, overview, model, bbox, aoiLabel, busy, jobText, connect: (base, key) => { api.configure(base, key); setBackend(b => ({...b, status: 'checking'})); connect(); },
    notify: setNotice, calibrate, loadDemo, importFirms, download, restoreDemo, pickServerFile: () => serverFile.current.click(), pickLocalFile: () => localFile.current.click(),
    night, setNight, processing, setProcessing, qualityOnly, setQualityOnly, localCount: rows.length,
    selectedMonth: range && monthChosen ? range.start.slice(0, 7) : null, onPickMonth: pickMonth, defaultYear: year,
    agreement, runAgreement, layers, setLayer, windowLabel, monthChosen};
  const matches = text => text.toLowerCase().includes(search.toLowerCase());

  return <div className={'app ' + (!entered ? 'intro-mode' : '')}>
    <div className="map-stage"><div ref={host} className="map-canvas"/><div ref={spot} className="cursor-light" aria-hidden="true" style={{width: radius * 2, height: radius * 2}}/></div><div className="map-shade"/>
    <header>
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setOrbit(false); setEntered(false); }}><span className="brand-symbol">◈</span> FIREBRIDGE<span className="brand-sub">EARTH OBSERVATORY</span></a>
      <div className="header-right">
        <button className={'data-tag ' + backend.status} onClick={() => setPanel('data')} aria-label="Data and connection"><i/>{live ? `LIVE API · REV ${overview.revision}` : backend.status === 'checking' ? 'CONNECTING…' : source === 'Demo observations' ? 'OFFLINE SHOWCASE' : 'IMPORTED DATA'}</button>
        <button className="lab" onClick={() => openLab()}><Activity size={15}/> Harmonize</button>
        <button className="icon" aria-label="About FireBridge" onClick={() => setPanel('about')}><Info size={19}/></button>
        <button className="menu" onClick={() => setPanel('regions')}>Explore <span>☰</span></button>
      </div>
    </header>

    {!entered ? <section className="intro">
      <p className="eyebrow">MODIS × VIIRS · ONE HARMONIZED FIRE RECORD</p>
      <h1>A world on fire.<br/><em>A clearer picture.</em></h1>
      <p className="intro-copy">Two generations of satellites see the same fires differently.<br/>FireBridge puts them on one scale — starting with China.</p>
      <div className="intro-actions"><button className="enter" onClick={enter}>Explore the atlas <ArrowUpRight size={23}/></button><button className="text-button" onClick={() => openLab()}>Open the harmonization lab <ArrowUpRight size={16}/></button></div>
      <div className="intro-bottom"><span>01 — CHINA, AND BEYOND</span><span>{live ? `${compact(overview.detections.archive + overview.detections.NRT)} DETECTIONS ON THE SERVER` : 'MODIS × VIIRS'}</span></div>
    </section> : <>
      <section className="location"><p className="eyebrow">THE FIRE ATLAS / {city ? 'CITY EXPLORER' : region.name === 'World' ? 'GLOBAL VIEW' : region.bounds ? 'YOUR DATA' : 'CHINA CHAPTER'}</p><h1>{region.name}<span>.</span></h1><button className="text-button" onClick={() => setPanel('regions')}>All places <ArrowUpRight size={16}/></button></section>

      <section className="observations">
        <span className="eyebrow">{headline.kind === 'index' ? 'HARMONIZED ACTIVITY INDEX' : headline.kind === 'local' ? 'FILTERED OBSERVATIONS' : 'SATELLITE DETECTIONS'}</span>
        <strong>{headline.value == null ? '—' : fmt(headline.value)}</strong>
        <span>{windowLabel}{year === 'all' ? ' · All years' : ''}</span>
        {headline.kind === 'index' && <small>{yearCal?.meta?.reference || 'SNPP'}-equivalent 10 km cell-days{headline.partial ? ' · some months unavailable' : ''}</small>}
        {headline.kind === 'detections' && <small>Detected pixels{model ? '' : ' · not calibrated yet'} · not individual fires</small>}
        {headline.kind === 'local' && <small>Across loaded data · not individual fires</small>}
        {headline.kind === 'none' && live && <small>{liveYears.length ? 'No data for this window' : overview.datasets.ready ? 'No data in this stream' : 'No data on the server yet'}</small>}
        {live && wantPixels && <small className="on-map">{loading ? 'Loading…' : `${fmt(pixels.rows.length)}${pixels.truncated ? '+' : ''} pixels on the map`}</small>}
        {live && wantPixels && pixels.truncated && !loading && <small className="on-map">First 30,000 shown — narrow the area or month, or use the 10 km grid</small>}
        {live && (pixels.error || grid.error) && <small className="warn">{pixels.error || grid.error}</small>}
        {live && !liveYears.length && <button className="text-button" onClick={() => setPanel('data')}>Add data <ArrowUpRight size={14}/></button>}
      </section>

      <nav className="map-tools" aria-label="Map controls">
        <button aria-label="Zoom in" onClick={() => map.current?.zoomIn()}><Plus/></button>
        <button aria-label="Zoom out" onClick={() => map.current?.zoomOut()}><Minus/></button>
        <button aria-label="Center map" onClick={() => (city ? visitCity(city) : fly(region))}><LocateFixed/></button>
        <button aria-label="Toggle map tilt" aria-pressed={tilted} onClick={() => { setTilted(!tilted); map.current?.easeTo({pitch: tilted ? 0 : 45, bearing: tilted ? 0 : -12}); }}>{tilted ? '3D' : '2D'}</button>
        <button aria-label="Switch to world" onClick={() => fly(WORLD)}><Globe2/></button>
        <button aria-label="Fullscreen" onClick={() => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => setNotice('Fullscreen is unavailable in this browser.')); }}><Maximize2 size={17}/></button>
      </nav>

      {city && <div className="city-navigation"><button aria-label="Previous city" onClick={() => visitCity(cities[(cities.indexOf(city) + cities.length - 1) % cities.length])}>←</button><span>{String(cities.indexOf(city) + 1).padStart(2, '0')} / {String(cities.length).padStart(2, '0')}<small>{city.sub}</small></span><button aria-label="Next city" onClick={() => visitCity(cities[(cities.indexOf(city) + 1) % cities.length])}>→</button></div>}

      <button className="scene-toggle" aria-expanded={sceneOpen} onClick={() => setSceneOpen(!sceneOpen)}>{sceneOpen ? 'Close scene settings ×' : 'Scene settings +'}</button>
      {sceneOpen && <div className="landscape-controls" aria-label="Landscape controls">
        <div><button aria-pressed={buildings} onClick={() => setBuildings(!buildings)}>3D buildings</button><button aria-pressed={orbit} disabled={!ready} onClick={() => setOrbit(!orbit)}>{orbit ? 'Stop orbit' : 'Orbit view'}</button><button onClick={() => setPanel('regions')}>All places</button></div>
        <div><button aria-pressed={basemap === 'atlas'} onClick={() => setBasemap('atlas')}>Atlas</button><button aria-pressed={basemap === 'satellite'} onClick={() => setBasemap('satellite')}>Satellite</button><button aria-pressed={relief} onClick={() => setRelief(!relief)}>Relief {relief ? 'on' : 'off'}</button></div>
        <div><button aria-pressed={spotlight} onClick={() => setSpotlight(!spotlight)}>Cursor light</button>{[10, 20, 80].map(r => <button key={r} aria-pressed={spotlight && radius === r} onClick={() => { setRadius(r); setSpotlight(true); }}>{r} px</button>)}</div>
        <div><button aria-pressed={highlight && !spotlight} onClick={() => { setSpotlight(false); setHighlight(spotlight ? true : !highlight); }}>Orange zone</button><button disabled={!ready} aria-pressed={drawMode} onClick={startDrawing}>{drawMode ? 'Cancel drawing' : 'Draw area'}</button>{customArea && <button onClick={() => { cancelDrawing(); if (city) visitCity(city); else { setCustomArea(null); setAreaKind(null); } }}>Reset area</button>}</div>
        {relief && <label>Height ×{exaggeration.toFixed(1)}<input aria-label="Terrain exaggeration" type="range" min="1" max="2.5" step=".1" value={exaggeration} onChange={e => setExaggeration(Number(e.target.value))}/></label>}
        <small>{buildings && !cityZoom ? 'ZOOM IN TO SEE BUILDINGS · ' : ''}{spotlight ? 'CURSOR LIGHT · RADIUS ' + radius + ' PX' : drawMode ? 'CLICK TWO CORNERS' : areaKind === 'drawn' ? 'CUSTOM AREA · USED BY ALL QUERIES' : region.name === 'World' ? 'DRAW AN AREA TO HIGHLIGHT' : region.name.toUpperCase() + ' · AREA OF INTEREST'}{basemap === 'satellite' ? ' · IMAGERY 2020' : ''}</small>
      </div>}

      {scale && <div className="ground-scale">{scale}</div>}

      {live && (layers.grid || layers.events) && <div className="map-legend">
        {layers.grid && <div><span className="eyebrow">10 KM ACTIVITY GRID</span>
          <i className="gradient" style={{background: `linear-gradient(90deg,${GRID_STOPS.map(s => s[1]).join(',')})`}}/>
          <span className="scale-ends"><b>1</b><b>{GRID_STOPS.at(-1)[0]}+ active day/night periods</b></span>
          <label>Satellite <select aria-label="Grid satellite" value={gridChoice} onChange={e => setGridChoice(e.target.value)}><option value="auto">Auto · {autoPlatform}</option>{PLATFORMS.map(p => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}</select></label>
          <small>{grid.loading ? 'Loading…' : grid.data ? `${fmt(grid.data.features.length)}${grid.truncated ? '+' : ''} occupied cells · ${gridPlatform} · not burned area` : ''}</small></div>}
        {layers.events && <div><span className="eyebrow">FUSED FIRE EVENTS</span>
          {Object.entries(AGREEMENT_TEXT).map(([k, text]) => <span key={k} className="key"><i style={{background: AGREEMENT_COLOR[k]}}/>{text}{agreement.events ? ` · ${fmt(agreement.events.summary.events_by_agreement[k])}` : ''}</span>)}
          <small>{agreement.loading ? 'Fusing pixels…' : agreement.events ? `${fmt(agreement.events.summary.events)} events from ${fmt(agreement.events.summary.detections)} pixels · size = pixels` : monthChosen ? '' : 'Pick a month'}</small>
          <button className="text-button" onClick={() => openLab('agreement')}>Sensor agreement <ArrowUpRight size={13}/></button></div>}
      </div>}

      <div className="layer-bar">
        {['All sensors', 'MODIS', 'VIIRS'].map(s => <button key={s} className={sensor === s ? 'active' : ''} onClick={() => setSensor(s)}>{s === 'All sensors' ? <Layers size={15}/> : <i className={s.toLowerCase()}/>} {s}</button>)}
        <span className="divider"/>
        <button aria-pressed={layers.points} className={layers.points ? 'active' : ''} onClick={() => setLayer('points', !layers.points)}>Pixels</button>
        <button aria-pressed={layers.heat} className={layers.heat ? 'active' : ''} onClick={() => setLayer('heat', !layers.heat)}>Density</button>
        {live && <button aria-pressed={layers.grid} className={layers.grid ? 'active' : ''} onClick={() => setLayer('grid', !layers.grid)}>Grid 10 km</button>}
        {live && <button aria-pressed={layers.events} className={layers.events ? 'active' : ''} onClick={toggleEvents}>Events</button>}
        <button aria-label="Data settings" onClick={() => setPanel('data')}><Upload size={16}/></button>
      </div>

      <section className="timeline">
        <div className="timeline-heading">
          <div><span className="eyebrow">{live ? 'BURNING ACTIVITY CALENDAR' : 'TIME EXPLORER'}</span><span className="time-title">{monthChosen ? MONTHS_LONG[Number(month) - 1] : 'Full year'} <b>{year === 'all' ? '' : year}</b></span></div>
          <div className="timeline-actions">
            <select aria-label="Year" value={year} onChange={e => setYear(e.target.value)}>{!live && <option value="all">All years</option>}{(live ? liveYears : localYears).map(y => <option key={y}>{y}</option>)}</select>
            <button onClick={() => { setMonth('all'); setPlaying(false); }}>Full year</button>
            {live && <button onClick={() => openLab('calendar')}>All years</button>}
            <button className="play" aria-label={playing ? 'Pause timeline' : 'Play timeline'} onClick={() => setPlaying(!playing)}>{playing ? <Pause size={16}/> : <Play size={16}/>}</button>
          </div>
        </div>
        <div className="months">{bars.map((b, i) => {
          const flags = b.row?.flags || [];
          const text = b.value == null ? 'no comparable value' : `${fmt(b.value)} ${b.kind === 'index' ? 'harmonized index' : 'detections'}`;
          return <button key={i} title={`${MONTHS_LONG[i]}: ${text}${b.row?.selected_platform ? ` · source ${b.row.selected_platform}` : ''}${flags.length ? '\n' + flags.map(flagLabel).join('\n') : ''}`}
            aria-label={`${MONTHS_LONG[i]}: ${text}`} aria-pressed={Number(month) === i + 1} onClick={() => { setMonth(String(i + 1)); setPlaying(false); }}>
            <span className={'bar' + (b.value == null ? ' empty' : '') + (flags.includes('validation_warning') ? ' flagged' : '')} style={{height: `${5 + 36 * (b.value || 0) / barMax}px`}}/>
            {live && <span className="src" style={{background: b.row?.selected_platform ? PLATFORM_COLOR[b.row.selected_platform] : 'transparent'}}/>}
            <span>{MONTHS[i]}</span>
          </button>;
        })}</div>
      </section>

      <footer><span>DRAG TO EXPLORE · SCROLL TO ZOOM · RIGHT-DRAG TO ROTATE</span><button onClick={() => setPanel('data')}>{live ? 'NASA FIRMS DATA · HARMONIZATION API' : source === 'Demo observations' ? 'SYNTHETIC DEMO DATA' : source} <ArrowUpRight size={12}/></button></footer>

      {building && <aside className="building-detail"><button className="close" aria-label="Close building" onClick={() => setBuilding(null)}><X/></button><p className="eyebrow">URBAN GEOMETRY</p><h2>{building.name || 'Building'}</h2><p>Rendered height: {Math.max(3, Number.isFinite(Number(building.render_height)) && building.render_height != null ? Number(building.render_height) : 9)} m</p><small>OSM / OpenFreeMap geometry. Heights may be inferred by the provider; missing values use 9 m. Not a surveyed 3D model.</small></aside>}

      {selected && <aside className="detail"><button className="close" aria-label="Close details" onClick={() => setSelected(null)}><X/></button>
        {selected.kind === 'pixel' && <><p className="eyebrow">SATELLITE OBSERVATION</p><Flame className="flame"/><h2>Thermal hotspot</h2><p>{selected.acq_date} · {selected.acq_time || '—'} UTC</p>
          <dl>{[['Sensor', selected.instrument], ['Satellite', selected.satellite || '—'], ['FRP', selected.frp != null && selected.frp !== '' ? `${selected.frp} MW` : 'Unavailable'],
            ['Confidence', [selected.confidence, selected.confidence_class].filter(Boolean).join(' · ') || '—'],
            ...(selected.scan_km != null && selected.scan_km !== '' ? [['Pixel footprint', `${Number(selected.scan_km).toFixed(2)} × ${Number(selected.track_km).toFixed(2)} km`]] : []),
            ...(selected.processing ? [['Stream', selected.processing]] : []),
            ['Coordinates', `${Number(selected.latitude).toFixed(4)}, ${Number(selected.longitude).toFixed(4)}`]].map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          <small>A thermal detection is not a confirmed wildfire. Several observations may belong to the same fire.</small></>}
        {selected.kind === 'cell' && <><p className="eyebrow">10 KM ACTIVITY CELL</p><h2>{fmt(selected.active_cell_days)} active period{Number(selected.active_cell_days) === 1 ? '' : 's'}</h2><p>{windowLabel} · {gridPlatform}</p>
          <dl>{[['Detected pixels', fmt(selected.detection_count)], ['Strongest FRP', selected.frp_max_mw != null ? `${Number(selected.frp_max_mw).toFixed(1)} MW` : 'Unavailable'], ['Cell', `${selected.gx} : ${selected.gy}`]].map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          <small>Occupied day/night periods of one satellite in an equal-area cell: the unit behind the harmonized index. It is not burned area.</small></>}
        {selected.kind === 'event' && <><p className="eyebrow">FUSED FIRE EVENT</p><Flame className="flame"/><h2>{AGREEMENT_TEXT[selected.agreement]}</h2><p>{String(selected.first_seen).replace('T', ' ').slice(0, 16)} → {String(selected.last_seen).replace('T', ' ').slice(0, 16)} UTC</p>
          <dl>{[['Detected pixels', `${fmt(selected.detections)} (MODIS ${selected.modis_detections} · VIIRS ${selected.viirs_detections})`],
            ['Satellites', Object.entries(parseMaybe(selected.detections_by_platform) || {}).map(([k, v]) => `${k} ${v}`).join(' · ')],
            ['Duration', `${Number(selected.duration_hours).toFixed(1)} h · ${selected.active_days} day${Number(selected.active_days) === 1 ? '' : 's'}`],
            ['Strongest FRP', selected.frp_max_mw != null ? `${Number(selected.frp_max_mw).toFixed(1)} MW` : 'Unavailable'],
            ['Centre', `${Number(selected.lngLat[1]).toFixed(4)}, ${Number(selected.lngLat[0]).toFixed(4)}`]].map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          <small>A space-time cluster of pixels from all satellites — not a confirmed, uniquely identified fire. FRP is never summed.</small></>}
      </aside>}
    </>}

    {panel && <div className="overlay" onClick={() => setPanel(null)}><section className={'panel ' + (panel === 'regions' ? 'region-panel' : panel === 'analytics' ? 'wide-panel' : panel === 'data' ? 'data-panel' : '')} role="dialog" aria-modal="true" aria-label={panel} onClick={e => e.stopPropagation()}>
      <button autoFocus className="close" aria-label="Close panel" onClick={() => setPanel(null)}><X/></button>
      <p className="eyebrow">FIREBRIDGE / {panel === 'analytics' ? 'HARMONIZATION LAB' : panel.toUpperCase()}</p>
      {panel === 'regions' && <><h2>Find your<br/><em>perspective.</em></h2><label className="search"><Search size={18}/><input placeholder="Search cities and regions" value={search} onChange={e => setSearch(e.target.value)}/></label>
        <p className="eyebrow">REGIONS / FIRE ATLAS</p><div className="region-list">{regionList.filter(r => matches(r.name)).map((r, i) => <button key={r.name} onClick={() => { setEntered(true); fly(r); }}><small>0{i + 1}</small><span>{r.name}<small>{r.sub}</small></span><ArrowUpRight/></button>)}</div>
        <p className="eyebrow">CITIES / 3D EXPLORATION</p><div className="region-list cities-list">{cities.filter(c => matches(c.name)).map((c, i) => <button key={c.name} onClick={() => visitCity(c)}><small>0{i + 1}</small><span>{c.name}<small>{c.sub}</small></span><ArrowUpRight/></button>)}{![...regionList, ...cities].some(r => matches(r.name)) && <p>No matching region.</p>}</div></>}
      {panel === 'data' && <DataPanel ctx={ctx}/>}
      {panel === 'analytics' && <Analytics ctx={ctx} tab={tab} setTab={setTab}/>}
      {panel === 'about' && <><h2>Different sensors.<br/><em>One perspective.</em></h2>
        <p>FireBridge harmonizes NASA FIRMS active-fire detections from MODIS (Terra, Aqua · 1 km · since 2000) and VIIRS (Suomi NPP, NOAA-20, NOAA-21 · 375 m · since 2012) into one comparable record, starting with China.</p>
        <h3>How the harmonization works</h3>
        <p>Every detection is placed on a 10 km equal-area grid. A cell that burns on a given day (or night) counts once per satellite, which removes most of the pixel-size effect. For the years when the satellites overlap, a scale factor to Suomi NPP is fitted per satellite and day/night, on 100 km regions, and then checked on a year the model never saw. The burning activity calendar uses one source per month on a fixed common area.</p>
        <h3>What you can do</h3>
        <p><b>Timeline</b> — pick a year and month; bars show the harmonized index. <b>Grid 10 km</b> — the unit behind the index. <b>Events</b> — pixels of all satellites fused into space-time clusters, coloured by which sensor family saw them. <b>Draw area</b> (Scene settings) — every query, the calendar and the anomalies follow your area. <b>Harmonize</b> — calendar of all years, seasonality and unusual months, validation of the model, MODIS–VIIRS agreement.</p>
        <h3>What this is not</h3>
        <p>A detection is a hot pixel, not a confirmed wildfire. The index measures recorded activity, not burned area or a number of fires. Suomi NPP is a reference, not ground truth. Night-time MODIS does not pass validation and is flagged everywhere. Without the backend the map shows synthetic points and the analytics show a precomputed report for all of China.</p>
        <h3>Scene</h3>
        <p>Terrain: Mapterhorn elevation. Satellite basemap: grayscale Sentinel-2 cloudless 2020 (EOX), not matched to the fire dates. City views use extruded OpenStreetMap footprints. Region outlines: geoBoundaries, for display only.</p>
        <a href="https://firms.modaps.eosdis.nasa.gov/" target="_blank" rel="noreferrer">NASA FIRMS <ArrowUpRight size={14}/></a></>}
    </section></div>}

    <input ref={localFile} type="file" accept=".csv,text/csv" hidden onChange={importLocal}/>
    <input ref={serverFile} type="file" accept=".csv,.zip,text/csv,application/zip,application/x-zip-compressed" multiple hidden onChange={uploadToServer}/>
    {notice && <div className="toast" role="status">{notice}<button aria-label="Dismiss notice" onClick={() => setNotice('')}><X size={16}/></button></div>}
    {error && <button role="alert" className="map-error" onClick={() => setError('')}>{error} ×</button>}
  </div>;
}
