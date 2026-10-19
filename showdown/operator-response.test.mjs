import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {awaitResponse, publishResponse, readResponse, sanitizeResponse} from './operator-response.mjs';

const cacheDirectory = fileURLToPath(new URL('../cache/', import.meta.url));
await mkdir(cacheDirectory, {recursive: true});
const directory = await mkdtemp(join(cacheDirectory, 'operator-response-test-'));
const cli = fileURLToPath(new URL('./operator-response.mjs', import.meta.url));
test.after(async () => {
  assert.equal(dirname(resolve(directory)), resolve(cacheDirectory));
  assert.match(basename(directory), /^operator-response-test-/);
  await rm(directory, {recursive: true, force: true});
});
const file = name => join(directory, name);
const run = args => new Promise((done, reject) => {
  const child = spawn(process.execPath, [cli, ...args], {stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  const timer = setTimeout(() => { child.kill(); reject(new Error('One-shot response CLI failed to exit promptly')); }, 5000);
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', code => { clearTimeout(timer); done({code, stdout, stderr}); });
});

test('publishes an id-bound envelope atomically and preserves the raw in-memory result', async () => {
  const target = file('published.json');
  const payload = {data: {room: 'fixture-room', controllerLease: 'private-lease', readReceipt: 'private-receipt'}};
  const published = await publishResponse(target, 'request:1', payload);
  assert.equal(published.id, 'request:1');
  assert.deepEqual(published.payload, {data: {room: 'fixture-room'}});
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), published);
  assert.deepEqual(await readResponse({file: target, id: 'request:1'}), published);
  assert.equal(payload.data.controllerLease, 'private-lease');
  assert.equal(payload.data.readReceipt, 'private-receipt');
  assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('published.json.')), []);
});

test('stale response IDs stay pending until the matching already-dispatched result arrives', async () => {
  const target = file('stale.json');
  await publishResponse(target, 'previous', {accepted: true});
  assert.equal(await readResponse({file: target, id: 'current'}), null);
  const waiting = awaitResponse({file: target, id: 'current', timeoutMs: 2000, intervalMs: 5});
  await publishResponse(target, 'current', {accepted: false, detail: 'fixture rejection'});
  const result = await waiting;
  assert.equal(result.complete, true);
  assert.deepEqual(result.value.payload, {accepted: false, detail: 'fixture rejection'});
});

test('missing, partial and unrelated JSON are ignored without creating output or treating them as a result', async () => {
  const target = file('partial.json');
  assert.equal(await readResponse({file: target, id: 'request'}), null);
  await assert.rejects(readFile(target), {code: 'ENOENT'});
  for (const text of ['{"format":', '{"id":"request","payload":{"accepted":true}}', 'null', '[]']) {
    await writeFile(target, text);
    assert.equal(await readResponse({file: target, id: 'request'}), null);
  }
  const waiting = awaitResponse({file: target, id: 'request', timeoutMs: 2000, intervalMs: 5});
  await publishResponse(target, 'request', {completed: true});
  assert.equal((await waiting).complete, true);
});

test('timeout is bounded, leaves files untouched, and explicitly forbids resend', async () => {
  const target = file('timeout.json');
  const original = '{"id":"old"}';
  await writeFile(target, original);
  const result = await awaitResponse({file: target, id: 'pending-command', timeoutMs: 15, intervalMs: 2});
  assert.equal(result.complete, false);
  assert.deepEqual(result.value, {id: 'pending-command', pending: true, reason: 'response-file-timeout', resend: false});
  assert.equal(await readFile(target, 'utf8'), original);
  assert(result.elapsedMs < 2000);
  await publishResponse(target, 'pending-command', {finished: true});
  assert.equal((await awaitResponse({file: target, id: 'pending-command', timeoutMs: 0})).complete, true);
});

test('sanitization strips nested credential keys and both structured and JSON text copies of secrets', () => {
  const password = 'synthetic-"password\nvalue';
  const payload = {
    structuredContent: {controllerLease: 'synthetic-lease', READ_RECEIPT: 'synthetic-receipt', nested: [{password}], choiceToken: 'legal-choice-token'},
    content: [{type: 'text', text: JSON.stringify({password, credential: 'synthetic-vault', result: {echo: password, turn: 3}})}],
    detail: 'echo synthetic-lease synthetic-receipt synthetic-free-text',
  };
  const clean = sanitizeResponse(payload, {redactValues: ['synthetic-free-text']});
  assert.deepEqual(clean.structuredContent, {nested: [{}], choiceToken: 'legal-choice-token'});
  assert.deepEqual(JSON.parse(clean.content[0].text), {result: {echo: '[redacted]', turn: 3}});
  assert.equal(clean.detail, 'echo [redacted] [redacted] [redacted]');
  const text = JSON.stringify(clean);
  for (const secret of ['synthetic-lease', 'synthetic-receipt', 'synthetic-vault', 'synthetic-free-text']) assert(!text.includes(secret));
  assert.equal(sanitizeResponse({password: 'shared-prefix', controllerLease: 'shared-prefix-longer', echo: 'shared-prefix-longer'}).echo, '[redacted]');
  assert.deepEqual(sanitizeResponse({credentials: {password: 'nested-secret'}, detail: 'nested-secret'}), {detail: '[redacted]'});
});

test('readers sanitize compatible output again instead of trusting an existing file', async () => {
  const target = file('read-sanitize.json');
  await writeFile(target, JSON.stringify({format: 'vgc-operator-response-v1', id: 'read', payload: {password: 'synthetic-password', turn: 2}}));
  assert.deepEqual((await readResponse({file: target, id: 'read'})).payload, {turn: 2});
});

test('whole JSON text secrets are redacted before parsing even when their echoes appear first', () => {
  for (const secret of ['["fixture-private-array"]', '  [ "fixture-private-array" ]\n', '{ "private": ["fixture-private-object"] }']) {
    assert.deepEqual(sanitizeResponse({echo: secret, password: secret}), {echo: '[redacted]'});
    assert.deepEqual(sanitizeResponse({echo: secret}, {redactValues: [secret]}), {echo: '[redacted]'});
    const payload = {
      content: [{type: 'text', text: JSON.stringify({echo: secret, turn: 3})}],
      credential: secret,
    };
    const clean = sanitizeResponse(payload);
    assert.deepEqual(JSON.parse(clean.content[0].text), {echo: '[redacted]', turn: 3});
    assert.equal(clean.credential, undefined);
  }
});

test('invalid IDs, budgets and non-JSON payloads fail before touching a response file', async () => {
  const target = file('invalid.json');
  for (const id of ['', '../command', 'newline\n', 'x'.repeat(61), undefined]) {
    await assert.rejects(publishResponse(target, id, {ready: true}), /response ID/);
    await assert.rejects(awaitResponse({file: target, id, timeoutMs: 0}), /response ID/);
  }
  for (const timeoutMs of [-1, 22001, Infinity, 1.1]) await assert.rejects(awaitResponse({file: target, id: 'valid', timeoutMs}), /timeoutMs/);
  for (const intervalMs of [0, 1001, NaN]) await assert.rejects(awaitResponse({file: target, id: 'valid', timeoutMs: 0, intervalMs}), /intervalMs/);
  const cycle = {}; cycle.self = cycle;
  for (const payload of [cycle, {number: Infinity}, {value: BigInt(1)}, () => {}, new Date()]) {
    await assert.rejects(publishResponse(target, 'valid', payload), /JSON data/);
  }
  await assert.rejects(readFile(target), {code: 'ENOENT'});
});

test('a failed atomic replacement retains the previous result and cleans the exact temporary file', async () => {
  const target = file('unchanged.json');
  await publishResponse(target, 'previous', {value: 'kept'});
  const blockedTarget = file('existing-directory');
  await mkdir(blockedTarget);
  await writeFile(join(blockedTarget, 'sentinel.txt'), 'keep');
  await assert.rejects(publishResponse(blockedTarget, 'next', {value: 'never published'}));
  assert.equal(await readFile(join(blockedTarget, 'sentinel.txt'), 'utf8'), 'keep');
  assert.equal((await readResponse({file: target, id: 'previous'})).payload.value, 'kept');
  assert.deepEqual((await readdir(directory)).filter(name => name.includes('.tmp')), []);
});

test('one-shot CLI emits one complete compact result and exits without waiting out its 22-second budget', async () => {
  const target = file('cli-ready.json');
  const data = 'fixture-data-'.repeat(12000);
  await publishResponse(target, 'cli-ready', {data, accepted: true});
  const result = await run(['--wait', target, '--id', 'cli-ready', '--timeout-ms', '22000']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.split('\n').length, 2);
  assert.deepEqual(JSON.parse(result.stdout).payload, {data, accepted: true});
});

test('CLI timeout reads only, sends nothing, and a later invocation drains the same ID', async () => {
  const target = file('cli-pending.json');
  const input = file('never-consumed-command.json');
  await writeFile(input, JSON.stringify({tool: 'battle_start', confirmed: true}));
  const before = await readdir(directory);
  const pending = await run(['--wait', target, '--id', 'same-id', '--timeout-ms', '0']);
  assert.equal(pending.code, 2);
  assert.deepEqual(JSON.parse(pending.stdout), {id: 'same-id', pending: true, reason: 'response-file-timeout', resend: false});
  assert.deepEqual(await readdir(directory), before);
  assert.deepEqual(JSON.parse(await readFile(input, 'utf8')), {tool: 'battle_start', confirmed: true});
  await publishResponse(target, 'same-id', {observed: true});
  const complete = await run(['--wait', target, '--id', 'same-id', '--timeout-ms', '0']);
  assert.equal(complete.code, 0);
  assert.equal(JSON.parse(complete.stdout).id, 'same-id');
  const invalid = await run(['--send', input, '--id', 'same-id']);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /Usage:/);
});
