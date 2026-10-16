import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {listBattles} from './store.mjs';
import {canonicalRoom,readWorkspaceFile,decodeInput,collectBattleEvents,refreshMetricsSources} from './import.mjs';
import {saveGameEvidence,buildCleanupPlan,cleanupBo3Files,validateCleanupReview} from './retention.mjs';
import {attachVerifiedReplay} from './replay-evidence.mjs';
import {updateTeamReport} from './live-reports.mjs';
import {callLocalSession} from '../showdown/local-bridge.mjs';

/** A completed-set maintenance operation; it cannot queue, authenticate or choose. */
export async function finalizeBo3({workspace,teamId,parentId,checkpointFile,sourceFiles=[],cleanupFiles=[],closedFiles=[],dryRun=true,confirmed,saveReplays=false,call=callLocalSession,fetchImpl=globalThis.fetch,skillOptions={}}={}){
  if(!/^[a-f0-9]{64}$/.test(teamId||''))throw new Error('Supply an exact teamId');
  if(typeof parentId!=='string'||!/^game-bestof3-gen9championsvgc2026regmcbo3-\d+(?:-[a-z0-9]+pw)?$/.test(parentId))throw new Error('Supply the completed M-C BO3 parent');
  if(typeof dryRun!=='boolean'||typeof saveReplays!=='boolean')throw new Error('Use boolean finalization options');
  if(!Array.isArray(sourceFiles)||sourceFiles.length>20||!Array.isArray(cleanupFiles)||cleanupFiles.length>100||!Array.isArray(closedFiles)||closedFiles.length>100)throw new Error('Supply bounded source and cleanup file lists');
  const canonicalParent=canonicalRoom(parentId),planArgs={workspace,teamId,parentId:canonicalParent,checkpointFile,files:cleanupFiles,closedFiles,skillOptions};
  if(dryRun)return {parentId:canonicalParent,teamId,dryRun:true,saveReplaysRequested:saveReplays,cleanup:await buildCleanupPlan(planArgs),note:'Preview only: no replay is uploaded, evidence written or file deleted.'};
  if(confirmed!==true)throw new Error('Finalization requires confirmed:true within the authorized replay and cleanup scope');
  const refresh=await refreshMetricsSources({workspace});
  const records=(await listBattles({workspace,includeArchived:true})).filter(record=>record.teamId===teamId&&record.parentId===canonicalParent);
  if(!records.length||records.some(record=>!record.completed||!record.metadata.setResult?.completed))throw new Error('The parent and every recorded child must have a completed official result');
  // Validate the review before any deletion or publication. Missing archives may
  // still be repaired below; an invalid checkpoint cannot be repaired by metrics.
  const checkpointSource=await readWorkspaceFile(workspace,checkpointFile,{extensions:['.json']}),checkpoint=JSON.parse(checkpointSource.text);
  const reviewValidation=await validateCleanupReview({workspace,teamId,parentId:canonicalParent,checkpointFile:checkpointSource.relative,checkpoint,skillOptions});
  if(!reviewValidation.complete)throw new Error('A current completed exact-team review and verified skill checkpoint is required. '+reviewValidation.blockers.join(' '));
  const inputs=await Promise.all(sourceFiles.map(file=>readWorkspaceFile(workspace,file)));
  const values=inputs.flatMap(decodeInput),rooms=collectBattleEvents(values);
  const archived=[],archiveFailures=[];
  for(const record of records){
    const data=rooms.get(record.roomId);
    if(!data)continue;
    try{archived.push(await saveGameEvidence({workspace,teamId,roomId:record.roomId,events:values.filter(value=>canonicalRoom(value.room)===record.roomId),sheets:data.sheets}));}
    catch{archiveFailures.push({roomId:record.roomId,error:'The compact game evidence could not be verified; original logs were retained.'});}
  }
  let replayResult=null;const replayFailures=[];
  if(saveReplays){
    try{
      const reply=await call(join(workspace,'cache','showdown-session.json'),{id:'replays-'+randomUUID(),op:'save-replays',room:parentId,confirmed:true});
      if(!reply.ok)throw new Error('Replay operation unavailable');
      replayResult=reply.result;
      for(const replay of replayResult.replays||[]){
        if(!records.some(record=>record.roomId===canonicalRoom(replay.roomId||replay.room)))continue;
        try{await attachVerifiedReplay({workspace,teamId,roomId:canonicalRoom(replay.roomId||replay.room),url:replay.url,fetchImpl});}
        catch{replayFailures.push({roomId:canonicalRoom(replay.roomId||replay.room),error:'Replay verification or local evidence saving failed; original logs were retained.'});}
      }
      for(const failure of replayResult.failures||[])replayFailures.push({roomId:canonicalRoom(failure.roomId||failure.room),error:'Replay saving was not verified; original logs were retained.'});
    }catch{replayFailures.push({parentId:canonicalParent,error:'The open client could not save this set’s replays. Keep its connection open and retain the local logs.'});}
  }
  const cleanup=archiveFailures.length||replayFailures.length?{...await buildCleanupPlan(planArgs),removed:[],kept:cleanupFiles.map(path=>({path,reason:'Preservation or replay verification failed; no cleanup performed.'}))}:await cleanupBo3Files({...planArgs,confirmed:true});
  const stableReport=await updateTeamReport({workspace,teamId});
  return {parentId:canonicalParent,teamId,dryRun:false,refresh,archived,archiveFailures,replays:replayResult?.replays||[],replayFailures,cleanup,stableReport};
}
