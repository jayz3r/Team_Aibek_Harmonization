// Harmonization lab: burning calendar, seasonality, model validation and sensor agreement.
import React, {useEffect, useMemo, useState} from 'react';
import {Check, Download, RefreshCw} from 'lucide-react';
import Papa from 'papaparse';
import {saveBlob, windowQuery} from './api.js';
import {AnnualChart, BeforeAfterChart, CalendarHeatmap, Histogram, PlatformLegend, RampLegend, SeasonChart, ShareBar, SlopeChart} from './charts.jsx';
import {AGREEMENT_COLOR} from './fireLayers.js';
import {MODIS, MONTHS_LONG, VIIRS, annualTotals, calendarMatrix, flagLabel, fmt, histogram, insights, signed, warningLabel} from './format.js';

/** Run an async task when deps change; ignores results of superseded runs. */
export function useAsync(task, deps, enabled = true) {
  const [state, setState] = useState({loading: enabled, data: null, error: null});
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setState({loading: false, data: null, error: null});
      return undefined;
    }
    const controller = new AbortController();
    setState(s => ({...s, loading: true, error: null}));
    task(controller.signal)
      .then(data => { if (!controller.signal.aborted) setState({loading: false, data, error: null}); })
      .catch(error => { if (!controller.signal.aborted) setState({loading: false, data: null, error}); });
    return () => controller.abort();
  }, [...deps, tick, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return {...state, reload: () => setTick(t => t + 1)};
}

/** Warning triangle drawn inline, so the UI does not depend on an icon name that differs between icon-set versions. */
export function Warn({size = 15}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>;
}

const showcaseCache = {};
function loadShowcase(name, signal) {
  showcaseCache[name] ||= fetch(`${import.meta.env.BASE_URL}data/showcase/${name}.json`, {signal})
    .then(r => { if (!r.ok) throw Error('Precomputed report is missing.'); return r.json(); })
    .catch(error => { delete showcaseCache[name]; throw error; });
  return showcaseCache[name];
}

const TABS = [['calendar', 'Burning calendar'], ['season', 'Seasonality'], ['model', 'Validation'], ['agreement', 'Sensor agreement']];

function Status({state, empty}) {
  if (state.loading) return <p className="status loading"><RefreshCw size={14}/> Computing…</p>;
  if (state.error) return <p className="status error"><Warn size={14}/> {state.error.message}</p>;
  return empty ? <p className="muted">{empty}</p> : null;
}

function Seg({value, onChange, options, label}) {
  return <div className="seg" role="group" aria-label={label}>{options.map(([v, text]) => <button key={v} aria-pressed={value === v} onClick={() => onChange(v)}>{text}</button>)}</div>;
}

function FlagSummary({rows}) {
  const counts = {};
  for (const row of rows) for (const f of row.flags || []) counts[f] = (counts[f] || 0) + 1;
  const list = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!list.length) return null;
  return <ul className="flags">{list.map(([flag, n]) => <li key={flag}><b>{n}</b> month{n === 1 ? '' : 's'} · {flagLabel(flag)}</li>)}</ul>;
}

function CalendarTab({ctx, source, dn}) {
  const {api, live, overview, bbox, model, selectedMonth, onPickMonth} = ctx;
  const [field, setField] = useState('harmonized_index');
  const range = overview?.years?.archive;
  const usable = model && !model.stale;
  const query = useMemo(() => range && windowQuery({
    start: `${range[0]}-01-01`, end: `${range[1]}-12-31`, bbox, daynight: dn,
    extra: {allow_extrapolation: true, ...(usable ? {model_id: model.id} : {})},
  }), [range?.[0], range?.[1], bbox?.join(), dn, usable ? model.id : null]); // eslint-disable-line react-hooks/exhaustive-deps
  const state = useAsync(signal => (source === 'live' ? api.calendar(query, signal) : loadShowcase('calendar', signal)),
    [source, query, overview?.revision], source === 'showcase' || (live && !!query));
  const rows = state.data?.rows || [];
  const meta = state.data?.meta;
  const shown = field === 'harmonized_index' && rows.length && rows.every(r => r.harmonized_index == null) ? 'supported_cell_days' : field;
  const totals = useMemo(() => annualTotals(rows), [rows]);
  const {max} = useMemo(() => calendarMatrix(rows, shown), [rows, shown]);

  async function exportCsv() {
    if (source === 'live') saveBlob(await api.csv('/exports/calendar.csv', query), 'burning_activity_calendar.csv');
    else {
      const flat = rows.map(r => ({month: r.month, selected_platform: r.selected_platform, raw_selected_cell_days: r.raw_selected_cell_days,
        supported_cell_days: r.supported_cell_days, excluded_cell_days: r.excluded_cell_days, harmonized_index: r.harmonized_index, flags: (r.flags || []).join(';')}));
      saveBlob(new Blob([Papa.unparse(flat)], {type: 'text/csv'}), 'burning_activity_calendar_china.csv');
    }
  }

  return <>
    <div className="tab-controls">
      <Seg label="Metric" value={shown} onChange={setField} options={[['harmonized_index', 'Harmonized index'], ['supported_cell_days', 'Raw sensor counts']]}/>
      {rows.length > 0 && <button className="ghost" onClick={() => exportCsv().catch(e => ctx.notify(e.message))}><Download size={14}/> CSV</button>}
    </div>
    <Status state={state} empty={!state.data && source === 'live' && !range ? 'Load data first: the calendar is built from the archive files.' : ''}/>
    {source === 'live' && !usable && rows.length > 0 && <p className="callout warn"><Warn size={15}/> {model?.stale ? 'The model is stale after a new import.' : 'No calibration model yet.'} Showing raw counts of the selected sensor — the MODIS→VIIRS step is still in the series. Open <b>Validation</b> and calibrate.</p>}
    {rows.length > 0 && <>
      <CalendarHeatmap rows={rows} field={shown} selected={source === 'live' ? selectedMonth : null} onPick={source === 'live' ? onPickMonth : undefined}/>
      <RampLegend max={max} label={shown === 'harmonized_index' ? `${meta?.reference || 'SNPP'}-equivalent occupied 10 km cell-days` : 'occupied 10 km cell-days of the selected sensor (uncalibrated)'}/>
      <PlatformLegend platforms={meta?.selected_platforms}/>
      <p className="muted">One source per month (left edge colour), never a sum of satellites. {source === 'live' && 'Click a month to show it on the map. '}Hover a cell for its flags; a ring marks months whose coefficient failed validation.</p>
      <h3>Does harmonization remove the sensor step?</h3>
      <AnnualChart totals={totals} reference={meta?.reference}/>
      <div className="line-legend"><span><i className="raw"/>Raw counts of the source sensor</span><span><i className="index"/>Harmonized index</span></div>
      <p className="muted">Raw counts jump when the record moves from 1 km MODIS to 375 m VIIRS. The harmonized series rescales MODIS-era months to the {meta?.reference || 'SNPP'} scale on a fixed common area{meta?.common_support_region_counts ? ` (${Object.entries(meta.common_support_region_counts).filter(([, n]) => n != null).map(([k, n]) => `${n} regions ${k === 'D' ? 'day' : 'night'}`).join(', ') || 'reference only'})` : ''}.</p>
      <h3>What the flags say</h3>
      <FlagSummary rows={rows}/>
    </>}
  </>;
}

function SeasonTab({ctx, source, dn}) {
  const {api, live, overview, bbox, model} = ctx;
  const range = overview?.years?.archive;
  const choices = useMemo(() => {
    const out = [];
    if (range) for (let y = range[1]; y >= range[0] + 3; y--) out.push(y);
    return out;
  }, [range?.[0], range?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const [target, setTarget] = useState(null);
  const year = target && choices.includes(target) ? target : (choices.find(y => String(y) === ctx.defaultYear) || choices[0]);
  const usable = model && !model.stale;
  const query = useMemo(() => year && usable && windowQuery({
    start: `${year}-01-01`, end: `${year}-12-31`, bbox, daynight: dn,
    extra: {model_id: model.id, allow_extrapolation: true, baseline_start_year: Math.max(range[0], year - 12), baseline_end_year: year - 1},
  }), [year, usable ? model.id : null, bbox?.join(), dn, range?.[0]]); // eslint-disable-line react-hooks/exhaustive-deps
  const state = useAsync(signal => (source === 'live' ? api.seasonality(query, signal) : loadShowcase('seasonality', signal)),
    [source, query, overview?.revision], source === 'showcase' || (live && !!query));
  const data = state.data;
  const unusual = (data?.anomalies || []).filter(a => a.classification.startsWith('unusually'));
  const shownYear = data?.anomalies?.[0]?.month.slice(0, 4);

  return <>
    {source === 'live' && <div className="tab-controls">
      <label className="inline">Target year <select value={year || ''} onChange={e => setTarget(Number(e.target.value))}>{choices.map(y => <option key={y}>{y}</option>)}</select></label>
    </div>}
    {source === 'live' && !usable && <p className="callout warn"><Warn size={15}/> Seasonality needs a current calibration model so every year is on one scale. Open <b>Validation</b> and calibrate.</p>}
    {source === 'live' && usable && !choices.length && <p className="muted">At least three earlier years are needed for a baseline.</p>}
    <Status state={state}/>
    {data && <>
      <SeasonChart profile={data.seasonal_profile} anomalies={data.anomalies}/>
      <div className="line-legend"><span><i className="mean"/>Baseline mean {data.meta?.baseline?.join('–')}</span><span><i className="bandkey"/>±1σ</span><span><i className="p95"/>P95</span><span><i className="bars"/>{shownYear}</span></div>
      <div className="chips"><span className="eyebrow">HISTORICALLY MOST ACTIVE</span>{data.historically_active_months.length ? data.historically_active_months.map(m => <b key={m}>{MONTHS_LONG[m - 1]}</b>) : <em>not enough baseline</em>}</div>
      <h3>{shownYear} against its own history</h3>
      {unusual.length ? <p className="callout"><Warn size={15}/> {unusual.map(a => `${MONTHS_LONG[Number(a.month.slice(5, 7)) - 1]} was ${a.classification.replace('_', ' ')} (z = ${a.z_score.toFixed(1)}, ${signed(a.anomaly_pct, 0)})`).join('; ')}.</p>
        : <p className="callout ok"><Check size={15}/> No month of {shownYear} leaves the ±2σ band of its baseline. Aggregating a large area can hide local anomalies — draw a smaller area on the map and reopen this tab.</p>}
      <table className="table"><thead><tr><th>Month</th><th>Index</th><th>Baseline</th><th>Anomaly</th><th>z</th><th>Source</th></tr></thead><tbody>
        {data.anomalies.map(a => <tr key={a.month} className={a.classification}><td>{MONTHS_LONG[Number(a.month.slice(5, 7)) - 1]}</td><td>{fmt(a.harmonized_index)}</td><td>{fmt(a.baseline_mean)}</td><td>{signed(a.anomaly_pct, 0)}</td><td>{a.z_score == null ? '—' : a.z_score.toFixed(2)}</td><td>{a.selected_platform || '—'}{a.classification !== 'typical' && <em> · {a.classification.replaceAll('_', ' ')}</em>}</td></tr>)}
      </tbody></table>
      <p className="muted">Descriptive z-score against the same calendar month in earlier years; not a significance test and not a forecast.</p>
    </>}
  </>;
}

function ModelTab({ctx, source}) {
  const {live, model: liveModel, calibrate, busy} = ctx;
  const [metric, setMetric] = useState('rmse');
  const state = useAsync(signal => loadShowcase('model', signal), [source], source === 'showcase');
  const model = source === 'live' ? liveModel : state.data;
  const findings = useMemo(() => insights(model), [model]);
  return <>
    {source === 'live' && <div className="tab-controls">
      <span className="muted">{model ? `Model ${model.id.slice(0, 8)} · revision ${model.revision}${model.stale ? ' · STALE' : ''}` : 'No model on this server yet.'}</span>
      <button className="primary small" disabled={!live || !!busy} onClick={calibrate}><RefreshCw size={14}/> {busy === 'calibrate' ? 'Fitting…' : model ? 'Re-calibrate' : 'Calibrate now'}</button>
    </div>}
    {source === 'showcase' && <Status state={state}/>}
    {source === 'live' && model?.stale && <p className="callout warn"><Warn size={15}/> Data changed after this model was fitted. The API refuses stale models — re-calibrate.</p>}
    {model && <>
      <p className="muted">Reference <b>{model.reference}</b> · trained {model.config.train_start_year}–{model.config.train_end_year} · tested on untouched <b>{model.config.test_year}</b> · {model.grid_km} km equal-area cells in {model.region_km} km regions · scope “{model.config.hotspot_scope}”.</p>
      {findings.length > 0 && <ul className="insights">{findings.map(text => <li key={text}>{text}</li>)}</ul>}
      <h3>Scale factors to the reference</h3>
      <SlopeChart coefficients={model.coefficients}/>
      <p className="muted">Dot = coefficient, bar = 95% year-block bootstrap. ×1 means the sensor already counts like {model.reference}. Hollow dots carry a validation warning.</p>
      <div className="tab-controls"><h3>Held-out year {model.config.test_year}: before → after</h3>
        <Seg label="Metric" value={metric} onChange={setMetric} options={[['rmse', 'RMSE'], ['mae', 'MAE'], ['aggregate_bias_pct', '|Bias| %']]}/></div>
      <BeforeAfterChart coefficients={model.coefficients} metric={metric}/>
      <div className="line-legend"><span><i className="before"/>before calibration</span><span><i className="better"/>after, improved</span><span><i className="worse"/>after, not improved</span></div>
      <table className="table"><thead><tr><th>Sensor</th><th>D/N</th><th>×</th><th>Train</th><th>Test rows</th><th>Verdict</th></tr></thead><tbody>
        {model.coefficients.map(c => <tr key={c.platform + c.daynight} className={c.warnings.length ? 'warned' : 'passed'}><td>{c.platform}</td><td>{c.daynight === 'D' ? 'Day' : 'Night'}</td><td>{c.slope.toFixed(3)}</td><td>{c.train_start}–{c.train_end} ({c.train_years} y)</td><td>{fmt(c.test_rows)}</td><td>{c.warnings.length ? c.warnings.map(warningLabel).join(', ') : 'agreement improved'}</td></tr>)}
      </tbody></table>
      {model.skipped?.length > 0 && <p className="muted">Skipped (not enough overlap): {model.skipped.map(s => `${s.platform} ${s.daynight}`).join(', ')}.</p>}
      <h3>Limits we state openly</h3>
      <ul className="limits">{model.limitations.map(l => <li key={l}>{l}</li>)}</ul>
    </>}
  </>;
}

const DIST_BINS = 5, TIME_BINS = 6;

function AgreementTab({ctx}) {
  const {live, agreement, runAgreement, layers, setLayer, windowLabel, monthChosen, overview} = ctx;
  const platforms = new Set((overview?.coverage?.archive || []).concat(overview?.coverage?.NRT || []).map(s => s.platform));
  const modisOptions = MODIS.filter(p => platforms.has(p)), viirsOptions = VIIRS.filter(p => platforms.has(p));
  const [p, setP] = useState({modis: 'Aqua', viirs: 'SNPP', distance: 1, minutes: 30, eventKm: 1.5, gapHours: 36});
  const params = {...p, modis: modisOptions.includes(p.modis) ? p.modis : modisOptions[0], viirs: viirsOptions.includes(p.viirs) ? p.viirs : viirsOptions[0]};
  const set = (key, value) => setP(old => ({...old, [key]: value}));
  const m = agreement.matches, e = agreement.events;
  const pairs = m?.pairs || [];
  const distance = useMemo(() => histogram(pairs.map(x => x.distance_km), DIST_BINS, m?.meta.radius_km || 1), [m]); // eslint-disable-line react-hooks/exhaustive-deps
  const minutes = useMemo(() => histogram(pairs.map(x => x.time_delta_minutes), TIME_BINS, m?.meta.window_minutes || 30), [m]); // eslint-disable-line react-hooks/exhaustive-deps
  const binLabels = (bins, max, digits) => Array.from({length: bins}, (_, i) => `${(i * max / bins).toFixed(digits)}–${((i + 1) * max / bins).toFixed(digits)}`);
  if (!live) return <p className="callout"><Warn size={15}/> Sensor agreement is computed on demand from stored detections. Start the backend to use it.</p>;
  return <>
    <p className="muted">Two views of the same question — do MODIS and VIIRS see the same burning? <b>Links</b> pair single pixels seen minutes apart. <b>Events</b> fuse all pixels of all satellites into space-time clusters.</p>
    <div className="form-grid">
      <label>MODIS<select value={params.modis || ''} onChange={ev => set('modis', ev.target.value)}>{modisOptions.map(x => <option key={x}>{x}</option>)}</select></label>
      <label>VIIRS<select value={params.viirs || ''} onChange={ev => set('viirs', ev.target.value)}>{viirsOptions.map(x => <option key={x}>{x}</option>)}</select></label>
      <label>Link radius<select value={p.distance} onChange={ev => set('distance', Number(ev.target.value))}>{[.5, 1, 2, 3].map(x => <option key={x} value={x}>{x} km</option>)}</select></label>
      <label>Time window<select value={p.minutes} onChange={ev => set('minutes', Number(ev.target.value))}>{[15, 30, 60, 120].map(x => <option key={x} value={x}>±{x} min</option>)}</select></label>
      <label>Event radius<select value={p.eventKm} onChange={ev => set('eventKm', Number(ev.target.value))}>{[1, 1.5, 2.5, 5].map(x => <option key={x} value={x}>{x} km</option>)}</select></label>
      <label>Event gap<select value={p.gapHours} onChange={ev => set('gapHours', Number(ev.target.value))}>{[12, 24, 36, 72].map(x => <option key={x} value={x}>{x} h</option>)}</select></label>
    </div>
    <div className="tab-controls">
      <span className="muted">{monthChosen ? windowLabel : 'Pick one month on the timeline (the comparison is limited to 31 days).'}</span>
      <button className="primary small" disabled={!monthChosen || agreement.loading || !params.modis || !params.viirs} onClick={() => runAgreement(params)}><RefreshCw size={14}/> {agreement.loading ? 'Comparing…' : 'Compare sensors'}</button>
    </div>
    {agreement.error && <p className="status error"><Warn size={14}/> {agreement.error}</p>}
    {m && <>
      <h3>Pixel links · {m.meta.modis_platform} × {m.meta.viirs_platform}</h3>
      <div className="kpis">
        <div><strong>{fmt(m.summary.candidate_pairs)}</strong><span>candidate pairs</span></div>
        <div><strong>{m.summary.matched_modis_pct == null ? '—' : m.summary.matched_modis_pct.toFixed(0) + '%'}</strong><span>of MODIS pixels have a VIIRS pixel nearby</span></div>
        <div><strong>{m.summary.matched_viirs_pct == null ? '—' : m.summary.matched_viirs_pct.toFixed(0) + '%'}</strong><span>of VIIRS pixels have a MODIS pixel nearby</span></div>
      </div>
      <ShareBar parts={[{label: 'MODIS matched', value: m.summary.matched_modis_points, color: AGREEMENT_COLOR.both}, {label: 'MODIS unmatched', value: m.summary.unmatched_modis_points, color: AGREEMENT_COLOR.modis_only}]}/>
      <ShareBar parts={[{label: 'VIIRS matched', value: m.summary.matched_viirs_points, color: AGREEMENT_COLOR.both}, {label: 'VIIRS unmatched', value: m.summary.unmatched_viirs_points, color: AGREEMENT_COLOR.viirs_only}]}/>
      {pairs.length > 0 && <div className="hist-row">
        <div><span className="eyebrow">DISTANCE BETWEEN PIXEL CENTRES</span><Histogram counts={distance} labels={binLabels(DIST_BINS, m.meta.radius_km, 1)} unit="km"/></div>
        <div><span className="eyebrow">TIME BETWEEN OVERPASSES</span><Histogram counts={minutes} labels={binLabels(TIME_BINS, m.meta.window_minutes, 0)} unit="min"/></div>
      </div>}
      <label className="check"><input type="checkbox" checked={layers.links} onChange={ev => setLayer('links', ev.target.checked)}/> Draw the {fmt(pairs.length)} links on the map</label>
    </>}
    {e && <>
      <h3>Fused fire events · all satellites</h3>
      <div className="kpis">
        <div><strong>{fmt(e.summary.events)}</strong><span>events from {fmt(e.summary.detections)} pixels</span></div>
        <div><strong>{e.summary.both_events_pct == null ? '—' : e.summary.both_events_pct.toFixed(0) + '%'}</strong><span>of events seen by both sensor families</span></div>
        <div><strong>{e.summary.detections_in_both_pct == null ? '—' : e.summary.detections_in_both_pct.toFixed(0) + '%'}</strong><span>of all pixels belong to those events</span></div>
      </div>
      <ShareBar parts={[{label: 'MODIS + VIIRS', value: e.summary.events_by_agreement.both, color: AGREEMENT_COLOR.both}, {label: 'VIIRS only', value: e.summary.events_by_agreement.viirs_only, color: AGREEMENT_COLOR.viirs_only}, {label: 'MODIS only', value: e.summary.events_by_agreement.modis_only, color: AGREEMENT_COLOR.modis_only}]}/>
      <p className="muted">{e.summary.pixels_per_event} pixels per event on average; {fmt(e.summary.multi_day_events)} events burn on more than one day. “VIIRS only” is expected: 375 m pixels resolve small and cool fires that a 1 km MODIS pixel cannot.{e.meta.truncated ? ` Showing the ${fmt(e.meta.returned)} largest events.` : ''}</p>
      <label className="check"><input type="checkbox" checked={layers.events} onChange={ev => setLayer('events', ev.target.checked)}/> Show events on the map (size = pixels, colour = who saw it)</label>
      <ul className="limits">{e.meta.limitations.slice(0, 3).map(l => <li key={l}>{l}</li>)}</ul>
    </>}
  </>;
}

export default function Analytics({ctx, tab, setTab}) {
  const {live} = ctx;
  const [wanted, setWanted] = useState(live ? 'live' : 'showcase');
  const [dn, setDn] = useState('D');
  useEffect(() => { setWanted(live ? 'live' : 'showcase'); }, [live]);
  const source = live ? wanted : 'showcase';
  const selectable = tab !== 'agreement';
  return <>
    <h2>Different sensors.<br/><em>One fire record.</em></h2>
    <div className="tabs" role="tablist">{TABS.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}</div>
    {selectable && <div className="source-row">
      <Seg label="Data source" value={source} onChange={setWanted} options={[...(live ? [['live', 'Live API · your data']] : []), ['showcase', 'Full-China report · 15.6 M detections']]}/>
      {tab !== 'model' && source === 'live' && <Seg label="Day or night" value={dn} onChange={setDn} options={[['D', 'Day'], ['N', 'Night'], ['both', 'Both']]}/>}
    </div>}
    {selectable && source === 'showcase' && <p className="callout"><Check size={15}/> Precomputed by this backend from the complete China archives (Terra, Aqua, Suomi NPP, NOAA-20, NOAA-21; 2000–2025; daytime). {live ? 'Switch to Live API to analyse the data and area loaded now.' : 'Start the backend to analyse your own area and dates.'}</p>}
    {selectable && source === 'live' && tab !== 'model' && <p className="scope">Area: <b>{ctx.aoiLabel}</b>{dn === 'N' ? ' · night-time MODIS coefficients did not pass validation' : ''}</p>}
    <div className="tab-body" role="tabpanel">
      {tab === 'calendar' && <CalendarTab ctx={ctx} source={source} dn={dn}/>}
      {tab === 'season' && <SeasonTab ctx={ctx} source={source} dn={dn}/>}
      {tab === 'model' && <ModelTab ctx={ctx} source={source}/>}
      {tab === 'agreement' && <AgreementTab ctx={ctx}/>}
    </div>
  </>;
}
