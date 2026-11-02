import test from 'node:test';
import assert from 'node:assert/strict';
import {createTimingRecorder, timingSpan, timingEvent, withTimingSpan, currentTimingContext,
  timingRequestKey, normalizeTimingEvent, timingImport} from './timing.mjs';

test('monotonic spans survive wall clock jumps, nest, and keep sync/async return semantics', async () => {
  let epoch = 10000, mono = 0;
  const recorder = createTimingRecorder({component: 'test', now: () => epoch, monotonic: () => mono});
  assert.equal(timingSpan('disabled').run(() => 7), 7);
  await recorder.run({commandId: 'first', password: 'hidden'}, async () => {
    assert.equal(currentTimingContext().commandId, 'first');
    assert.equal(currentTimingContext().password, undefined);
    const parent = timingSpan('test.parent');
    await parent.run(async () => {
      mono += 2;
      assert.equal(withTimingSpan('test.child', {}, () => 42), 42);
      epoch -= 5000;
      mono += 8;
      assert.equal(await withTimingSpan('test.async', {}, async () => { mono += 3; return 6; }), 6);
    });
    parent.end('error');
  });
  const events = recorder.snapshot(), end = events.find(event => event.name === 'test.parent' && event.event === 'span.end');
  assert.equal(end.durationMs, 13);
  assert.equal(end.status, 'ok');
  assert.equal(events.filter(event => event.name === 'test.parent' && event.event === 'span.end').length, 1);
  assert.equal(events.find(event => event.name === 'test.child').parentSpanId, end.spanId);
  assert.equal(currentTimingContext(), undefined);
});

test('error/refusal outcomes and hostile callbacks do not expose data or mask original errors', () => {
  const recorder = createTimingRecorder({component: 'test', onEvent: () => { throw new Error('sink'); }});
  recorder.run({}, () => {
    assert.throws(() => withTimingSpan('test.error', {}, () => { throw new Error('actual'); }), /actual/);
    const refusal = timingSpan('test.refusal');
    refusal.run(() => { refusal.end('refused'); });
    timingEvent('test.event', {password: 'no', token: 'no', controllerLease: 'no', input: {private: 'no'},
      tool: 'calculate_speed', bytes: 9, outcome: 'refused-before-engine', coreStarted: false});
  });
  const events = recorder.snapshot();
  assert(events.some(event => event.status === 'error'));
  assert(events.some(event => event.status === 'refused'));
  const safe = events.find(event => event.name === 'test.event');
  assert.equal(safe.tool, 'calculate_speed');
  assert.equal(safe.coreStarted, false);
  assert.equal(safe.password, undefined);
  assert.equal(safe.token, undefined);
  assert.equal(safe.input, undefined);
  assert.equal(recorder.status().callbackErrors, events.length);
});

test('capture is bounded and imported worker records retain a separate clock domain', () => {
  const parent = createTimingRecorder({component: 'parent', maxEvents: 16});
  const worker = createTimingRecorder({component: 'worker'});
  parent.run({teamId: 'a'.repeat(64)}, () => {
    worker.run(currentTimingContext(), () => timingSpan('worker.engine').run(() => {}));
    timingImport(worker.snapshot());
    for (let i = 0; i < 100; i++) timingEvent('test.event');
  });
  const events = parent.drain();
  assert.equal(events.length, 16);
  assert(parent.status().droppedEvents > 0);
  assert.equal(events[0].processInstanceId, worker.status().processInstanceId);
  assert.notEqual(events[0].clockDomain, parent.status().clockDomain);
  assert.equal(parent.snapshot().length, 0);
  assert.deepEqual(normalizeTimingEvent({...events[0], password: 'no'}), events[0]);
  assert.equal(normalizeTimingEvent({...events[0], clockDomain: 'other'}), null);
  const plain = events.find(event => event.event === 'event');
  assert.equal(normalizeTimingEvent({...plain, spanId: {token: 'private-capability'}}), null);
  assert.equal(normalizeTimingEvent({...plain, parentSpanId: {token: 'private-capability'}}), null);
});

test('request correlation hashes capabilities and does not accept incomplete identity', () => {
  const input = {sessionId: 'session', roomId: 'battle-gen9championsvgc2026regmcbo3-123', rqid: 1, token: 'private'};
  const key = timingRequestKey(input);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key, timingRequestKey(input));
  assert.notEqual(key, timingRequestKey({...input, rqid: 2}));
  assert.equal(timingRequestKey({rqid: 1}), undefined);
});

test('isolated API latency and usage survive normalization without payload or credentials', () => {
  const recorder = createTimingRecorder({component: 'isolated'});
  recorder.run({teamId:'a'.repeat(64)}, () => timingEvent('isolated.api.completed', {
    headersLatencyMs:172.5, firstEventLatencyMs:175, firstTextLatencyMs:2300,
    completionLatencyMs:2600, parseDurationMs:0.4, requestWallTimeMs:2601,
    processingMs:null, inputTokens:2100, outputTokens:304, totalTokens:2404,
    cachedInputTokens:1024, reasoningTokens:128, inputBytes:8200, outputBytes:1200,
    requestBytes:11000, promptBytes:9000, password:'hidden', apiKey:'hidden',
    authorization:'Bearer hidden', input:{private:'hidden'}, reasoning: 'hidden',
  }));
  const event=recorder.snapshot()[0], normalized=normalizeTimingEvent(event);
  assert.equal(normalized.headersLatencyMs,172.5);
  assert.equal(normalized.parseDurationMs,0.4);
  assert.equal(normalized.reasoningTokens,128);
  assert.equal(normalized.inputTokens,2100);
  assert.equal(normalized.processingMs,undefined, 'missing provider duration stays unknown');
  for(const key of ['password','apiKey','authorization','input','reasoning']) assert.equal(normalized[key],undefined);
  assert.equal(normalizeTimingEvent({...event,requestWallTimeMs:-1,inputTokens:Infinity}).requestWallTimeMs,undefined);
  assert.equal(normalizeTimingEvent({...event,inputTokens:Infinity}).inputTokens,undefined);
});
