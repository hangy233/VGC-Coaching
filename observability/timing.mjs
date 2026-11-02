import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash, randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';

const active = new AsyncLocalStorage();
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const LABEL = /^[A-Za-z0-9_.:-]{1,100}$/;
const NAME = /^[a-z][a-z0-9_.-]{0,99}$/;
const STATUS = new Set(['ok', 'error', 'timeout', 'cancelled', 'refused', 'late', 'unknown']);
const uuid = value => typeof value === 'string' && UUID.test(value);
const name = value => typeof value === 'string' && NAME.test(value);
const TEXT = new Set(['commandId', 'operation', 'tool', 'phase', 'source', 'outcomeCertainty', 'stage', 'mode', 'outcome']);
const NUMBERS = new Set(['rqid', 'turn', 'requestReceivedAt', 'cutoffAt', 'timeoutMs', 'bytes',
  'inputReceivedAt', 'inputProcessedAt', 'inputQueuedMs', 'eventAt', 'detectedAt', 'contextCapturedAt', 'handoffDelayMs', 'readStartedAt', 'readCompletedAt',
  'preparedAt', 'idAvailableAt', 'publicationReturnedAt']);
const API_METRICS = new Set(['headersLatencyMs', 'firstEventLatencyMs', 'firstTextLatencyMs',
  'completionLatencyMs', 'parseDurationMs', 'requestWallTimeMs', 'processingMs',
  'inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningTokens',
  'inputBytes', 'outputBytes', 'requestBytes', 'promptBytes']);
const CONTEXT = new Set(['teamId', 'commandId', 'requestKey', 'roomId', 'rqid', 'turn', 'operation', 'tool', 'requestReceivedAt', 'cutoffAt']);

// Never copy inputs, board snapshots, errors or credentials into timing records.
// New attributes require an explicit schema change here.
function attributes(input = {}) {
  const result = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  for (const [key, value] of Object.entries(input)) {
    if (TEXT.has(key) && typeof value === 'string' && LABEL.test(value)) result[key] = value;
    else if (key === 'status' && STATUS.has(value)) result[key] = value;
    else if (NUMBERS.has(key) && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000) result[key] = value;
    else if (API_METRICS.has(key) && Number.isFinite(value) && value >= 0 && value <= 8640000000000000) result[key] = value;
    else if ((key === 'teamId' || key === 'requestKey') && typeof value === 'string' && HASH.test(value)) result[key] = value;
    else if (key === 'roomId' && typeof value === 'string' && value.length <= 200 && /^(?:battle|game-bestof3)-[a-z0-9]+-\d+$/.test(value)) result[key] = value;
    else if (['observationOwnership', 'workerCreated', 'readyObserved', 'coreStarted'].includes(key) && typeof value === 'boolean') result[key] = value;
  }
  return result;
}

export function timingRequestKey({sessionId, roomId, room, rqid, token} = {}) {
  if (typeof sessionId !== 'string' || typeof (roomId ?? room) !== 'string' || !Number.isSafeInteger(rqid) || typeof token !== 'string') return undefined;
  return createHash('sha256').update(JSON.stringify([sessionId, roomId ?? room, rqid, token])).digest('hex');
}

export function currentTimingContext() {
  const state = active.getStore();
  if (!state) return undefined;
  return {traceId: state.traceId, ...(state.parentSpanId ? {parentSpanId: state.parentSpanId} : {}),
    ...Object.fromEntries(Object.entries(attributes(state.context)).filter(([key]) => CONTEXT.has(key)))};
}

const noopSpan = Object.freeze({end() {}, run: fn => fn()});
export function timingSpan(name, attrs = {}) {
  const state = active.getStore();
  return state ? state.recorder.start(name, attrs, state) : noopSpan;
}
export function timingEvent(name, attrs = {}) {
  const state = active.getStore();
  if (state) state.recorder.event(name, attrs, state);
}
export function withTimingSpan(name, attrs, fn) { return timingSpan(name, attrs).run(fn); }
export function timingImport(events) { active.getStore()?.recorder.ingest(events); }

/** Small, synchronous, bounded capture. Disk I/O belongs to an explicit sink.
 * An absent recorder is a no-op and instrumentation never changes an action.
 * Epoch times correlate processes approximately; monotonic times are local.
 */
export function createTimingRecorder({component, now = Date.now, monotonic = () => performance.now(),
  onEvent, maxEvents = 8192} = {}) {
  if (!name(component) || typeof now !== 'function' || typeof monotonic !== 'function' ||
      !Number.isInteger(maxEvents) || maxEvents < 16 || maxEvents > 20000 || onEvent !== undefined && typeof onEvent !== 'function') {
    throw new TypeError('A bounded timing recorder requires a component and valid clocks.');
  }
  const processInstanceId = randomUUID(), clockDomain = processInstanceId;
  let sequence = 0, droppedEvents = 0, callbackErrors = 0;
  let events = [];
  const stamp = () => {
    try {
      const epochMs = now(), monotonicMs = monotonic();
      if (!Number.isSafeInteger(epochMs) || epochMs < 0 || !Number.isFinite(monotonicMs) || monotonicMs < 0) return null;
      return {epochMs, monotonicMs};
    } catch { return null; }
  };
  const capture = event => {
    if (!event || events.length >= maxEvents) { droppedEvents++; return; }
    events.push(Object.freeze(event));
    if (onEvent) { try { onEvent({...event}); } catch { callbackErrors++; } }
  };
  function base(name, attrs, state, event, spanId, time) {
    return {schemaVersion: 1, traceId: state.traceId, ...(spanId ? {spanId} : {}),
      ...(state.parentSpanId ? {parentSpanId: state.parentSpanId} : {}), sequence: ++sequence,
      processInstanceId, clockDomain, component, name, event, ...time,
      ...attributes({...state.context, ...attrs})};
  }
  const recorder = {
    run(context = {}, fn) {
      const inherited = active.getStore();
      const traceId = uuid(context.traceId) ? context.traceId : inherited?.traceId ?? randomUUID();
      const parentSpanId = uuid(context.parentSpanId) ? context.parentSpanId : inherited?.parentSpanId;
      return active.run({recorder, traceId, parentSpanId, context: attributes({...inherited?.context, ...context})}, fn);
    },
    start(name, attrs, state = active.getStore()) {
      if (typeof name !== 'string' || !NAME.test(name) || !state || state.recorder !== recorder) return noopSpan;
      const started = stamp();
      if (!started) { droppedEvents++; return noopSpan; }
      const spanId = randomUUID(), context = attributes({...state.context, ...attrs});
      capture(base(name, context, state, 'span.start', spanId, started));
      let ended = false;
      const span = {
        end(status = 'ok', extra = {}) {
          if (ended) return;
          ended = true;
          const finished = stamp();
          if (!finished || finished.monotonicMs < started.monotonicMs) { droppedEvents++; return; }
          capture({...base(name, {...context, ...extra}, state, 'span.end', spanId, finished),
            durationMs: finished.monotonicMs - started.monotonicMs, status: STATUS.has(status) ? status : 'unknown'});
        },
        run(fn) {
          const nested = {...state, context, parentSpanId: spanId};
          try {
            const value = active.run(nested, fn);
            if (value && typeof value.then === 'function') return Promise.resolve(value).then(result => { span.end(); return result; }, error => { span.end('error'); throw error; });
            span.end();
            return value;
          } catch (error) { span.end('error'); throw error; }
        },
      };
      return span;
    },
    event(name, attrs = {}, state = active.getStore()) {
      if (typeof name !== 'string' || !NAME.test(name) || !state || state.recorder !== recorder) return;
      const time = stamp();
      if (!time) { droppedEvents++; return; }
      capture(base(name, attrs, state, 'event', undefined, time));
    },
    ingest(input) {
      if (!Array.isArray(input)) return;
      const own = active.getStore();
      for (const item of input.slice(0, maxEvents)) {
        const event = normalizeTimingEvent(item);
        if (!event || own && (event.traceId !== own.traceId || own.context.teamId && event.teamId !== own.context.teamId)) { droppedEvents++; continue; }
        capture(event);
      }
      droppedEvents += Math.max(0, input.length - maxEvents);
    },
    snapshot: () => events.map(event => ({...event})),
    drain() { const batch = events; events = []; return batch.map(event => ({...event})); },
    status: () => ({component, processInstanceId, clockDomain, bufferedEvents: events.length, droppedEvents, callbackErrors, maxEvents}),
  };
  return recorder;
}

export function normalizeTimingEvent(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || !uuid(value.traceId) ||
      !uuid(value.processInstanceId) || value.clockDomain !== value.processInstanceId || !name(value.component) ||
      !name(value.name) || !['span.start', 'span.end', 'event'].includes(value.event) ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !Number.isSafeInteger(value.epochMs) || value.epochMs < 0 ||
      !Number.isFinite(value.monotonicMs) || value.monotonicMs < 0 ||
      value.parentSpanId !== undefined && (typeof value.parentSpanId !== 'string' || !UUID.test(value.parentSpanId)) ||
      value.spanId !== undefined && (typeof value.spanId !== 'string' || !UUID.test(value.spanId))) return null;
  if (value.event.startsWith('span.') && !UUID.test(value.spanId ?? '')) return null;
  if (value.event === 'span.end' && (!STATUS.has(value.status) || !Number.isFinite(value.durationMs) || value.durationMs < 0)) return null;
  return {schemaVersion: 1, traceId: value.traceId, processInstanceId: value.processInstanceId,
    clockDomain: value.clockDomain, component: value.component, sequence: value.sequence,
    name: value.name, event: value.event, epochMs: value.epochMs, monotonicMs: value.monotonicMs,
    ...(value.spanId ? {spanId: value.spanId} : {}), ...(value.parentSpanId ? {parentSpanId: value.parentSpanId} : {}),
    ...(value.event === 'span.end' ? {durationMs: value.durationMs, status: value.status} : {}), ...attributes(value)};
}
