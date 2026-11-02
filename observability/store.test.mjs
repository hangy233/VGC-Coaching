import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readdir, readFile, writeFile, rm, symlink, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {registerTeamFromText} from '../metrics/import.mjs';
import {deleteTeamReport} from '../metrics/team-cleanup.mjs';
import {createTeamTiming, readTeamTiming} from './store.mjs';
import {timingEvent, timingSpan} from './timing.mjs';
import {registerWorkflowTools} from '../workflow/mcp-tools.mjs';

const TEAM = [['Golisopod', 'Emergency Exit'], ['Kommo-o', 'Soundproof'], ['Rillaboom', 'Grassy Surge'],
  ['Politoed', 'Drizzle'], ['Farigiraf', 'Armor Tail'], ['Sylveon', 'Pixilate']]
  .map(([species, ability]) => `${species}\nAbility: ${ability}\nLevel: 50\nEVs: 32 HP / 32 SpA / 2 SpD\nModest Nature\n- Protect`).join('\n\n');
async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'vgc-timing-'));
  t.after(() => rm(workspace, {recursive: true, force: true}));
  const {teamId} = await registerTeamFromText({workspace, teamText: TEAM});
  return {workspace, teamId};
}

test('timing storage is bounded, whitelisted and readable through the MCP report', async t => {
  const {workspace, teamId} = await fixture(t);
  const sink = await createTeamTiming({workspace, teamId, component: 'test', intervalMs: 0, maxFiles: 2,
    maxEventsPerFile: 16, recorderOptions: {maxEvents: 16}});
  t.after(() => sink.close());
  for (let i = 0; i < 3; i++) {
    sink.recorder.run({teamId, commandId: `command-${i}`}, () => {
      timingSpan('calculator.engine', {tool: 'calculate_speed'}).run(() => {});
      timingEvent('test.event', {password: 'sensitive', token: 'sensitive', tool: 'calculate_speed'});
      for (let j = 0; j < 13; j++) timingEvent('test.padding');
    });
    await sink.flush();
  }
  const report = await readTeamTiming({workspace, teamId});
  assert.equal(report.filesRead, 2);
  assert.equal(report.events.length, 32);
  assert.equal(sink.status().writtenFiles, 3);
  assert(!JSON.stringify(report).includes('sensitive'));
  const tools = new Map();
  registerWorkflowTools({registerTool: (name, config, handler) => tools.set(name, {config, handler})}, {workspace});
  const tool = tools.get('battle_timing_report');
  const result = await tool.handler({teamId, limitFiles: 64, includeEvents: false});
  const value = JSON.parse(result.content[0].text);
  assert.equal(result.isError, undefined);
  assert.equal(value.analysis.perTool.calculate_speed.engine.n, 2);
  assert.equal(value.events, undefined);
  assert(value.analysis.unknown.some(text => /Model delivery/.test(text)));
});

test('frequent unbound post-set flushes retain the earlier room trace within the unchanged file bound', async t => {
  const {workspace, teamId} = await fixture(t);
  const sink = await createTeamTiming({workspace, teamId, component: 'test', intervalMs: 0});
  t.after(() => sink.close());
  const roomId = 'battle-gen9championsvgc2026regmcbo3-990001';
  sink.recorder.run({teamId, roomId}, () => timingEvent('request.observed'));
  await sink.flush();
  for (let i = 0; i < 70; i++) {
    sink.recorder.run({teamId}, () => timingEvent('test.review'));
    await sink.flush();
  }
  const report = await readTeamTiming({workspace, teamId, roomId});
  assert.equal(report.events.length, 1);
  assert.equal(report.events[0].name, 'request.observed');
  assert.equal(report.availableFiles, 1);
  assert.equal(sink.status().writtenFiles, 1);
  assert.equal(sink.status().writtenBatches, 71);
});

test('separate timing writers coalesce only their own chunks and do not duplicate prior events', async t => {
  const {workspace, teamId} = await fixture(t);
  const a = await createTeamTiming({workspace, teamId, component: 'operator', intervalMs: 0});
  const b = await createTeamTiming({workspace, teamId, component: 'mcp-server', intervalMs: 0});
  t.after(async () => { await a.close(); await b.close(); });
  for (let i = 0; i < 3; i++) {
    a.recorder.run({teamId}, () => timingEvent('test.operator'));
    b.recorder.run({teamId}, () => timingEvent('test.server'));
    await Promise.all([a.flush(), b.flush()]);
  }
  const report = await readTeamTiming({workspace, teamId});
  assert.equal(report.availableFiles, 2);
  assert.equal(report.events.length, 6);
  assert.equal(new Set(report.events.map(event => event.processInstanceId + ':' + event.sequence)).size, 6);
  assert.equal(a.status().persistenceErrors + b.status().persistenceErrors, 0);
});

test('a chunk removed by retention is not recreated with cached old events', async t => {
  const {workspace, teamId} = await fixture(t);
  const sink = await createTeamTiming({workspace, teamId, component: 'test', intervalMs: 0});
  t.after(() => sink.close());
  sink.recorder.run({teamId}, () => timingEvent('test.old'));
  await sink.flush();
  const directory = join(workspace, 'cache/team-metrics/timing');
  const [old] = await readdir(directory);
  await unlink(join(directory, old));
  sink.recorder.run({teamId}, () => timingEvent('test.new'));
  await sink.flush();
  const report = await readTeamTiming({workspace, teamId});
  assert.deepEqual(report.events.map(event => event.name), ['test.new']);
  assert.equal(sink.status().persistenceErrors, 0);
  assert(!((await readdir(directory)).includes(old)));
});

test('an externally changed active chunk is retained and reported rather than overwritten', async t => {
  const {workspace, teamId} = await fixture(t);
  const sink = await createTeamTiming({workspace, teamId, component: 'test', intervalMs: 0});
  t.after(() => sink.close());
  sink.recorder.run({teamId}, () => timingEvent('test.original'));
  await sink.flush();
  const directory = join(workspace, 'cache/team-metrics/timing');
  const [name] = await readdir(directory), file = join(directory, name);
  await writeFile(file, 'changed externally');
  sink.recorder.run({teamId}, () => timingEvent('test.must_not_overwrite'));
  await sink.flush();
  assert.equal(await readFile(file, 'utf8'), 'changed externally');
  assert.equal(sink.status().persistenceErrors, 1);
  assert.equal(sink.status().lostEvents, 1);
});

test('byte-bound rotation preserves both complete batches below the fixed decompression ceiling', async t => {
  const {workspace, teamId} = await fixture(t);
  const sink = await createTeamTiming({workspace, teamId, component: 'test', intervalMs: 0});
  t.after(() => sink.close());
  const attributes = Object.fromEntries(['commandId','operation','tool','phase','source','outcomeCertainty','stage','mode','outcome'].map(key => [key, 'x'.repeat(100)]));
  for (let batch = 0; batch < 2; batch++) {
    sink.recorder.run({teamId}, () => { for (let i = 0; i < 4096; i++) timingEvent('test.sized', attributes); });
    await sink.flush();
  }
  const report = await readTeamTiming({workspace, teamId});
  assert.equal(report.events.length, 8192);
  assert.equal(report.availableFiles, 2);
  const directory = join(workspace, 'cache/team-metrics/timing');
  for (const name of await readdir(directory)) assert(gunzipSync(await readFile(join(directory, name))).length <= 8 * 1024 * 1024);
  assert.equal(sink.status().lostEvents, 0);
});

test('small batches rotate before repeated merges exceed the bounded live-loop work target', async t => {
  const {workspace, teamId} = await fixture(t);
  const sink = await createTeamTiming({workspace, teamId, component: 'test', intervalMs: 0});
  t.after(() => sink.close());
  const attributes = Object.fromEntries(['commandId','operation','tool','phase','source','outcomeCertainty','stage','mode','outcome'].map(key => [key, 'x'.repeat(100)]));
  for (let batch = 0; batch < 2; batch++) {
    sink.recorder.run({teamId}, () => { for (let i = 0; i < 300; i++) timingEvent('test.merge_sized', attributes); });
    await sink.flush();
  }
  const report = await readTeamTiming({workspace, teamId});
  assert.equal(report.events.length, 600);
  assert.equal(report.availableFiles, 2);
  const directory = join(workspace, 'cache/team-metrics/timing');
  for (const name of await readdir(directory)) assert(gunzipSync(await readFile(join(directory, name))).length <= 512 * 1024);
});

test('chunk capacity must fit the recorder batch rather than silently dropping its tail', async t => {
  const {workspace, teamId} = await fixture(t);
  await assert.rejects(createTeamTiming({workspace, teamId, component: 'test', maxEventsPerFile: 16}), /complete recorder batch/);
});

test('deliberate team recreation never restores deleted history from an older sink', async t => {
  const {workspace, teamId} = await fixture(t);
  const sink = await createTeamTiming({workspace, teamId, component: 'test', intervalMs: 0});
  t.after(() => sink.close());
  sink.recorder.run({teamId}, () => timingEvent('test.deleted_history'));
  await sink.flush();
  assert.equal((await deleteTeamReport({workspace, teamId, dryRun: false, confirmed: true})).complete, true);
  assert.equal((await registerTeamFromText({workspace, teamText: TEAM})).teamId, teamId);
  sink.recorder.run({teamId}, () => timingEvent('test.fresh_observation'));
  await sink.flush();
  assert.deepEqual((await readTeamTiming({workspace, teamId})).events.map(event => event.name), ['test.fresh_observation']);
});

test('team deletion cascades timing evidence and blocks a stale recorder from recreating it', async t => {
  const {workspace, teamId} = await fixture(t);
  const sink = await createTeamTiming({workspace, teamId, component: 'test', intervalMs: 0});
  t.after(() => sink.close());
  sink.recorder.run({teamId}, () => timingEvent('test.event'));
  await sink.flush();
  const before = await readdir(join(workspace, 'cache/team-metrics/timing'));
  assert.equal(before.length, 1);
  const deleted = await deleteTeamReport({workspace, teamId, dryRun: false, confirmed: true});
  assert.equal(deleted.complete, true);
  assert(deleted.removed.some(item => item.kind === 'timing-evidence'));
  sink.recorder.run({teamId}, () => timingEvent('test.stale'));
  await sink.flush();
  assert.equal(sink.status().lostEvents, 1);
  assert.equal(sink.status().lastErrorCode, 'METRICS_TEAM_DELETED');
  assert.deepEqual(await readdir(join(workspace, 'cache/team-metrics/timing')), []);
});

test('timing persistence failure is observable and does not reject a command or flush', async t => {
  const {workspace, teamId} = await fixture(t);
  await writeFile(join(workspace, 'cache/team-metrics/timing'), 'blocked');
  const sink = await createTeamTiming({workspace, teamId, component: 'test', intervalMs: 0});
  sink.recorder.run({teamId}, () => timingSpan('test.command').run(() => {}));
  await sink.close();
  assert.equal(sink.status().persistenceErrors, 1);
  assert.equal(sink.status().lostEvents, 2);
  assert.equal(await readFile(join(workspace, 'cache/team-metrics/timing'), 'utf8'), 'blocked');
});

test('foreign team events are rejected with coverage evidence instead of being reassigned', async t => {
  const {workspace, teamId} = await fixture(t);
  const sink = await createTeamTiming({workspace, teamId, component: 'test', intervalMs: 0});
  sink.recorder.run({teamId: 'b'.repeat(64)}, () => timingEvent('test.foreign'));
  await sink.close();
  const report = await readTeamTiming({workspace, teamId});
  assert.equal(report.events.length, 0);
  assert.equal(report.ownershipRejected, 1);
  assert(report.warnings.some(value => value.includes('another team identity')));
});

test('a concurrent retention removal returns explicit partial coverage rather than failing the report', async t => {
  const {workspace, teamId} = await fixture(t);
  const sink = await createTeamTiming({workspace, teamId, component: 'test', intervalMs: 0});
  sink.recorder.run({teamId}, () => timingEvent('test.event'));
  await sink.close();
  const report = await readTeamTiming({workspace, teamId, readChunk: async () => { throw Object.assign(new Error('removed'), {code: 'ENOENT'}); }});
  assert.equal(report.filesRead, 0);
  assert.equal(report.vanishedFiles, 1);
  assert(report.warnings.some(value => value.includes('disappeared during the read')));
});

test('linked timing storage cannot write or read outside the workspace', async t => {
  const {workspace, teamId} = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'vgc-timing-outside-'));
  t.after(() => rm(outside, {recursive: true, force: true}));
  try { await symlink(outside, join(workspace, 'cache/team-metrics/timing'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Directory links unavailable'); return; } throw error; }
  const sink = await createTeamTiming({workspace, teamId, component: 'test', intervalMs: 0});
  sink.recorder.run({teamId}, () => timingEvent('test.event'));
  await sink.close();
  assert.equal(sink.status().persistenceErrors, 1);
  assert.deepEqual(await readdir(outside), []);
  await assert.rejects(readTeamTiming({workspace, teamId}), /real workspace/);
});
