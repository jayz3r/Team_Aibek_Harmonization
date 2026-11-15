// Dependency-free SVG charts for the analytics drawer.
import React from 'react';
import {MONTHS, MONTHS_LONG, PLATFORM_COLOR, PLATFORM_LABEL, PLATFORMS, calendarMatrix, compact, flagLabel, fmt, signed, yearFraction} from './format.js';

const RAMP = [[0, [38, 56, 64]], [.18, [104, 66, 64]], [.42, [190, 98, 66]], [.68, [244, 160, 84]], [.86, [255, 214, 138]], [1, [255, 246, 214]]];

export function ramp(t) {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < RAMP.length; i++) {
    if (x <= RAMP[i][0]) {
      const [a, ca] = RAMP[i - 1], [b, cb] = RAMP[i];
      const k = (x - a) / (b - a || 1);
      return `rgb(${ca.map((c, j) => Math.round(c + (cb[j] - c) * k)).join(',')})`;
    }
  }
  return 'rgb(255,246,214)';
}

const SERIOUS = ['validation_warning', 'no_common_spatial_support', 'missing_calibration'];

/** Burning activity calendar: one row per year, one cell per month. */
export function CalendarHeatmap({rows, field = 'harmonized_index', selected, onPick}) {
  const {years, cells, max} = calendarMatrix(rows, field);
  if (!years.length) return <p className="muted">No months in this range.</p>;
  const cw = 44, ch = 19, left = 46, top = 22;
  const width = left + 12 * cw + 4, height = top + years.length * ch + 4;
  return <svg className="chart heatmap" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Burning activity calendar, years by months">
    <defs><pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="#22333b"/><line x1="0" y1="0" x2="0" y2="5" stroke="#3b4d55" strokeWidth="1.6"/></pattern></defs>
    {MONTHS.map((m, i) => <text key={m} x={left + i * cw + cw / 2} y={14} textAnchor="middle" className="axis">{m}</text>)}
    {years.map((year, r) => <g key={year}>
      <text x={left - 8} y={top + r * ch + ch / 2 + 3.5} textAnchor="end" className="axis">{year}</text>
      {cells[year].map((row, i) => {
        const x = left + i * cw, y = top + r * ch;
        if (!row) return <rect key={i} x={x + 1} y={y + 1} width={cw - 2} height={ch - 2} fill="#1d2d34"/>;
        const value = row[field];
        const active = selected === row.month;
        const flags = row.flags || [];
        return <g key={i} className={onPick ? 'cell pick' : 'cell'} onClick={onPick ? () => onPick(row) : undefined}>
          <title>{`${MONTHS_LONG[i]} ${year}\n${value == null ? 'No comparable value' : fmt(value, value % 1 ? 1 : 0)}${row.selected_platform ? ` · source ${row.selected_platform}` : ''}${flags.length ? '\n⚠ ' + flags.map(flagLabel).join('\n⚠ ') : ''}`}</title>
          <rect x={x + 1} y={y + 1} width={cw - 2} height={ch - 2} fill={value == null ? 'url(#hatch)' : ramp(max ? Math.sqrt(value / max) : 0)} stroke={active ? '#fff' : 'none'} strokeWidth={active ? 1.6 : 0}/>
          {row.selected_platform && <rect x={x + 1} y={y + 1} width={3} height={ch - 2} fill={PLATFORM_COLOR[row.selected_platform]}/>}
          {flags.some(f => SERIOUS.includes(f)) && <circle cx={x + cw - 6} cy={y + 6} r={1.8} fill="#1b2a31" stroke="#ffe9c9" strokeWidth=".8"/>}
        </g>;
      })}
    </g>)}
  </svg>;
}

export function RampLegend({max, label}) {
  return <div className="ramp-legend"><span>0</span><i style={{background: `linear-gradient(90deg,${[0, .1, .25, .5, .75, 1].map(t => ramp(Math.sqrt(t))).join(',')})`}}/><span>{compact(max)}</span><em>{label}</em><span className="swatch hatch"/> no comparable value</div>;
}

export function PlatformLegend({platforms = PLATFORMS}) {
  return <div className="platform-legend">{platforms.map(p => <span key={p}><i style={{background: PLATFORM_COLOR[p]}}/>{PLATFORM_LABEL[p]}</span>)}</div>;
}

function scaleLinear(d0, d1, r0, r1) {
  const span = d1 - d0 || 1;
  return v => r0 + ((v - d0) / span) * (r1 - r0);
}

function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0];
  const raw = max / count, power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * power).find(s => s >= raw);
  const ticks = [];
  // The last tick is the first multiple of the step at or above the maximum, so nothing is clipped.
  for (let i = 0; i <= Math.ceil(max / step - 1e-9); i++) ticks.push(Math.round(i * step * 1e6) / 1e6);
  return ticks;
}

/** Annual totals: raw selected-sensor series against the harmonized series. */
export function AnnualChart({totals, reference = 'SNPP'}) {
  const data = totals.filter(t => t.raw != null || t.index != null);
  if (data.length < 2) return <p className="muted">At least two complete years are needed for the annual comparison.</p>;
  const W = 580, H = 210, L = 46, R = 12, T = 14, B = 26;
  const max = Math.max(...data.map(t => Math.max(t.raw || 0, t.index || 0)));
  const ticks = niceTicks(max);
  const x = scaleLinear(data[0].year, data.at(-1).year, L, W - R), y = scaleLinear(0, ticks.at(-1), H - B, T);
  const path = key => data.filter(t => t[key] != null).map((t, i) => `${i ? 'L' : 'M'}${x(t.year).toFixed(1)},${y(t[key]).toFixed(1)}`).join(' ');
  const eras = [];
  for (const t of data) {
    const p = t.platforms[0];
    if (!p) continue;
    const last = eras.at(-1);
    if (last && last.p === p) last.to = t.year; else eras.push({p, from: t.year, to: t.year});
  }
  const half = (x(data[0].year + 1) - x(data[0].year)) / 2;
  return <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Annual activity, raw against harmonized">
    {eras.map(e => <g key={e.p + e.from}><rect x={Math.max(L, x(e.from) - half)} y={T} width={Math.min(W - R, x(e.to) + half) - Math.max(L, x(e.from) - half)} height={H - B - T} fill={PLATFORM_COLOR[e.p]} opacity=".07"/><text x={(x(e.from) + x(e.to)) / 2} y={T + 11} textAnchor="middle" className="axis era">{e.p}</text></g>)}
    {ticks.map(t => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="gridline"/><text x={L - 6} y={y(t) + 3} textAnchor="end" className="axis">{compact(t)}</text></g>)}
    {data.filter((t, i) => i % Math.ceil(data.length / 9) === 0).map(t => <text key={t.year} x={x(t.year)} y={H - 8} textAnchor="middle" className="axis">{t.year}</text>)}
    <path d={path('raw')} className="line raw"/>
    <path d={path('index')} className="line index"/>
    {data.map(t => <g key={t.year}>
      {t.raw != null && <circle cx={x(t.year)} cy={y(t.raw)} r="2.4" className="dot raw"><title>{`${t.year} · raw ${t.platforms.join('/')} cell-days: ${fmt(t.raw)}`}</title></circle>}
      {t.index != null && <circle cx={x(t.year)} cy={y(t.index)} r="2.8" className="dot index"><title>{`${t.year} · harmonized (${reference}-equivalent): ${fmt(t.index)}`}</title></circle>}
    </g>)}
  </svg>;
}

const CLASS_COLOR = {unusually_high: '#ff8c42', unusually_low: '#8fb7c9', typical: '#eeb79e'};

/** 12-month baseline (mean ± 1σ, P95) with the target year drawn as bars. */
export function SeasonChart({profile, anomalies}) {
  const W = 580, H = 230, L = 46, R = 12, T = 12, B = 28;
  const target = Array(12).fill(null);
  for (const a of anomalies || []) target[Number(a.month.slice(5, 7)) - 1] = a;
  const max = Math.max(1, ...profile.map(p => Math.max(p.p95 || 0, (p.mean || 0) + (p.std || 0))), ...target.map(a => a?.harmonized_index || 0));
  const ticks = niceTicks(max);
  const band = (W - L - R) / 12;
  const cx = i => L + band * (i + .5), y = scaleLinear(0, ticks.at(-1), H - B, T);
  const known = profile.map((p, i) => ({...p, i})).filter(p => p.mean != null);
  const line = key => known.map((p, k) => `${k ? 'L' : 'M'}${cx(p.i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  const area = known.length ? known.map((p, k) => `${k ? 'L' : 'M'}${cx(p.i).toFixed(1)},${y(p.mean + (p.std || 0)).toFixed(1)}`).join(' ')
    + ' ' + [...known].reverse().map(p => `L${cx(p.i).toFixed(1)},${y(Math.max(0, p.mean - (p.std || 0))).toFixed(1)}`).join(' ') + ' Z' : '';
  return <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Seasonal profile and target year">
    {ticks.map(t => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="gridline"/><text x={L - 6} y={y(t) + 3} textAnchor="end" className="axis">{compact(t)}</text></g>)}
    {target.map((a, i) => a?.harmonized_index != null && <rect key={i} x={cx(i) - band * .3} width={band * .6} y={y(a.harmonized_index)} height={Math.max(0, H - B - y(a.harmonized_index))} fill={CLASS_COLOR[a.classification] || '#7d8c90'} opacity=".85">
      <title>{`${MONTHS_LONG[i]} ${a.month.slice(0, 4)}: ${fmt(a.harmonized_index)}\nbaseline mean ${fmt(a.baseline_mean)} · anomaly ${signed(a.anomaly_pct)} · z ${a.z_score == null ? '—' : a.z_score.toFixed(2)}\n${a.classification.replaceAll('_', ' ')}`}</title></rect>)}
    {area && <path d={area} className="band"/>}
    {known.length > 0 && <path d={line('p95')} className="line p95"/>}
    {known.length > 0 && <path d={line('mean')} className="line mean"/>}
    {known.map(p => <circle key={p.i} cx={cx(p.i)} cy={y(p.mean)} r="2.4" className="dot mean"><title>{`${MONTHS_LONG[p.i]} baseline (${p.baseline_years} years)\nmean ${fmt(p.mean)} · σ ${fmt(p.std)} · median ${fmt(p.median)} · P95 ${fmt(p.p95)}`}</title></circle>)}
    {MONTHS.map((m, i) => <text key={m} x={cx(i)} y={H - 9} textAnchor="middle" className="axis">{m}</text>)}
  </svg>;
}

/** Calibration slopes with bootstrap intervals on a log axis; 1 = identical to the reference. */
export function SlopeChart({coefficients}) {
  const rows = coefficients;
  const W = 580, rowH = 24, L = 118, R = 60, T = 22;
  const H = T + rows.length * rowH + 8;
  const hi = Math.max(2, ...rows.map(c => c.slope_ci95?.[1] || c.slope)) * 1.15, lo = Math.min(.5, ...rows.map(c => c.slope_ci95?.[0] || c.slope)) / 1.15;
  const x = v => L + ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (W - L - R);
  const ticks = [.5, 1, 2, 5, 10, 20].filter(t => t >= lo && t <= hi);
  return <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Calibration coefficients with 95% bootstrap intervals">
    {ticks.map(t => <g key={t}><line x1={x(t)} x2={x(t)} y1={T - 4} y2={H - 6} className={t === 1 ? 'refline' : 'gridline'}/><text x={x(t)} y={12} textAnchor="middle" className="axis">×{t}</text></g>)}
    {rows.map((c, i) => {
      const cy = T + i * rowH + rowH / 2, warn = c.warnings?.length > 0;
      return <g key={c.platform + c.daynight}>
        <text x={8} y={cy + 3.5} className="axis label">{c.platform} · {c.daynight === 'D' ? 'day' : 'night'}</text>
        {c.slope_ci95 && <line x1={x(c.slope_ci95[0])} x2={x(c.slope_ci95[1])} y1={cy} y2={cy} stroke={PLATFORM_COLOR[c.platform]} strokeWidth="2.4" strokeLinecap="round"/>}
        <circle cx={x(c.slope)} cy={cy} r="4.2" fill={warn ? '#1b2a31' : PLATFORM_COLOR[c.platform]} stroke={PLATFORM_COLOR[c.platform]} strokeWidth="1.6"><title>{`${c.platform} ${c.daynight}: ×${c.slope.toFixed(3)}${c.slope_ci95 ? ` (95% bootstrap ${c.slope_ci95[0].toFixed(3)}–${c.slope_ci95[1].toFixed(3)})` : ''}\ntrained on ${c.train_years} years, ${fmt(c.train_rows)} region-months`}</title></circle>
        <text x={W - R + 8} y={cy + 3.5} className="axis value">×{c.slope.toFixed(2)}</text>
      </g>;
    })}
  </svg>;
}

/** Held-out error before and after calibration, one pair of bars per stratum. */
export function BeforeAfterChart({coefficients, metric = 'rmse'}) {
  const rows = coefficients.filter(c => c.before && c.after);
  if (!rows.length) return <p className="muted">No held-out metrics in this model.</p>;
  const W = 580, rowH = 30, L = 118, R = 78, T = 6;
  const H = T + rows.length * rowH + 4;
  const value = (c, when) => Math.abs(c[when][metric] ?? 0);
  const max = Math.max(...rows.map(c => Math.max(value(c, 'before'), value(c, 'after')))) || 1;
  const w = v => (v / max) * (W - L - R);
  return <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Held-out ${metric} before and after calibration`}>
    {rows.map((c, i) => {
      const y = T + i * rowH, before = value(c, 'before'), after = value(c, 'after');
      const better = after < before;
      const text = metric === 'aggregate_bias_pct' ? `${signed(c.before[metric], 0)} → ${signed(c.after[metric], 0)}` : `${before.toFixed(1)} → ${after.toFixed(1)}`;
      return <g key={c.platform + c.daynight}>
        <text x={8} y={y + 17} className="axis label">{c.platform} · {c.daynight === 'D' ? 'day' : 'night'}</text>
        <rect x={L} y={y + 4} width={Math.max(1, w(before))} height={9} className="bar before"><title>{`Before: ${c.before[metric]?.toFixed(2)}`}</title></rect>
        <rect x={L} y={y + 14} width={Math.max(1, w(after))} height={9} className={'bar after ' + (better ? 'better' : 'worse')}><title>{`After: ${c.after[metric]?.toFixed(2)}`}</title></rect>
        <text x={W - R + 6} y={y + 17} className={'axis value ' + (better ? 'good' : 'bad')}>{text}</text>
      </g>;
    })}
  </svg>;
}

/** File coverage per satellite (first/last detection in the uploaded files). */
export function CoverageChart({spans}) {
  const rows = PLATFORMS.map(p => spans.find(s => s.platform === p)).filter(Boolean);
  if (!rows.length) return null;
  const W = 580, rowH = 22, L = 118, R = 70, T = 20;
  const H = T + rows.length * rowH + 4;
  const from = Math.floor(Math.min(...rows.map(s => yearFraction(s.start)))), to = Math.ceil(Math.max(...rows.map(s => yearFraction(s.end))));
  const x = scaleLinear(from, Math.max(to, from + 1), L, W - R);
  const step = Math.max(1, Math.ceil((to - from) / 8));
  const ticks = [];
  for (let y = from; y <= to; y += step) ticks.push(y);
  return <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Satellite file coverage">
    {ticks.map(t => <g key={t}><line x1={x(t)} x2={x(t)} y1={T - 4} y2={H - 4} className="gridline"/><text x={x(t)} y={11} textAnchor="middle" className="axis">{t}</text></g>)}
    {rows.map((s, i) => {
      const y = T + i * rowH + 5, x0 = x(yearFraction(s.start)), x1 = x(yearFraction(s.end));
      return <g key={s.platform}>
        <text x={8} y={y + 9} className="axis label">{PLATFORM_LABEL[s.platform]}</text>
        <rect x={x0} y={y} width={Math.max(2, x1 - x0)} height={11} rx="2" fill={PLATFORM_COLOR[s.platform]}><title>{`${s.platform}: ${String(s.start).slice(0, 10)} → ${String(s.end).slice(0, 10)} · ${fmt(s.detections)} detections`}</title></rect>
        <text x={W - R + 6} y={y + 9} className="axis value">{compact(s.detections)}</text>
      </g>;
    })}
  </svg>;
}

export function Histogram({counts, labels, unit}) {
  const W = 270, H = 96, L = 6, B = 18, T = 6;
  const max = Math.max(1, ...counts), bw = (W - 2 * L) / counts.length;
  return <svg className="chart small" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Distribution of ${unit}`}>
    {counts.map((n, i) => <rect key={i} x={L + i * bw + 1} width={bw - 2} y={T + (H - B - T) * (1 - n / max)} height={(H - B - T) * (n / max)} className="bar hist"><title>{`${labels[i]} ${unit}: ${n}`}</title></rect>)}
    <text x={L} y={H - 5} className="axis">{labels[0].split('–')[0]}</text>
    <text x={W - L} y={H - 5} textAnchor="end" className="axis">{labels.at(-1).split('–')[1]} {unit}</text>
  </svg>;
}

/** Share bar: [{label, value, color}] */
export function ShareBar({parts}) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!total) return null;
  return <div className="share"><div className="share-bar">{parts.filter(p => p.value > 0).map(p => <i key={p.label} style={{width: `${100 * p.value / total}%`, background: p.color}} title={`${p.label}: ${fmt(p.value)}`}/>)}</div>
    <div className="share-legend">{parts.map(p => <span key={p.label}><i style={{background: p.color}}/>{p.label} <b>{fmt(p.value)}</b> <em>{(100 * p.value / total).toFixed(0)}%</em></span>)}</div></div>;
}
