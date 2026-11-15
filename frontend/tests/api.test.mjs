import assert from 'node:assert/strict';
import {ApiError, FireAPI, windowQuery} from '../src/api.js';

// query builder never sends empty/undefined fields (the backend forbids unknown or null extras)
assert.deepEqual(windowQuery({start: '2025-03-01', end: '2025-03-31'}), {start: '2025-03-01', end: '2025-03-31', daynight: 'both', processing: 'archive'});
assert.deepEqual(windowQuery({start: 'a', end: 'b', bbox: [1, 2, 3, 4], daynight: 'D', processing: 'NRT', extra: {limit: 5}}),
  {start: 'a', end: 'b', daynight: 'D', processing: 'NRT', limit: 5, area: {bbox: [1, 2, 3, 4]}});

const calls = [];
const reply = (status, body, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), {status, headers: {'content-type': type}});
let handler = () => reply(200, {});
globalThis.fetch = async (url, options = {}) => { calls.push({url, ...options}); return handler(url, options); };

const api = new FireAPI('http://localhost:8000/', 'secret');
assert.equal(api.base, 'http://localhost:8000');              // trailing slash removed

handler = () => reply(200, {type: 'FeatureCollection', features: []});
await api.detections({start: '2025-01-01', end: '2025-01-31'});
assert.equal(calls.at(-1).url, 'http://localhost:8000/api/v1/detections/query');
assert.equal(calls.at(-1).method, 'POST');
assert.equal(calls.at(-1).headers['X-API-Key'], 'secret');
assert.equal(calls.at(-1).headers['Content-Type'], 'application/json');
assert.deepEqual(JSON.parse(calls.at(-1).body), {start: '2025-01-01', end: '2025-01-31'});

await api.loadDemo();                                         // POST without a body
assert.equal(calls.at(-1).body, undefined);
assert.equal(calls.at(-1).headers['Content-Type'], undefined);

await api.model('abc/def');
assert.equal(calls.at(-1).url, 'http://localhost:8000/api/v1/harmonization/models/abc%2Fdef?compact=true');

// validation errors become one readable message
handler = () => reply(422, {detail: [{loc: ['body', 'end'], msg: 'Input should be a valid date'}]});
await assert.rejects(api.calendar({}), e => e instanceof ApiError && e.status === 422 && e.message === 'end: Input should be a valid date');
handler = () => reply(409, {detail: 'Calibration is stale after ingestion; create a new model'});
await assert.rejects(api.calendar({}), e => e.status === 409 && e.message.includes('stale'));
handler = () => reply(401, 'nope', 'text/plain');
await assert.rejects(api.overview(), e => e.status === 401 && e.message === 'Invalid or missing API key.');

// a dev server that answers /health with index.html is not our backend
handler = () => reply(200, '<!doctype html>', 'text/html');
await assert.rejects(api.health(), e => e.status === 0 && e.message.includes('does not serve'));
handler = () => { throw new TypeError('fetch failed'); };
await assert.rejects(api.health(), e => e.status === 0 && e.message.includes('Backend unreachable'));

// job polling: progress, success, failure
let polls = 0;
const seen = [];
handler = () => reply(200, ++polls < 3 ? {status: 'running', result: {input_rows: polls * 100}} : {status: 'succeeded', result: {id: 'model-1'}});
assert.deepEqual(await api.waitForJob('j1', {interval: 1, onProgress: j => seen.push(j.result.input_rows)}), {id: 'model-1'});
assert.deepEqual(seen, [100, 200]);
assert.equal(calls.at(-1).url, 'http://localhost:8000/api/v1/jobs/j1');
handler = () => reply(200, {status: 'failed', error: 'No valid observations'});
await assert.rejects(api.waitForJob('j2', {interval: 1}), e => e.message === 'No valid observations');
handler = () => reply(200, {status: 'interrupted', error: 'Server restarted; submit the job again'});
await assert.rejects(api.waitForJob('j3', {interval: 1}), /Server restarted/);

// upload is multipart with the field name the backend expects
handler = () => reply(202, {job_id: 'j4'});
await api.upload(new Blob(['latitude,longitude\n'], {type: 'text/csv'}));
assert(calls.at(-1).body instanceof FormData && calls.at(-1).body.has('file'));
assert.equal(calls.at(-1).headers['Content-Type'], undefined); // the browser sets the multipart boundary

// same-origin default (Vite proxy / served by the backend)
assert.equal(new FireAPI('', '').base, '');
console.log('PASS: query builder, headers, paths, error mapping, non-API responses, job polling, multipart upload.');
