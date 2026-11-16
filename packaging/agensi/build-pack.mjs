#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PACKAGE_VERSION = '3.0.0';
export const REPOSITORY = 'https://github.com/hangy233/VGC-Coaching';
export const SKILL_FILES = Object.freeze({
  'vgc-coaching': ['SKILL.md', 'references/evidence-workflow.md', 'references/setup.md'],
  'champions-mc-matchups': ['SKILL.md', 'agents/openai.yaml', 'references/battle-regression-cases.md',
    'references/headless-battle-cycle.md', 'references/live-battle-lessons.md', 'references/mc-rules-and-tools.md',
    'references/proactive-win-plans.md', 'references/sources.md', 'references/turn-planning.md', 'scripts/sync-skill.mjs'],
  'champions-mc-teambuilding': ['SKILL.md', 'agents/openai.yaml', 'references/mc-rules-and-tools.md', 'references/sources.md'],
});
export const SHARED_DOCUMENTS = Object.freeze(['docs/AGENSI-PACK.md', 'docs/AGENT-STARTUP.md',
  'docs/ARCHITECTURE.md', 'docs/SIMULATOR.md', 'isolated/README.md', 'metrics/README.md',
  'showdown/AGENT-WORKFLOW.md', 'showdown/README.md']);
const packStem = `vgc-coaching-pack-v${PACKAGE_VERSION}`;
const maximumFiles = 100;
const maximumUploadBytes = 5 * 1024 * 1024;
const maximumListingCharacters = 6_000_000;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function safeRelative(filename) {
  if (!filename || filename.includes('\\') || filename.includes('\0') || path.posix.isAbsolute(filename)
    || filename.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe package path: ${filename}`);
  }
  return filename;
}

async function rejectLinks(root, relative = '') {
  let absolute = path.resolve(root);
  for (const segment of ['', ...relative.split('/').filter(Boolean)]) {
    if (segment) absolute = path.join(absolute, segment);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Symlinks and junctions cannot be packaged: ${relative || '.'}`);
  }
  return absolute;
}

async function sourceBytes(root, relative) {
  safeRelative(relative);
  const absolute = await rejectLinks(root, relative);
  const stat = await lstat(absolute);
  if (!stat.isFile()) throw new Error(`Expected a regular source file: ${relative}`);
  return readFile(absolute);
}

async function inventory(root, relative) {
  const absolute = await rejectLinks(root, relative);
  const stat = await lstat(absolute);
  if (!stat.isDirectory()) throw new Error(`Expected a skill folder: ${relative}`);
  const result = [];
  for (const entry of (await readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const child = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Symlinks and junctions cannot be packaged: ${child}`);
    if (entry.isDirectory()) {
      const children = await inventory(root, child);
      if (!children.length) throw new Error(`Empty source directories require publication review: ${child}`);
      result.push(...children);
    }
    else if (entry.isFile()) result.push(child);
    else throw new Error(`Unsupported source file: ${child}`);
  }
  return result;
}

// Exactly the complete-folder algorithm used by the repository's sync helper.
function folderHash(files) {
  const entries = new Map();
  for (const [relative, bytes] of files) {
    const segments = relative.split('/');
    for (let index = 1; index < segments.length; index++) entries.set(segments.slice(0, index).join('/'), { type: 'directory' });
    entries.set(relative, { type: 'file', digest: sha256(bytes) });
  }
  const hash = createHash('sha256');
  for (const relative of [...entries.keys()].sort()) {
    const entry = entries.get(relative);
    hash.update(`${entry.type}:${Buffer.byteLength(relative)}:${relative}:${entry.digest || ''}\n`);
  }
  return hash.digest('hex');
}

function markdownLinks(text) {
  const prose = text.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1\s*$/gm, '');
  return [...prose.matchAll(/!?\[[^\]\n]*\]\((<?[^)\n]*>?)\)/g)].map(match => ({
    full: match[0], destination: match[1].replace(/^<|>$/g, '').trim(),
  }));
}

function headings(text) {
  const result = new Set();
  const counts = new Map();
  for (const match of text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1].toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    result.add(`${base}${count ? `-${count}` : ''}`);
  }
  for (const match of text.matchAll(/<(?:a|h[1-6])\b[^>]*\bid=["']([^"']+)["']/gi)) result.add(match[1]);
  return result;
}

function localDestination(filename, destination) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(destination)) return null;
  const [rawPath, rawAnchor] = destination.split('#', 2);
  const relative = decodeURIComponent(rawPath || '');
  if (relative.includes('\\') || relative.includes('\0') || relative.startsWith('/')) throw new Error(`Unsafe Markdown link in ${filename}`);
  const target = path.posix.normalize(relative ? path.posix.join(path.posix.dirname(filename), relative) : filename);
  safeRelative(target);
  return { target, anchor: rawAnchor === undefined ? null : decodeURIComponent(rawAnchor) };
}

function checkPrivacy(filename, bytes) {
  const content = bytes.toString('utf8');
  if (!bytes.equals(Buffer.from(content))) throw new Error(`Only UTF-8 text files can be packaged: ${filename}`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z\d]{20,}|sk-(?:proj-)?[A-Za-z\d_-]{20,})\b/.test(content)) {
    throw new Error(`Possible credential material in ${filename}`);
  }
  for (const match of content.matchAll(/https?:\/\/(?:replay\.pokemonshowdown\.com|play\.pokemonshowdown\.com)\/[^\s)<>'"`]*|https?:\/\/pokepast\.es\/[^\s)<>'"`]+/gi)) {
    const url = new URL(match[0]);
    if (url.hostname === 'replay.pokemonshowdown.com' && !url.search && !url.hash && ['/', '/REPLAY_ID', '/REPLAY_ID.json'].includes(url.pathname)) continue;
    if (url.hostname === 'play.pokemonshowdown.com' && url.pathname === '/' && !url.search && !url.hash) continue;
    throw new Error(`Private battle or team URL is not allowed in ${filename}`);
  }
  if (/\bbattle-gen\d[a-z\d]*-\d{5,}(?:-[a-z\d]+)?\b/i.test(content)) throw new Error(`Battle identifiers are not allowed in ${filename}`);
}

// Fixed timestamps, order, UTF-8 names and stored records make the ZIP reproducible.
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}
function zipArchive(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [filename, bytes] of entries) {
    const name = Buffer.from(safeRelative(filename));
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0x0021, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    locals.push(header, name, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8); record.writeUInt16LE(0x0021, 14); record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(bytes.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function sourceState(root, sourceRevision, inputs) {
  if (sourceRevision !== undefined) {
    if (!/^[a-f\d]{40}$/i.test(sourceRevision)) throw new Error('sourceRevision must be a complete 40-character Git revision');
    return { revision: sourceRevision.toLowerCase(), workingTreeModified: true };
  }
  const { stdout: revision } = await execute('git', ['rev-parse', 'HEAD'], { cwd: root });
  const { stdout: changes } = await execute('git', ['status', '--porcelain', '--untracked-files=all', '--', ...inputs], { cwd: root });
  if (!/^[a-f\d]{40}$/i.test(revision.trim())) throw new Error('Could not identify the source Git revision');
  return { revision: revision.trim(), workingTreeModified: Boolean(changes.trim()) };
}

async function writeArtifact(filename, bytes) {
  let absolute = path.resolve(filename);
  const root = path.parse(absolute).root;
  let cursor = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Output path cannot contain symlinks or junctions');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
}

export async function buildPack({ repoRoot = defaultRoot, outputDir, sourceRevision } = {}) {
  const root = path.resolve(repoRoot);
  const output = path.resolve(outputDir || path.join(root, 'dist/agensi'));
  const files = new Map();
  const sourceFiles = new Map();
  const skills = [];
  for (const [name, expectedFiles] of Object.entries(SKILL_FILES)) {
    const prefix = `skills/${name}`;
    const actual = (await inventory(root, prefix)).map(filename => filename.slice(prefix.length + 1)).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expectedFiles].sort())) throw new Error(`Unexpected or missing files in ${prefix}; review the explicit publication allowlist`);
    const folderFiles = new Map();
    for (const relative of actual) {
      const filename = `${prefix}/${relative}`;
      const bytes = await sourceBytes(root, filename);
      checkPrivacy(filename, bytes);
      files.set(filename, bytes);
      sourceFiles.set(filename, bytes);
      folderFiles.set(relative, bytes);
    }
    const entry = files.get(`${prefix}/SKILL.md`).toString('utf8');
    if (!entry.startsWith('---') || !new RegExp(`^name:\\s*${name}\\s*$`, 'm').test(entry) || !/^description:\s*\S/m.test(entry)) {
      throw new Error(`Invalid skill name or description in ${prefix}/SKILL.md`);
    }
    skills.push({ name, path: `${prefix}/SKILL.md`, files: actual.length, sourceFolderSha256: folderHash(folderFiles) });
  }
  for (const filename of SHARED_DOCUMENTS) {
    const bytes = await sourceBytes(root, filename);
    checkPrivacy(filename, bytes);
    files.set(filename, bytes);
    sourceFiles.set(filename, bytes);
  }
  files.set('README.md', files.get('docs/AGENSI-PACK.md'));
  const state = await sourceState(root, sourceRevision, [...sourceFiles.keys()]);
  const rewrites = [];
  for (const [filename, bytes] of files) {
    if (!filename.endsWith('.md') || filename.startsWith('skills/')) continue;
    let text = bytes.toString('utf8');
    for (const { full, destination } of markdownLinks(text)) {
      const local = localDestination(filename, destination);
      if (!local) continue;
      // The ZIP root README describes the pack; the repo root README describes installing the runtime.
      if (local.target === 'README.md' && filename !== 'README.md') {
        const target = `${REPOSITORY}/blob/${state.revision}/README.md${local.anchor ? `#${encodeURIComponent(local.anchor)}` : ''}`;
        text = text.replace(full, full.replace(destination, target));
        rewrites.push({ file: filename, from: destination, to: target });
      }
    }
    files.set(filename, Buffer.from(text));
  }
  const headingsByFile = new Map([...files].filter(([name]) => name.endsWith('.md')).map(([name, bytes]) => [name, headings(bytes.toString('utf8'))]));
  let localLinksChecked = 0;
  for (const [filename, bytes] of files) {
    if (!filename.endsWith('.md')) continue;
    for (const { destination } of markdownLinks(bytes.toString('utf8'))) {
      const local = localDestination(filename, destination);
      if (!local) continue;
      if (!files.has(local.target)) throw new Error(`Unbundled local link in ${filename}: ${destination}`);
      if (local.anchor && !headingsByFile.get(local.target)?.has(local.anchor)) throw new Error(`Missing Markdown anchor in ${filename}: ${destination}`);
      localLinksChecked++;
    }
  }
  const skillCount = [...files.keys()].filter(filename => filename.endsWith('/SKILL.md') || filename === 'SKILL.md').length;
  if (skillCount !== 3) throw new Error(`Expected exactly three skills, received ${skillCount}`);
  const sourceFingerprint = sha256(jsonBytes([...sourceFiles].sort(([left], [right]) => left.localeCompare(right, 'en')).map(([filename, bytes]) => ({ path: filename, sha256: sha256(bytes) }))));
  const revision = /Cycle revision:\s*\*\*([^*]+)\*\*/.exec(files.get('skills/champions-mc-matchups/SKILL.md').toString('utf8'))?.[1];
  if (!revision) throw new Error('The matchup guidance must declare its cycle revision');
  const manifest = {
    schemaVersion: 1, packageName: 'vgc-coaching-pack', packageVersion: PACKAGE_VERSION,
    repository: REPOSITORY, sourceRevision: state.revision, sourceWorkingTreeModified: state.workingTreeModified,
    sourceFingerprintSha256: sourceFingerprint, matchupGuidanceRevision: revision,
    purpose: 'Instruction snapshot; not a runtime, installed-skill adoption receipt, or model qualification',
    skills, sharedDocuments: SHARED_DOCUMENTS, linkRewrites: rewrites,
    validation: { localMarkdownLinksChecked: localLinksChecked, exactSkillSourceBytes: true, maximumFiles, maximumUploadBytes,
      qualificationPerformed: false, installedSkillAdoptionVerified: false },
    manifestSelfExcludedFromFileInventory: true,
    files: [...files].sort(([left], [right]) => left.localeCompare(right, 'en')).map(([filename, bytes]) => ({
      path: filename, bytes: bytes.length, sha256: sha256(bytes),
      sourcePath: filename === 'README.md' ? 'docs/AGENSI-PACK.md' : filename,
      sourceSha256: sha256(sourceFiles.get(filename === 'README.md' ? 'docs/AGENSI-PACK.md' : filename)),
    })),
  };
  const manifestBuffer = jsonBytes(manifest);
  files.set('PACK-MANIFEST.json', manifestBuffer);
  for (const [filename, bytes] of files) checkPrivacy(filename, bytes);
  const entries = [...files].sort(([left], [right]) => left.localeCompare(right, 'en'));
  const upload = jsonBytes(entries.map(([filename, bytes]) => ({ path: filename, content: bytes.toString('utf8') })));
  const archive = zipArchive(entries);
  const characters = entries.reduce((sum, [, bytes]) => sum + bytes.toString('utf8').length, 0);
  if (entries.length > maximumFiles || upload.length > maximumUploadBytes || archive.length > maximumUploadBytes || characters > maximumListingCharacters) {
    throw new Error('Package exceeds the conservative Agensi agent-upload limits');
  }
  const archivePath = path.join(output, `${packStem}.zip`);
  const manifestPath = path.join(output, `${packStem}.manifest.json`);
  const uploadPath = path.join(output, `${packStem}.files.json`);
  await writeArtifact(archivePath, archive);
  await writeArtifact(manifestPath, manifestBuffer);
  await writeArtifact(uploadPath, upload);
  return { packageVersion: PACKAGE_VERSION, archivePath, manifestPath, uploadPath, archiveSha256: sha256(archive),
    archiveBytes: archive.length, uploadBytes: upload.length, fileCount: entries.length, skillCount,
    sourceRevision: state.revision, sourceWorkingTreeModified: state.workingTreeModified,
    sourceFingerprintSha256: sourceFingerprint, matchupGuidanceRevision: revision, localMarkdownLinksChecked: localLinksChecked, skills };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--output-dir' || !args[1])) throw new Error('Usage: node packaging/agensi/build-pack.mjs [--output-dir PATH]');
    process.stdout.write(`${JSON.stringify(await buildPack({ outputDir: args[1] }), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Agensi pack not built: ${error.message}\n`);
    process.exitCode = 1;
  }
}
