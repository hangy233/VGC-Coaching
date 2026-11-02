import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const attrs = event => ({...event.attrs, ...event});
const domain = event => JSON.stringify([event.processInstanceId, event.clockDomain]);
const identity = event => JSON.stringify([event.traceId, event.processInstanceId, event.clockDomain, event.spanId]);
const marker = (event, names) => names.includes(event.name) || names.includes(event.phase);

/** Nearest-rank p95. Missing values never become zero-duration observations. */
export function summarize(values) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  const n = sorted.length;
  return {n, medianMs: n ? n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : null,
    p95Ms: n ? sorted[Math.ceil(n * .95) - 1] : null, maxMs: n ? sorted[n - 1] : null};
}

/** Measure observed coverage, without adding nested or overlapping spans. */
export function unionDuration(intervals) {
  const sorted = intervals.filter(([start, end]) => finite(start) && finite(end) && end >= start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0, start = null, end = null;
  for (const [nextStart, nextEnd] of sorted) {
    if (start === null) { start = nextStart; end = nextEnd; }
    else if (nextStart <= end) end = Math.max(end, nextEnd);
    else { total += end - start; start = nextStart; end = nextEnd; }
  }
  return start === null ? 0 : total + end - start;
}

export function parseTrace(text) {
  const events = [], errors = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); }
    catch { errors.push({line: index + 1, error: 'invalid-json'}); }
  }
  return {events, errors};
}

function validEvent(event) {
  return event && event.schemaVersion === 1 && typeof event.traceId === 'string' && event.traceId &&
    typeof event.processInstanceId === 'string' && event.processInstanceId &&
    typeof event.clockDomain === 'string' && event.clockDomain &&
    typeof event.name === 'string' && ['event', 'span.start', 'span.end'].includes(event.event) &&
    finite(event.monotonicMs) && finite(event.epochMs) &&
    (event.event === 'event' || typeof event.spanId === 'string' && event.spanId);
}

const TOOL_NAMES = ['operator.mcp_call', 'mcp.tool', 'tool', 'tool.call'];
const ENGINE_NAMES = ['calculator.engine', 'simulation.native_engine', 'engine'];
const PUBLISH_NAMES = ['operator.publish', 'response.publication', 'publication'];
const AFTER_SEND_NAMES = ['operator.post_send_wait', 'wait.after-send', 'after-send.wait', 'afterSendWait'];
const OPPONENT_NAMES = ['wait.opponent', 'opponent.wait', 'opponentWait'];
const knownWait = span => AFTER_SEND_NAMES.includes(span.name) || OPPONENT_NAMES.includes(span.name) ||
  ['response.wait', 'operator.queue'].includes(span.name) || span.name === 'operator.mcp_call' && span.tool === 'battle_wait';

/** Pure analysis: no battle files, authentication, network, or model calls. */
export function analyzeEvents(inputEvents) {
  const diagnostics = {invalidEvents: 0, duplicateStarts: 0, duplicateEnds: 0, orphanEnds: 0,
    unfinishedSpans: 0, invalidIntervals: 0, durationDisagreements: 0, sequenceGaps: 0};
  const events = inputEvents.filter(event => {
    if (validEvent(event)) return true;
    diagnostics.invalidEvents++; return false;
  }).map(attrs);
  const starts = new Map(), ended = new Set(), spans = [];
  const byDomain = new Map();
  for (const event of events) {
    const key = domain(event);
    if (!byDomain.has(key)) byDomain.set(key, []);
    byDomain.get(key).push(event);
    if (event.event === 'span.start') {
      if (starts.has(identity(event)) || ended.has(identity(event))) diagnostics.duplicateStarts++;
      else starts.set(identity(event), event);
    }
  }
  // Input JSONL can contain independently flushed children before their parents.
  for (const event of events.filter(item => item.event === 'span.end')) {
    const key = identity(event);
    if (ended.has(key)) { diagnostics.duplicateEnds++; continue; }
    ended.add(key);
    const start = starts.get(key);
    if (!start) { diagnostics.orphanEnds++; continue; }
    starts.delete(key);
    const durationMs = event.monotonicMs - start.monotonicMs;
    if (durationMs < 0) { diagnostics.invalidIntervals++; continue; }
    if (finite(event.durationMs) && Math.abs(event.durationMs - durationMs) > .1) diagnostics.durationDisagreements++;
    spans.push({...start, ...event, startMs: start.monotonicMs, endMs: event.monotonicMs, durationMs});
  }
  diagnostics.unfinishedSpans = starts.size;
  const metrics = Object.create(null), samples = new Map();
  const add = (name, value) => {
    if (!finite(value)) return;
    if (!samples.has(name)) samples.set(name, []);
    samples.get(name).push(value);
  };
  const tools = Object.create(null), outcomes = Object.create(null), statuses = Object.create(null), deadlines = {observed: 0, missed: 0, unknown: 0};
  const spanStatusSamples = new Map();
  for (const event of events) {
    if (event.event === 'span.start') continue;
    if (event.status) statuses[event.status] = (statuses[event.status] ?? 0) + 1;
    if (event.outcomeCertainty) outcomes[event.outcomeCertainty] = (outcomes[event.outcomeCertainty] ?? 0) + 1;
  }
  for (const span of spans) {
    add(`span:${span.name}`, span.durationMs);
    if (!spanStatusSamples.has(span.name)) spanStatusSamples.set(span.name, new Map());
    const statusSamples = spanStatusSamples.get(span.name), status = span.status ?? 'unknown';
    if (!statusSamples.has(status)) statusSamples.set(status, []);
    statusSamples.get(status).push(span.durationMs);
    if (TOOL_NAMES.includes(span.name)) {
      add('toolElapsed', span.durationMs);
      if (span.name === 'operator.mcp_call') add('operatorToolElapsed', span.durationMs);
      if (span.name === 'mcp.tool') add('serverToolElapsed', span.durationMs);
      const tool = span.tool ?? 'unknown';
      tools[tool] ??= {elapsed: [], operatorElapsed: [], serverElapsed: [], engine: []}; tools[tool].elapsed.push(span.durationMs);
      if (span.name === 'operator.mcp_call') tools[tool].operatorElapsed.push(span.durationMs);
      if (span.name === 'mcp.tool') tools[tool].serverElapsed.push(span.durationMs);
      if (span.tool === 'battle_wait' && span.name === 'operator.mcp_call') add('battleWaitToolElapsed', span.durationMs);
    }
    if (ENGINE_NAMES.includes(span.name)) {
      add('engine', span.durationMs);
      // Engine descendants may inherit the tool label, or use a same-domain
      // parent chain. Never assign engines based on nearest wall timestamp.
      let ancestor = span, visited = new Set();
      while (!ancestor.tool && ancestor.parentSpanId && !visited.has(ancestor.parentSpanId)) {
        visited.add(ancestor.parentSpanId);
        ancestor = spans.find(parent => domain(parent) === domain(span) && parent.traceId === span.traceId && parent.spanId === ancestor.parentSpanId) ?? {};
      }
      const tool = ancestor.tool ?? 'unknown';
      tools[tool] ??= {elapsed: [], operatorElapsed: [], serverElapsed: [], engine: []}; tools[tool].engine.push(span.durationMs);
    }
    if (PUBLISH_NAMES.includes(span.name)) add('responsePublication', span.durationMs);
    if (AFTER_SEND_NAMES.includes(span.name)) add('afterSendWait', span.durationMs);
    if (OPPONENT_NAMES.includes(span.name)) add('opponentWait', span.durationMs);
    if (span.name === 'response.wait') add('responseReaderWait', span.durationMs);
    if (span.name === 'model.delivery') add('modelDelivery', span.durationMs);
    if (span.name === 'operator.queue') add('queue', span.durationMs);
  }
  const coverage = [], requests = [];
  for (const [key, items] of byDomain) {
    items.sort((a, b) => a.monotonicMs - b.monotonicMs || (a.sequence ?? 0) - (b.sequence ?? 0));
    const sequences = [...new Set(items.map(item => item.sequence).filter(Number.isSafeInteger))].sort((a, b) => a - b);
    for (let i = 1; i < sequences.length; i++) if (sequences[i] > sequences[i - 1] + 1) diagnostics.sequenceGaps += sequences[i] - sequences[i - 1] - 1;
    const localSpans = spans.filter(span => domain(span) === key);
    const activeSpans = localSpans.filter(span => !knownWait(span));
    // A command wrapping an opponent wait still covers that wait. Subtract the
    // interval union rather than pretending dropping the child excludes it.
    const waitIntervals = localSpans.filter(knownWait)
      .map(span => [span.startMs, span.endMs]);
    const postSendIntervals = localSpans.filter(span => AFTER_SEND_NAMES.includes(span.name) || OPPONENT_NAMES.includes(span.name))
      .map(span => [span.startMs, span.endMs]);
    const allIntervals = localSpans.map(span => [span.startMs, span.endMs]);
    const activeIntervals = activeSpans.map(span => [span.startMs, span.endMs]);
    const waitOverlap = unionDuration(activeIntervals) + unionDuration(waitIntervals) - unionDuration([...activeIntervals, ...waitIntervals]);
    coverage.push({processInstanceId: items[0].processInstanceId, clockDomain: items[0].clockDomain,
      observedSpanUnionMs: unionDuration(allIntervals),
      observedActiveUnionMs: Math.max(0, unionDuration(activeIntervals) - waitOverlap),
      observedNonWaitUnionMs: Math.max(0, unionDuration(activeIntervals) - waitOverlap),
      knownWaitUnionMs: unionDuration(waitIntervals),
      afterSendOrOpponentWaitUnionMs: unionDuration(postSendIntervals),
      limitation: 'Observed interval union in this clock domain only. observedActiveUnionMs is a compatibility alias for observedNonWaitUnionMs: excludes recorded queue/reader/battle-wait/post-send waits, not CPU time or model thinking. No cross-process sum or complete end-to-end critical path is established.'});
    const commands = new Map();
    for (const item of items) {
      if (!item.commandId) continue;
      if (!commands.has(item.commandId)) commands.set(item.commandId, []);
      commands.get(item.commandId).push(item);
    }
    for (const command of commands.values()) {
      const received = command.find(item => marker(item, ['operator.input_received', 'operator.input', 'input']));
      const began = command.find(item => marker(item, ['operator.command_started', 'command_started']));
      const hasQueueSpan = localSpans.some(span => span.name === 'operator.queue' && span.commandId === command[0].commandId);
      if (!hasQueueSpan && received && began && began.monotonicMs >= received.monotonicMs) add('queue', began.monotonicMs - received.monotonicMs);
    }
    const requestGroups = new Map();
    for (const item of items) {
      if (!item.requestKey) continue;
      const requestId = item.requestKey;
      if (!requestGroups.has(requestId)) requestGroups.set(requestId, []);
      requestGroups.get(requestId).push(item);
    }
    for (const group of requestGroups.values()) {
      const received = group.find(item => marker(item, ['request.received']));
      const observed = group.find(item => marker(item, ['request.observed']));
      const authored = name => group.find(item => item.event !== 'span.start' && marker(item, [name]) && item.source === 'authored');
      const staged = authored('authored.stage'), sent = authored('authored.send');
      const request = {processInstanceId: group[0].processInstanceId, clockDomain: group[0].clockDomain,
        requestKey: group[0].requestKey, receiptObserved: Boolean(received), clientObservationObserved: Boolean(observed),
        authoredStageObserved: Boolean(staged), authoredSendObserved: Boolean(sent)};
      const receiptMetadata = group.find(item => finite(item.requestReceivedAt));
      if (receiptMetadata) request.requestReceivedAt = receiptMetadata.requestReceivedAt;
      for (const [boundary, item] of [['Stage', staged], ['Send', sent]]) {
        for (const [origin, start] of [['request', received], ['observedRequest', observed]]) {
          const latency = start && item && item.monotonicMs >= start.monotonicMs ? item.monotonicMs - start.monotonicMs : null;
          request[`${origin}ToFirstAuthored${boundary}Ms`] = latency;
          add(`${origin}ToFirstAuthored${boundary}`, latency);
        }
        if (receiptMetadata && item) {
          const estimate = item.epochMs - receiptMetadata.requestReceivedAt;
          request[`crossProcessEpochEstimateToFirstAuthored${boundary}Ms`] = estimate;
          add(`crossProcessEpochEstimateToFirstAuthored${boundary}`, estimate);
          request.epochEstimateLimitation = 'Sender epoch minus source requestReceivedAt; clock adjustments and cross-process clock agreement are unverified. This is not a same-clock monotonic latency.';
        }
      }
      if (sent && finite(sent.cutoffAt)) {
        deadlines.observed++;
        const slack = sent.cutoffAt - sent.epochMs;
        add('deadlineSlackAtAuthoredSend', slack); if (slack < 0) deadlines.missed++;
        request.deadlineBasis = 'recorded epoch cutoff minus sender epoch; cross-host clock synchronization is not established';
      } else if (sent) deadlines.unknown++;
      requests.push(request);
    }
  }
  for (const [name, values] of samples) metrics[name] = summarize(values);
  for (const name of ['queue', 'toolElapsed', 'engine', 'responsePublication', 'requestToFirstAuthoredStage',
    'requestToFirstAuthoredSend', 'observedRequestToFirstAuthoredStage', 'observedRequestToFirstAuthoredSend',
    'afterSendWait', 'opponentWait', 'responseReaderWait', 'modelDelivery']) metrics[name] ??= summarize([]);
  if (metrics.toolElapsed) metrics.toolElapsed.sampleBasis = 'wrapper span observations across layers; not distinct calls';
  const perTool = Object.fromEntries(Object.entries(tools).map(([tool, values]) => [tool,
    {elapsed: {...summarize(values.elapsed), sampleBasis: 'wrapper span observations across layers; not distinct calls'},
      operatorElapsed: summarize(values.operatorElapsed), serverElapsed: summarize(values.serverElapsed), engine: summarize(values.engine)}]));
  // Match the event/status token, not letters embedded in ordinary names such
  // as "isolated" or "calculate". These are observations, not inferred misses.
  const hasLateToken = text => /(?:^|[^a-z0-9])late(?:$|[^a-z0-9])/i.test(text);
  const exceptionalEvents = events.filter(item => {
    const text = `${item.status ?? ''} ${item.name} ${item.outcome ?? ''} ${item.outcomeCertainty ?? ''}`;
    return item.event !== 'span.start' && (/timeout|timed.out|refus|cancel|abort|default|inactiv/i.test(text) || hasLateToken(text));
  });
  const exceptions = Object.create(null);
  for (const event of exceptionalEvents) {
    const text = `${event.status ?? ''} ${event.name} ${event.outcome ?? ''} ${event.outcomeCertainty ?? ''}`;
    const category = /(?:^|[^a-z0-9])late[._-]settle/i.test(event.name) ? 'lateSettlement' :
      /refus/i.test(text) ? 'refusal' : /server[._-]default/i.test(text) ? 'serverDefault' :
      /(?:generated|watchdog)[._-]default|default[._-]generated/i.test(text) ? 'generatedDefault' :
      /default/i.test(text) ? 'defaultObservation' : /inactiv/i.test(text) ? 'inactivity' :
      /cancel/i.test(text) ? 'cancelled' : hasLateToken(text) ? 'late' : 'timeoutOrAbort';
    exceptions[category] = (exceptions[category] ?? 0) + 1;
  }
  const unknown = [];
  if (!metrics.modelDelivery.n) unknown.push('Model delivery, model selection, reasoning effort, generation and model-side tool dispatch are not observed by local traces.');
  if (!metrics.requestToFirstAuthoredSend.n) unknown.push('Server request receipt to first authored send is unknown without same-domain request.received and authored.send markers. Client observation latency excludes the preceding delivery gap.');
  if (!metrics.queue.n) unknown.push('Operator queue time is unknown without matched input and command_started markers.');
  if (diagnostics.unfinishedSpans || diagnostics.orphanEnds || diagnostics.invalidEvents || diagnostics.sequenceGaps) unknown.push('Trace coverage is incomplete; unfinished spans and missing events are not zero-duration work.');
  unknown.push('A successful tool return or authored-send marker does not establish server acceptance, execution, opponent intent, or tactical quality.');
  unknown.push('Absent default/inactivity markers do not prove those outcomes were absent from the battle client. Exception totals are trace observations, not distinct failures or rates.');
  unknown.push('toolElapsed pools observed wrapper samples. Use perTool.operatorElapsed and perTool.serverElapsed for distinct transport and server distributions; engine measurements may nest inside either and are never added to them.');
  const spanLatencyByStatus = Object.fromEntries([...spanStatusSamples].map(([name, statuses]) => [name,
    Object.fromEntries([...statuses].map(([status, values]) => [status, summarize(values)]))]));
  return {schemaVersion: 1, kind: 'local-timing-analysis', eventCount: events.length, completedSpanCount: spans.length,
    countBasis: 'Trace observations, not distinct commands, battle defaults, or failures. Repeated/layered observations remain separate.',
    diagnostics, metrics, perTool, spanLatencyByStatus, domains: coverage, requests, deadlines, statuses, outcomes, exceptions, unknown};
}

export function analyzeTraceFile(path) {
  const parsed = parseTrace(readFileSync(path, 'utf8'));
  return {...analyzeEvents(parsed.events), parseErrors: parsed.errors};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2);
  if (!paths.length) { console.error('Usage: node observability/analyze.mjs TRACE.jsonl [TRACE.jsonl ...]'); process.exitCode = 2; }
  else {
    const parsed = paths.map(path => parseTrace(readFileSync(path, 'utf8')));
    console.log(JSON.stringify({...analyzeEvents(parsed.flatMap(item => item.events)),
      parseErrors: parsed.flatMap((item, index) => item.errors.map(error => ({file: paths[index], ...error})))}, null, 2));
  }
}
