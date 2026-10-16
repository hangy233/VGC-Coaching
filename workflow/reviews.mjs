import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { acquireMetricsBattleLock, assertMetricsTeamWritable } from '../metrics/catalog.mjs';
import { getTeamReport, listBattles } from '../metrics/store.mjs';
import { loadMetricsTeam } from '../metrics/import.mjs';
import { readGameEvidence, reviewedCheckpoint } from '../metrics/retention.mjs';
import { getSkillStatus, verifySkillRead } from './skill-service.mjs';
import { readCalculation } from './calculations.mjs';

const HASH = /^[a-f0-9]{64}$/u;
const PARENT = /^game-bestof3-gen9championsvgc2026regmcbo3-\d+$/u;
const ROOM = /^battle-[a-z0-9]+-\d+$/u;
const MAX = 2 * 1024 * 1024;
const fail = message => new Error('BO3 review: ' + message);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value, name, max = 4000) => { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw fail(`${name} must be bounded nonempty text`); return value.trim(); };
const inside = (root, path) => { const part = relative(root, path); return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
function identities(teamId, parentId) {
  if (typeof teamId !== 'string' || !HASH.test(teamId) || (parentId !== undefined && (typeof parentId !== 'string' || !PARENT.test(parentId)))) throw fail('use the exact team fingerprint and canonical owned BO3 parent ID');
}

async function directory(workspace, create = false) {
  const root = await realpath(workspace); let current = root;
  for (const part of ['cache', 'champions-mc-reviews']) {
    current = join(current, part);
    if (create) { try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    let info; try { info = await lstat(current); } catch (error) { if (error.code === 'ENOENT' && !create) return null; throw error; }
    if (info.isSymbolicLink() || !info.isDirectory() || !inside(root, await realpath(current))) throw fail('review storage must stay in real workspace cache directories');
  }
  return current;
}
async function readCheckpoint(workspace, parentId) {
  const dir = await directory(workspace); if (!dir) return null;
  const path = join(dir, parentId + '.json');
  let info; try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX) throw fail('existing checkpoint is unsafe or exceeds its size limit');
  return JSON.parse(await readFile(path, 'utf8'));
}
const checkpointFile = parentId => `cache/champions-mc-reviews/${parentId}.json`;
const recordFacts = records => records.map(game => ({ roomId: game.roomId, parentId: game.parentId, teamId: game.teamId, outcome: game.outcome, completed: game.completed, quality: game.quality, setResult: game.metadata.setResult || null, evidence: game.metadata.evidence || null, replay: game.metadata.replay || null, annotations: game.metadata.annotations || [] })).sort((a, b) => a.roomId.localeCompare(b.roomId));

async function setFacts(workspace, teamId, parentId) {
  await assertMetricsTeamWritable({ workspace, teamId });
  const all = (await listBattles({ workspace, includeArchived: true })).filter(game => game.teamId === teamId);
  if (parentId === undefined) {
    const parents = all.filter(game => game.parentId).sort((a, b) => String(b.metadata.endedAt || b.importedAt || '').localeCompare(String(a.metadata.endedAt || a.importedAt || '')) || b.parentId.localeCompare(a.parentId));
    parentId = parents[0]?.parentId;
  }
  if (!parentId) return { teamId, parentId: null, records: [], blockers: [], required: false };
  const records = all.filter(game => game.parentId === parentId), blockers = [];
  if (!records.length) blockers.push('No child games are stored for this exact team and parent.');
  if (records.length > 3) blockers.push('The stored parent has more than three child games; reconcile its identity.');
  if (records.some(game => !game.completed || !game.metadata.setResult?.completed)) blockers.push('Completed child games and an official parent result are required.');
  const outcomes = [...new Set(records.filter(game => game.metadata.setResult?.completed).map(game => game.metadata.setResult.outcome))];
  if (outcomes.length !== 1 || !['win', 'loss', 'tie'].includes(outcomes[0])) blockers.push('An unambiguous stored official parent result is required.');
  const manifests=[...new Set(records.filter(game=>game.metadata.setResult?.completed&&game.metadata.setResult.expectedChildIds?.length).map(game=>JSON.stringify([...game.metadata.setResult.expectedChildIds].sort())))];
  const expectedChildIds=manifests.length===1?JSON.parse(manifests[0]):[];
  if(!manifests.length)blockers.push('Expected child coverage is unknown: retain the official parent child list or a complete reviewed ledger before validating this BO3 review.');
  else if(manifests.length>1)blockers.push('Stored official parent child manifests conflict; reconcile their expected coverage.');
  else{
    if(expectedChildIds.some(child=>!records.some(game=>game.roomId===child)))blockers.push('An expected child from the official parent or reviewed ledger is missing from stored game evidence.');
    if(records.some(game=>!expectedChildIds.includes(game.roomId)))blockers.push('A stored child is absent from the independently retained official parent manifest.');
  }
  return { teamId, parentId, records, blockers, required: true, officialResult: outcomes.length === 1 ? { outcome: outcomes[0], completed: records.every(game => game.metadata.setResult?.completed), source: 'stored-official-parent-result' } : null, expectedChildIds, evidenceRevision: hash(recordFacts(records)) };
}

export async function getReview({ workspace, teamId, parentId, skillOptions = {} } = {}) {
  identities(teamId, parentId); if (!parentId) throw fail('parentId is required');
  await assertMetricsTeamWritable({ workspace, teamId });
  const checkpoint = await readCheckpoint(workspace, parentId);
  if (checkpoint && (checkpoint.teamId ?? checkpoint.teamSha256) !== teamId) throw fail('that parent checkpoint belongs to another exact team');
  return { teamId, parentId, exists: !!checkpoint, checkpointFile: checkpointFile(parentId), checkpoint, ...(await reviewStatus({ workspace, teamId, parentId, skillOptions })) };
}

export async function reviewStatus({ workspace, teamId, parentId, skillOptions = {} } = {}) {
  identities(teamId, parentId);
  const facts = await setFacts(workspace, teamId, parentId);
  if (!facts.required) return { teamId, parentId: null, exists: false, required: false, complete: true, blockers: [], reason: 'no-prior-recorded-set' };
  const blockers = [...facts.blockers], checkpoint = await readCheckpoint(workspace, facts.parentId);
  if (!checkpoint) blockers.push('The required private BO3 decision review has not been saved.');
  else {
    if (!reviewedCheckpoint(checkpoint, { teamId, parentId: facts.parentId })) blockers.push('The saved checkpoint lacks a completed review or matching adopted skill hashes.');
    const expected = checkpoint.expectedChildIds || checkpoint.children?.map(child => typeof child === 'string' ? child : child.roomId || child.id);
    if (JSON.stringify([...(expected || [])].sort()) !== JSON.stringify(facts.expectedChildIds)) blockers.push('The saved checkpoint does not cover the exact stored child games.');
    if (checkpoint.evidenceRevision && checkpoint.evidenceRevision !== facts.evidenceRevision) blockers.push('Game, official-result or retained-evidence facts changed after this review; save a reviewed revision.');
    for (const game of facts.records) {
      try { if (!(await readGameEvidence({ workspace, teamId, roomId: game.roomId })).complete) blockers.push(`${game.roomId}: retained game evidence is incomplete.`); }
      catch { blockers.push(`${game.roomId}: retained game evidence could not be verified.`); }
    }
    try { await loadMetricsTeam({ workspace, teamId }); }
    catch { blockers.push('The exact immutable legal team snapshot could not be verified.'); }
    for (const citation of checkpoint.calculations || []) {
      try { const value = await readCalculation({ workspace, teamId, id: citation.id }); if (value.sha256 !== citation.sha256 || !facts.expectedChildIds.includes(value.roomId)) blockers.push('A cited actual calculation changed or belongs to a different parent.'); }
      catch { blockers.push('A cited actual calculation could not be verified.'); }
    }
    const status = await getSkillStatus({ workspace, ...skillOptions });
    if (!status.synchronized || checkpoint.adoption?.sourceSha256 !== status.sourceSha256 || checkpoint.adoption?.installedSha256 !== status.installedSha256) blockers.push('The current repository and installed guidance must be synchronized and adopted in the checkpoint.');
  }
  return { teamId, parentId: facts.parentId, exists: !!checkpoint, required: true, complete: blockers.length === 0, blockers: [...new Set(blockers)], checkpointFile: checkpointFile(facts.parentId), revision: checkpoint?.revision || null, reviewedAt: checkpoint?.reviewedAt || null, officialResult: facts.officialResult, expectedChildIds: facts.expectedChildIds, evidenceRevision: facts.evidenceRevision, legacyCheckpoint: !!checkpoint && !checkpoint.evidenceRevision };
}

function boundedArray(value, name, { min = 0, max = 50 } = {}) { if (!Array.isArray(value) || value.length < min || value.length > max) throw fail(`${name} must contain ${min}–${max} entries`); return value; }
function reference(value, records, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !ROOM.test(value.roomId || '') || !records.some(game => game.roomId === value.roomId)) throw fail(`${name} must cite a child game in this exact set`);
  const result = { roomId: value.roomId };
  if (value.turn !== undefined) {
    if (!Number.isSafeInteger(value.turn) || value.turn < 0 || value.turn > records.find(game => game.roomId === value.roomId).turns) throw fail(`${name}.turn is outside the retained game`);
    result.turn = value.turn;
  }
  return result;
}
function normalizeReview(args, records) {
  const decisionReview = boundedArray(args.decisionReview, 'decisionReview', { min: 1, max: 30 }).map((value, index) => {
    const result = reference(value, records, `decisionReview[${index}]`);
    for (const field of ['knownBefore', 'opposingRead', 'selected', 'executed', 'partnerProgress']) result[field] = text(value[field], `decisionReview.${field}`);
    if (!value.alternative && !value.limitation) throw fail('each decisive action needs a feasible alternative or explicit unresolved limitation');
    for (const field of ['accepted', 'alternative', 'limitation']) if (value[field] !== undefined) result[field] = text(value[field], `decisionReview.${field}`);
    return result;
  });
  const positiveEvidence = boundedArray(args.positiveEvidence, 'positiveEvidence', { min: 1, max: 30 }).map(value => ({ ...reference(value, records, 'positiveEvidence'), observation: text(value.observation, 'positiveEvidence.observation'), whyPreserve: text(value.whyPreserve, 'positiveEvidence.whyPreserve') }));
  const executionAndVariance = boundedArray(args.executionAndVariance, 'executionAndVariance', { max: 50 }).map(value => {
    if (!['execution', 'default', 'rejected', 'stale', 'inactivity', 'concession', 'critical-hit', 'miss', 'variance', 'unknown'].includes(value.kind)) throw fail('executionAndVariance.kind is unsupported');
    return { ...reference(value, records, 'executionAndVariance'), kind: value.kind, observation: text(value.observation, 'executionAndVariance.observation') };
  });
  const outcome = args.reusableOutcome;
  if (!outcome || !['lesson', 'no-change'].includes(outcome.kind)) throw fail('record a supported lesson or an explicit no-change reason');
  const reusableOutcome = { kind: outcome.kind, reason: text(outcome.reason, 'reusableOutcome.reason'), evidence: boundedArray(outcome.evidence, 'reusableOutcome.evidence', { min: 1, max: 30 }).map(value => ({ ...reference(value, records, 'reusableOutcome.evidence'), observation: text(value.observation, 'reusableOutcome.evidence.observation') })) };
  if (outcome.kind === 'lesson') reusableOutcome.counterexample = text(outcome.counterexample, 'reusableOutcome.counterexample');
  else if (outcome.counterexample !== undefined) reusableOutcome.counterexample = text(outcome.counterexample, 'reusableOutcome.counterexample');
  const validation = boundedArray(args.validation, 'validation', { min: 1, max: 30 }).map(value => ({ check: text(value.check, 'validation.check', 1000), result: text(value.result, 'validation.result', 1000), evidence: text(value.evidence, 'validation.evidence') }));
  return { decisionReview, positiveEvidence, executionAndVariance, reusableOutcome, validation, validationAttribution: 'Agent-reported checks; this save operation validates identity, evidence availability, official results and skill adoption, not tactical correctness.' };
}

export async function saveReview({ workspace, teamId, parentId, readReceipt, expectedRevision, expectedChildIds, calculationIds = [], retrospective = false, subsequentSearchOccurred = false, skillOptions = {}, ...review } = {}) {
  identities(teamId, parentId); if (!parentId) throw fail('parentId is required');
  if (typeof retrospective !== 'boolean' || typeof subsequentSearchOccurred !== 'boolean' || (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))) throw fail('invalid review timing or expected revision');
  const release = await acquireMetricsBattleLock({ workspace, teamId, roomId: 'review-' + parentId });
  try {
    const facts = await setFacts(workspace, teamId, parentId);
    if (facts.blockers.length) throw fail(facts.blockers.join(' '));
    if (expectedChildIds !== undefined && (!Array.isArray(expectedChildIds) || JSON.stringify([...new Set(expectedChildIds)].sort()) !== JSON.stringify(facts.expectedChildIds))) throw fail('expectedChildIds must exactly match every stored child of this parent');
    const normalized = normalizeReview(review, facts.records);
    const adoption = await verifySkillRead({ workspace, readReceipt, ...skillOptions });
    const calculations = [];
    for (const id of [...new Set(boundedArray(calculationIds, 'calculationIds', { max: 50 }))]) {
      const value = await readCalculation({ workspace, teamId, id });
      if (!facts.expectedChildIds.includes(value.roomId)) throw fail('a calculation receipt belongs to a different parent set');
      calculations.push({ id: value.id, tool: value.tool, roomId: value.roomId, turn: value.turn, path: value.path, sha256: value.sha256 });
    }
    const snapshot = await loadMetricsTeam({ workspace, teamId });
    const report = await getTeamReport({ workspace, teamId, touch: false });
    if (snapshot.teamId !== report.team.teamId) throw fail('cached team snapshot and report identity differ');
    const children = [];
    for (const game of facts.records) {
      let evidence;
      try { evidence = await readGameEvidence({ workspace, teamId, roomId: game.roomId }); }
      catch { throw fail(`${game.roomId}: durable evidence must be readable before completing its review`); }
      if (!evidence.complete) throw fail(`${game.roomId}: durable evidence is incomplete`);
      children.push({ id: game.roomId, outcome: game.outcome, operational: game.quality.operational, selectionKnown: game.selectionKnown, replay: game.metadata.replay || null, replayLimitation: game.metadata.replay?.verified ? null : 'No verified saved replay link is recorded.', evidence: evidence.evidence, sourceKind: evidence.sourceKind, decisionEvidenceIncluded: evidence.decisionEvidenceIncluded, decisionLimitation: evidence.decisionEvidenceIncluded ? null : 'No selected/accepted action journal is available; executed protocol alone does not prove intent or submission.' });
    }
    const previous = await readCheckpoint(workspace, parentId);
    if (previous && (previous.teamId ?? previous.teamSha256) !== teamId) throw fail('that parent checkpoint already belongs to a different team');
    const previousRevision = previous?.revision || (previous ? 1 : 0);
    if (previous && expectedRevision === undefined) throw fail('updating an existing review requires its expectedRevision to avoid overwriting another review');
    if (expectedRevision !== undefined && expectedRevision !== previousRevision) throw fail('review revision changed; retrieve the current checkpoint before updating');
    const revision = previousRevision + 1, reviewedAt = new Date().toISOString();
    const included = new Set(report.games.map(game => game.roomId));
    const checkpoint = { schemaVersion: 2, parentId, teamId, teamSha256: teamId, revision, previousRevisionSha256: previous ? hash(previous) : null, reviewedAt, status: retrospective ? 'review-complete-retrospective' : 'review-complete', retrospective, subsequentSearchOccurred, expectedChildIds: facts.expectedChildIds, officialResult: facts.officialResult, evidenceRevision: facts.evidenceRevision, children, calculations, metricsEvidence: { teamId, cachedTeamFile: snapshot.teamFile, cachedSheetMatch: true, readAt: reviewedAt, refresh: 'Stored report read directly; live session flush and remembered-source refresh must be requested separately before review.', quality: report.quality, filters: report.filters, includedChildIds: facts.expectedChildIds.filter(id => included.has(id)), excludedChildIds: facts.expectedChildIds.filter(id => !included.has(id)), missingChildIds: [], dataCutoff: facts.records.map(game => game.metadata.endedAt || game.updatedAt || game.importedAt || '').sort().at(-1) || null }, ...normalized, adoption };
    if (!reviewedCheckpoint(checkpoint, { teamId, parentId })) throw fail('generated review checkpoint failed retention validation');
    const dir = await directory(workspace, true), path = join(dir, parentId + '.json');
    // A crash leaves a recognizable team-bound JSON candidate for the existing
    // whole-team review cascade; an unreadable partial file remains a blocker.
    const pending = join(dir, `.pending-${parentId}--${teamId}--${randomUUID()}.json`);
    // History is in the same managed flat review directory so whole-team cleanup owns it.
    if (previous) {
      const history = join(dir, `${parentId}--${teamId}--r${String(previousRevision).padStart(4, '0')}.json`);
      try { await writeFile(history, JSON.stringify(previous, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; const info = await lstat(history); if (!info.isFile() || info.isSymbolicLink() || info.size > MAX || hash(JSON.parse(await readFile(history, 'utf8'))) !== hash(previous)) throw fail('prior revision history conflicts; existing files were retained'); }
    }
    const bytes = JSON.stringify(checkpoint, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > MAX) throw fail('checkpoint exceeds its size limit');
    try {
      await writeFile(pending, bytes, { flag: 'wx', mode: 0o600 });
      await directory(workspace);
      const current = await readCheckpoint(workspace, parentId);
      if (hash(current) !== hash(previous)) throw fail('checkpoint changed during review save; retry from its current revision');
      await rename(pending, path);
    } finally { try { await unlink(pending); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    return { teamId, parentId, checkpointFile: checkpointFile(parentId), revision, checkpoint, complete: true, lesson: normalized.reusableOutcome.kind, syncVerified: true, replayCoverage: { expected: children.length, verified: children.filter(game => game.replay?.verified).length }, cleanup: 'Not performed. Use team_metrics_finalize_bo3 dry run after this checkpoint.' };
  } finally { await release(); }
}
