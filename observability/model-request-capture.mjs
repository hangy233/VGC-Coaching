import http from 'node:http';
import {constants} from 'node:fs';
import {lstat, mkdir, open, readFile, readdir, realpath, unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

// Deliberately no SDK, proxy, credential handling, or model requests. Only the
// explicitly configured exporter can supply model telemetry to this listener.
// The installed Codex runtime emitted an 856223-byte JSON metrics envelope.
// Admit that measured payload within a fixed 1 MiB ceiling; retained records,
// disk use, concurrency and collection limits remain independently bounded.
export const MODEL_CAPTURE_LIMITS = Object.freeze({maxBodyBytes: 1024 * 1024, maxConcurrent: 4,
  maxConnections: 16, maxRecords: 512, maxFiles: 32, maxBytes: 4 * 1024 * 1024,
  maxSessions: 8, maxArchiveBytes: 32 * 1024 * 1024, requestTimeoutMs: 3000, closeTimeoutMs: 4000});
const SOURCE = 'https://learn.chatgpt.com/docs/config-file/config-advanced';
const EVENTS = new Set(['codex.conversation_starts', 'codex.api_request', 'codex.sse_event',
  'codex.websocket_request', 'codex.websocket_event']);
const METRICS = new Set(['codex.api_request', 'codex.api_request.duration_ms', 'codex.sse_event',
  'codex.sse_event.duration_ms', 'codex.websocket.request', 'codex.websocket.request.duration_ms',
  'codex.websocket.event', 'codex.websocket.event.duration_ms', 'codex.responses_api_overhead.duration_ms',
  'codex.responses_api_inference_time.duration_ms', 'codex.responses_api_engine_iapi_ttft.duration_ms',
  'codex.responses_api_engine_service_ttft.duration_ms', 'codex.responses_api_engine_iapi_tbt.duration_ms',
  'codex.responses_api_engine_service_tbt.duration_ms', 'codex.transport.fallback_to_http',
  'codex.turn.e2e_duration_ms', 'codex.turn.ttft.duration_ms', 'codex.turn.ttfm.duration_ms', 'codex.turn.token_usage']);
const KINDS = new Set(['response.created', 'response.in_progress', 'response.completed', 'response.failed',
  'response.incomplete', 'response.output_item.added', 'response.output_item.done', 'response.content_part.added',
  'response.content_part.done', 'response.output_text.delta', 'response.output_text.done',
  'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done', 'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done', 'response.function_call_arguments.delta', 'response.function_call_arguments.done',
  'response.refusal.delta', 'response.refusal.done', 'error', 'done']);
const ID_KEYS = new Set(['conversation.id', 'conversation_id', 'thread.id', 'thread_id', 'request.id',
  'request_id', 'response.id', 'response_id', 'turn_id', 'turn.id', 'client_request_id', 'server_request_id']);
const NUM_KEYS = new Set(['duration_ms', 'duration', 'attempt', 'attempt_count', 'retry', 'retry_count',
  'retry_delay_ms', 'status', 'status_code', 'http.response.status_code', 'input_tokens', 'output_tokens',
  'cached_input_tokens', 'reasoning_output_tokens', 'total_tokens', 'input_token_count', 'output_token_count',
  'cached_token_count', 'reasoning_token_count', 'total_token_count', 'input_cached_tokens',
  'responses_api_overhead_ms', 'responses_api_inference_time_ms', 'engine_iapi_ttft_ms',
  'engine_service_ttft_ms', 'engine_iapi_tbt_ms', 'engine_service_tbt_ms']);
const EFFORT = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const PROVIDERS = new Set(['openai', 'azure', 'azure_openai', 'bedrock', 'anthropic', 'google', 'gemini', 'ollama', 'lmstudio']);
const ERROR_CODES = new Set(['timeout', 'connection_failed', 'rate_limit_exceeded', 'server_error', 'service_unavailable',
  'request_aborted', 'incomplete_response', 'context_length_exceeded', 'invalid_request_error', 'authentication_error',
  'permission_denied', 'overloaded_error', 'insufficient_quota', 'slow_down', 'server_is_overloaded']);
const SECRET = /(?:sk-(?:proj-|svcacct-)?[a-z0-9_-]{8,}|\bbearer\b|gh[pousr]_[a-z0-9]+|\beyJ[a-z0-9_-]*\.[a-z0-9_-]+\.|-----BEGIN|password|api[_-]?key|secret|token=)/i;
const ID = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{16,64}|(?:req|resp|turn|thread|conv|call)_[a-z0-9_-]{1,120})$/i;
const SESSION = /^capture-[a-f0-9-]{36}$/;
const RECORD_FILE = /^batch-\d{6}\.json$/;
const STRUCTURE_KEYS = new Set(['resourceLogs', 'scopeLogs', 'logRecords', 'resourceMetrics', 'scopeMetrics', 'metrics',
  'resourceSpans', 'scopeSpans', 'spans', 'resource_logs', 'scope_logs', 'log_records', 'resource_metrics', 'scope_metrics',
  'resource_spans', 'scope_spans', 'instrumentationLibraryLogs', 'instrumentationLibraryMetrics', 'instrumentationLibrarySpans',
  'resource', 'scope', 'schemaUrl', 'attributes', 'key', 'value', 'eventName', 'event_name', 'body', 'name', 'description',
  'unit', 'sum', 'gauge', 'histogram', 'exponentialHistogram', 'summary', 'dataPoints', 'data_points', 'aggregationTemporality',
  'isMonotonic', 'timeUnixNano', 'observedTimeUnixNano', 'startTimeUnixNano', 'endTimeUnixNano', 'time_unix_nano',
  'observed_time_unix_nano', 'start_time_unix_nano', 'end_time_unix_nano', 'traceId', 'spanId', 'parentSpanId', 'flags',
  'severityNumber', 'severityText', 'droppedAttributesCount', 'events', 'links', 'status', 'code', 'message', 'kind',
  'traceState', 'droppedEventsCount', 'droppedLinksCount', 'asDouble', 'asInt', 'count', 'min', 'max', 'bucketCounts',
  'explicitBounds', 'exemplars', 'scale', 'zeroCount', 'positive', 'negative', 'offset', 'quantileValues', 'quantile',
  'stringValue', 'intValue', 'doubleValue', 'boolValue', 'arrayValue', 'kvlistValue', 'bytesValue', 'values']);
const KNOWN_ATTRIBUTE_KEYS = new Set([...ID_KEYS, ...NUM_KEYS, 'error.code', 'error_code', 'success', 'retryable', 'kind',
  'event.kind', 'model', 'gen_ai.request.model', 'gen_ai.response.model', 'reasoning_effort', 'effort', 'reasoning.effort',
  'model_provider', 'provider', 'gen_ai.provider.name', 'token_type', 'from_wire_api', 'service.name', 'app.version',
  'service.version', 'telemetry.sdk.version', 'event.name', 'event_name', 'message', 'target', 'level']);
const REJECTIONS = ['closing', 'concurrency', 'route', 'content_type', 'encoding', 'body_bound', 'invalid_json', 'invalid_shape',
  'record_bound', 'collection_bound', 'interrupted', 'persistence_failure', 'internal'];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const numeric = value => finite(value) ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && finite(Number(value)) ? Number(value) : undefined;
const nanos = value => typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : undefined;
const identifier = value => typeof value === 'string' && ID.test(value) && !SECRET.test(value) ? value : undefined;
const hex = (value, size) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`, 'i').test(value) ? value : undefined;
function scalar(value) {
  if (!object(value)) return undefined;
  if (own(value, 'stringValue') && typeof value.stringValue === 'string') return value.stringValue;
  if (own(value, 'boolValue') && typeof value.boolValue === 'boolean') return value.boolValue;
  if (own(value, 'intValue')) return numeric(value.intValue);
  if (own(value, 'doubleValue')) return numeric(value.doubleValue);
}
function safeAttribute(key, value) {
  if (ID_KEYS.has(key)) return identifier(value);
  if (NUM_KEYS.has(key)) return numeric(value);
  if (key === 'error.code' || key === 'error_code') return numeric(value) ?? (ERROR_CODES.has(value) ? value : undefined);
  if (key === 'success' || key === 'retryable') return typeof value === 'boolean' ? value : undefined;
  if (key === 'kind' || key === 'event.kind') return KINDS.has(value) ? value : undefined;
  if (key === 'model' || key === 'gen_ai.request.model' || key === 'gen_ai.response.model') {
    return typeof value === 'string' && /^(?:gpt|codex|o[1-9])[a-z0-9_.:-]{0,75}$/i.test(value) && !SECRET.test(value) ? value : undefined;
  }
  if (['reasoning_effort', 'effort', 'reasoning.effort'].includes(key)) return EFFORT.has(value) ? value : undefined;
  if (['model_provider', 'provider', 'gen_ai.provider.name'].includes(key)) return PROVIDERS.has(value) ? value : undefined;
  if (key === 'token_type') return ['total', 'input', 'cached_input', 'output', 'reasoning_output'].includes(value) ? value : undefined;
  if (key === 'from_wire_api') return ['responses', 'chat', 'websocket'].includes(value) ? value : undefined;
  if (key === 'service.name') return ['codex', 'codex-cli', 'codex_cli_rs', 'codex-app-server', 'codex-otel'].includes(value) ? value : undefined;
  if (['app.version', 'service.version', 'telemetry.sdk.version'].includes(key)) return typeof value === 'string' && /^\d[\d.a-z+-]{0,39}$/i.test(value) ? value : undefined;
}
/** A duration is retained under its documented boundary, never inferred as wire
 * latency. Export timestamps may be batched/delayed and need not share a clock. */
export function classifyModelTiming(name) {
  if (/sse_event|websocket[._]event/.test(name)) return 'stream-event-processing';
  if (/engine_.*ttft/.test(name)) return 'provider-reported-engine-ttft';
  if (/engine_.*tbt/.test(name)) return 'provider-reported-engine-tbt';
  if (/inference_time/.test(name)) return 'provider-reported-inference';
  if (/overhead/.test(name)) return 'provider-reported-overhead';
  if (/turn\.ttft/.test(name)) return 'reported-turn-ttft';
  if (/turn\.ttfm/.test(name)) return 'reported-turn-first-model-item';
  if (/turn\.e2e/.test(name)) return 'reported-turn-total';
  // Observed Codex websocket_request duration may cover a short transport
  // operation while response.completed arrives seconds later. It does not
  // establish an exact send boundary or the complete model round trip.
  if (/websocket[._]request/.test(name)) return 'reported-websocket-request-duration';
  if (/api_request/.test(name)) return 'reported-request-total';
  return 'unclassified';
}
function boundedArray(value, max, label) {
  if (!Array.isArray(value)) throw new TypeError(`Invalid bounded ${label}.`);
  if (value.length > max) { const error = new RangeError(`Bound exceeded for ${label}.`); error.captureCode = 'collection_bound'; throw error; }
  return value;
}
function unknownFields(value, allowed, stats) {
  if (!object(value)) return;
  for (const key of Object.keys(value)) if (!allowed.includes(key)) stats.droppedFields++;
}
function attributes(value, stats) {
  const out = Object.create(null);
  for (const item of boundedArray(value ?? [], 128, 'attributes')) {
    if (!object(item) || typeof item.key !== 'string') { stats.droppedAttributes++; continue; }
    const safe = safeAttribute(item.key, scalar(item.value));
    if (safe === undefined || own(out, item.key)) stats.droppedAttributes++;
    else out[item.key] = safe;
  }
  return out;
}
function eventName(record) {
  if (EVENTS.has(record.eventName)) return record.eventName;
  for (const item of record.attributes ?? []) {
    if (['event.name', 'event_name', 'message'].includes(item?.key) && EVENTS.has(scalar(item.value))) return scalar(item.value);
  }
  // Some OTLP logging bridges use the exact event name as their string body.
  const bodyName = scalar(record.body);
  return EVENTS.has(bodyName) ? bodyName : undefined;
}
/** Bounded structural counts only. Keys and enum values come from fixed local
 * vocabularies. Unknown keys/values are represented solely by numeric counts. */
export function fingerprintModelOtlp(payload) {
  const out = {version: 1, structuralKeyTypes: {}, knownAttributeKeys: {}, knownEventNameOccurrences: {},
    knownMetricNameOccurrences: {}, eventNameField: {missing: 0, empty: 0, known: 0, otherString: 0, nonString: 0},
    unknownStructuralKeys: 0, unknownAttributeKeys: 0, unknownNameStrings: 0, truncated: 0};
  let remaining = 4096;
  const increment = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
  const type = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  function visit(value, depth = 0, context = '') {
    if (remaining-- <= 0 || depth > 12) { out.truncated++; return; }
    if (Array.isArray(value)) {
      const count = Math.min(value.length, 512);
      if (count < value.length) out.truncated += value.length - count;
      for (let i = 0; i < count; i++) visit(value[i], depth + 1, context);
      return;
    }
    if (!object(value)) return;
    if (context === 'logRecords' || context === 'log_records') {
      const candidate = value.eventName;
      out.eventNameField[!own(value, 'eventName') ? 'missing' : candidate === '' ? 'empty' : EVENTS.has(candidate) ? 'known' : typeof candidate === 'string' ? 'otherString' : 'nonString']++;
    }
    if (typeof value.key === 'string' && own(value, 'value')) {
      if (KNOWN_ATTRIBUTE_KEYS.has(value.key)) increment(out.knownAttributeKeys, value.key);
      else out.unknownAttributeKeys++;
      if (['event.name', 'event_name', 'message'].includes(value.key) && EVENTS.has(scalar(value.value))) increment(out.knownEventNameOccurrences, scalar(value.value));
    }
    for (const key of Object.keys(value)) {
      if (!STRUCTURE_KEYS.has(key)) { out.unknownStructuralKeys++; continue; }
      const item = value[key]; increment(out.structuralKeyTypes, `${key}:${type(item)}`);
      if (['eventName', 'event_name', 'name', 'stringValue'].includes(key)) {
        if (EVENTS.has(item)) increment(out.knownEventNameOccurrences, item);
        else if (METRICS.has(item) || METRICS.has('codex.' + item)) increment(out.knownMetricNameOccurrences, item);
        else if (typeof item === 'string' && key === 'name') out.unknownNameStrings++;
      }
      if (object(item) || Array.isArray(item)) visit(item, depth + 1, key);
    }
  }
  visit(payload);
  return out;
}
function identity(record) {
  const out = {};
  for (const key of ['timeUnixNano', 'observedTimeUnixNano', 'startTimeUnixNano', 'endTimeUnixNano']) {
    const value = nanos(record[key]); if (value !== undefined) out[key] = value;
  }
  for (const [key, size] of [['traceId', 32], ['spanId', 16], ['parentSpanId', 16]]) {
    const value = hex(record[key], size); if (value !== undefined) out[key] = value;
  }
  // Preserve both original emitted fields. An OTLP zero timestamp is absent;
  // its observed timestamp is explicitly emitter-observed, never collector
  // arrival time and never silently promoted to the emitter's event timestamp.
  if (out.timeUnixNano && !/^0+$/.test(out.timeUnixNano)) {
    out.emittedTimestamp = {unixNano: out.timeUnixNano, field: 'timeUnixNano', meaning: 'emitter-event-time'};
  } else if (out.observedTimeUnixNano && !/^0+$/.test(out.observedTimeUnixNano)) {
    out.emittedTimestamp = {unixNano: out.observedTimeUnixNano, field: 'observedTimeUnixNano', meaning: 'emitter-observed-time'};
  }
  return out;
}
/** Project only explicitly permitted scalars. No raw body, attribute values,
 * header, scope name, exception, description, prompt, or tool result survives. */
export function sanitizeModelOtlp(payload, signal, {maxRecords = MODEL_CAPTURE_LIMITS.maxRecords} = {}) {
  if (!object(payload) || !['logs', 'metrics', 'traces'].includes(signal) || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > MODEL_CAPTURE_LIMITS.maxRecords) throw new TypeError('Invalid OTLP envelope.');
  const stats = {receivedRecords: 0, droppedRecords: 0, capturedSpanEvents: 0, droppedSpanEvents: 0, droppedAttributes: 0, droppedFields: 0,
    schemaFingerprint: fingerprintModelOtlp(payload)};
  const records = [], key = {logs: 'resourceLogs', metrics: 'resourceMetrics', traces: 'resourceSpans'}[signal];
  unknownFields(payload, [key], stats);
  let visited = 0;
  const visit = (record = true) => { if (++visited > maxRecords) { const error = new RangeError('Record bound exceeded.'); error.captureCode = 'record_bound'; throw error; } if (record) stats.receivedRecords++; };
  for (const group of boundedArray(payload[key], maxRecords, 'resource groups')) {
    if (!object(group)) throw new TypeError('Invalid OTLP resource.');
    const resource = attributes(group.resource?.attributes, stats);
    unknownFields(group.resource, ['attributes', 'droppedAttributesCount'], stats);
    const scopeKey = {logs: 'scopeLogs', metrics: 'scopeMetrics', traces: 'scopeSpans'}[signal];
    unknownFields(group, ['resource', scopeKey, 'schemaUrl'], stats);
    for (const scope of boundedArray(group[scopeKey] ?? [], maxRecords, 'scopes')) {
      if (!object(scope)) throw new TypeError('Invalid OTLP scope.');
      const leafKey = {logs: 'logRecords', metrics: 'metrics', traces: 'spans'}[signal];
      unknownFields(scope, ['scope', leafKey, 'schemaUrl'], stats);
      // Scope names/attributes are intentionally not recorded or trusted.
      if (scope.scope) stats.droppedFields++;
      for (const leaf of boundedArray(scope[leafKey] ?? [], maxRecords, 'records')) {
        if (!object(leaf)) throw new TypeError('Invalid OTLP record.');
        if (signal === 'metrics') {
          const name = leaf.name;
          if (!METRICS.has(name)) { visit(); stats.droppedRecords++; continue; }
          unknownFields(leaf, ['name', 'description', 'unit', 'sum', 'gauge', 'histogram'], stats);
          const types = ['sum', 'gauge', 'histogram'].filter(type => own(leaf, type));
          if (types.length !== 1) { visit(); stats.droppedRecords++; continue; }
          const type = types[0], metric = leaf[type];
          if (!object(metric)) throw new TypeError('Invalid OTLP metric.');
          unknownFields(metric, ['dataPoints', 'aggregationTemporality', 'isMonotonic'], stats);
          for (const point of boundedArray(metric.dataPoints ?? [], maxRecords, 'data points')) {
            visit(); if (!object(point)) throw new TypeError('Invalid OTLP point.');
            unknownFields(point, ['attributes', 'startTimeUnixNano', 'timeUnixNano', 'asDouble', 'asInt', 'count', 'sum', 'min', 'max', 'bucketCounts', 'explicitBounds', 'flags', 'exemplars'], stats);
            const record = {signal, name, metricType: type, timingMeaning: classifyModelTiming(name),
              ...identity(point), resource, attributes: attributes(point.attributes, stats)};
            if (type === 'histogram') {
              record.count = numeric(point.count);
              if (!Number.isSafeInteger(record.count)) { stats.droppedRecords++; continue; }
              for (const field of ['sum', 'min', 'max']) { const value = numeric(point[field]); if (value !== undefined) record[field] = value; }
              const buckets = boundedArray(point.bucketCounts ?? [], 128, 'histogram buckets').map(numeric);
              const bounds = boundedArray(point.explicitBounds ?? [], 127, 'histogram bounds').map(numeric);
              if (buckets.some(v => !Number.isSafeInteger(v)) || bounds.some(v => v === undefined) || (buckets.length && buckets.length !== bounds.length + 1) || bounds.some((v, i) => i && v <= bounds[i - 1])) { stats.droppedRecords++; continue; }
              record.bucketCounts = buckets; record.explicitBounds = bounds;
            } else {
              record.value = numeric(point.asDouble ?? point.asInt);
              if (record.value === undefined) { stats.droppedRecords++; continue; }
            }
            if ([1, 2].includes(metric.aggregationTemporality)) record.aggregationTemporality = metric.aggregationTemporality;
            if (typeof metric.isMonotonic === 'boolean') record.isMonotonic = metric.isMonotonic;
            records.push(record);
          }
        } else {
          visit();
          const name = signal === 'logs' ? eventName(leaf) : leaf.name;
          if (!EVENTS.has(name)) { stats.droppedRecords++; continue; }
          unknownFields(leaf, signal === 'logs' ? ['eventName', 'timeUnixNano', 'observedTimeUnixNano', 'traceId', 'spanId', 'flags', 'severityNumber', 'severityText', 'attributes', 'droppedAttributesCount', 'body'] : ['name', 'traceId', 'spanId', 'parentSpanId', 'startTimeUnixNano', 'endTimeUnixNano', 'attributes', 'droppedAttributesCount', 'events', 'links', 'status', 'kind', 'flags', 'traceState', 'droppedEventsCount', 'droppedLinksCount'], stats);
          const record = {signal, name, timingMeaning: classifyModelTiming(name), ...identity(leaf), resource, attributes: attributes(leaf.attributes, stats)};
          if (leaf.body !== undefined) stats.droppedFields++;
          if (signal === 'traces') {
            if ([0, 1, 2].includes(leaf.status?.code)) record.statusCode = leaf.status.code;
            if (leaf.status?.message) stats.droppedFields++;
            if (leaf.links) stats.droppedFields++;
            record.events = [];
            for (const event of boundedArray(leaf.events ?? [], maxRecords, 'span events')) {
              visit(false);
              if (!object(event) || !EVENTS.has(event.name)) { stats.droppedSpanEvents++; continue; }
              unknownFields(event, ['name', 'timeUnixNano', 'attributes', 'droppedAttributesCount'], stats);
              record.events.push({name: event.name, ...identity(event), attributes: attributes(event.attributes, stats), timingMeaning: classifyModelTiming(event.name)});
              stats.capturedSpanEvents++;
            }
          }
          records.push(record);
        }
      }
    }
  }
  return {records, stats};
}
const inside = (root, path) => { const part = relative(root, path); return part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
async function ordinaryDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()) throw new Error('Capture directories must be ordinary unlinked paths.');
}
async function privateFile(path, bytes) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error('Capture file must be private and unlinked.');
    await handle.writeFile(bytes); await handle.sync();
  } finally { await handle.close(); }
}
function limitsFrom(options) {
  const limits = {...MODEL_CAPTURE_LIMITS};
  for (const key of Object.keys(limits)) if (options[key] !== undefined) {
    if (!Number.isSafeInteger(options[key]) || options[key] < 1 || options[key] > limits[key]) throw new TypeError(`Invalid ${key}.`);
    limits[key] = options[key];
  }
  if (limits.maxFiles < 3 || limits.maxBytes < 8192 || limits.maxArchiveBytes < limits.maxBytes) throw new TypeError('Capture storage limits are too small.');
  return limits;
}
async function storage(workspace, limits, outputDirectory) {
  const root = await realpath(workspace);
  await ordinaryDirectory(root);
  // A fixed cache-only location prevents CLI paths from escaping ignored output.
  const ignore = await readFile(join(root, '.gitignore'), 'utf8');
  if (!/^\/?cache\/\s*$/m.test(ignore) || /^!\/?cache(?:\/|\s*$)/m.test(ignore)) throw new Error('Workspace must ignore cache/.');
  if (outputDirectory !== undefined) {
    if (typeof outputDirectory !== 'string' || !isAbsolute(outputDirectory)) throw new TypeError('Capture output must be an absolute cache path.');
    const path = resolve(outputDirectory), cache = join(root, 'cache');
    if (!inside(cache, path)) throw new Error('Capture output must be inside workspace cache/.');
    // The caller owns/admitted this namespace. Validate existing ancestry, then
    // create only the requested directory; do not invent a second archive tree.
    let parent = root;
    for (const part of relative(root, dirname(path)).split(sep)) { parent = join(parent, part); await ordinaryDirectory(parent); }
    await mkdir(path, {mode: 0o700}); await ordinaryDirectory(path);
    return {id: randomUUID(), path, async release() {}};
  }
  let base = root;
  for (const component of ['cache', 'model-request-capture']) {
    base = join(base, component);
    try { await mkdir(base, {mode: 0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await ordinaryDirectory(base);
    if (!inside(root, base)) throw new Error('Capture output escaped workspace.');
  }
  const lockPath = join(base, '.capture.lock');
  await privateFile(lockPath, JSON.stringify({schemaVersion: 1, kind: 'model-capture-lock', pid: process.pid}) + '\n');
  let owned = true;
  try {
    let sessions = 0, archiveBytes = 0;
    for (const name of await readdir(base)) {
      if (name === '.capture.lock') continue;
      if (!SESSION.test(name)) throw new Error('Unknown capture cache entry; refusing retention or writes.');
      sessions++; const path = join(base, name); await ordinaryDirectory(path);
      const names = await readdir(path);
      if (names.length > MODEL_CAPTURE_LIMITS.maxFiles) throw new Error('Capture archive file bound exceeded.');
      for (const file of names) {
        if (!['session.json', 'terminal.json'].includes(file) && !RECORD_FILE.test(file)) throw new Error('Unknown capture archive file.');
        const info = await lstat(join(path, file));
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MODEL_CAPTURE_LIMITS.maxBodyBytes * 2) throw new Error('Unsafe capture archive file.');
        archiveBytes += info.size;
      }
    }
    if (sessions >= limits.maxSessions || archiveBytes + limits.maxBytes > limits.maxArchiveBytes) throw new Error('Capture archive bound reached; retain or remove an old capture explicitly.');
    const id = randomUUID(), path = join(base, 'capture-' + id);
    await mkdir(path, {mode: 0o700}); await ordinaryDirectory(path);
    return {id, path, async release() { if (owned) { owned = false; const info = await lstat(lockPath); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Capture lock changed.'); await unlink(lockPath); } }};
  } catch (error) { if (owned) await unlink(lockPath); throw error; }
}
function fail(code) { const error = new Error(code); error.captureCode = code; return error; }
/** The listener never starts on import. A caller must explicitly start it. */
export async function createModelRequestCapture(options = {}) {
  const {workspace = process.cwd(), port = 0} = options;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid loopback port.');
  if (options.host !== undefined && options.host !== '127.0.0.1') throw new TypeError('Capture binds only 127.0.0.1.');
  const limits = limitsFrom(options), target = await storage(workspace, limits, options.outputDirectory);
  const status = {schemaVersion: 1, captureId: target.id, state: 'starting', requestsReceived: 0, requestsAccepted: 0,
    requestsRejected: 0, requestsInterrupted: 0, activeRequests: 0, receivedRecords: 0, persistedRecords: 0,
    droppedRecords: 0, capturedSpanEvents: 0, droppedSpanEvents: 0, droppedAttributes: 0, droppedFields: 0, persistenceErrors: 0, filesWritten: 0, bytesWritten: 0,
    terminalPersisted: false, connectionsRejected: 0, responsesFinished: 0, responsesClosedBeforeFinish: 0, startedAt: new Date().toISOString(),
    maxDeclaredBodyBytes: 0, receivedBodyBytes: 0, maxReceivedBodyBytes: 0,
    rejectionCounts: Object.fromEntries(REJECTIONS.map(key => [key, 0])), contentTypeCounts: {json: 0, protobuf: 0, other: 0, missing: 0}};
  const provenance = {source: 'explicit-exporter-otlp-http-json-loopback', exporterIdentity: 'unattested-local-sender',
    documentation: SOURCE, limitation: 'Exporter-reported boundaries and clocks. Request total is not network latency; stream processing is not TTFT. Missing provider/queue/inference boundaries remain unknown.'};
  const terminalReserve = 4096;
  let pending = Promise.resolve(), closePromise, accepting = true, sequence = 0;
  async function write(name, document, terminal = false) {
    const bytes = Buffer.from(JSON.stringify(document) + '\n');
    if (bytes.length > MODEL_CAPTURE_LIMITS.maxBodyBytes * 2 || status.filesWritten >= limits.maxFiles - (terminal ? 0 : 1) || status.bytesWritten + bytes.length > limits.maxBytes - (terminal ? 0 : terminalReserve)) throw fail('storage_bound');
    await ordinaryDirectory(target.path);
    await privateFile(join(target.path, name), bytes);
    status.filesWritten++; status.bytesWritten += bytes.length;
  }
  try { await write('session.json', {schemaVersion: 1, kind: 'model-request-capture-session', captureId: target.id, startedAt: status.startedAt, limits, provenance}); }
  catch (error) { await target.release(); throw error; }
  const snapshot = () => ({...status, rejectionCounts: {...status.rejectionCounts}, contentTypeCounts: {...status.contentTypeCounts}});
  const enqueue = document => {
    const task = pending.then(() => write(`batch-${String(++sequence).padStart(6, '0')}.json`, document));
    pending = task.catch(() => {}); return task;
  };
  const sockets = new Set(), operations = new Set();
  const server = http.createServer({maxHeaderSize: 8192}, (request, response) => {
    const collectorReceivedAt = new Date().toISOString();
    status.requestsReceived++;
    response.once('finish', () => { status.responsesFinished++; });
    response.once('close', () => { if (!response.writableFinished) status.responsesClosedBeforeFinish++; });
    const reply = (code, body = {}) => { if (!response.destroyed && !response.writableEnded) { response.writeHead(code, {'content-type': 'application/json', 'connection': 'close'}); response.end(JSON.stringify(body)); } };
    const reject = (code, category) => { status.requestsRejected++; status.rejectionCounts[category]++; reply(code); request.resume(); };
    const media = request.headers['content-type'];
    const contentType = /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(media ?? '') ? 'json' :
      /^application\/(?:x-protobuf|protobuf)(?:\s*;[^\r\n]*)?$/i.test(media ?? '') ? 'protobuf' : media === undefined ? 'missing' : 'other';
    status.contentTypeCounts[contentType]++;
    if (!accepting) return reject(503, 'closing');
    if (status.activeRequests >= limits.maxConcurrent) return reject(429, 'concurrency');
    const signal = {'/v1/logs': 'logs', '/v1/metrics': 'metrics', '/v1/traces': 'traces'}[request.url];
    if (request.method !== 'POST' || !signal) return reject(404, 'route');
    if (contentType !== 'json') return reject(415, 'content_type');
    if (request.headers['content-encoding']) return reject(415, 'encoding');
    const length = request.headers['content-length'];
    const declaredBytes = typeof length === 'string' && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) ? Number(length) : undefined;
    if (declaredBytes !== undefined) status.maxDeclaredBodyBytes = Math.max(status.maxDeclaredBodyBytes, declaredBytes);
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limits.maxBodyBytes)) return reject(413, 'body_bound');
    status.activeRequests++;
    const operation = (async () => {
      let interrupted = false;
      const onAbort = () => { interrupted = true; };
      request.on('aborted', onAbort);
      const timer = setTimeout(() => { interrupted = true; request.destroy(); }, limits.requestTimeoutMs); timer.unref();
      try {
        const chunks = []; let count = 0;
        for await (const chunk of request) {
          count += chunk.length; status.receivedBodyBytes += chunk.length;
          status.maxReceivedBodyBytes = Math.max(status.maxReceivedBodyBytes, count);
          if (count > limits.maxBodyBytes) { reply(413); throw fail('body_bound'); }
          chunks.push(chunk);
        }
        if (interrupted) throw fail('interrupted');
        const collectorBodyCompletedAt = new Date().toISOString();
        let filtered, parsed, parseCategory;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { parseCategory = 'invalid_json'; }
        if (!parseCategory) {
          try { filtered = sanitizeModelOtlp(parsed, signal, limits); }
          catch (error) { parseCategory = ['record_bound', 'collection_bound'].includes(error.captureCode) ? error.captureCode : 'invalid_shape'; }
        }
        if (parseCategory) {
          try {
            await enqueue({schemaVersion: 1, kind: 'model-request-capture-rejection', captureId: target.id, signal,
              collectorReceivedAt, collectorBodyCompletedAt, provenance, rejectionCategory: parseCategory,
              stats: {schemaFingerprint: parseCategory === 'invalid_json' ? null : fingerprintModelOtlp(parsed)}, records: []});
          } catch { status.persistenceErrors++; }
          reply(['record_bound', 'collection_bound'].includes(parseCategory) ? 413 : 400); throw fail(parseCategory);
        }
        for (const key of Object.keys(filtered.stats)) if (typeof filtered.stats[key] === 'number') status[key] += filtered.stats[key];
        // Serialize writes; at most maxConcurrent bounded requests can be queued.
        const task = enqueue({schemaVersion: 1, kind: 'model-request-capture-batch', captureId: target.id, signal,
          collectorReceivedAt, collectorBodyCompletedAt, collectorWriteStartedAt: new Date().toISOString(), provenance, stats: filtered.stats, records: filtered.records});
        try { await task; } catch { status.persistenceErrors++; status.droppedRecords += filtered.records.length; reply(503); throw fail('persistence_failure'); }
        status.persistedRecords += filtered.records.length;
        status.requestsAccepted++;
        const rejected = filtered.stats.droppedRecords;
        const field = {logs: 'rejectedLogRecords', metrics: 'rejectedDataPoints', traces: 'rejectedSpans'}[signal];
        reply(200, rejected ? {partialSuccess: {[field]: String(rejected)}} : {});
      } catch (error) {
        status.requestsRejected++;
        const category = interrupted ? 'interrupted' : REJECTIONS.includes(error.captureCode) ? error.captureCode : 'internal';
        status.rejectionCounts[category]++;
        if (interrupted) status.requestsInterrupted++;
        reply(400);
      }
      finally { clearTimeout(timer); request.off('aborted', onAbort); status.activeRequests--; }
    })();
    operations.add(operation); void operation.finally(() => operations.delete(operation));
  });
  server.maxConnections = limits.maxConnections;
  server.headersTimeout = limits.requestTimeoutMs;
  server.requestTimeout = limits.requestTimeoutMs;
  server.keepAliveTimeout = 1;
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.setTimeout(limits.requestTimeoutMs, () => socket.destroy()); });
  server.on('clientError', (_error, socket) => { status.requestsRejected++; status.rejectionCounts.internal++; socket.destroy(); });
  server.on('drop', () => { status.connectionsRejected++; });
  try {
    await new Promise((accept, reject) => { server.once('error', reject); server.listen({host: '127.0.0.1', port, exclusive: true}, () => { server.off('error', reject); accept(); }); });
  } catch (error) { await target.release(); throw error; }
  status.state = 'listening';
  const address = server.address();
  return {directory: target.path, endpoint: `http://127.0.0.1:${address.port}`, limits,
    status: snapshot,
    close(reason = 'requested') {
      if (closePromise) return closePromise;
      const terminalReason = ['requested', 'SIGINT', 'SIGTERM'].includes(reason) ? reason : 'requested';
      closePromise = (async () => {
        accepting = false; status.state = 'closing';
        let forcedSocketClosures = 0;
        const closed = new Promise(accept => server.close(accept)); server.closeIdleConnections();
        const timer = setTimeout(() => { forcedSocketClosures = sockets.size; for (const socket of sockets) socket.destroy(); }, limits.closeTimeoutMs); timer.unref();
        await closed; clearTimeout(timer); await Promise.allSettled([...operations]); await pending;
        status.state = 'closed'; status.closedAt = new Date().toISOString(); status.forcedSocketClosures = forcedSocketClosures;
        status.terminalReason = terminalReason;
        try {
          // The terminal snapshot states whether persistence succeeded in the
          // file itself. Its file/byte totals explicitly precede this write.
          await write('terminal.json', {schemaVersion: 1, kind: 'model-request-capture-terminal',
            ...status, terminalPersisted: true, accounting: 'filesWritten and bytesWritten exclude this terminal file; requestsAccepted means persisted batches; responsesFinished means locally written responses, not exporter receipt; receivedBodyBytes counts ingested chunks, excluding bodies drained after a declared-length rejection', provenance}, true);
          status.terminalPersisted = true;
        } catch { status.persistenceErrors++; }
        try { await target.release(); } catch { status.persistenceErrors++; status.lockReleaseFailed = true; }
        return snapshot();
      })();
      return closePromise;
    }};
}

export async function modelCaptureMain(argv = process.argv.slice(2)) {
  const options = {}; let serve = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === 'serve' && !serve) { serve = true; continue; }
    if (['--workspace', '--port', '--output-directory'].includes(argv[i]) && argv[i + 1] !== undefined) {
      const key = argv[i] === '--output-directory' ? 'outputDirectory' : argv[i].slice(2);
      options[key] = key === 'port' ? Number(argv[++i]) : argv[++i];
    } else throw new TypeError('Usage: node observability/model-request-capture.mjs serve [--workspace PATH] [--output-directory NEW_CACHE_PATH] [--port PORT]');
  }
  if (!serve) throw new TypeError('Use explicit serve to start local capture.');
  const capture = await createModelRequestCapture(options);
  process.stdout.write(JSON.stringify({state: 'listening', endpoint: capture.endpoint, directory: capture.directory, pid: process.pid}) + '\n');
  const stop = async reason => { const result = await capture.close(reason); process.stdout.write(JSON.stringify(result) + '\n'); if (!result.terminalPersisted || result.lockReleaseFailed) process.exitCode = 1; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  return capture;
}
if (typeof process !== 'undefined' && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  modelCaptureMain().catch(() => { process.stderr.write('Model capture failed; no raw error or payload logged.\n'); process.exitCode = 1; });
}
