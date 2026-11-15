// Data & connection panel: backend status, datasets, uploads, live FIRMS import, filters, exports.
import React, {useState} from 'react';
import {ArrowLeft, Database, Download, RefreshCw, Upload} from 'lucide-react';
import {useAsync, Warn} from './Analytics.jsx';
import {CoverageChart} from './charts.jsx';
import {fmt} from './format.js';

const FIRMS_SOURCES = [
  ['VIIRS_SNPP_NRT', 'VIIRS Suomi NPP · near real-time'], ['VIIRS_NOAA20_NRT', 'VIIRS NOAA-20 · near real-time'],
  ['VIIRS_NOAA21_NRT', 'VIIRS NOAA-21 · near real-time'], ['MODIS_NRT', 'MODIS Terra + Aqua · near real-time'],
  ['VIIRS_SNPP_SP', 'VIIRS Suomi NPP · standard'], ['VIIRS_NOAA20_SP', 'VIIRS NOAA-20 · standard'], ['MODIS_SP', 'MODIS · standard'],
];

function datasetRows(dataset) {
  const members = Array.isArray(dataset.audit) ? dataset.audit : [];
  return {
    rows: members.reduce((sum, m) => sum + (m.valid_rows || 0), 0),
    platforms: [...new Set(members.flatMap(m => m.platforms || []))].join(', '),
    span: members.length ? `${members.map(m => m.start).filter(Boolean).sort()[0]?.slice(0, 10) || '?'} → ${members.map(m => m.end).filter(Boolean).sort().at(-1)?.slice(0, 10) || '?'}` : '',
  };
}

export default function DataPanel({ctx}) {
  const {api, backend, live, overview, busy, jobText, bbox, aoiLabel} = ctx;
  const [address, setAddress] = useState(api.base);
  const [key, setKey] = useState(api.key);
  const [firms, setFirms] = useState({source: 'VIIRS_SNPP_NRT', days: 2});
  const datasets = useAsync(signal => api.datasets(signal), [overview?.revision, live], live);
  const caps = overview?.capabilities || {};
  const firmsBox = bbox || overview?.bounds;
  const spans = [...(overview?.coverage?.archive || [])];
  const nrt = overview?.coverage?.NRT || [];

  return <>
    <h2>Your data.<br/><em>In perspective.</em></h2>

    <div className={'connection ' + backend.status}>
      <i/>
      {backend.status === 'live' && <span><b>Connected to the harmonization API</b> · v{overview?.version} · data revision {overview?.revision}</span>}
      {backend.status === 'checking' && <span>Looking for the backend…</span>}
      {backend.status === 'offline' && <span><b>Offline showcase.</b> {backend.error || 'Backend not found.'} The map shows synthetic demo points; analytics show the precomputed full-China report.</span>}
    </div>
    {backend.status === 'offline' && <pre className="howto">cd backend{'\n'}pip install -r requirements.txt{'\n'}uvicorn app.main:app --port 8000</pre>}
    <details className="settings" open={backend.status === 'offline'}>
      <summary>Connection settings</summary>
      <label>API address<input value={address} onChange={e => setAddress(e.target.value)} placeholder="same origin (default) or http://localhost:8000"/></label>
      <label>API key<input value={key} onChange={e => setKey(e.target.value)} type="password" placeholder="only if the server sets API_KEY" autoComplete="off"/></label>
      <button className="ghost" onClick={() => ctx.connect(address, key)}><RefreshCw size={14}/> Connect</button>
    </details>

    {live && <>
      <h3>On the server</h3>
      <div className="kpis">
        <div><strong>{fmt(overview.detections.archive)}</strong><span>archive detections</span></div>
        <div><strong>{fmt(overview.detections.NRT)}</strong><span>near real-time detections</span></div>
        <div><strong>{overview.datasets.ready}</strong><span>imported files</span></div>
      </div>
      {spans.length > 0 && <><CoverageChart spans={spans}/><p className="muted">First and last archived detection per satellite in the uploaded files — not verified clear-sky coverage.{nrt.length ? ` Near real-time stream: ${nrt.map(s => s.platform).join(', ')}.` : ''}</p></>}
      {!spans.length && !nrt.length && <p className="callout"><Database size={15}/> The database is empty. Load the bundled real sample or upload your FIRMS archives.</p>}

      <h3>Add data</h3>
      <div className="actions">
        <button className="primary small" disabled={!!busy} onClick={ctx.pickServerFile}><Upload size={15}/> Upload FIRMS CSV / ZIP</button>
        {caps.demo_sample && <button className="ghost" disabled={!!busy} onClick={ctx.loadDemo}><Database size={15}/> Load real sample + calibrate</button>}
      </div>
      {busy && <p className="status loading"><RefreshCw size={14}/> {jobText || 'Working…'}</p>}
      <p className="muted">Upload the ZIP exactly as NASA FIRMS Archive Download sends it (CSV format: <code>fire_archive_*.csv</code>, <code>fire_nrt_*.csv</code>) — several files can be picked at once. Up to {Math.round((overview.limits?.max_upload_bytes || 256 * 1048576) / 1048576)} MB per file. Re-uploading the same file is harmless. After new data, re-calibrate the model in the Harmonize panel.</p>

      <h3>Live FIRMS import</h3>
      {caps.firms_live ? <>
        <div className="form-grid two">
          <label>Product<select value={firms.source} onChange={e => setFirms({...firms, source: e.target.value})}>{FIRMS_SOURCES.map(([v, text]) => <option key={v} value={v}>{text}</option>)}</select></label>
          <label>Last days<select value={firms.days} onChange={e => setFirms({...firms, days: Number(e.target.value)})}>{[1, 2, 3, 4, 5].map(d => <option key={d}>{d}</option>)}</select></label>
        </div>
        <div className="actions"><button className="ghost" disabled={!!busy || !firmsBox} onClick={() => ctx.importFirms({source: firms.source, days: firms.days, area: {bbox: firmsBox}})}><Download size={15}/> Fetch from NASA FIRMS</button>
          <span className="muted">{firmsBox ? `Area: ${bbox ? aoiLabel : 'extent of loaded data'}` : 'Draw an area on the map first.'}</span></div>
      </> : <p className="muted">Disabled: put a free NASA <code>FIRMS_MAP_KEY</code> into <code>backend/.env</code> and restart the server. The key never leaves the backend.</p>}

      <h3>Imported files</h3>
      {datasets.loading && <p className="status loading"><RefreshCw size={14}/> Loading…</p>}
      {datasets.error && <p className="status error"><Warn size={14}/> {datasets.error.message}</p>}
      {datasets.data && (datasets.data.datasets.length ? <table className="table"><thead><tr><th>File</th><th>Status</th><th>Valid rows</th><th>Satellites</th><th>Dates</th></tr></thead><tbody>
        {datasets.data.datasets.map(d => { const info = datasetRows(d); return <tr key={d.id} className={d.status === 'ready' ? '' : 'warned'}><td>{d.name}</td><td>{d.status}</td><td>{fmt(info.rows)}</td><td>{info.platforms}</td><td>{info.span}</td></tr>; })}
      </tbody></table> : <p className="muted">Nothing imported yet.</p>)}
    </>}

    <h3>Map filters</h3>
    <label className="setting">Day / night<select value={ctx.night} onChange={e => ctx.setNight(e.target.value)}><option>All</option><option value="D">Day</option><option value="N">Night</option></select></label>
    {live && <label className="setting">Processing stream<select value={ctx.processing} onChange={e => ctx.setProcessing(e.target.value)}><option value="archive">Archive · science quality</option><option value="NRT">Near real-time (NRT)</option></select></label>}
    {live && <label className="setting">Detections<select value={ctx.qualityOnly ? 'quality' : 'all'} onChange={e => ctx.setQualityOnly(e.target.value === 'quality')}><option value="quality">Quality only · MODIS ≥ 30, VIIRS nominal/high</option><option value="all">Include low confidence</option></select></label>}

    <h3>Export</h3>
    <button className="setting" onClick={ctx.download}>{live ? 'Detections of the current view (CSV, server page)' : 'Filtered observations (CSV)'} <Download size={18}/></button>

    {!live && <>
      <h3>Without the backend</h3>
      <p>Import a NASA FIRMS CSV straight into the browser. It replaces the synthetic points for this session; nothing is uploaded and nothing is harmonized.</p>
      <button className="primary" onClick={ctx.pickLocalFile}><Upload size={18}/> Import FIRMS CSV locally</button>
      <p className="muted">Required: latitude, longitude, acq_date. Supported: instrument, satellite, frp, confidence, daynight, acq_time. Loaded: {fmt(ctx.localCount)} observations.</p>
      <button className="setting" onClick={ctx.restoreDemo}>Restore synthetic demo <ArrowLeft size={18}/></button>
    </>}
  </>;
}
