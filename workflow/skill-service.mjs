import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const execute = promisify(execFile);
const SKILLS = new Set(['champions-mc-matchups', 'champions-mc-teambuilding']);
const receipts = new Map();
const TTL = 60 * 60 * 1000;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => new Error('Battle skill: ' + message);
const contains = (root, path) => { const part = relative(root, path); return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)); };

async function rejectLinks(path) {
  const absolute = resolve(path), parsed = (await import('node:path')).parse(absolute);
  let current = parsed.root;
  for (const part of relative(parsed.root, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw fail('linked skill paths are not supported'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  }
}

/** Match the maintained sync script's path-and-content digest, without executing it. */
async function scan(root, { required = false } = {}) {
  await rejectLinks(root);
  let info;
  try { info = await lstat(root); } catch (error) { if (error.code === 'ENOENT' && !required) return { entries: new Map(), sha256: null }; throw error; }
  if (!info.isDirectory()) throw fail('a skill folder must be a directory');
  const entries = new Map(); let bytesRead = 0;
  async function visit(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), local = prefix ? `${prefix}/${name}` : name, info = await lstat(path);
      if (entries.size >= 512 || info.isSymbolicLink()) throw fail('skill contains a link or exceeds the file limit');
      if (info.isDirectory()) { entries.set(local, { type: 'directory' }); await visit(path, local); }
      else if (info.isFile()) {
        if (info.size > 1024 * 1024 || bytesRead + info.size > 8 * 1024 * 1024) throw fail('skill exceeds the bounded reading limit');
        const bytes = await readFile(path); bytesRead += bytes.length;
        if (bytes.includes(0)) throw fail('skill files must contain text');
        entries.set(local, { type: 'file', bytes, digest: digest(bytes) });
      } else throw fail('skill contains a non-regular file');
    }
  }
  await visit(root);
  const hash = createHash('sha256');
  for (const path of [...entries.keys()].sort()) { const entry = entries.get(path); hash.update(`${entry.type}:${Buffer.byteLength(path)}:${path}:${entry.digest || ''}\n`); }
  return { entries, sha256: hash.digest('hex') };
}

function locations({ workspace, skill = 'champions-mc-matchups', target }) {
  if (typeof workspace !== 'string' || !SKILLS.has(skill)) throw fail('choose a maintained Champions skill');
  const source = resolve(workspace, 'skills', skill);
  // target is an internal test injection only; it is never an MCP input field.
  const installed = resolve(target || join(process.env.CODEX_HOME || join(process.env.USERPROFILE || homedir(), '.codex'), 'skills', skill));
  if (contains(source, installed) || contains(installed, source)) throw fail('source and installed folders must be separate');
  return { skill, workspace: resolve(workspace), source, installed };
}

async function inspect(options) {
  const paths = locations(options);
  const [source, installed] = await Promise.all([scan(paths.source, { required: true }), scan(paths.installed)]);
  const differences = [];
  for (const path of [...new Set([...source.entries.keys(), ...installed.entries.keys()])].sort()) {
    const wanted = source.entries.get(path), actual = installed.entries.get(path);
    if (!wanted) differences.push({ path, status: 'extra' });
    else if (!actual) differences.push({ path, status: 'missing' });
    else if (wanted.type !== actual.type) differences.push({ path, status: 'type-conflict' });
    else if (wanted.digest !== actual.digest) differences.push({ path, status: 'changed' });
  }
  return { paths, source, installed, status: { skill: paths.skill, synchronized: source.sha256 === installed.sha256, sourceSha256: source.sha256, installedSha256: installed.sha256, source: paths.source, target: paths.installed, files: [...source.entries.values()].filter(value => value.type === 'file').length, differences, checkedAt: new Date().toISOString() } };
}

export async function getSkillStatus(options = {}) { return (await inspect(options)).status; }

/** Return every maintained instruction and bind a short-lived receipt to its exact contents. */
export async function readSkill(options = {}) {
  const { paths, source, status } = await inspect(options);
  for (const [id, value] of receipts) if (value.expiresAt < Date.now()) receipts.delete(id);
  while (receipts.size >= 256) receipts.delete(receipts.keys().next().value);
  const receipt = randomUUID(), issuedAt = new Date().toISOString(), expiresAt = Date.now() + TTL;
  receipts.set(receipt, { workspace: paths.workspace, skill: paths.skill, sha256: source.sha256, issuedAt, expiresAt });
  return { ...status, filesRead: [...source.entries].filter(([, value]) => value.type === 'file').map(([path, value]) => ({ path, sha256: value.digest, content: value.bytes.toString('utf8') })), readReceipt: receipt, receiptExpiresAt: new Date(expiresAt).toISOString(), limitation: 'The receipt verifies delivery of these exact files through this MCP process, not that the agent understood or followed them.' };
}

export async function verifySkillRead({ workspace, readReceipt, target }) {
  const value = receipts.get(readReceipt), status = await getSkillStatus({ workspace, target });
  if (!status.synchronized) throw fail('repository and installed matchup guidance differ; review and sync before completing a BO3 checkpoint');
  if (!value || value.workspace !== resolve(workspace) || value.skill !== 'champions-mc-matchups' || value.expiresAt < Date.now() || value.sha256 !== status.sourceSha256) throw fail('read the current complete matchup guidance with battle_skill_read and supply its unexpired readReceipt');
  return { sourceSha256: status.sourceSha256, installedSha256: status.installedSha256, syncVerified: true, changedInstructionsRead: true, checkedAt: status.checkedAt, readAt: value.issuedAt, readReceiptKind: 'exact-content-delivered', limitation: 'Delivery was verified; judgment and compliance remain agent responsibilities.' };
}

/** Only the fixed maintained script, source and installed skill paths are executable. */
export async function syncSkill({ workspace, skill = 'champions-mc-matchups', target, dryRun = true, confirmed = false } = {}) {
  if (typeof dryRun !== 'boolean' || typeof confirmed !== 'boolean') throw fail('dryRun and confirmed must be booleans');
  const before = await inspect({ workspace, skill, target });
  if (dryRun || before.status.synchronized) return { ...before.status, dryRun, changed: false, requiresConfirmation: !before.status.synchronized };
  if (!confirmed) throw fail('applying a reviewed skill sync requires confirmed:true');
  if (before.status.differences.some(value => ['extra', 'type-conflict'].includes(value.status))) throw fail('installed extra paths or type conflicts must be reviewed separately; no files were changed');
  const backup = resolve(workspace, 'cache', 'skill-backups', `${skill}-${Date.now()}-${randomUUID()}`);
  await rejectLinks(resolve(workspace, 'cache', 'skill-backups'));
  const script = resolve(workspace, 'skills', 'champions-mc-matchups', 'scripts', 'sync-skill.mjs');
  await rejectLinks(script);
  if (!(await lstat(script)).isFile()) throw fail('maintained sync script is unavailable');
  // execFile uses an argument array, no shell, and no caller-supplied command or path.
  let output;
  try { output = await execute(process.execPath, [script, '--install', '--source', before.paths.source, '--target', before.paths.installed, '--backup', backup], { cwd: await realpath(workspace), windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }); }
  catch (error) { let report; try { report = JSON.parse(error.stdout || ''); } catch {} throw fail(report?.error || 'skill sync failed; inspect the installed copy and retained backup'); }
  const applied = JSON.parse(output.stdout), after = await getSkillStatus({ workspace, skill, target });
  if (!applied.synchronized || !after.synchronized || after.sourceSha256 !== before.status.sourceSha256) throw fail('source changed or post-sync verification failed; read the current guidance and inspect the backup');
  return { ...after, dryRun: false, changed: true, backup: applied.backup || null, requiresRead: true };
}
