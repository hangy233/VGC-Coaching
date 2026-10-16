import {randomUUID} from 'node:crypto';
import {listBattles,updateBattleMetadata,gameAnnotationState} from './store.mjs';
import {updateTeamReport} from './live-reports.mjs';

function identity(teamId,roomId){if(!/^[a-f0-9]{64}$/u.test(teamId)||!/^battle-[a-z0-9]+-\d+$/u.test(roomId))throw new Error('Use an exact team fingerprint and canonical battle room.');}
export async function getGameAnnotations({workspace,teamId,roomId}={}){
  identity(teamId,roomId);
  const record=(await listBattles({workspace,includeArchived:true})).find(row=>row.teamId===teamId&&row.roomId===roomId);
  if(!record)throw new Error('Game not found for this exact team.');
  return {teamId,roomId,originalOutcome:record.outcome,operational:record.quality.operational,...gameAnnotationState(record),interpretation:'Annotations are review judgments, not measured protocol facts. Excluding a game also excludes its BO3 from default set performance.'};
}
export async function annotateGame({workspace,teamId,roomId,action='note',reason,author='agent',annotationId=randomUUID()}={}){
  identity(teamId,roomId);
  if(!['note','exclude','include'].includes(action)||typeof reason!=='string'||!reason.trim()||reason.length>4000||/[\u0000-\u001f\u007f]/u.test(reason)||typeof author!=='string'||!author.trim()||author.length>100||/[\u0000-\u001f\u007f]/u.test(author)||! /^[a-f0-9-]{36}$/u.test(annotationId))throw new Error('Use a bounded review reason, author, action and UUID.');
  const before=await getGameAnnotations({workspace,teamId,roomId});
  const existing=before.history.find(entry=>entry.id===annotationId);
  if(existing&&(existing.action!==action||existing.reason!==reason.trim()||existing.author!==author.trim()))throw new Error('An annotation ID cannot be rewritten.');
  if(!existing)await updateBattleMetadata({workspace,teamId,roomId,metadata:{annotations:[{id:annotationId,at:new Date().toISOString(),action,reason:reason.trim(),author:author.trim()}]}});
  const stableReport=await updateTeamReport({workspace,teamId});
  return {...await getGameAnnotations({workspace,teamId,roomId}),stableReport,status:existing?'unchanged':'appended'};
}
