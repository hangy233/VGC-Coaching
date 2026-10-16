import {createHash} from 'node:crypto';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {isAbsolute,join,relative,sep} from 'node:path';
import {promisify} from 'node:util';
import {gunzip} from 'node:zlib';
import {listBattles} from '../metrics/store.mjs';
import {readGameEvidence} from '../metrics/retention.mjs';
import {canonicalReplayUrl} from '../metrics/replay-evidence.mjs';
const decompress=promisify(gunzip),HASH=/^[a-f0-9]{64}$/u,ROOM=/^battle-gen9championsvgc2026regmcbo3-\d+$/u;
const canonical=value=>String(value||'').replace(/-[a-z0-9]+pw$/u,'');
const inside=(root,path)=>{const rel=relative(root,path);return rel!==''&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel);};

/** Local proof of a saved report link plus both replay and canonical evidence. */
export async function verifySetReplayPreservation({workspace,teamId,parentId,roomIds,officialOutcome}={}){
  parentId=canonical(parentId);roomIds=Array.isArray(roomIds)?roomIds.map(canonical):[];
  if(!HASH.test(teamId||'')||!/^game-bestof3-gen9championsvgc2026regmcbo3-\d+$/u.test(parentId)||roomIds.length<1||roomIds.length>3||new Set(roomIds).size!==roomIds.length||roomIds.some(room=>!ROOM.test(room))||officialOutcome!==undefined&&!['win','loss','tie'].includes(officialOutcome))throw new Error('Use an exact team, parent and independently observed child list.');
  const rows=(await listBattles({workspace,includeArchived:true})).filter(row=>row.teamId===teamId&&row.parentId===parentId),root=await realpath(workspace),preserved=[],missing=[],failures=[];
  const expected=[...roomIds].sort();
  const manifests=[...new Set(rows.map(row=>row.metadata.setResult?.expectedChildIds).filter(Boolean).map(ids=>JSON.stringify([...ids].sort())))];
  const results=[...new Set(rows.map(row=>row.metadata.setResult?.outcome))];
  const coverage=rows.length===roomIds.length&&rows.every(row=>roomIds.includes(row.roomId))&&manifests.length===1&&manifests[0]===JSON.stringify(expected)&&results.length===1&&['win','loss','tie'].includes(results[0])&&(officialOutcome===undefined||results[0]===officialOutcome);
  for(const roomId of roomIds){
    try{
      if(!coverage)throw new Error('coverage');
      const row=rows.find(row=>row.roomId===roomId);if(!row?.completed||!row.metadata.setResult?.completed||!row.metadata.replay?.verified)throw new Error('row');
      const replay=row.metadata.replay;canonicalReplayUrl(replay.url,{roomId});
      const path=`cache/team-metrics/evidence/${roomId}--${teamId}.replay.log.gz`;
      if(replay.evidencePath!==path||!HASH.test(replay.logSha256))throw new Error('reference');
      let current=root;const parts=path.split('/');
      for(const [index,name]of parts.entries()){current=join(current,name);const info=await lstat(current);if(info.isSymbolicLink()||(index<parts.length-1?!info.isDirectory():!info.isFile()||info.size>8*1024*1024)||!inside(root,await realpath(current)))throw new Error('path');}
      const log=await decompress(await readFile(current),{maxOutputLength:8*1024*1024});
      if(createHash('sha256').update(log).digest('hex')!==replay.logSha256)throw new Error('hash');
      const evidence=await readGameEvidence({workspace,teamId,roomId});if(!evidence.complete||evidence.sourceKind!=='sanitized-events')throw new Error('canonical');
      preserved.push(roomId);
    }catch{missing.push(roomId);failures.push({roomId,reason:coverage?'A verified report replay link and complete local replay/canonical evidence could not be confirmed.':'Stored children or official parent manifests do not match the observed completed set.'});}
  }
  return {teamId,parentId,complete:missing.length===0,preserved,missing,failures,checkedAt:new Date().toISOString(),scope:'Local durable report/evidence verification only; no upload, fetch, authentication or battle action.'};
}
