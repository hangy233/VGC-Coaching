import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import fileSystem, {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
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
const retainedFile = (target, id) => join(`${target}.responses`, `${createHash('sha256').update(id).digest('hex')}.json`);
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
  assert.deepEqual((await readdir(`${target}.responses`)).filter(name => name.endsWith('.tmp')), []);
  assert.equal((await readFile(retainedFile(target, 'request:1'), 'utf8')).includes('private-lease'), false);
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

test('a failed latest replacement preserves both the previous latest and the exact completed ID', async () => {
  const target = file('unchanged.json');
  await publishResponse(target, 'previous', {value: 'kept'});
  const blockedTarget = file('existing-directory');
  await mkdir(blockedTarget);
  await writeFile(join(blockedTarget, 'sentinel.txt'), 'keep');
  const result = await publishResponse(blockedTarget, 'next', {value: 'retained by ID'});
  assert.equal(result.publication.idRetained, true);
  assert.equal(result.publication.latestUpdated, false);
  assert.deepEqual((await readResponse({file: blockedTarget, id: 'next'})).payload, {value: 'retained by ID'});
  assert.equal(await readFile(join(blockedTarget, 'sentinel.txt'), 'utf8'), 'keep');
  assert.equal((await readResponse({file: target, id: 'previous'})).payload.value, 'kept');
  assert.deepEqual((await readdir(directory)).filter(name => name.includes('.tmp')), []);
});

test('transient Windows latest replacement errors retry the same sanitized result', async t => {
  const target = file('rename-retry.json');
  await publishResponse(target, 'before', {value: 'before'});
  const originalRename = fileSystem.rename;
  let attempts = 0;
  t.mock.method(fileSystem, 'rename', async (source, destination) => {
    if (destination === target && ++attempts <= 2) throw Object.assign(new Error('fixture sharing violation'), {code: 'EPERM'});
    return originalRename(source, destination);
  });
  const result = await publishResponse(target, 'after:retry', {controllerLease: 'fixture-secret', echo: 'fixture-secret', accepted: true});
  assert.equal(attempts, 3);
  assert.equal(result.publication, undefined);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')).payload, {echo: '[redacted]', accepted: true});
  assert.deepEqual((await readResponse({file: target, id: 'before'})).payload, {value: 'before'});
});

test('persistent latest EPERM resolves with a warning and the exact ID remains immediately readable', async t => {
  const target = file('rename-persistent.json');
  await publishResponse(target, 'old', {value: 'old'});
  const originalRename = fileSystem.rename;
  let attempts = 0;
  t.mock.method(fileSystem, 'rename', async (source, destination) => {
    if (destination === target) { attempts++; throw Object.assign(new Error('fixture lock'), {code: 'EPERM'}); }
    return originalRename(source, destination);
  });
  const began = performance.now();
  const result = await publishResponse(target, 'new', {accepted: true, password: 'fixture-private', echo: 'fixture-private'});
  assert.equal(attempts, 6);
  assert(performance.now() - began < 2000);
  assert.deepEqual(result.publication, {idRetained: true, latestUpdated: false, warning: 'latest-response-not-updated', code: 'EPERM'});
  assert.equal(JSON.parse(await readFile(target, 'utf8')).id, 'old');
  assert.deepEqual((await readResponse({file: target, id: 'new'})).payload, {accepted: true, echo: '[redacted]'});
  const cliResult = await run(['--wait', target, '--id', 'new', '--timeout-ms', '0']);
  assert.equal(cliResult.code, 0);
  assert.equal(JSON.parse(cliResult.stdout).id, 'new');
  assert.deepEqual((await readdir(`${target}.responses`)).filter(name => name.endsWith('.tmp')), []);
});

test('failure to retain the exact ID fails closed before changing latest', async t => {
  const target = file('retain-failure.json');
  await publishResponse(target, 'old', {value: 'old'});
  const originalRename = fileSystem.rename;
  t.mock.method(fileSystem, 'rename', async (source, destination) => {
    if (destination === retainedFile(target, 'new')) throw Object.assign(new Error('fixture denied'), {code: 'EACCES'});
    return originalRename(source, destination);
  });
  await assert.rejects(publishResponse(target, 'new', {accepted: true}), {code: 'EACCES'});
  assert.equal(JSON.parse(await readFile(target, 'utf8')).id, 'old');
  assert.equal(await readResponse({file: target, id: 'new'}), null);
  assert.deepEqual((await readdir(`${target}.responses`)).filter(name => name.endsWith('.tmp')), []);
});

test('ID retention is immutable, bounded, and leaves unrelated files alone', async () => {
  const target = file('retention-bound.json');
  await publishResponse(target, 'first', {value: 0});
  await publishResponse(target, 'first', {value: 0});
  await assert.rejects(publishResponse(target, 'first', {value: 'different'}), /different or invalid retained result/);
  await writeFile(join(`${target}.responses`, 'unrelated.txt'), 'keep');
  for (let index = 1; index <= 20; index++) await publishResponse(target, `result-${index}`, {value: index});
  assert.equal((await readdir(`${target}.responses`)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length, 16);
  assert.equal(await readFile(join(`${target}.responses`, 'unrelated.txt'), 'utf8'), 'keep');
  assert.equal(await readResponse({file: target, id: 'first'}), null);
  assert.equal((await readResponse({file: target, id: 'result-20'})).payload.value, 20);
});

test('reader falls back to legacy latest for partial or incompatible exact ID copies', async () => {
  const target = file('reader-fallback.json');
  await publishResponse(target, 'matching', {turn: 7});
  for (const text of ['{"format":', '{"format":"wrong","id":"matching","payload":{}}', '{"format":"vgc-operator-response-v1","id":"different","payload":{}}']) {
    await writeFile(retainedFile(target, 'matching'), text);
    assert.deepEqual((await readResponse({file: target, id: 'matching'})).payload, {turn: 7});
  }
});

test('retention refuses an observed symlinked response area without writing through it', async t => {
  const target = file('symlink-area.json');
  const area = `${target}.responses`;
  await mkdir(area);
  await writeFile(join(area, 'sentinel.txt'), 'keep');
  const originalLstat = fileSystem.lstat;
  t.mock.method(fileSystem, 'lstat', async path => path === area ? {isDirectory: () => true, isSymbolicLink: () => true} : originalLstat(path));
  await assert.rejects(publishResponse(target, 'unsafe', {accepted: true}), /real directory/);
  await assert.rejects(readResponse({file: target, id: 'unsafe'}), /real directory/);
  assert.deepEqual(await readdir(area), ['sentinel.txt']);
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
