// Client for the FastAPI backend (see backend/docs/frontend.md). Dates are YYYY-MM-DD, UTC.
import {errorText} from './format.js';

const read = (key, fallback = '') => {
  try { return globalThis.localStorage?.getItem(key) ?? fallback; } catch { return fallback; }
};
const write = (key, value) => {
  try { value ? globalThis.localStorage?.setItem(key, value) : globalThis.localStorage?.removeItem(key); } catch { /* private mode */ }
};
const clean = url => String(url || '').trim().replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export class FireAPI {
  /**
   * base '' = same origin: the Vite dev server proxies /api and /health to the backend,
   * and the backend serves the built app itself. VITE_API_URL or the Data panel override it.
   */
  constructor(base, key) {
    this.base = clean(base ?? (import.meta.env?.VITE_API_URL || read('firebridge.api')));
    this.key = key ?? read('firebridge.key');
  }

  configure(base, key) {
    this.base = clean(base);
    this.key = String(key || '').trim();
    write('firebridge.api', this.base);
    write('firebridge.key', this.key);
  }

  async call(path, {method = 'GET', body, form, signal, timeout} = {}) {
    const headers = {};
    if (this.key) headers['X-API-Key'] = this.key;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, {once: true});
    let timedOut = false;
    const timer = timeout ? setTimeout(() => { timedOut = true; controller.abort(); }, timeout) : null;
    let response;
    try {
      response = await fetch(this.base + path, {
        method, headers, signal: controller.signal,
        body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiError(0, timedOut ? 'The server did not answer in time.' : 'Backend unreachable. Is uvicorn running on port 8000?');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    if (!response.ok) {
      let detail = '';
      try { detail = errorText((await response.clone().json()).detail); } catch { /* not JSON */ }
      if (!detail && response.status === 401) detail = 'Invalid or missing API key.';
      throw new ApiError(response.status, detail || `Request failed (HTTP ${response.status}).`);
    }
    return response;
  }

  async json(path, options) {
    const response = await this.call(path, options);
    const type = response.headers.get('content-type') || '';
    // A dev server without the proxy answers /health with index.html: that is not our API.
    if (!type.includes('json')) throw new ApiError(0, 'This address does not serve the FireBridge API.');
    return response.json();
  }

  get(path, signal) { return this.json('/api/v1' + path, {signal}); }
  post(path, body, signal) { return this.json('/api/v1' + path, {method: 'POST', body, signal}); }

  health(signal) { return this.json('/health', {signal, timeout: 5000}); }
  overview(signal) { return this.get('/overview', signal); }
  datasets(signal) { return this.get('/datasets', signal); }
  model(id, signal) { return this.get(`/harmonization/models/${encodeURIComponent(id)}?compact=true`, signal); }
  detections(query, signal) { return this.post('/detections/query', query, signal); }
  grid(query, signal) { return this.post('/grid/query', query, signal); }
  calendar(query, signal) { return this.post('/analytics/calendar', query, signal); }
  seasonality(query, signal) { return this.post('/analytics/seasonality', query, signal); }
  matches(query, signal) { return this.post('/harmonization/matches', query, signal); }
  events(query, signal) { return this.post('/harmonization/events', query, signal); }
  calibrate(config = {}) { return this.post('/harmonization/calibrate', config); }
  loadDemo() { return this.post('/demo/load', undefined); }
  importFirms(body) { return this.post('/ingest/firms', body); }

  upload(file) {
    const form = new FormData();
    form.append('file', file);
    return this.json('/api/v1/datasets/upload', {method: 'POST', form});
  }

  /** Poll a background job until it ends. Resolves with job.result, rejects with job.error. */
  async waitForJob(jobId, {onProgress, signal, interval = 700, timeoutMs = 30 * 60_000} = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await this.get(`/jobs/${encodeURIComponent(jobId)}`, signal);
      if (job.status === 'succeeded') return job.result;
      if (job.status === 'failed' || job.status === 'interrupted') throw new ApiError(200, job.error || `Job ${job.status}.`);
      onProgress?.(job);
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    throw new ApiError(0, 'The job is still running. Refresh later.');
  }

  /** POST a query, receive a CSV attachment as a Blob. */
  async csv(path, body) {
    return (await this.call('/api/v1' + path, {method: 'POST', body})).blob();
  }
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Drop undefined/empty values so the strict backend schema (extra=forbid) never sees them. */
export function windowQuery({start, end, bbox, daynight, processing, extra = {}}) {
  const query = {start, end, daynight: daynight || 'both', processing: processing || 'archive', ...extra};
  if (bbox) query.area = {bbox};
  return query;
}
