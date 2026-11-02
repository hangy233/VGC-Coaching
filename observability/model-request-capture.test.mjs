import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createModelRequestCapture, sanitizeModelOtlp, classifyModelTiming, fingerprintModelOtlp} from './model-request-capture.mjs';

const thread = '019a5a61-2a1b-7e00-8c16-001122334455';
const attr = (key, value) => ({key, value: typeof value === 'boolean' ? {boolValue: value} : typeof value === 'number' ? {doubleValue: value} : {stringValue: value}});
const log = (name = 'codex.api_request', extra = {}) => ({eventName: name, timeUnixNano: '1792790000123456789',
  attributes: [attr('conversation.id', thread), attr('model', 'gpt-6.1-sol'), attr('attempt', 1), attr('status', 200), attr('duration_ms', 23000)], ...extra});
const logs = (...items) => ({resourceLogs: [{resource: {attributes: [attr('service.name', 'codex'), attr('service.version', '0.163.0-alpha.11.2')]}, scopeLogs: [{logRecords: items}]}]});
const metrics = (name, type, metric) => ({resourceMetrics: [{scopeMetrics: [{metrics: [{name, [type]: metric}]}]}]});
const traces = (...spans) => ({resourceSpans: [{scopeSpans: [{spans}]}]});
async function fixture(t, options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'model-capture-'));
  await writeFile(join(workspace, '.gitignore'), 'cache/\n');
  const capture = await createModelRequestCapture({workspace, ...options});
  t.after(async () => { await capture.close(); await rm(workspace, {recursive: true, force: true}); });
  return {workspace, capture};
}
async function post(capture, body, {path = '/v1/logs', headers = {}} = {}) {
  const bytes = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((accept, reject) => {
    const request = http.request(capture.endpoint + path, {method: 'POST', headers: {'content-type': 'application/json', ...headers}}, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', value => { text += value; }); response.on('end', () => accept({status: response.statusCode, body: JSON.parse(text)}));
    });
    request.on('error', reject); request.end(bytes);
  });
}
async function captured(capture) {
  const names = (await readdir(capture.directory)).filter(name => /^batch-/.test(name)).sort();
  return Promise.all(names.map(async name => JSON.parse(await readFile(join(capture.directory, name), 'utf8'))));
}

test('real HTTP logs retain separate attempts, correlation and event kind without request content', async t => {
  const {capture} = await fixture(t);
  const first = log('codex.api_request', {attributes: [...log().attributes, attr('request_id', 'req_1234'), attr('response_id', 'resp_5678'), attr('success', true)]});
  const second = log('codex.api_request', {attributes: [attr('conversation.id', thread), attr('attempt', 2), attr('status', 503), attr('duration_ms', 9)]});
  const stream = log('codex.sse_event', {attributes: [attr('kind', 'response.completed'), attr('duration_ms', 7), attr('output_token_count', 321)]});
  assert.deepEqual(await post(capture, logs(first, second, stream)), {status: 200, body: {}});
  const [batch] = await captured(capture);
  assert.equal(batch.records.length, 3);
  assert.equal(batch.records[0].attributes.attempt, 1);
  assert.equal(batch.records[1].attributes.attempt, 2);
  assert.equal(batch.records[0].attributes['conversation.id'], thread);
  assert.equal(batch.records[0].attributes.response_id, 'resp_5678');
  assert.equal(batch.records[2].attributes.kind, 'response.completed');
  assert.equal(batch.records[2].timingMeaning, 'stream-event-processing');
  assert.equal(batch.records[0].timingMeaning, 'reported-request-total');
  assert.equal(batch.records[0].timeUnixNano, first.timeUnixNano);
  assert.equal(batch.provenance.exporterIdentity, 'unattested-local-sender');
  assert.equal(capture.status().requestsAccepted, 1);
});

test('secret fixtures in bodies, headers, fields, attributes and names never reach disk or status', async t => {
  const {capture} = await fixture(t);
  const secrets = ['sk-proj-abc123456789SECRET', 'Bearer abc123456789SECRET', 'PROMPT PRIVATE CONTENT',
    'TOOL PRIVATE RESULT', 'ERROR PRIVATE DETAIL', 'ghp_abcdef123456789', 'gpt-secret-value'];
  const payload = logs(log('codex.api_request', {body: {stringValue: secrets[2]},
    attributes: [...log().attributes, attr('prompt', secrets[2]), attr('tool_result', secrets[3]), attr('error', secrets[4]),
      attr('response_id', secrets[0]), attr('provider', secrets[1]), attr('model', secrets[6])],
    exception: {message: secrets[4]}, secret: secrets[5]}), log(secrets[5]));
  payload.rawHeaders = secrets[0];
  assert.equal((await post(capture, payload, {headers: {authorization: secrets[1], 'x-api-key': secrets[0]}})).status, 200);
  const final = await capture.close();
  const all = (await Promise.all((await readdir(capture.directory)).map(name => readFile(join(capture.directory, name), 'utf8')))).join('') + JSON.stringify(final);
  for (const value of secrets) assert.equal(all.includes(value), false, value);
  assert.equal(final.droppedRecords, 1);
  assert.ok(final.droppedAttributes >= 6);
  assert.ok(final.droppedFields >= 4);
});

test('JSON metric histograms preserve aggregates and signal meaning, not invented individual timings', async t => {
  const {capture} = await fixture(t);
  const payload = metrics('codex.responses_api_engine_service_ttft.duration_ms', 'histogram', {
    aggregationTemporality: 2, dataPoints: [{timeUnixNano: '1792790000123456789', count: '2', sum: 47, min: 20, max: 27,
      bucketCounts: ['0', '2', '0'], explicitBounds: [10, 30], attributes: [attr('model', 'gpt-6.1-sol')],
      exemplars: [{filteredAttributes: [attr('prompt', 'PRIVATE EXEMPLAR')]}]}]});
  assert.equal((await post(capture, payload, {path: '/v1/metrics'})).status, 200);
  const record = (await captured(capture))[0].records[0];
  assert.equal(record.metricType, 'histogram'); assert.equal(record.count, 2);
  assert.equal(record.timingMeaning, 'provider-reported-engine-ttft');
  assert.deepEqual(record.bucketCounts, [0, 2, 0]);
  assert.equal(record.aggregationTemporality, 2);
  assert.equal(JSON.stringify(record).includes('PRIVATE EXEMPLAR'), false);
});

test('measured-size Codex metrics envelopes fit the fixed 1 MiB ceiling while larger bodies remain rejected', async t => {
  const {capture} = await fixture(t);
  const payload = metrics('codex.responses_api_inference_time.duration_ms', 'histogram', {
    aggregationTemporality: 2, dataPoints: [{count: '1', sum: 23, bucketCounts: ['1'], explicitBounds: []}]
  });
  payload.resourceMetrics[0].scopeMetrics[0].metrics[0].description = 'UNRETAINED LARGE DESCRIPTION '.padEnd(856000, 'x');
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  assert.ok(bytes > 856223 && bytes < 1024 * 1024);
  assert.equal((await post(capture, payload, {path: '/v1/metrics', headers: {'content-length': bytes}})).status, 200);
  const [batch] = await captured(capture);
  assert.equal(batch.records[0].timingMeaning, 'provider-reported-inference');
  assert.equal(JSON.stringify(batch).includes('UNRETAINED LARGE DESCRIPTION'), false);
  const oversized = 1024 * 1024 + 1;
  assert.equal((await post(capture, 'x'.repeat(oversized), {path: '/v1/metrics', headers: {'content-length': oversized}})).status, 413);
  assert.equal((await post(capture, logs(log()))).status, 200);
  assert.equal(capture.status().rejectionCounts.body_bound, 1);
});

test('JSON traces retain allowlisted spans, event boundaries, status code and fixed correlation', async t => {
  const {capture} = await fixture(t);
  const payload = traces({name: 'codex.websocket_request', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16),
    startTimeUnixNano: '1792790000000000000', endTimeUnixNano: '1792790023000000000',
    attributes: [attr('request_id', 'req_trace1')], status: {code: 2, message: 'PRIVATE ERROR'},
    events: [{name: 'codex.websocket_event', timeUnixNano: '1792790023000000000', attributes: [attr('kind', 'response.completed')]},
      {name: 'PRIVATE EVENT', attributes: [attr('body', 'PRIVATE PAYLOAD')]}], links: [{traceId: 'PRIVATE LINK'}]});
  assert.equal((await post(capture, payload, {path: '/v1/traces'})).status, 200);
  const batch = (await captured(capture))[0], record = batch.records[0];
  assert.equal(record.traceId, 'a'.repeat(32)); assert.equal(record.statusCode, 2);
  assert.equal(record.events.length, 1); assert.equal(record.events[0].attributes.kind, 'response.completed');
  assert.equal(batch.stats.droppedRecords, 0); assert.equal(batch.stats.droppedSpanEvents, 1);
  assert.equal(JSON.stringify(batch).includes('PRIVATE'), false);
});

test('unknown events, attribute values and malformed metric shapes are discarded with counts', () => {
  const filtered = sanitizeModelOtlp(logs(log('codex.user_prompt'), log('codex.api_request', {attributes: [attr('kind', 'novel.secret.event'), attr('novel.secret.key', 'PRIVATE VALUE'), attr('duration_ms', -1)]})), 'logs');
  assert.equal(filtered.records.length, 1); assert.deepEqual({...filtered.records[0].attributes}, {});
  assert.equal(filtered.stats.droppedRecords, 1); assert.equal(filtered.stats.droppedAttributes, 3);
  const invalid = sanitizeModelOtlp(metrics('codex.api_request.duration_ms', 'histogram', {dataPoints: [{count: '2', bucketCounts: [1, 1], explicitBounds: [20, 10]}]}), 'metrics');
  assert.equal(invalid.records.length, 0); assert.equal(invalid.stats.droppedRecords, 1);
  assert.throws(() => sanitizeModelOtlp(logs(log(), log()), 'logs', {maxRecords: 1}), /bound/i);
});

test('logging bridges accept only whole known body or message event names and bounded error codes', () => {
  const body = log(undefined, {eventName: undefined, body: {stringValue: 'codex.api_request'}, attributes: [attr('error.code', 'timeout')]});
  const message = log(undefined, {eventName: undefined, attributes: [attr('message', 'codex.sse_event'), attr('kind', 'response.completed'), attr('error.code', 'PRIVATE ERROR TEXT')]});
  const rejected = log(undefined, {eventName: undefined, body: {stringValue: 'codex.api_request PRIVATE BODY'}, attributes: [attr('message', 'codex.api_request PRIVATE MESSAGE')]});
  const filtered = sanitizeModelOtlp(logs(body, message, rejected), 'logs');
  assert.deepEqual(filtered.records.map(item => item.name), ['codex.api_request', 'codex.sse_event']);
  assert.equal(filtered.records[0].attributes['error.code'], 'timeout');
  assert.equal(filtered.records[1].attributes['error.code'], undefined);
  assert.equal(filtered.stats.droppedRecords, 1);
  assert.equal(JSON.stringify(filtered).includes('PRIVATE'), false);
  const throttled = sanitizeModelOtlp(logs(...['slow_down', 'server_is_overloaded', 'arbitrary PRIVATE ERROR'].map(code =>
    log('codex.api_request', {attributes: [attr('error.code', code), attr('attempt', 1), attr('status', 429)]}))), 'logs');
  assert.deepEqual(throttled.records.map(item => item.attributes['error.code']), ['slow_down', 'server_is_overloaded', undefined]);
  assert.equal(throttled.stats.droppedAttributes, 1);
  assert.equal(throttled.records[2].attributes.status, 429);
});

test('empty or unfamiliar eventName fields do not hide known attribute or body event names', () => {
  const payload = logs(log('', {attributes: [attr('event.name', 'codex.api_request')]}),
    log('unknown.private.namespace', {attributes: [attr('message', 'codex.sse_event')]}),
    log('', {attributes: [], body: {stringValue: 'codex.websocket_event'}}),
    log('unknown.private.namespace', {attributes: [attr('event.name', 'unknown.private.namespace')]}));
  const result = sanitizeModelOtlp(payload, 'logs');
  assert.deepEqual(result.records.map(item => item.name), ['codex.api_request', 'codex.sse_event', 'codex.websocket_event']);
  assert.equal(result.stats.droppedRecords, 1);
  assert.deepEqual(result.stats.schemaFingerprint.eventNameField, {missing: 0, empty: 2, known: 0, otherString: 2, nonString: 0});
  assert.equal(result.stats.schemaFingerprint.knownAttributeKeys['event.name'], 2);
  assert.equal(JSON.stringify(result).includes('unknown.private.namespace'), false);
});

test('schema fingerprints retain finite known key/type and enum counts only, even for rejected envelopes', () => {
  const payload = {resource_metrics: [{scope_metrics: [{metrics: [{name: 'api_request', histogram: {data_points: [{asInt: '1'}]}}]}]}],
    PRIVATE_STRUCTURAL_KEY: {body: {stringValue: 'PRIVATE BODY'}}, resourceLogs: [{scopeLogs: [{logRecords: [
      log('', {body: {stringValue: 'PRIVATE BODY'}, attributes: [attr('conversation.id', 'PRIVATE VALUE'), attr('PRIVATE_ATTRIBUTE_KEY', 'PRIVATE VALUE')]})]}]}]};
  const result = fingerprintModelOtlp(payload);
  assert.equal(result.structuralKeyTypes['resource_metrics:array'], 1);
  assert.equal(result.knownMetricNameOccurrences.api_request, 1);
  assert.equal(result.knownAttributeKeys['conversation.id'], 1);
  assert.equal(result.unknownAttributeKeys, 1); assert.ok(result.unknownStructuralKeys >= 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  const oversized = fingerprintModelOtlp({resourceLogs: Array.from({length: 700}, () => ({}))});
  assert.ok(oversized.truncated > 0);
});

test('request body size, content type, route, JSON shape and record count are bounded over HTTP', async t => {
  const {capture} = await fixture(t, {maxBodyBytes: 2048, maxRecords: 2});
  assert.equal((await post(capture, 'x'.repeat(2049), {headers: {'content-length': 2049}})).status, 413);
  assert.equal((await post(capture, logs(log()), {headers: {'content-type': 'application/x-protobuf'}})).status, 415);
  assert.equal((await post(capture, logs(log()), {headers: {'content-encoding': 'gzip'}})).status, 415);
  assert.equal((await post(capture, logs(log()), {path: '/v1/logs?secret=private'})).status, 404);
  assert.equal((await post(capture, '{')).status, 400);
  assert.equal((await post(capture, {resourceLogs: {}})).status, 400);
  assert.equal((await post(capture, logs(log(), log(), log()))).status, 413);
  const rejected = await captured(capture);
  assert.deepEqual(rejected.map(item => item.rejectionCategory), ['invalid_json', 'invalid_shape', 'collection_bound']);
  assert.equal(rejected[0].stats.schemaFingerprint, null);
  assert.equal(rejected[2].stats.schemaFingerprint.eventNameField.known, 3);
  assert.deepEqual(capture.status().contentTypeCounts, {json: 6, protobuf: 1, other: 0, missing: 0});
  assert.equal(capture.status().rejectionCounts.content_type, 1);
  assert.equal(capture.status().rejectionCounts.encoding, 1);
  assert.equal(capture.status().rejectionCounts.body_bound, 1);
  assert.equal(capture.status().rejectionCounts.invalid_json, 1);
  assert.equal(capture.status().rejectionCounts.invalid_shape, 1);
  assert.equal(capture.status().rejectionCounts.collection_bound, 1);
  assert.equal(capture.status().maxDeclaredBodyBytes, 2049);
  assert.ok(capture.status().receivedBodyBytes > 0);
  assert.ok(capture.status().maxReceivedBodyBytes <= 2048);
  assert.equal((await post(capture, logs(log()))).status, 200);
});

test('a total record bound has a distinct safe rejection reason and retains a structural fingerprint', async t => {
  const {capture} = await fixture(t, {maxRecords: 2});
  const payload = {resourceLogs: [{scopeLogs: [{logRecords: [log(), log()]}, {logRecords: [log()]}]}]};
  assert.equal((await post(capture, payload)).status, 413);
  const [rejection] = await captured(capture);
  assert.equal(rejection.rejectionCategory, 'record_bound');
  assert.equal(rejection.stats.schemaFingerprint.eventNameField.known, 3);
  assert.equal(capture.status().rejectionCounts.record_bound, 1);
});

test('chunked oversized body and concurrent slow clients cannot bypass bounds', async t => {
  const {capture} = await fixture(t, {maxBodyBytes: 1024, maxConcurrent: 1, requestTimeoutMs: 1000});
  const held = http.request(capture.endpoint + '/v1/logs', {method: 'POST', headers: {'content-type': 'application/json'}});
  held.on('error', () => {});
  const connected = new Promise((resolve, reject) => { held.once('error', reject); held.once('socket', socket => socket.once('connect', resolve)); });
  held.write('{'); await connected;
  // A round trip to the same server establishes that the first request reached
  // its active-body phase, without relying on a fixed scheduling sleep.
  let rejected;
  for (let i = 0; i < 8 && rejected?.status !== 429; i++) rejected = await post(capture, logs(log()));
  assert.equal(rejected.status, 429);
  held.destroy();
  for (let i = 0; i < 20 && capture.status().activeRequests; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(capture.status().activeRequests, 0);
  const oversized = await new Promise((accept, reject) => {
    const request = http.request(capture.endpoint + '/v1/logs', {method: 'POST', headers: {'content-type': 'application/json'}}, response => {
      response.resume(); response.on('end', () => accept(response.statusCode));
    });
    request.on('error', reject); request.write(' '.repeat(1025)); request.end();
  });
  assert.equal(oversized, 413);
  assert.ok(capture.status().maxReceivedBodyBytes >= 1025);
  const terminal = await capture.close();
  assert.equal(terminal.activeRequests, 0); assert.ok(terminal.requestsInterrupted >= 1);
});

test('close bounds unfinished requests and reports interrupted responses instead of claiming delivery', async t => {
  const {capture} = await fixture(t, {closeTimeoutMs: 25});
  const held = http.request(capture.endpoint + '/v1/logs', {method: 'POST', headers: {'content-type': 'application/json'}});
  held.on('error', () => {});
  const connected = new Promise((resolve, reject) => { held.once('error', reject); held.once('socket', socket => socket.once('connect', resolve)); });
  held.write('{'); await connected;
  for (let i = 0; i < 20 && !capture.status().activeRequests; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(capture.status().activeRequests, 1);
  const final = await capture.close();
  assert.equal(final.terminalPersisted, true); assert.equal(final.activeRequests, 0);
  assert.equal(final.requestsAccepted, 0); assert.equal(final.requestsInterrupted, 1);
  assert.equal(final.responsesFinished, 0); assert.equal(final.responsesClosedBeforeFinish, 1);
  assert.equal(final.forcedSocketClosures, 1);
});

test('disk byte bound rejects an otherwise valid batch while retaining terminal headroom', async t => {
  const {capture} = await fixture(t, {maxBytes: 8192});
  assert.equal((await post(capture, logs(...Array.from({length: 32}, () => log())))).status, 503);
  const final = await capture.close();
  assert.equal(final.terminalPersisted, true); assert.equal(final.persistedRecords, 0);
  assert.equal(final.droppedRecords, 32); assert.equal(final.persistenceErrors, 1);
  assert.ok(final.bytesWritten <= 8192); assert.equal(final.filesWritten, 2);
});

test('storage is exclusive, ignored, create-only and reserves an honest terminal record', async t => {
  const {capture, workspace} = await fixture(t, {maxFiles: 3});
  await assert.rejects(createModelRequestCapture({workspace}), /EEXIST/);
  assert.equal((await post(capture, logs(log()))).status, 200);
  assert.equal((await post(capture, logs(log()))).status, 503);
  const final = await capture.close();
  assert.equal(final.terminalPersisted, true); assert.equal(final.filesWritten, 3);
  assert.equal(final.requestsAccepted, 1); assert.equal(final.requestsRejected, 1);
  assert.equal(final.persistenceErrors, 1); assert.equal(final.persistedRecords, 1); assert.equal(final.droppedRecords, 1);
  const terminal = JSON.parse(await readFile(join(capture.directory, 'terminal.json'), 'utf8'));
  assert.equal(terminal.terminalPersisted, true); assert.equal(terminal.filesWritten, 2);
  assert.match(terminal.accounting, /exclude this terminal/);
  assert.deepEqual(await capture.close(), final);
});

test('storage rejects linked cache directories and unignored output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'capture-link-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const workspace = join(root, 'workspace'), outside = join(root, 'outside');
  await mkdir(workspace); await mkdir(outside); await writeFile(join(workspace, '.gitignore'), 'cache/\n');
  try { await symlink(outside, join(workspace, 'cache'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Symlink privilege unavailable.'); throw error; }
  await assert.rejects(createModelRequestCapture({workspace}), /ordinary|unlinked/);
  assert.deepEqual(await readdir(outside), []);
  const other = join(root, 'unignored'); await mkdir(other); await writeFile(join(other, '.gitignore'), '');
  await assert.rejects(createModelRequestCapture({workspace: other}), /ignore cache/);
  await assert.rejects(createModelRequestCapture({workspace, host: '0.0.0.0'}), /127.0.0.1/);
});

test('caller-admitted output creates only the exact cache directory and rejects reuse or escape', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'capture-caller-'));
  t.after(() => rm(workspace, {recursive: true, force: true}));
  await writeFile(join(workspace, '.gitignore'), 'cache/\n');
  await mkdir(join(workspace, 'cache', 'owned-pilot'), {recursive: true});
  const outputDirectory = join(workspace, 'cache', 'owned-pilot', 'diagnostic-0001');
  const capture = await createModelRequestCapture({workspace, outputDirectory});
  try {
    assert.equal(capture.directory, outputDirectory);
    await assert.rejects(createModelRequestCapture({workspace, outputDirectory}), /EEXIST/);
    await assert.rejects(createModelRequestCapture({workspace, outputDirectory: join(workspace, 'outside')}), /cache/);
    assert.deepEqual(await readdir(join(workspace, 'cache')), ['owned-pilot']);
  } finally { await capture.close(); }
});

test('timing classification preserves uncertainty and never identifies network from duration', () => {
  for (const name of ['codex.api_request', 'codex.api_request.duration_ms']) assert.equal(classifyModelTiming(name), 'reported-request-total');
  for (const name of ['codex.websocket_request', 'codex.websocket.request.duration_ms']) assert.equal(classifyModelTiming(name), 'reported-websocket-request-duration');
  for (const name of ['codex.sse_event.duration_ms', 'codex.websocket.event.duration_ms']) assert.equal(classifyModelTiming(name), 'stream-event-processing');
  assert.equal(classifyModelTiming('codex.responses_api_engine_iapi_ttft.duration_ms'), 'provider-reported-engine-ttft');
  assert.equal(classifyModelTiming('codex.turn.ttft.duration_ms'), 'reported-turn-ttft');
  assert.equal(classifyModelTiming('unknown.duration_ms'), 'unclassified');
});

test('short WebSocket duration remains distinct from emitter-observed completion interval and collector arrival', () => {
  const result = sanitizeModelOtlp(logs(
    log('codex.websocket_request', {timeUnixNano: '0', observedTimeUnixNano: '1792790000000000000', attributes: [attr('duration_ms', 1)]}),
    log('codex.sse_event', {timeUnixNano: '0', observedTimeUnixNano: '1792790002914000000', attributes: [attr('kind', 'response.completed'), attr('duration_ms', 0)]})), 'logs');
  assert.equal(result.records[0].attributes.duration_ms, 1);
  assert.equal(result.records[0].timingMeaning, 'reported-websocket-request-duration');
  assert.equal(result.records[0].timeUnixNano, '0');
  assert.deepEqual(result.records[0].emittedTimestamp, {unixNano: '1792790000000000000', field: 'observedTimeUnixNano', meaning: 'emitter-observed-time'});
  assert.equal(result.records[1].emittedTimestamp.unixNano, '1792790002914000000');
  assert.equal(result.records[0].durationMs, undefined);
  assert.equal(result.records[0].collectorReceivedAt, undefined);
  const zeroOnly = sanitizeModelOtlp(logs(log('codex.api_request', {timeUnixNano: '0'})), 'logs');
  assert.equal(zeroOnly.records[0].emittedTimestamp, undefined);
  const explicit = sanitizeModelOtlp(logs(log()), 'logs');
  assert.equal(explicit.records[0].emittedTimestamp.field, 'timeUnixNano');
});

test('module import remains inert when the host provides no global process', () => {
  const url = new URL('./model-request-capture.mjs', import.meta.url).href;
  const code = `const hostProcess = process; globalThis.process = undefined; const mod = await import(${JSON.stringify(url)}); hostProcess.stdout.write(typeof mod.createModelRequestCapture);`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '--eval', code], {encoding: 'utf8'}), 'function');
});
