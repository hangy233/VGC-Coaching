#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Content and relative paths are authoritative; timestamps are deliberately ignored.
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function separate(left, right) {
  if (contains(left, right) || contains(right, left)) throw new Error(`Paths must not overlap: ${left} and ${right}`);
}
async function statIfPresent(filename) {
  try { return await lstat(filename); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function rejectSymlinkAncestors(filename) {
  const root = path.parse(filename).root;
  let current = root;
  for (const part of path.relative(root, filename).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await statIfPresent(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error(`Symlinks and junctions are not allowed: ${current}`);
  }
}
async function scan(root, required = false) {
  await rejectSymlinkAncestors(root);
  const rootStat = await statIfPresent(root);
  if (!rootStat) {
    if (required) throw new Error(`Source directory does not exist: ${root}`);
    return { entries: new Map(), digest: null, files: 0 };
  }
  if (!rootStat.isDirectory()) throw new Error(`Expected a directory: ${root}`);
  const entries = new Map();
  async function visit(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const absolute = path.join(directory, name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Symlinks and junctions are not allowed: ${absolute}`);
      if (stat.isDirectory()) {
        entries.set(relative, { type: 'directory' });
        await visit(absolute, relative);
      } else if (stat.isFile()) {
        const bytes = await readFile(absolute);
        entries.set(relative, { type: 'file', bytes, digest: sha256(bytes) });
      } else throw new Error(`Only regular files and directories are supported: ${absolute}`);
    }
  }
  await visit(root);
  const digest = createHash('sha256');
  for (const relative of [...entries.keys()].sort()) {
    const entry = entries.get(relative);
    // Length-prefixed paths and fixed-size content hashes avoid delimiter ambiguity.
    digest.update(`${entry.type}:${Buffer.byteLength(relative)}:${relative}:${entry.digest || ''}\n`);
  }
  return { entries, digest: digest.digest('hex'), files: [...entries.values()].filter(entry => entry.type === 'file').length };
}
function differences(source, installed) {
  const result = [];
  for (const filename of [...new Set([...source.keys(), ...installed.keys()])].sort()) {
    const wanted = source.get(filename);
    const actual = installed.get(filename);
    if (!wanted) result.push({ path: filename, status: 'extra' });
    else if (!actual) result.push({ path: filename, status: 'missing' });
    else if (wanted.type !== actual.type) result.push({ path: filename, status: 'type-conflict' });
    else if (wanted.digest !== actual.digest) result.push({ path: filename, status: 'changed' });
  }
  return result;
}
function options(argv) {
  const result = { mode: 'check' };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!['--check', '--install', '--source', '--target', '--backup'].includes(flag)) throw new Error(`Unknown argument: ${flag}`);
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    seen.add(flag);
    if (flag === '--check' || flag === '--install') result.mode = flag.slice(2);
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`A path is required after ${flag}`);
      result[flag.slice(2)] = path.resolve(value);
    }
  }
  if (seen.has('--check') && seen.has('--install')) throw new Error('Choose either --check or --install.');
  result.source ||= path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  result.target ||= path.join(process.env.CODEX_HOME || path.join(process.env.USERPROFILE || homedir(), '.codex'), 'skills', 'champions-mc-matchups');
  result.source = path.resolve(result.source);
  result.target = path.resolve(result.target);
  return result;
}

let report = { synchronized: false, sourceSha256: null, installedSha256: null, files: 0, differences: [] };
try {
  const config = options(process.argv.slice(2));
  separate(config.source, config.target);
  const source = await scan(config.source, true);
  const installed = await scan(config.target);
  const delta = differences(source.entries, installed.entries);
  report = { ...report, mode: config.mode, source: config.source, target: config.target,
    sourceSha256: source.digest, installedSha256: installed.digest, files: source.files, differences: delta,
    synchronized: source.digest === installed.digest };
  if (config.mode === 'install' && !report.synchronized) {
    if (delta.some(entry => entry.status === 'extra')) throw new Error('Installed copy contains extra paths. No files were changed or deleted; review those paths before syncing.');
    if (delta.some(entry => entry.status === 'type-conflict')) throw new Error('A file/directory type conflicts. No files were changed or deleted; resolve that path before syncing.');
    const overwritten = delta.filter(entry => entry.status === 'changed');
    if (overwritten.length && !config.backup) throw new Error('Overwriting installed files requires an explicit --backup directory. No files were changed.');
    if (config.backup) {
      separate(config.backup, config.source);
      separate(config.backup, config.target);
      const backup = await scan(config.backup);
      if (backup.entries.size) throw new Error('Backup directory must be absent or empty. No files were changed.');
      if (overwritten.length) {
        await mkdir(config.backup, { recursive: true });
        for (const entry of overwritten) {
          const destination = path.join(config.backup, entry.path);
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, installed.entries.get(entry.path).bytes, { flag: 'wx' });
        }
        report.backup = config.backup;
      }
    }
    // Recheck every path immediately before writing; never follow an installed link.
    await rejectSymlinkAncestors(config.target);
    await mkdir(config.target, { recursive: true });
    for (const entry of delta) {
      const destination = path.join(config.target, entry.path);
      await rejectSymlinkAncestors(destination);
      const wanted = source.entries.get(entry.path);
      if (wanted.type === 'directory') await mkdir(destination, { recursive: true });
      else {
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, wanted.bytes, { flag: entry.status === 'missing' ? 'wx' : 'w' });
      }
    }
    const finalSource = await scan(config.source, true);
    const finalInstalled = await scan(config.target, true);
    report.sourceSha256 = finalSource.digest;
    report.installedSha256 = finalInstalled.digest;
    report.differences = differences(finalSource.entries, finalInstalled.entries);
    report.synchronized = source.digest === finalSource.digest && finalSource.digest === finalInstalled.digest;
    if (!report.synchronized) throw new Error('Verification failed or source changed during installation; inspect both copies and the backup.');
  }
  process.exitCode = report.synchronized ? 0 : 1;
} catch (error) {
  report.error = error.message;
  process.exitCode = 2;
}
process.stdout.write(`${JSON.stringify(report)}\n`);
