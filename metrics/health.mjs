import {lstat,readFile,realpath} from 'node:fs/promises';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import {listBattles,listTeams,gameAnnotationState} from './store.mjs';
import {listMetricsTeamDeletions} from './catalog.mjs';
import {loadMetricsTeam} from './import.mjs';
import {readGameEvidence} from './retention.mjs';

/** Read-only path inspection: never follows linked ancestors or reads a session capability. */
async function inspect(workspace,file,{json=false}={}){
  if(typeof file!=='string'||isAbsolute(file)||/^[a-z]+:/iu.test(file)||file.split(/[\\/]/u).some(part=>['..','.git','.aws','.codex','.agents'].includes(part))||/(?:^|[\\/])(?:\.env[^/\\]*|showdown[^/\\]*session[^/\\]*\.json)$/iu.test(file))return {status:'unsafe'};
  const root=await realpath(workspace),target=resolve(root,file),part=relative(root,target);
  if(!part||part==='..'||part.startsWith('..'+sep)||isAbsolute(part))return {status:'unsafe'};
  let current=root;
  try{
    const parts=part.split(sep);let stat;
    for(const [index,name]of parts.entries()){current=resolve(current,name);stat=await lstat(current);if(stat.isSymbolicLink()||(index<parts.length-1?!stat.isDirectory():!stat.isFile()))return {status:'unsafe'};}
    if(stat.size>32*1024*1024)return {status:'oversized',bytes:stat.size};
    return {status:'available',bytes:stat.size,modifiedAt:stat.mtime.toISOString(),...(json?{value:JSON.parse(await readFile(target,'utf8'))}:{})};
  }catch(error){return {status:error.code==='ENOENT'?'missing':error instanceof SyntaxError?'invalid-json':'unreadable'};}
}
export async function getMetricsHealth({workspace,teamId,verifyEvidence=true}={}){
  if(teamId!==undefined&&!/^[a-f0-9]{64}$/u.test(teamId))throw new Error('Use the full exact team fingerprint.');
  if(typeof verifyEvidence!=='boolean')throw new Error('verifyEvidence must be boolean.');
  const pendingCleanupTeams=await listMetricsTeamDeletions({workspace});
  const teams=(await listTeams({workspace,includeArchived:true})).filter(team=>!teamId||team.teamId===teamId);
  if(teamId&&!teams.length&&!pendingCleanupTeams.some(team=>team.teamId===teamId))throw new Error('Unknown exact team.');
  const records=await listBattles({workspace,includeArchived:true});
  const registry=await inspect(workspace,'cache/team-metrics/sources/registry.json',{json:true});
  const registryValid=registry.status==='available'&&Array.isArray(registry.value)&&registry.value.length<=50&&registry.value.every(source=>source&&typeof source==='object'&&!Array.isArray(source)&&/^[a-f0-9]{64}$/u.test(source.expectedTeamId)&&Array.isArray(source.files)&&source.files.length<=20&&source.files.every(file=>typeof file==='string'&&file.length<=2048));
  const sources=registryValid?registry.value:[];
  const reports=[];
  for(const team of teams){
    const games=records.filter(record=>record.teamId===team.teamId);let snapshot;
    try{await loadMetricsTeam({workspace,teamId:team.teamId});snapshot={status:'verified',path:`cache/team-metrics/teams/${team.teamId}.txt`};}catch{snapshot={status:'missing-or-invalid',path:`cache/team-metrics/teams/${team.teamId}.txt`};}
    const sourceDiagnostics=[];
    for(const source of sources.filter(source=>source.expectedTeamId===team.teamId)){
      let teamSnapshotCheck='saved-id-only';
      if(source.teamFile){try{const saved=await loadMetricsTeam({workspace,teamFile:source.teamFile});teamSnapshotCheck=saved.teamId===team.teamId?'matches-exact-team':'changed-team-fingerprint';}catch{teamSnapshotCheck='invalid-or-unreadable';}}
      for(const file of [...new Set([...(source.files||[]),source.teamFile,source.ledgerFile].filter(Boolean))]){
        const check=await inspect(workspace,file),{value:_,...safe}=check;
        sourceDiagnostics.push({path:check.status==='unsafe'?'<unsafe-source-path>':file,...safe,teamBinding:source.expectedTeamId,teamSnapshotCheck,importRefresh:'not-attempted-read-only'});
      }
    }
    const evidence=[];
    for(const game of games){
      let status=game.metadata.evidence?.complete?'recorded':'missing';
      if(verifyEvidence&&(game.metadata.evidence||game.metadata.replay?.evidencePath)){try{const retained=await readGameEvidence({workspace,teamId:team.teamId,roomId:game.roomId});status=retained.complete?'verified-complete':'partial';}catch{status='invalid-or-unreadable';}}
      evidence.push({roomId:game.roomId,completed:game.completed,canonicalEvidence:status,verifiedReplay:game.metadata.replay?.verified===true,manuallyExcluded:gameAnnotationState(game).excluded});
    }
    const latestMetricUpdateAt=games.flatMap(game=>[game.updatedAt,game.importedAt]).filter(Boolean).sort().at(-1)||null;
    const reportArtifacts=await Promise.all(['.html','.agent.json','.agent.md'].map(async suffix=>{const path=`cache/team-metrics/reports/teams/${team.teamId}${suffix}`;return {path,...await inspect(workspace,path)};}));
    reports.push({teamId:team.teamId,active:team.active,snapshot,games:games.length,missingReplays:evidence.filter(game=>game.completed&&!game.verifiedReplay).map(game=>game.roomId),missingOrInvalidEvidence:evidence.filter(game=>game.completed&&!['verified-complete','recorded'].includes(game.canonicalEvidence)).map(game=>game.roomId),evidence,sourceDiagnostics,latestMetricUpdateAt,reportArtifacts:reportArtifacts.map(entry=>({...entry,olderThanMetrics:Boolean(latestMetricUpdateAt&&entry.modifiedAt&&entry.modifiedAt<latestMetricUpdateAt)}))});
  }
  const cleanupInventory=new Map(pendingCleanupTeams.map(team=>[team.teamId,team]));
  for(const team of teams.filter(team=>!team.active&&team.archiveReason==='capacity'))if(!cleanupInventory.has(team.teamId))cleanupInventory.set(team.teamId,{teamId:team.teamId,state:'awaiting-cleanup',startedAt:null});
  const cleanup=[];
  for(const team of cleanupInventory.values())if(!teamId||team.teamId===teamId){const journal=await inspect(workspace,`cache/team-metrics/deletions/${team.teamId}.json`,{json:true}),value=journal.value;const valid=value?.kind==='team-cleanup'&&value.teamId===team.teamId&&Array.isArray(value.files)&&Array.isArray(value.retained);cleanup.push({...team,journalStatus:journal.status==='available'&&!valid?'invalid-schema':journal.status,remainingFiles:valid?value.files.length:null,retained:valid?value.retained.slice(0,100).map(entry=>({path:typeof entry.path==='string'?entry.path:null,reason:typeof entry.reason==='string'?entry.reason:'Ownership or writer check is pending.'})):[],detailsScope:'Last saved cleanup journal only. Active-writer and shared-file blockers are rechecked by team_metrics_delete_team in its default dry run.'});}
  return {schemaVersion:1,checkedAt:new Date().toISOString(),readOnly:true,teams:reports,sourceRegistry:{status:registry.status==='available'&&!registryValid?'invalid-schema':registry.status,entries:sources.length},pendingCleanupTeams:cleanup,interpretation:'Stored timestamps and file checks do not prove a live recorder is flushed. Missing replays need an authorized save; this check never authenticates, publishes, refreshes imports or deletes data.'};
}
