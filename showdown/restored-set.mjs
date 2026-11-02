import {listBattles} from '../metrics/store.mjs';
import {loadMetricsTeam} from '../metrics/import.mjs';
import {readGameEvidence} from '../metrics/retention.mjs';

const proofs = new WeakMap();
const parentPattern = /^game-bestof3-gen9championsvgc2026regmcbo3-[1-9]\d*$/u;
const accountId = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/gu, '');
export const canonicalRecoveryRoom = value => String(value ?? '').replace(/-[a-z0-9]+pw$/u, '');
const requireThat = (value, message) => {if (!value) throw new Error(message);};

/** Read-only admission from existing, hash-checked live-client observations.
 * The returned object is an in-process capability, never a caller's ownership claim.
 * No connection, authentication, join, search or control operation occurs here.
 */
export async function loadRestoredSetProof({workspace, parentId, teamId, username} = {}) {
  requireThat(parentPattern.test(parentId ?? ''), 'Recovery requires one canonical M-C BO3 parent');
  requireThat(/^[a-f0-9]{64}$/u.test(teamId ?? '') && accountId(username), 'Recovery requires the exact team and account');
  const snapshot = await loadMetricsTeam({workspace, teamId});
  requireThat(snapshot.teamId === teamId && snapshot.team.length === 6, 'Recovery full team snapshot differs');
  const rows = (await listBattles({workspace, includeArchived:true})).filter(row => row.parentId === parentId);
  requireThat(rows.length >= 1 && rows.length <= 3 && rows.every(row => row.teamId === teamId && accountId(row.username) === accountId(username) && accountId(row.players?.[row.ownSide]) === accountId(username)), 'No exclusive recorded parent/team/account ownership for recovery');
  const evidence = [];let stronglyOwnedChildren=0;
  for (const row of rows) {
    requireThat(row.metadata?.sources?.includes('live-client') && row.metadata?.evidence?.kind === 'sanitized-events', 'Recovery requires retained live-client evidence');
    const observed = await readGameEvidence({workspace, teamId, roomId:row.roomId});
    requireThat(observed.parentId === parentId && observed.sourceKind === 'sanitized-events', 'Recovery lacks hash-checked prior owned evidence');
    const privateAccount=observed.events.some(event => event.type === 'request' && accountId(event.request?.side?.name) === accountId(username));
    const controlled=observed.controlTrace.some(trace => trace.controllerId && trace.controllerId !== 'none');
    const linkedRecovery=observed.controlTrace.some(trace=>trace.type==='restored-parent-child-verified'&&trace.source==='restored-set-forfeit'&&trace.reasonCode==='trusted-parent-link');
    if(privateAccount&&controlled)stronglyOwnedChildren++;
    else requireThat(linkedRecovery,'Recovery child lacks prior private control or a retained verified parent link');
    evidence.push({record:row, observed});
  }
  requireThat(stronglyOwnedChildren>0,'Recovery requires at least one original private owned-child anchor');
  const proof = Object.freeze({version:1, parentId, teamId, account:accountId(username), childIds:Object.freeze(rows.map(row => row.roomId)), authority:'forfeit-and-preservation-only'});
  proofs.set(proof, evidence);
  return proof;
}

export function restoredSetEvidence(proof, {username, teamId}) {
  requireThat(proofs.has(proof) && proof.teamId === teamId && proof.account === accountId(username), 'Unverified restored-set recovery proof');
  return structuredClone(proofs.get(proof));
}
