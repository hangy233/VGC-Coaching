import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {callLocalSession} from '../showdown/local-bridge.mjs';
import {getMetricsHealth} from '../metrics/health.mjs';
import {listBattles} from '../metrics/store.mjs';
import {getSkillStatus} from './skill-service.mjs';
import {reviewStatus} from './reviews.mjs';

const HASH=/^[a-f0-9]{64}$/u;
const PARENT=/^game-bestof3-gen9championsvgc2026regmcbo3-\d+(?:-[a-z0-9]+pw)?$/u;
const required=['start','choose','ready','metrics-sync'];
const controlOperations=['control-claim','control-release','set-control-policy','stage-fallback','turn-status','control-trace'];
const boolean=value=>typeof value==='boolean'?value:null;
const finite=value=>Number.isFinite(value)?value:null;
function controlSummary(status){
  const controller=status.controller,policy=status.controlPolicy;
  return {
    controller:controller?{required:boolean(controller.required),owner:typeof controller.owner==='string'?controller.owner:null,generation:Number.isInteger(controller.generation)?controller.generation:null,claimedAt:finite(controller.claimedAt)}:null,
    controlPolicy:policy?{enabled:boolean(policy.enabled),forfeitIfStuck:boolean(policy.forfeitIfStuck),emergencyDefaultChoice:boolean(policy.emergencyDefaultChoice),planningMs:finite(policy.planningMs),safetyMarginMs:finite(policy.safetyMarginMs),unknownClockMs:finite(policy.unknownClockMs),halted:boolean(policy.halted),haltReason:typeof policy.haltReason==='string'?policy.haltReason:null,disposed:boolean(policy.disposed)}:null,
  };
}
const canonical=value=>String(value||'').replace(/-[a-z0-9]+pw$/u,'');
function localParents(records){
  if(!Array.isArray(records))throw new Error('Local battle history is unavailable');
  const parents=new Map();
  for(const record of records){
    const parentId=canonical(record?.parentId);
    if(!HASH.test(record?.teamId||'')||!PARENT.test(parentId))continue;
    const raw=record.metadata?.endedAt||record.metadata?.startedAt||record.importedAt||record.updatedAt;
    const observedAt=raw&&Number.isFinite(Date.parse(raw))?new Date(raw).toISOString():null;
    const key=record.teamId+'|'+parentId,previous=parents.get(key);
    if(!previous||observedAt&&(previous.observedAt===null||observedAt>previous.observedAt))parents.set(key,{teamId:record.teamId,parentId,observedAt});
  }
  const all=[...parents.values()],latestKnown=all.map(parent=>parent.observedAt).filter(Boolean).sort().at(-1);
  // A missing timestamp could hide the newest set. Keep every undated parent
  // plus every equally latest dated parent rather than inventing a chronology.
  return {all,candidates:all.filter(parent=>parent.observedAt===null||parent.observedAt===latestKnown)};
}
async function boundedStatus(call,workspace){
  let timer;
  try{
    const reply=await Promise.race([call(join(workspace,'cache','showdown-session.json'),{id:randomUUID(),op:'status'}),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),4000);})]);
    if(!reply?.ok||!reply.result)throw new Error('unavailable');return reply.result;
  }finally{clearTimeout(timer);}
}

/** Observation-only readiness; it neither authorizes nor queues a set. */
export async function battlePreflight({workspace,teamId,parentId,call=callLocalSession,skillOptions={},skillReader=getSkillStatus,reviewReader=reviewStatus,healthReader=getMetricsHealth,historyReader=listBattles}={}){
  if(teamId!==undefined&&!HASH.test(teamId))throw new Error('Use an exact team fingerprint');
  if(parentId!==undefined&&!PARENT.test(parentId))throw new Error('Use an exact M-C BO3 parent');
  const checks=[],warnings=[],blockers=[];
  const check=(name,passed,detail,blocking=true)=>{checks.push({name,passed,detail,blocking});if(!passed)(blocking?blockers:warnings).push(detail);};
  const [live,skill,history]=await Promise.allSettled([boundedStatus(call,workspace),skillReader({workspace,...skillOptions}),historyReader({workspace,includeArchived:true})]);
  const status=live.status==='fulfilled'?live.value:null;
  check('session',!!status,'A terminal-owned client must be available; this tool never starts or authenticates one.');
  const exactTeam=teamId||status?.teamSha256;
  let latestParent;
  let reviewTeamId=exactTeam;
  let latestOwned;
  let session=null;
  if(status){
    check('connected',status.connected===true&&!status.stopped,'The current client must be connected and running.');
    check('authenticated',status.authenticated===true,'The existing client has not confirmed authentication.');
    check('team-version',HASH.test(status.teamSha256)&&(!teamId||teamId===status.teamSha256),'Requested team must match the client’s approved team.');
    const idle=!!status.search&&Array.isArray(status.search.searching)&&status.search.searching.length===0&&!Object.keys(status.search.games||{}).length&&!status.searchPending&&!status.awaitingSet&&!status.savingReplays&&!status.switchingTeam&&!(status.actions||[]).length&&!(status.rooms||[]).some(room=>!room.ended&&PARENT.test(room.id));
    check('server-idle',idle,'The server must confirm idle with no pending search, game, readiness, replay save or team switch.');
    const remaining=Number.isInteger(status.authorizedSets)&&Number.isInteger(status.searchesSent)?Math.max(0,status.authorizedSets-status.searchesSent):null;
    check('set-allowance',remaining!==null&&remaining>0,'No verified authorized set allowance remains. Preflight never extends it.');
    const capabilities=status.capabilities||null;
    const operations=capabilities?.operations||capabilities?.supportedOperations||capabilities?.supportedOps||[];
    check('loaded-capabilities',Array.isArray(operations)&&required.every(operation=>operations.includes(operation)),'The loaded client must advertise the battle and recording operations required by this workflow. Source changes do not update an older client.');
    const enforcedLease=capabilities?.features?.controllerLease===true;
    const watchdog=capabilities?.features?.deadlineSupervisor===true;
    const controls=controlSummary(status);
    check('exclusive-control-capability',enforcedLease,'The loaded client does not advertise enforced exclusive controller leases. Do not assume competing operators are prevented; source changes require its next normal authorized startup.',false);
    check('deadline-protection-capability',watchdog,'The loaded client has no advertised deadline watchdog. Do not assume automatic fallback submission or stuck containment exists; source changes require its next normal authorized startup.',enforcedLease);
    if(enforcedLease){
      check('loaded-control-operations',Array.isArray(operations)&&controlOperations.every(operation=>operations.includes(operation)),'The loaded client must advertise exclusive control, fallback staging, deadline policy and compact safety evidence operations.');
      check('deadline-recovery-capability',capabilities?.features?.deadlinePlanningRecovery===true,'The loaded client must distinguish a missed planning target from a verified server emergency deadline; restart the repaired client before another search.');
      check('compact-turn-board-capability',capabilities?.features?.compactTurnBoard===true,'The loaded client must provide the current board and legal choices together in compact turn status; source changes do not update an older process.');
      check('controller-owner',controls.controller?.required===true&&typeof controls.controller.owner==='string'&&controls.controller.owner.trim().length>0,'Claim one exclusive controller with battle_control_claim before starting another set; retain its private lease for mutations.');
      check('deadline-protection',controls.controlPolicy?.enabled===true&&controls.controlPolicy.halted===false&&controls.controlPolicy.disposed!==true,'Enable non-halted deadline protection with battle_set_control_policy while idle before starting another set; review a safety halt before deliberately resetting it.');
    }
    let sourceRevision=null;
    try{sourceRevision=createHash('sha256').update(await readFile(join(workspace,'showdown','agent-session.mjs'))).digest('hex');}catch{}
    const loadedRevision=capabilities?.buildRevision||null;
    const runtime={loadedRevision,sourceRevision,matchesSource:loadedRevision&&sourceRevision?loadedRevision===sourceRevision:null,scope:'AgentSession implementation only; dependency adoption is represented by loaded capability flags, not this file digest.'};
    if(runtime.matchesSource===false)warnings.push('The loaded client differs from the current AgentSession source. Keep its advertised capabilities distinct from changes waiting for the next normal start.');
    if(status.metrics?.enabled)check('recorder',status.metrics.state==='ready'&&!status.metrics.lastError,'Recording is not ready; sync or inspect its errors before a new search.');
    else check('recorder',false,'Direct recording is unavailable; explicitly preserve and import the existing client’s logs.',false);
    if(status.replayPolicy){
      check('replay-preservation',!status.replayPolicy.active&&Array.isArray(status.replayPolicy.pendingParents)&&status.replayPolicy.pendingParents.length===0,'Authorized replay preservation must finish before another search; inspect replayPolicy and retry the existing parent without repeating uploads.');
      if(status.replayPolicy.enabled)check('replay-policy-capability',status.replayPolicy.capable===true&&status.metrics?.enabled===true,'The enabled replay policy needs a loaded preservation verifier and live metrics recorder.');
    }
    // A requested old parent is diagnostic input, never an override for the
    // newest owned set's mandatory checkpoint.
    latestOwned=(status.rooms||[]).filter(room=>room.ended&&PARENT.test(room.id)).at(-1);
    latestParent=latestOwned?.id;
    if(latestOwned?.teamId&&HASH.test(latestOwned.teamId))reviewTeamId=latestOwned.teamId;
    session={sessionId:status.sessionId,connected:status.connected,authenticated:status.authenticated,stopped:status.stopped,teamId:status.teamSha256,remainingSets:remaining,idle,capabilities,runtime,metrics:status.metrics||null,replayPolicy:status.replayPolicy||null,...controls};
  }
  const skills=skill.status==='fulfilled'?skill.value:null;
  check('skill-sync',skills?.synchronized===true,'The maintained and installed matchup skill must match; inspect skill status and sync reviewed changes.');
  let local={all:[],candidates:[]},historyReadable=history.status==='fulfilled';
  if(historyReadable)try{local=localParents(history.value);}catch{historyReadable=false;}
  check('local-history',historyReadable,'Local set history must be readable to check review continuity across clients and team versions.');
  const tooManyCandidates=local.candidates.length>20;
  if(tooManyCandidates)check('history-chronology',false,'More than 20 local parents have tied or unknown recency; review continuity needs explicit reconciliation before another search.');
  const localCandidates=local.candidates.slice(0,20);
  const targets=new Map();
  const addTarget=(teamId,parentId,origin)=>{
    if(!HASH.test(teamId||''))return;
    parentId=parentId?canonical(parentId):null;
    const key=teamId+'|'+(parentId||'<latest-stored>');
    const existing=targets.get(key);
    if(existing){if(!existing.origins.includes(origin))existing.origins.push(origin);}
    else targets.set(key,{teamId,parentId,origins:[origin]});
  };
  addTarget(exactTeam,null,'current-team-latest-stored');
  if(latestOwned){addTarget(reviewTeamId,latestOwned.id,'latest-ended-owned-parent');addTarget(reviewTeamId,null,'owned-team-latest-stored');}
  for(const candidate of localCandidates){addTarget(candidate.teamId,candidate.parentId,'latest-all-local-stored-parent');addTarget(candidate.teamId,null,'history-team-latest-stored');}
  if(parentId){
    const owned=(status?.rooms||[]).find(room=>canonical(room.id)===canonical(parentId));
    const matching=local.all.filter(parent=>parent.parentId===canonical(parentId));
    const requestedTeam=HASH.test(owned?.teamId||'')?owned.teamId:matching.length===1?matching[0].teamId:exactTeam;
    addTarget(requestedTeam,parentId,'requested-parent-diagnostic');
  }
  const requestedTargets=[...targets.values()];
  const [reviewResults,health]=await Promise.all([
    Promise.allSettled(requestedTargets.map(target=>reviewReader({workspace,teamId:target.teamId,...(target.parentId?{parentId:target.parentId}:{}),skillOptions}))),
    Promise.resolve().then(()=>healthReader({workspace,...(exactTeam&&HASH.test(exactTeam)?{teamId:exactTeam}:{})})).then(value=>({status:'fulfilled',value}),()=>({status:'rejected'})),
  ]);
  const reviews=reviewResults.map((result,index)=>({...requestedTargets[index],status:result.status==='fulfilled'?result.value:{complete:false,blockers:['Review status could not be verified for this exact team and parent.']}}));
  const primary=reviews.find(review=>review.origins.includes('latest-ended-owned-parent'))||reviews.find(review=>review.origins.includes('latest-all-local-stored-parent'))||reviews[0];
  const previousReview=primary?.status||null;
  if(primary){reviewTeamId=primary.teamId;latestParent=primary.parentId||previousReview?.parentId;}
  if(exactTeam&&HASH.test(exactTeam))check('previous-review',reviews.length>0&&reviews.every(review=>review.status?.complete===true),'Every latest known local/owned set needs a validated review and skill checkpoint before another search; a requested older set cannot replace this check.');
  for(const review of reviews)if(review.status?.complete!==true)blockers.push(`${review.parentId||review.status?.parentId||'Latest stored parent'} (${review.teamId}): ${(review.status?.blockers||['Required review is incomplete.']).join(' ')}`);
  const reportHealth=health.status==='fulfilled'?health.value:null;
  if(exactTeam&&HASH.test(exactTeam))check('team-snapshot',reportHealth?.teams?.find(report=>report.teamId===exactTeam)?.snapshot?.status==='verified','The exact approved team snapshot must be available and verified.');
  if(!reportHealth)warnings.push('Report health could not be read; existing records were left unchanged.');
  else{
    if(reportHealth.warnings?.length)warnings.push(...reportHealth.warnings.map(value=>typeof value==='string'?value:value.message||'Report health needs attention.'));
    for(const report of reportHealth.teams||[]){
      if(report.missingReplays?.length)warnings.push(`${report.missingReplays.length} completed games lack verified replay links; retain their local evidence.`);
      if(report.missingOrInvalidEvidence?.length)warnings.push(`${report.missingOrInvalidEvidence.length} completed games need retained-evidence repair before cleanup.`);
      if(report.sourceDiagnostics?.some(source=>source.status!=='available'||source.teamSnapshotCheck&&!['matches-exact-team','saved-id-only'].includes(source.teamSnapshotCheck)))warnings.push('A remembered team source is missing, changed or unsafe; inspect report health.');
    }
    if(reportHealth.pendingCleanupTeams?.length)warnings.push('Some team artifacts are still pending cleanup; inspect their specific blockers.');
  }
  const historyCoverage={source:'all-local-retained-metrics-parents',readable:historyReadable,storedParents:local.all.length,candidates:localCandidates,accountScope:'All local team versions; no account match was inferred.',chronology:'Recency uses stored ended/start/import/update timestamps. Undated and tied latest parents remain candidates; timestamps do not prove actual battle order.',externalCoverage:'Battles absent from this local store and the current owned session are unverified.',limited:tooManyCandidates};
  return {schemaVersion:1,kind:'battle-preflight',checkedAt:new Date().toISOString(),teamId:exactTeam||null,reviewTeamId:reviewTeamId||null,parentId:latestParent?canonical(latestParent):previousReview?.parentId||null,requestedParentId:parentId?canonical(parentId):null,ready:blockers.length===0,checks,blockers:[...new Set(blockers)],warnings,session,skill:skills,review:previousReview,reviews,historyCoverage,reports:reportHealth,authorization:'Readiness is informational. It grants no search, roster change, replay publication or authentication.'};
}
