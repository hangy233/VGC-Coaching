import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildPack, PACKAGE_VERSION, SHARED_DOCUMENTS, SKILL_FILES } from './build-pack.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const revision = 'a'.repeat(40);
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'vgc-agensi-pack-'));
  t.after(async () => {
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
    assert(!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
    assert(path.basename(root).startsWith('vgc-agensi-pack-'));
    await rm(root, { recursive: true, force: true });
  });
  const sources = [...SHARED_DOCUMENTS, ...Object.entries(SKILL_FILES).flatMap(([name, files]) => files.map(filename => `skills/${name}/${filename}`))];
  for (const filename of sources) {
    const destination = path.join(root, filename);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(repositoryRoot, filename), destination);
  }
  return { root, sources, build: extra => buildPack({ repoRoot: root, sourceRevision: revision, ...extra }) };
}

// Independent parser checks both ZIP directory structures and each record CRC.
function readStoredZip(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  const result = new Map();
  let cursor = 0;
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x04034b50);
    assert.equal(bytes.readUInt16LE(cursor + 6), 0x0800);
    assert.equal(bytes.readUInt16LE(cursor + 8), 0);
    const length = bytes.readUInt32LE(cursor + 18);
    assert.equal(length, bytes.readUInt32LE(cursor + 22));
    const nameLength = bytes.readUInt16LE(cursor + 26);
    const extraLength = bytes.readUInt16LE(cursor + 28);
    const name = bytes.subarray(cursor + 30, cursor + 30 + nameLength).toString('utf8');
    const data = bytes.subarray(cursor + 30 + nameLength + extraLength, cursor + 30 + nameLength + extraLength + length);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    assert.equal((crc ^ 0xffffffff) >>> 0, bytes.readUInt32LE(cursor + 14));
    assert(!result.has(name));
    result.set(name, { data, localOffset: cursor });
    cursor += 30 + nameLength + extraLength + length;
  }
  assert.equal(cursor, directoryOffset);
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.equal(result.get(name).localOffset, bytes.readUInt32LE(cursor + 42));
    cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor, end);
  return new Map([...result].map(([name, entry]) => [name, entry.data]));
}

test('ZIP, manifest and upload files round-trip complete canonical skills and shared docs', async t => {
  const { root, sources, build } = await fixture(t);
  const result = await build();
  const archiveBytes = await readFile(result.archivePath);
  const files = readStoredZip(archiveBytes);
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  const upload = JSON.parse(await readFile(result.uploadPath, 'utf8'));
  assert.equal(PACKAGE_VERSION, '3.0.0');
  assert.equal(files.size, result.fileCount);
  assert.equal([...files.keys()].filter(filename => filename.endsWith('/SKILL.md')).length, 3);
  assert.equal(result.archiveSha256, hash(archiveBytes));
  assert.equal(manifest.sourceRevision, revision);
  assert.equal(manifest.sourceWorkingTreeModified, true);
  assert.equal(manifest.validation.qualificationPerformed, false);
  assert.equal(manifest.validation.installedSkillAdoptionVerified, false);
  assert(result.localMarkdownLinksChecked > 50);
  assert.deepEqual(files.get('PACK-MANIFEST.json'), await readFile(result.manifestPath));
  assert.deepEqual(files.get('README.md'), await readFile(path.join(root, 'docs/AGENSI-PACK.md')));
  for (const filename of sources.filter(filename => filename.startsWith('skills/'))) {
    assert.deepEqual(files.get(filename), await readFile(path.join(root, filename)), filename);
  }
  for (const filename of SHARED_DOCUMENTS) assert(files.has(filename));
  for (const item of manifest.files) {
    assert.equal(item.sha256, hash(files.get(item.path)), item.path);
    assert.equal(item.sourceSha256, hash(await readFile(path.join(root, item.sourcePath))), item.path);
  }
  for (const item of upload) assert.deepEqual(Buffer.from(item.content), files.get(item.path), item.path);
  assert.equal(upload.length, files.size);
  assert(![...files.keys()].some(filename => /^(?:cache|teams|logs|dist|node_modules|\.git|\.codex|docs\/distribution)\//.test(filename)));
  const policy = await readFile(path.join(repositoryRoot, 'isolated/decision-context.mjs'), 'utf8');
  const policyHash = /skillSha256:'([a-f\d]{64})'/.exec(policy)?.[1];
  assert(policyHash, 'the live runner must pin a complete-folder guidance hash');
  assert.equal(manifest.skills.find(skill => skill.name === 'champions-mc-matchups').sourceFolderSha256, policyHash);
});

test('rebuilds are byte-identical independently of output directory', async t => {
  const { root, build } = await fixture(t);
  const first = await build({ outputDir: path.join(root, 'out-a') });
  const second = await build({ outputDir: path.join(root, 'out-b') });
  for (const key of ['archivePath', 'manifestPath', 'uploadPath']) assert.deepEqual(await readFile(first[key]), await readFile(second[key]));
  assert.equal(first.archiveSha256, second.archiveSha256);
  assert(!(await readFile(first.manifestPath, 'utf8')).includes(root));
});

test('shared installation links point to the original pinned runtime README', async t => {
  const { build } = await fixture(t);
  const result = await build();
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  const files = readStoredZip(await readFile(result.archivePath));
  const startup = files.get('docs/AGENT-STARTUP.md').toString('utf8');
  assert(startup.includes(`/blob/${revision}/README.md#install-and-connect`));
  assert(manifest.linkRewrites.some(item => item.file === 'docs/AGENT-STARTUP.md'));
  assert.notEqual(manifest.files.find(item => item.path === 'docs/AGENT-STARTUP.md').sha256,
    manifest.files.find(item => item.path === 'docs/AGENT-STARTUP.md').sourceSha256);
});

test('unexpected skill files fail closed before writing the release', async t => {
  const { root, build } = await fixture(t);
  await writeFile(path.join(root, 'skills/vgc-coaching/private.txt'), 'unreviewed data');
  await assert.rejects(build(), /explicit publication allowlist/);
  await assert.rejects(lstat(path.join(root, 'dist/agensi')), { code: 'ENOENT' });
});

test('missing required references are rejected', async t => {
  const { root, build } = await fixture(t);
  await unlink(path.join(root, 'skills/champions-mc-teambuilding/references/sources.md'));
  await assert.rejects(build(), /explicit publication allowlist/);
});

test('empty skill directories cannot silently disappear from a complete-folder receipt', async t => {
  const { root, build } = await fixture(t);
  await mkdir(path.join(root, 'skills/vgc-coaching/unreviewed-empty-folder'));
  await assert.rejects(build(), /Empty source directories require publication review/);
});

for (const [label, destination, expected] of [
  ['missing dependency', 'references/not-bundled.md', /Unbundled local link/],
  ['missing heading', 'SKILL.md#not-a-real-heading', /Missing Markdown anchor/],
  ['escaping path', '../../../../outside.md', /Unsafe package path/],
]) {
  test(`rejects ${label} in canonical guidance`, async t => {
    const { root, build } = await fixture(t);
    const filename = path.join(root, 'skills/vgc-coaching/SKILL.md');
    await writeFile(filename, `${await readFile(filename, 'utf8')}\n[check](${destination})\n`);
    await assert.rejects(build(), expected);
  });
}

for (const [label, material, expected] of [
  ['private replay URL', 'https://replay.pokemonshowdown.com/gen9test-123456789-secret', /Private battle or team URL/],
  ['private team URL', 'https://pokepast.es/0123456789abcdef', /Private battle or team URL/],
  ['battle identifier', 'battle-gen9championsvgc2026regmc-123456789-secret', /Battle identifiers/],
  ['credential', `ghp_${'a'.repeat(32)}`, /Possible credential material/],
]) {
  test(`rejects ${label} from allowlisted source`, async t => {
    const { root, build } = await fixture(t);
    const filename = path.join(root, 'docs/AGENSI-PACK.md');
    await writeFile(filename, `${await readFile(filename, 'utf8')}\n${material}\n`);
    await assert.rejects(build(), expected);
  });
}

test('rejects a skill renamed to collide with another entry', async t => {
  const { root, build } = await fixture(t);
  const filename = path.join(root, 'skills/vgc-coaching/SKILL.md');
  await writeFile(filename, (await readFile(filename, 'utf8')).replace('name: vgc-coaching', 'name: champions-mc-matchups'));
  await assert.rejects(build(), /Invalid skill name or description/);
});

test('rejects invalid revision labels instead of minting an ambiguous source receipt', async t => {
  const { build } = await fixture(t);
  await assert.rejects(build({ sourceRevision: 'main' }), /40-character Git revision/);
});

test('rejects oversized text uploads before writing any artifact', async t => {
  const { root, build } = await fixture(t);
  const filename = path.join(root, 'skills/champions-mc-teambuilding/references/sources.md');
  await writeFile(filename, 'plain text\n'.repeat(600_000));
  await assert.rejects(build(), /agent-upload limits/);
  await assert.rejects(lstat(path.join(root, 'dist/agensi')), { code: 'ENOENT' });
});

test('rejects source symlinks rather than reading outside the curated folder', async t => {
  const { root, build } = await fixture(t);
  const filename = path.join(root, 'skills/vgc-coaching/references/setup.md');
  const target = path.join(root, 'external-data.txt');
  await writeFile(target, 'external data');
  await unlink(filename);
  try { await symlink(target, filename, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Windows file symlink permission unavailable'); throw error; }
  await assert.rejects(build(), /Symlinks and junctions/);
});

test('rejects an output junction before overwriting external files', async t => {
  const { root, build } = await fixture(t);
  const output = path.join(root, 'linked-output');
  const target = path.join(root, 'actual-output');
  await mkdir(target);
  try { await symlink(target, output, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Directory link permission unavailable'); throw error; }
  await assert.rejects(build({ outputDir: output }), /Output path cannot contain symlinks or junctions/);
  await assert.rejects(lstat(path.join(target, 'vgc-coaching-pack-v3.0.0.zip')), { code: 'ENOENT' });
});
