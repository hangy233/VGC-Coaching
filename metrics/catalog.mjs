import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const MAX_ACTIVE_TEAMS = 10;
const CATALOG_FILENAME = 'catalog.sqlite';
const HASH = /^[a-f0-9]{64}$/u;
const BATTLE_FILE = /^[a-z0-9]+(?:-[a-z0-9]+)*--[a-f0-9]{64}\.json$/u;
const POKEMON_COUNTERS = ['switchIns', 'faints', 'knockouts', 'indirectKnockouts', 'itemRemovals', 'couldNotAct'];
const MOVE_COUNTERS = ['uses', 'calledUses', 'failed', 'missed', 'blocked', 'knockouts', 'itemRemovals'];
const SOURCES_LOCK_TEAM = '0'.repeat(64);
const coordinationLock = (roomId, teamId) => teamId === SOURCES_LOCK_TEAM && roomId === 'metrics-sources';

function invalid(message) { throw new TypeError(`Invalid metrics catalog: ${message}`); }
function validateTeamId(teamId) {
  if (typeof teamId !== 'string' || !HASH.test(teamId)) invalid('teamId must be a lowercase SHA-256 hash');
  return teamId;
}
function safeText(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${field} must be bounded text`);
  return value.trim();
}
function descriptor({ teamId, name, format, roster } = {}) {
  validateTeamId(teamId);
  const result = { teamId };
  if (name !== undefined) result.name = safeText(name, 'name');
  if (format !== undefined && format !== null) result.format = safeText(format, 'format');
  if (roster !== undefined) {
    if (!Array.isArray(roster) || roster.length > 24) invalid('roster must be a bounded array');
    result.roster = [...new Set(roster.map(species => safeText(species, 'roster species')))];
  }
  return result;
}
const date = value => {
  if (value === undefined || value === null || value === '') return null;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
};
const sortedTexts = value => [...new Set((value ?? []).map(entry => String(entry).trim()))].sort();
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};

/** Exclude provenance/display changes, timestamps generated on import, and warnings from battle activity. */
export function materialBattleSignature(record) {
  const pokemon = (record.pokemon ?? []).map(entry => ({
    key: entry.key, species: entry.species, forms: sortedTexts(entry.forms), selected: entry.selected === true,
    lead: entry.lead === true, megaEvolved: entry.megaEvolved === true,
    ...Object.fromEntries(POKEMON_COUNTERS.map(field => [field, entry[field] ?? 0])),
    moves: (entry.moves ?? []).map(move => ({ move: move.move, ...Object.fromEntries(MOVE_COUNTERS.map(field => [field, move[field] ?? 0])) })).sort((a, b) => a.move.localeCompare(b.move)),
  })).sort((a, b) => a.key.localeCompare(b.key));
  const value = {
    roomId: record.roomId, parentId: record.parentId ?? null, teamId: record.teamId,
    username: record.username, ownSide: record.ownSide, outcome: record.outcome, completed: record.completed === true,
    turns: record.turns ?? 0, opponentRoster: sortedTexts(record.opponentRoster), opponentSelected: sortedTexts(record.opponentSelected),
    opponentLeads: sortedTexts(record.opponentLeads), opponentSelectionKnown: record.opponentSelectionKnown === true,
    opponentMega: sortedTexts(record.opponentMega), selected: sortedTexts(record.selected), selectionKnown: record.selectionKnown === true,
    leads: sortedTexts(record.leads), pokemon, quality: { complete: record.quality?.complete === true, operational: record.quality?.operational === true },
    startedAt: date(record.metadata?.startedAt), endedAt: date(record.metadata?.endedAt),
    setResult: record.metadata?.setResult ? { completed: record.metadata.setResult.completed === true, outcome: record.metadata.setResult.outcome } : null,
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function contained(root, target) {
  const part = relative(root, target);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
async function storageDirectory(workspace, create) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) invalid('workspace must be an absolute directory');
  const root = await realpath(workspace);
  let current = root;
  for (const name of ['cache', 'team-metrics']) {
    current = join(current, name);
    let info;
    try { info = await lstat(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return null;
      try { await mkdir(current); } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory() || !contained(root, await realpath(current))) invalid('storage directories must be real directories within the workspace');
  }
  return current;
}
async function safeCatalogFile(file) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      const info = await lstat(file + suffix);
      if (info.isSymbolicLink() || !info.isFile()) invalid('catalog and sidecars must be regular files, not links');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** Read legacy summaries solely to seed the catalog. The summaries remain in place and unmodified. */
async function legacyRecords(directory) {
  const records = [];
  for (const name of (await readdir(directory)).filter(entry => entry.endsWith('.json')).sort()) {
    if (!BATTLE_FILE.test(name)) invalid('unexpected JSON file in metrics storage');
    const path = join(directory, name), info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 2_000_000) invalid('legacy battle must be a bounded regular file');
    const record = JSON.parse(await readFile(path, 'utf8'));
    validateTeamId(record?.teamId);
    if (name !== `${record.roomId}--${record.teamId}.json`) invalid('legacy identity does not match its filename');
    record.catalogLegacyAt = date(record.updatedAt) ?? date(record.importedAt) ?? date(record.metadata?.endedAt) ?? date(record.metadata?.startedAt) ?? info.mtime.toISOString();
    records.push(record);
  }
  return records;
}

function transaction(database, operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
function nextOrder(database) {
  database.prepare("UPDATE catalog_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'usage_order'").run();
  return Number(database.prepare("SELECT value FROM catalog_meta WHERE key = 'usage_order'").get().value);
}
function unpack(row) {
  if (!row) return null;
  return { teamId: row.team_id, name: row.name, format: row.format, roster: JSON.parse(row.roster_json),
    active: row.active === 1, archived: row.active !== 1, createdAt: row.created_at, lastUsedAt: row.last_used_at,
    usageOrder: row.usage_order, archivedAt: row.archived_at, archiveReason: row.archive_reason };
}
const selectOne = (database, teamId) => unpack(database.prepare('SELECT * FROM teams WHERE team_id = ?').get(teamId));
function deletionStatus(database, teamId) {
  const row = database.prepare('SELECT team_id,state,started_at,completed_at FROM deleted_teams WHERE team_id=?').get(teamId);
  return row ? { teamId: row.team_id, state: row.state, startedAt: row.started_at, completedAt: row.completed_at } : null;
}
function assertWritable(database, teamId) {
  const deletion = deletionStatus(database, teamId);
  if (!deletion) return;
  const error = new Error('This team report has been deleted or is being deleted; stale imports and live recording cannot recreate it.');
  error.code = 'METRICS_TEAM_DELETED';
  error.teamId = teamId;
  error.deletionState = deletion.state;
  throw error;
}
function updateDescriptor(database, input) {
  assertWritable(database, input.teamId);
  const existing = selectOne(database, input.teamId);
  if (!existing) return null;
  database.prepare('UPDATE teams SET name = ?, format = ?, roster_json = ? WHERE team_id = ?').run(
    input.name ?? existing.name, input.format ?? existing.format, JSON.stringify(input.roster?.length ? input.roster : existing.roster), input.teamId);
  return selectOne(database, input.teamId);
}
function trimActive(database, now) {
  const evicted = database.prepare('SELECT team_id FROM teams WHERE active = 1 AND team_id NOT IN(SELECT team_id FROM deleted_teams) ORDER BY usage_order DESC, team_id ASC LIMIT -1 OFFSET ?').all(MAX_ACTIVE_TEAMS);
  const archive = database.prepare("UPDATE teams SET active = 0, archived_at = ?, archive_reason = 'capacity' WHERE team_id = ?");
  for (const row of evicted) archive.run(now, row.team_id);
  return evicted.map(row => row.team_id);
}
function touch(database, input, now = new Date().toISOString()) {
  assertWritable(database, input.teamId);
  const existing = selectOne(database, input.teamId);
  const order = nextOrder(database);
  database.prepare(`INSERT INTO teams(team_id,name,format,roster_json,created_at,last_used_at,usage_order,active,archived_at,archive_reason)
    VALUES(?,?,?,?,?,?,?,1,NULL,NULL)
    ON CONFLICT(team_id) DO UPDATE SET name=excluded.name,format=excluded.format,roster_json=excluded.roster_json,
      last_used_at=excluded.last_used_at,usage_order=excluded.usage_order,active=1,archived_at=NULL,archive_reason=NULL`).run(
    input.teamId, input.name ?? existing?.name ?? input.teamId.slice(0, 12), input.format ?? existing?.format ?? null,
    JSON.stringify(input.roster?.length ? input.roster : existing?.roster ?? []), existing?.createdAt ?? now, now, order);
  const evictedTeams = trimActive(database, now);
  return { team: selectOne(database, input.teamId), evictedTeams, maxActiveTeams: MAX_ACTIVE_TEAMS };
}

async function openCatalog({ workspace, create = false } = {}) {
  const directory = await storageDirectory(workspace, create);
  if (!directory) return null;
  const file = join(directory, CATALOG_FILENAME);
  let exists = true;
  try { await lstat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
  if (!exists && !create && !(await readdir(directory)).some(name => BATTLE_FILE.test(name))) return null;
  await safeCatalogFile(file);
  const database = new DatabaseSync(file, { timeout: 5000, enableDoubleQuotedStringLiterals: false });
  try {
    // Deleted descriptors and battle signatures should not remain in reusable SQLite pages.
    database.exec('PRAGMA secure_delete=ON');
    database.exec(`CREATE TABLE IF NOT EXISTS catalog_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
      INSERT OR IGNORE INTO catalog_meta(key,value) VALUES('usage_order','0');
      CREATE TABLE IF NOT EXISTS teams(
        team_id TEXT PRIMARY KEY CHECK(length(team_id)=64), name TEXT NOT NULL,format TEXT,roster_json TEXT NOT NULL,
        created_at TEXT NOT NULL,last_used_at TEXT NOT NULL,usage_order INTEGER NOT NULL,
        active INTEGER NOT NULL CHECK(active IN(0,1)),archived_at TEXT,archive_reason TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS teams_active_usage ON teams(active,usage_order);
      CREATE TABLE IF NOT EXISTS battle_signatures(
        room_id TEXT NOT NULL,team_id TEXT NOT NULL,signature TEXT NOT NULL,
        PRIMARY KEY(room_id,team_id),FOREIGN KEY(team_id) REFERENCES teams(team_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS battle_write_locks(
        room_id TEXT NOT NULL,team_id TEXT NOT NULL,owner_pid INTEGER NOT NULL CHECK(owner_pid>0),
        owner_nonce TEXT NOT NULL,acquired_at TEXT NOT NULL,PRIMARY KEY(room_id,team_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS deleted_teams(
        team_id TEXT PRIMARY KEY CHECK(length(team_id)=64),
        state TEXT NOT NULL CHECK(state IN('deleting','deleted')),
        started_at TEXT NOT NULL,completed_at TEXT
      ) STRICT;`);
    if (!database.prepare("SELECT value FROM catalog_meta WHERE key='legacy_migrated'").get()) {
      const records = await legacyRecords(directory);
      transaction(database, () => {
        if (database.prepare("SELECT value FROM catalog_meta WHERE key='legacy_migrated'").get()) return;
        const grouped = new Map();
        for (const record of records) {
          if (deletionStatus(database, record.teamId)) continue;
          const current = grouped.get(record.teamId);
          if (!current || current.at < record.catalogLegacyAt) grouped.set(record.teamId, { at: record.catalogLegacyAt, input: descriptor({ ...record.team, teamId: record.teamId }) });
        }
        for (const group of [...grouped.values()].sort((a, b) => a.at.localeCompare(b.at) || a.input.teamId.localeCompare(b.input.teamId))) touch(database, group.input, group.at);
        const insert = database.prepare('INSERT OR IGNORE INTO battle_signatures(room_id,team_id,signature) VALUES(?,?,?)');
        for (const record of records) if (!deletionStatus(database, record.teamId)) insert.run(record.roomId, record.teamId, materialBattleSignature(record));
        database.prepare("INSERT INTO catalog_meta(key,value) VALUES('legacy_migrated','1')").run();
      });
    }
    return database;
  } catch (error) { database.close(); throw error; }
}

export async function listMetricsCatalog({ workspace, includeArchived = false } = {}) {
  if (typeof includeArchived !== 'boolean') invalid('includeArchived must be boolean');
  const database = await openCatalog({ workspace });
  if (!database) return [];
  try {
    return database.prepare(`SELECT * FROM teams WHERE team_id NOT IN(SELECT team_id FROM deleted_teams) ${includeArchived ? '' : 'AND active=1'} ORDER BY active DESC,usage_order DESC,team_id ASC`).all().map(unpack);
  } finally { database.close(); }
}

/** true = active, false = archived, null = unknown (including a never-imported team). */
export async function isMetricsTeamActive({ workspace, teamId } = {}) {
  validateTeamId(teamId);
  const database = await openCatalog({ workspace });
  if (!database) return null;
  try { if (deletionStatus(database, teamId)) return null; const team = selectOne(database, teamId); return team ? team.active : null; }
  finally { database.close(); }
}

/** Explicit registration/access activates an exact team version and makes it most recently used. */
export async function registerMetricsTeam({ workspace, teamId, name, format, roster } = {}) {
  const input = descriptor({ teamId, name, format, roster });
  const database = await openCatalog({ workspace, create: true });
  let result;
  try { result = transaction(database, () => touch(database, input)); }
  finally { database.close(); }
  return cleanEvicted({ workspace, result });
}

async function cleanEvicted({ workspace, result }) {
  if (!result.evictedTeams.length) return result;
  // Cleanup needs separate, short catalog transactions; never await filesystem work inside SQLite.
  const { cleanupEvictedTeams } = await import('./team-cleanup.mjs');
  return { ...result, cleanup: await cleanupEvictedTeams({ workspace, teamIds: result.evictedTeams }) };
}

/** Recover a retained non-capacity archive; deleted LRU versions cannot be restored. */
export async function restoreMetricsTeam({ workspace, teamId } = {}) {
  validateTeamId(teamId);
  const database = await openCatalog({ workspace });
  if (!database) invalid('team is not present in the catalog');
  let result;
  try {
    result = transaction(database, () => {
      assertWritable(database, teamId);
      const existing = selectOne(database, teamId);
      if (!existing) invalid('team is not present in the catalog');
      return touch(database, existing);
    });
  } finally { database.close(); }
  return cleanEvicted({ workspace, result });
}

/**
 * Transactional signatures prevent repeated/background imports from changing LRU,
 * even if another process imports the same room simultaneously. Metadata-only
 * edits can refresh display fields without reactivating an archived team.
 */
export async function recordMetricsBattle({ workspace, record } = {}) {
  const input = descriptor({ ...record?.team, teamId: record?.teamId });
  const signature = materialBattleSignature(record);
  const database = await openCatalog({ workspace, create: true });
  let result;
  try {
    result = transaction(database, () => {
      assertWritable(database, input.teamId);
      const previous = database.prepare('SELECT signature FROM battle_signatures WHERE room_id=? AND team_id=?').get(record.roomId, input.teamId);
      if (previous?.signature === signature) return { changed: false, team: updateDescriptor(database, input), evictedTeams: [], maxActiveTeams: MAX_ACTIVE_TEAMS };
      const result = touch(database, input);
      database.prepare('INSERT INTO battle_signatures(room_id,team_id,signature) VALUES(?,?,?) ON CONFLICT(room_id,team_id) DO UPDATE SET signature=excluded.signature').run(record.roomId, input.teamId, signature);
      return { ...result, changed: true };
    });
  } finally { database.close(); }
  return cleanEvicted({ workspace, result });
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) invalid('writer lock owner PID is invalid');
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true; // Lack of permission never proves an owner is dead.
    throw error;
  }
}

/** A retained, minimal tombstone prevents automatic sources from resurrecting deleted reports. */
export async function getMetricsTeamDeletion({ workspace, teamId } = {}) {
  validateTeamId(teamId);
  const database = await openCatalog({ workspace });
  if (!database) return null;
  try { return deletionStatus(database, teamId); }
  finally { database.close(); }
}

/** Pending cleanup survives a failed filesystem operation and can be retried on the next refresh. */
export async function listMetricsTeamDeletions({ workspace, state = 'deleting' } = {}) {
  if (!['deleting', 'deleted'].includes(state)) invalid('deletion state is not recognized');
  const database = await openCatalog({ workspace });
  if (!database) return [];
  try {
    return database.prepare('SELECT team_id,state,started_at,completed_at FROM deleted_teams WHERE state=? ORDER BY started_at,team_id').all(state)
      .map(row => ({ teamId: row.team_id, state: row.state, startedAt: row.started_at, completedAt: row.completed_at }));
  } finally { database.close(); }
}

/** Check before starting a non-catalog operation; battle writes must additionally hold their row lease. */
export async function assertMetricsTeamWritable({ workspace, teamId } = {}) {
  validateTeamId(teamId);
  const database = await openCatalog({ workspace });
  if (!database) return;
  try { assertWritable(database, teamId); }
  finally { database.close(); }
}

/**
 * Stop new writers before removing any files. An already running writer must
 * release its lease first; only a confirmed dead process may be reclaimed.
 * Repeating this after a partial cleanup preserves the original tombstone.
 */
export async function beginMetricsTeamDeletion({ workspace, teamId, requireCapacityEviction = false } = {}) {
  validateTeamId(teamId);
  if (typeof requireCapacityEviction !== 'boolean') invalid('requireCapacityEviction must be boolean');
  const database = await openCatalog({ workspace, create: true });
  try {
    return transaction(database, () => {
      const existing = deletionStatus(database, teamId);
      if (existing) return existing;
      if (requireCapacityEviction) {
        const team = selectOne(database, teamId);
        if (!team || team.active || team.archiveReason !== 'capacity') return null;
      }
      const owners = database.prepare('SELECT room_id,owner_pid,owner_nonce FROM battle_write_locks WHERE team_id=?').all(teamId).filter(owner => !coordinationLock(owner.room_id, teamId));
      if (owners.some(owner => processAlive(owner.owner_pid))) {
        const error = new Error('This team report has an active local writer; wait for recording or importing to finish before deleting it.');
        error.code = 'METRICS_TEAM_BUSY';
        throw error;
      }
      for (const owner of owners) database.prepare('DELETE FROM battle_write_locks WHERE room_id=? AND team_id=? AND owner_nonce=?').run(owner.room_id, teamId, owner.owner_nonce);
      database.prepare("INSERT INTO deleted_teams(team_id,state,started_at,completed_at) VALUES(?,'deleting',?,NULL)").run(teamId, new Date().toISOString());
      return deletionStatus(database, teamId);
    });
  } finally { database.close(); }
}

/** Finish only after the caller has removed every team-owned file and source reference. */
export async function finishMetricsTeamDeletion({ workspace, teamId } = {}) {
  validateTeamId(teamId);
  const database = await openCatalog({ workspace });
  if (!database) invalid('team deletion must begin before it can finish');
  try {
    return transaction(database, () => {
      const existing = deletionStatus(database, teamId);
      if (!existing) invalid('team deletion must begin before it can finish');
      if (existing.state === 'deleted') return existing;
      database.prepare('DELETE FROM battle_signatures WHERE team_id=?').run(teamId);
      database.prepare("DELETE FROM battle_write_locks WHERE team_id=? AND NOT(team_id=? AND room_id='metrics-sources')").run(teamId, SOURCES_LOCK_TEAM);
      database.prepare('DELETE FROM teams WHERE team_id=?').run(teamId);
      database.prepare("UPDATE deleted_teams SET state='deleted',completed_at=? WHERE team_id=?").run(new Date().toISOString(), teamId);
      return deletionStatus(database, teamId);
    });
  } finally { database.close(); }
}

/** Only a deliberate new report registration may clear a completed deletion. */
export async function recreateDeletedMetricsTeam({ workspace, teamId } = {}) {
  validateTeamId(teamId);
  const database = await openCatalog({ workspace });
  if (!database) return { teamId, recreated: false };
  try {
    return transaction(database, () => {
      const deletion = deletionStatus(database, teamId);
      if (!deletion) return { teamId, recreated: false };
      if (deletion.state !== 'deleted') {
        const error = new Error('This team report cleanup is still pending; finish deletion before creating a fresh report.');
        error.code = 'METRICS_TEAM_BUSY';
        throw error;
      }
      const owners = database.prepare('SELECT room_id,owner_pid FROM battle_write_locks WHERE team_id=?').all(teamId).filter(owner => !coordinationLock(owner.room_id, teamId));
      if (owners.some(owner => processAlive(owner.owner_pid))) {
        const error = new Error('This team report has an active local writer; wait before creating a fresh report.');
        error.code = 'METRICS_TEAM_BUSY';
        throw error;
      }
      database.prepare("DELETE FROM battle_write_locks WHERE team_id=? AND NOT(team_id=? AND room_id='metrics-sources')").run(teamId, SOURCES_LOCK_TEAM);
      database.prepare('DELETE FROM deleted_teams WHERE team_id=?').run(teamId);
      return { teamId, recreated: true };
    });
  } finally { database.close(); }
}

/**
 * A process-owned logical lease serializes each JSON read/merge/replace operation.
 * SQLite transactions only acquire/release the lease; none remains open while
 * the caller awaits filesystem work. A confirmed dead PID may be reclaimed.
 */
export async function acquireMetricsBattleLock({ workspace, roomId, teamId, timeoutMs = 10_000 } = {}) {
  validateTeamId(teamId);
  if (typeof roomId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(roomId) || /-[a-z0-9]+pw$/u.test(roomId) || roomId.length > 180) invalid('writer lock room ID is unsafe');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) invalid('writer lock timeout must be 1–10000 milliseconds');
  const nonce = randomUUID(), startedAt = Date.now();
  for (;;) {
    const database = await openCatalog({ workspace, create: true });
    let acquired;
    try {
      acquired = transaction(database, () => {
        if (!coordinationLock(roomId, teamId)) assertWritable(database, teamId);
        const owner = database.prepare('SELECT owner_pid,owner_nonce FROM battle_write_locks WHERE room_id=? AND team_id=?').get(roomId, teamId);
        if (owner && processAlive(owner.owner_pid)) return false;
        if (owner) database.prepare('DELETE FROM battle_write_locks WHERE room_id=? AND team_id=? AND owner_nonce=?').run(roomId, teamId, owner.owner_nonce);
        database.prepare('INSERT INTO battle_write_locks(room_id,team_id,owner_pid,owner_nonce,acquired_at) VALUES(?,?,?,?,?)').run(roomId, teamId, process.pid, nonce, new Date().toISOString());
        return true;
      });
    } finally { database.close(); }
    if (acquired) break;
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Metrics battle is busy in another local process; retry the import.');
    await delay(Math.min(40, Math.max(1, timeoutMs - (Date.now() - startedAt))));
  }
  let released = false;
  return async () => {
    if (released) return;
    const database = await openCatalog({ workspace });
    if (!database) invalid('writer lock catalog disappeared');
    try {
      transaction(database, () => {
        const result = database.prepare('DELETE FROM battle_write_locks WHERE room_id=? AND team_id=? AND owner_pid=? AND owner_nonce=?').run(roomId, teamId, process.pid, nonce);
        if (result.changes !== 1) invalid('writer lock ownership changed');
      });
      released = true;
    } finally { database.close(); }
  };
}
