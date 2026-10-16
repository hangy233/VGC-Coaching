import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../skills/champions-mc-matchups/scripts/sync-skill.mjs', import.meta.url));
async function fixture(t) {
  const temporaryRoot = await realpath(tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, 'vgc-skill-sync-'));
  const resolvedRoot = await realpath(root);
  assert.equal(path.dirname(resolvedRoot), temporaryRoot);
  assert.ok(path.basename(resolvedRoot).startsWith('vgc-skill-sync-'));
  t.after(async () => {
    assert.equal(await realpath(root), resolvedRoot);
    assert.equal(path.dirname(resolvedRoot), temporaryRoot);
    await rm(resolvedRoot, { recursive: true, force: true });
  });
  const source = path.join(root, 'source');
  const target = path.join(root, 'installed');
  const backup = path.join(root, 'backup');
  await mkdir(path.join(source, 'references'), { recursive: true });
  await mkdir(path.join(source, 'agents'), { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '# Matchups\n');
  await writeFile(path.join(source, 'references', 'cycle.md'), 'Conclude, update, then queue.\n');
  await writeFile(path.join(source, 'agents', 'openai.yaml'), 'display_name: Matchups\n');
  function run(...args) {
    const result = spawnSync(process.execPath, [script, '--source', source, '--target', target, ...args], { encoding: 'utf8' });
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.stderr, '');
    return { status: result.status, body: JSON.parse(result.stdout) };
  }
  return { root, source, target, backup, run };
}

test('check reports a missing installation and install verifies every file', async t => {
  const f = await fixture(t);
  const stale = f.run('--check');
  assert.equal(stale.status, 1);
  assert.equal(stale.body.installedSha256, null);
  assert.equal(stale.body.files, 3);
  assert.ok(stale.body.differences.some(entry => entry.path === 'references/cycle.md' && entry.status === 'missing'));
  const installed = f.run('--install');
  assert.equal(installed.status, 0);
  assert.equal(installed.body.synchronized, true);
  assert.equal(installed.body.sourceSha256, installed.body.installedSha256);
  assert.deepEqual(installed.body.differences, []);
  assert.equal(await readFile(path.join(f.target, 'references', 'cycle.md'), 'utf8'), 'Conclude, update, then queue.\n');
  const again = f.run('--install');
  assert.equal(again.status, 0);
  assert.equal(again.body.sourceSha256, installed.body.sourceSha256);
  assert.equal('backup' in again.body, false);
});

test('reference and agent metadata changes are detected and overwritten bytes are backed up exactly', async t => {
  const f = await fixture(t);
  assert.equal(f.run('--install').status, 0);
  const original = await readFile(path.join(f.target, 'agents', 'openai.yaml'));
  await writeFile(path.join(f.source, 'agents', 'openai.yaml'), 'display_name: Updated\r\n');
  await writeFile(path.join(f.source, 'references', 'cycle.md'), 'Require an evidence-backed update.\n');
  const check = f.run('--check');
  assert.equal(check.status, 1);
  assert.deepEqual(check.body.differences, [
    { path: 'agents/openai.yaml', status: 'changed' },
    { path: 'references/cycle.md', status: 'changed' },
  ]);
  const refused = f.run('--install');
  assert.equal(refused.status, 2);
  assert.match(refused.body.error, /explicit --backup/);
  assert.deepEqual(await readFile(path.join(f.target, 'agents', 'openai.yaml')), original);
  const installed = f.run('--install', '--backup', f.backup);
  assert.equal(installed.status, 0);
  assert.deepEqual(await readFile(path.join(f.backup, 'agents', 'openai.yaml')), original);
  assert.equal(await readFile(path.join(f.backup, 'references', 'cycle.md'), 'utf8'), 'Conclude, update, then queue.\n');
  assert.equal(await readFile(path.join(f.target, 'agents', 'openai.yaml'), 'utf8'), 'display_name: Updated\r\n');
  assert.equal(f.run('--check').status, 0);
});

test('renamed paths and empty directories affect the digest even with identical file bytes', async t => {
  const f = await fixture(t);
  const first = f.run('--install');
  await mkdir(path.join(f.target, 'extra-empty'));
  const extra = f.run('--check');
  assert.equal(extra.status, 1);
  assert.notEqual(extra.body.installedSha256, first.body.sourceSha256);
  assert.ok(extra.body.differences.some(entry => entry.path === 'extra-empty' && entry.status === 'extra'));
  await rmdir(path.join(f.target, 'extra-empty'));
  await writeFile(path.join(f.target, 'renamed.md'), await readFile(path.join(f.target, 'SKILL.md')));
  await rm(path.join(f.target, 'SKILL.md'));
  const renamed = f.run('--check');
  assert.equal(renamed.status, 1);
  assert.ok(renamed.body.differences.some(entry => entry.path === 'SKILL.md' && entry.status === 'missing'));
  assert.ok(renamed.body.differences.some(entry => entry.path === 'renamed.md' && entry.status === 'extra'));
});

test('extra installed paths refuse the entire install without deleting or overwriting anything', async t => {
  const f = await fixture(t);
  assert.equal(f.run('--install').status, 0);
  await writeFile(path.join(f.target, 'local-note.md'), 'Keep this local file.');
  await writeFile(path.join(f.source, 'SKILL.md'), '# New content\n');
  const result = f.run('--install', '--backup', f.backup);
  assert.equal(result.status, 2);
  assert.match(result.body.error, /extra paths/);
  assert.equal(await readFile(path.join(f.target, 'local-note.md'), 'utf8'), 'Keep this local file.');
  assert.equal(await readFile(path.join(f.target, 'SKILL.md'), 'utf8'), '# Matchups\n');
  assert.ok(!(await readdir(f.root)).includes('backup'));
});

test('same and nested roots, nested backups, and nonempty backups are refused', async t => {
  const f = await fixture(t);
  for (const target of [f.source, path.join(f.source, 'nested'), f.root]) {
    const result = spawnSync(process.execPath, [script, '--source', f.source, '--target', target, '--check'], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(JSON.parse(result.stdout).error, /must not overlap/);
  }
  assert.equal(f.run('--install').status, 0);
  await writeFile(path.join(f.source, 'SKILL.md'), 'Changed\n');
  const nested = f.run('--install', '--backup', path.join(f.target, 'backups'));
  assert.equal(nested.status, 2);
  assert.match(nested.body.error, /must not overlap/);
  await mkdir(f.backup);
  await writeFile(path.join(f.backup, 'previous.txt'), 'Previous backup');
  const nonempty = f.run('--install', '--backup', f.backup);
  assert.equal(nonempty.status, 2);
  assert.match(nonempty.body.error, /absent or empty/);
  assert.equal(await readFile(path.join(f.target, 'SKILL.md'), 'utf8'), '# Matchups\n');
});

test('source and installed symlinks or junctions are refused without traversal', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'private.txt'), 'Outside content must stay untouched.');
  try {
    await symlink(outside, path.join(f.source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    t.skip('This process cannot create a fixture symlink/junction; run unsandboxed to exercise link refusal.');
    return;
  }
  let result = f.run('--install');
  assert.equal(result.status, 2);
  assert.match(result.body.error, /Symlinks and junctions/);
  const sourceLink = path.resolve(f.source, 'linked');
  assert.equal(path.dirname(sourceLink), f.source);
  assert.ok((await lstat(sourceLink)).isSymbolicLink());
  await rm(sourceLink, { recursive: true });
  assert.equal(f.run('--install').status, 0);
  await symlink(outside, path.join(f.target, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  result = f.run('--check');
  assert.equal(result.status, 2);
  assert.match(result.body.error, /Symlinks and junctions/);
  const alias = path.join(f.root, 'installed-alias');
  await symlink(f.target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliasResult = spawnSync(process.execPath, [script, '--source', f.source, '--target', alias, '--check'], { encoding: 'utf8' });
  assert.equal(aliasResult.status, 2);
  assert.match(JSON.parse(aliasResult.stdout).error, /Symlinks and junctions/);
  assert.equal(await readFile(path.join(outside, 'private.txt'), 'utf8'), 'Outside content must stay untouched.');
});

test('file/directory conflicts refuse writes instead of deleting conflicting paths', async t => {
  const f = await fixture(t);
  await mkdir(f.target);
  await writeFile(path.join(f.target, 'references'), 'Installed regular file.');
  const result = f.run('--install', '--backup', f.backup);
  assert.equal(result.status, 2);
  assert.match(result.body.error, /type conflicts/);
  assert.equal(await readFile(path.join(f.target, 'references'), 'utf8'), 'Installed regular file.');
});
