import {createHash,randomUUID} from 'node:crypto';
import {lstat,readdir,readFile,realpath,rename,unlink,mkdir,writeFile} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve,sep,extname,basename} from 'node:path';
import {listBattles,listTeams} from './store.mjs';
import {beginMetricsTeamDeletion,finishMetricsTeamDeletion,getMetricsTeamDeletion,listMetricsTeamDeletions,acquireMetricsBattleLock} from './catalog.mjs';
import {decodeInput,canonicalRoom,mutateMetricsSources} from './import.mjs';
import {callLocalSession} from '../showdown/local-bridge.mjs';

const HASH=/^[a-f0-9]{64}$/u,MAX=64*1024*1024;
const controlId=createHash('sha256').update('team-metrics-cleanup-control').digest('hex');
const slash=value=>value.replaceAll('\\','/');
const digest=value=>createHash('sha256').update(value).digest('hex');
const key=value=>slash(value).toLowerCase();
const fail=message=>new Error('Team cleanup: '+message);
const inside=(root,path)=>{const part=relative(root,path);return part!==''&&part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part);};
function identity(teamId){if(typeof teamId!=='string'||!HASH.test(teamId))throw fail('use the full exact team fingerprint');}

/** Resolve every ancestor; deletion never follows a link or leaves the cache. */
async function fileAt(workspace,file){
  const root=await realpath(workspace),path=resolve(root,file),rel=slash(relative(root,path));
  if(!inside(root,path)||!rel.startsWith('cache/'))throw fail('generated data must stay inside the workspace cache');
  let current=root;
  const parts=relative(root,path).split(sep);
  for(const [index,part]of parts.entries()){
    current=join(current,part);let info;
    try{info=await lstat(current);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    if(info.isSymbolicLink()||(index<parts.length-1?!info.isDirectory():!info.isFile())||!inside(root,await realpath(current)))throw fail('linked or non-regular artifacts must be retained');
    if(index===parts.length-1){if(info.size>MAX)throw fail('artifact exceeds the cleanup size limit');const bytes=await readFile(path);return {path:rel,absolute:path,bytes,size:bytes.length,sha256:digest(bytes)};}
  }
}
async function names(workspace,directory){
  const root=await realpath(workspace),path=resolve(root,directory);
  if(!inside(root,path)||!slash(relative(root,path)).startsWith('cache/'))throw fail('artifact directory must remain in cache');
  let current=root;
  for(const part of relative(root,path).split(sep)){
    current=join(current,part);let info;try{info=await lstat(current);}catch(error){if(error.code==='ENOENT')return [];throw error;}
    if(info.isSymbolicLink()||!info.isDirectory()||!inside(root,await realpath(current)))throw fail('artifact directory is linked or unsafe');
  }
  return (await readdir(path,{withFileTypes:true})).filter(entry=>entry.isFile()||entry.isSymbolicLink()).map(entry=>slash(join(directory,entry.name)));
}
async function jsonAt(workspace,file){const value=await fileAt(workspace,file);return value?JSON.parse(value.bytes.toString('utf8')):null;}
function alive(pid){if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}}
async function sessionStatus(sessionCall,descriptor){
  let timer;
  try{return await Promise.race([sessionCall(descriptor,{id:randomUUID(),op:'status'}),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(fail('active client ownership check timed out')),1500);})]);}
  finally{clearTimeout(timer);}
}

function csvRows(text){
  const rows=[];let row=[],cell='',quoted=false;
  for(let index=0;index<text.length;index++){
    const char=text[index];
    if(quoted){if(char==='"'&&text[index+1]==='"'){cell+='"';index++;}else if(char==='"')quoted=false;else cell+=char;}
    else if(char==='"'){if(cell)throw fail('unrecognized CSV');quoted=true;}
    else if(char===','){row.push(cell);cell='';}
    else if(char==='\n'){row.push(cell.replace(/\r$/u,''));rows.push(row);row=[];cell='';}
    else cell+=char;
  }
  if(quoted)throw fail('unrecognized CSV');if(cell||row.length){row.push(cell.replace(/\r$/u,''));rows.push(row);}return rows;
}
function exportOwner(file,text){
  try{
    if(extname(file)==='.json'){const value=JSON.parse(text);return value.schemaVersion===1&&HASH.test(value.team?.teamId)?value.team.teamId:null;}
    if(extname(file)==='.html'){
      const embedded=/<script type="application\/json" id="report-data">(.*?)<\/script>/su.exec(text);
      if(!embedded)return null;const value=JSON.parse(embedded[1]);return value.schemaVersion===1&&HASH.test(value.team?.teamId)?value.team.teamId:null;
    }
    if(extname(file)==='.csv'){
      const rows=csvRows(text),header=rows.shift(),index=header?.indexOf('teamId');
      if(index<0||header?.[0]!=='section')return null;
      const ids=new Set(rows.filter(row=>row.some(Boolean)).map(row=>row[index]));return ids.size===1&&HASH.test([...ids][0])?[...ids][0]:null;
    }
  }catch{}return null;
}

/** Check content ownership rather than assuming that a source reference is exclusive. */
function sourceOwner(file,text,rooms,parents,teamId){
  const extension=extname(file).toLowerCase();
  if(extension==='.json'){
    try{
      const value=JSON.parse(text);
      if(value.kind==='official-showdown-replay'&&typeof value.id==='string'&&typeof value.log==='string')return rooms.has(canonicalRoom('battle-'+value.id.replace(/^battle-/u,'')));
      if(typeof value.id==='string'&&typeof value.log==='string')return sourceOwner(file.replace(/\.json$/u,'.log'),'>battle-'+value.id.replace(/^battle-/u,'')+'\n'+value.log,rooms,parents,teamId);
      // Private review checkpoints explicitly bind their team version.
      if((value.teamSha256===teamId||value.teamId===teamId)&&typeof value.parentId==='string'&&parents.has(canonicalRoom(value.parentId)))return true;
      const sets=[...(Array.isArray(value.sets)?value.sets:[]),...(Array.isArray(value.excludedRuns)?value.excludedRuns:[])];
      if(sets.length&&sets.every(set=>parents.has(canonicalRoom(set.parentId))&&(set.children||set.childResults||[]).length>0&&(set.children||set.childResults||[]).every(child=>rooms.has(canonicalRoom(child.id||child.room)))))return true;
      return false;
    }catch{return false;}
  }
  if(!['.jsonl','.log','.txt'].includes(extension))return false;
  if(extension!=='.jsonl'&&text.split(/\r?\n/u).some(line=>line.trim()&&!line.startsWith('|')&&!line.startsWith('>')))return false;
  let values;try{values=decodeInput({path:file,text});}catch{return false;}
  if(!values.length)return false;
  const allowed=new Set([...rooms,...parents]);let observed=false;
  for(const value of values){
    const room=canonicalRoom(value?.room||'');
    if(!room||!allowed.has(room))return false;observed=true;
    // A log may contain command wrappers with other room IDs nested inside.
    const walk=(entry,field)=>{
      if(typeof entry==='string'&&['room','roomId','parentId'].includes(field))return allowed.has(canonicalRoom(entry));
      if(entry&&typeof entry==='object')return Object.entries(entry).every(([name,child])=>walk(child,name));return true;
    };
    if(!walk(value))return false;
  }
  return observed;
}

async function activeProtection(workspace,teamId,sessionCall){
  const blockers=[],activePaths=new Set();let activeClient=false;
  for(const file of ['cache/showdown-session.json','cache/showdown-standby-session.json']){
    let descriptor;try{descriptor=await jsonAt(workspace,file);}catch{blockers.push('A local session descriptor could not be checked.');continue;}
    if(!descriptor)continue;
    if(!Number.isSafeInteger(descriptor.pid)||descriptor.pid<1){blockers.push('A session descriptor has unverified process ownership. Its files remain protected.');continue;}
    if(!alive(descriptor.pid))continue;
    activeClient=true;
    for(const field of ['logFile','logPath','eventLogFile','decisionLogFile'])if(typeof descriptor[field]==='string')activePaths.add(key(slash(relative(resolve(workspace),resolve(workspace,descriptor[field])))));
    try{
      const reply=await sessionStatus(sessionCall,join(workspace,file));
      if(!reply?.ok||!HASH.test(reply.result?.teamSha256))throw fail('unknown active team');
      if(reply.result.teamSha256===teamId&&!reply.result.stopped)blockers.push('This team still belongs to an open battle session. Keep its files until that session is deliberately released.');
    }catch{blockers.push('An active client’s team ownership could not be verified. Its files remain protected.');}
  }
  return {blockers,activePaths,activeClient};
}

/** Inventory a whole exact version, including orphaned generated files. */
export async function planTeamCleanup({workspace,teamId,sessionCall=callLocalSession}={}){
  identity(teamId);
  const records=await listBattles({workspace,includeArchived:true}),owned=records.filter(record=>record.teamId===teamId),others=records.filter(record=>record.teamId!==teamId);
  const catalog=await listTeams({workspace,includeArchived:true});
  const tombstone=await getMetricsTeamDeletion({workspace,teamId});
  const journalFile=`cache/team-metrics/deletions/${teamId}.json`;
  const journal=await jsonAt(workspace,journalFile);
  if(journal&&(journal.kind!=='team-cleanup'||journal.teamId!==teamId||!Array.isArray(journal.files)))throw fail('invalid pending cleanup journal');
  const rooms=new Set([...owned.map(record=>record.roomId),...(journal?.roomIds||[])]),parents=new Set([...owned.map(record=>record.parentId).filter(Boolean),...(journal?.parentIds||[])]);
  const files=new Map(),retained=[],blockers=[];
  const protection=await activeProtection(workspace,teamId,sessionCall);blockers.push(...protection.blockers);
  const add=async(file,kind,{expected,shared=false,source=false}={})=>{
    if(files.has(key(file))||retained.some(entry=>key(entry.path)===key(file)))return;
    try{
      const value=await fileAt(workspace,file);if(!value)return;
      if(shared){retained.push({path:value.path,kind,size:value.size,sha256:value.sha256,reason:'Shared with another retained team version.'});return;}
      if(protection.activePaths.has(key(value.path))){blockers.push('An active writer owns '+value.path);return;}
      if(expected&&expected!==value.sha256){retained.push({path:value.path,kind,size:value.size,sha256:expected,reason:'Artifact changed since the pending cleanup plan.'});return;}
      if(source&&protection.activeClient&&!file.startsWith('cache/team-metrics/')){retained.push({path:value.path,kind,size:value.size,sha256:value.sha256,reason:'An open client may still write this raw source; closure has not been verified.'});return;}
      if(source&&!sourceOwner(file,value.bytes.toString('utf8'),rooms,parents,teamId)){retained.push({path:value.path,kind,size:value.size,sha256:value.sha256,reason:'Source contains shared or unrecognized data; exclusive ownership is not established.'});return;}
      files.set(key(value.path),{path:value.path,kind,size:value.size,sha256:value.sha256});
    }catch{blockers.push('Artifact is unsafe or unreadable: '+slash(file));}
  };
  // Full hashes avoid accidentally deleting a neighboring team version.
  for(const file of await names(workspace,'cache/team-metrics'))if(file.endsWith('--'+teamId+'.json'))await add(file,'game-summary');
  for(const file of await names(workspace,'cache/team-metrics/evidence'))if(file.endsWith('--'+teamId+'.events.json.gz')||file.endsWith('--'+teamId+'.replay.log.gz')){
    const room=basename(file).split('--')[0];if(/^battle-[a-z0-9]+-\d+$/u.test(room))rooms.add(room);
    await add(file,'game-evidence');
  }
  for(const file of await names(workspace,'cache/team-metrics/decision-notes'))if(new RegExp('^'+teamId+'--(?:battle-[a-z0-9]+-\\d+|game-bestof3-[a-z0-9]+-\\d+)\\.json$','u').test(basename(file))||new RegExp('^\\.pending-'+teamId+'-[a-f0-9-]{36}\\.tmp$','u').test(basename(file)))await add(file,'decision-notes');
  for(const file of await names(workspace,'cache/team-metrics/calculations'))if(new RegExp('^'+teamId+'--[a-f0-9-]{36}\\.json$','u').test(basename(file))||new RegExp('^\\.pending-'+teamId+'-[a-f0-9-]{36}\\.tmp$','u').test(basename(file)))await add(file,'calculation-evidence');
  for(const directory of ['','teams','reports/teams','evidence','replays'])for(const file of await names(workspace,'cache/team-metrics'+(directory?'/'+directory:'')))if(new RegExp('^\\.pending-'+teamId+'-[a-f0-9-]{36}\\.tmp$','u').test(basename(file)))await add(file,'temporary-file');
  for(const file of await names(workspace,'cache/team-metrics/deletions'))if(new RegExp('^\\.cleanup-'+teamId+'-[a-f0-9-]{36}\\.tmp$','u').test(basename(file)))await add(file,'temporary-file');
  await add(`cache/team-metrics/teams/${teamId}.txt`,'team-snapshot');
  for(const suffix of ['.html','.agent.json','.agent.md'])await add(`cache/team-metrics/reports/teams/${teamId}${suffix}`,'stable-report');
  for(const file of await names(workspace,'cache/team-metrics/reports')){
    const value=await fileAt(workspace,file);if(value&&exportOwner(file,value.bytes.toString('utf8'))===teamId)await add(file,'export');
  }
  let sources=[];
  try{sources=await jsonAt(workspace,'cache/team-metrics/sources/registry.json')||[];if(!Array.isArray(sources)||sources.length>50)throw fail('invalid source registry');}
  catch{blockers.push('Source registrations could not be safely checked.');sources=[];}
  const registrations=sources.filter(source=>source.expectedTeamId===teamId),otherSources=sources.filter(source=>source.expectedTeamId!==teamId);
  const sourceFiles=new Set([...owned.flatMap(record=>record.metadata.sources||[]),...registrations.flatMap(source=>[...(source.files||[]),...(source.ledgerFile?[source.ledgerFile]:[])])]);
  for(const room of rooms){
    const file=`cache/team-metrics/replays/${digest(room.replace(/^battle-/u,''))}.json`;
    sourceFiles.add(file);
  }
  for(const file of sourceFiles){
    if(!file.startsWith('cache/')||file==='live-client')continue;
    if(!['.json','.jsonl','.log','.txt'].includes(extname(file)))continue;
    const shared=others.some(record=>(record.metadata.sources||[]).some(path=>key(path)===key(file))||file===`cache/team-metrics/replays/${digest(record.roomId.replace(/^battle-/u,''))}.json`)||otherSources.some(source=>[...(source.files||[]),source.ledgerFile,source.teamFile].filter(Boolean).some(path=>key(path)===key(file)));
    await add(file,'source-log',{shared,source:true});
  }
  for(const file of await names(workspace,'cache/champions-mc-reviews')){
    if(!file.endsWith('.json'))continue;
    try{const value=await jsonAt(workspace,file);if(value?.teamSha256===teamId||value?.teamId===teamId)await add(file,'review',{source:true});}catch{blockers.push('A team review could not be safely inspected.');}
  }
  for(const parent of parents){
    if(!/^(?:game-)?bestof3-[a-z0-9]+-\d+$/u.test(parent))continue;
    for(const file of await names(workspace,'cache/bo3-runs/'+parent)){
      if(['.jsonl','.log','.txt','.json'].includes(extname(file)))await add(file,'run-log',{source:true});
      else if(/\.(?:tmp|temp)$/u.test(file))await add(file,'temporary-file',{shared:others.some(record=>record.parentId===parent)});
      else retained.push({path:file,kind:'run-artifact',reason:'Run artifact ownership or active control use is not established.'});
    }
  }
  for(const previous of [...(journal?.files||[]),...(journal?.retained||[])])if(typeof previous.path==='string')await add(previous.path,previous.kind,{expected:previous.sha256,source:['source-log','run-log','review'].includes(previous.kind),shared:others.some(record=>(record.metadata.sources||[]).some(path=>key(path)===key(previous.path))||previous.path===`cache/team-metrics/replays/${digest(record.roomId.replace(/^battle-/u,''))}.json`)||otherSources.some(source=>[...(source.files||[]),source.ledgerFile].filter(Boolean).some(path=>key(path)===key(previous.path)))});
  return {schemaVersion:1,teamId,exists:catalog.some(team=>team.teamId===teamId)||owned.length>0||files.size>0||!!journal||!!tombstone,ready:blockers.length===0,complete:false,roomIds:[...rooms],parentIds:[...parents],files:[...files.values()],retained,blockers:[...new Set(blockers)],sourceRegistrations:registrations.length,tombstone,journalFile};
}

async function saveJournal(workspace,plan){
  const root=await realpath(workspace);let directory=root;
  for(const part of ['cache','team-metrics','deletions']){
    directory=join(directory,part);let info;
    try{info=await lstat(directory);}catch(error){if(error.code!=='ENOENT')throw error;try{await mkdir(directory);}catch(created){if(created.code!=='EEXIST')throw created;}info=await lstat(directory);}
    if(info.isSymbolicLink()||!info.isDirectory()||!inside(root,await realpath(directory)))throw fail('cleanup journals must stay in real cache directories');
  }
  const path=join(workspace,plan.journalFile),temporary=join(directory,'.cleanup-'+plan.teamId+'-'+randomUUID()+'.tmp');
  const value={schemaVersion:1,kind:'team-cleanup',teamId:plan.teamId,roomIds:plan.roomIds,parentIds:plan.parentIds,files:plan.files,retained:plan.retained};
  try{await writeFile(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});await rename(temporary,path);}finally{try{await unlink(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
}

/** Permanent deletion is separate from ordinary per-BO3 log retention. */
export async function deleteTeamReport({workspace,teamId,dryRun=true,confirmed=false,sessionCall=callLocalSession,capacityEviction=false}={}){
  identity(teamId);
  if(typeof dryRun!=='boolean'||typeof capacityEviction!=='boolean')throw fail('cleanup options must be booleans');
  if(!dryRun&&confirmed!==true)throw fail('confirmed:true is required for permanent team cleanup');
  let plan=await planTeamCleanup({workspace,teamId,sessionCall});
  if(dryRun)return {...plan,dryRun:true,removed:[],pending:plan.retained.length>0||!plan.ready};
  if(!plan.ready)return {...plan,dryRun:false,removed:[],pending:true};
  if(!plan.exists)return {...plan,dryRun:false,removed:[],complete:true,pending:false};
  const release=await acquireMetricsBattleLock({workspace,teamId:controlId,roomId:'delete-team-'+teamId});
  const removed=[];
  try{
    const deletion=await beginMetricsTeamDeletion({workspace,teamId,requireCapacityEviction:capacityEviction});
    if(!deletion)return {...plan,dryRun:false,removed,complete:false,pending:false,skipped:'Team became active again before capacity cleanup.'};
    plan=await planTeamCleanup({workspace,teamId,sessionCall});
    if(!plan.ready)return {...plan,dryRun:false,removed,pending:true};
    await saveJournal(workspace,plan);
    await mutateMetricsSources({workspace,update:sources=>sources.filter(source=>source.expectedTeamId!==teamId)});
    const retained=[...plan.retained];
    for(const entry of plan.files){
      try{
        const current=await fileAt(workspace,entry.path);if(!current)continue;
        if(current.size!==entry.size||current.sha256!==entry.sha256){retained.push({...entry,reason:'Artifact changed after the cleanup plan.'});continue;}
        await unlink(current.absolute);removed.push(entry);
      }catch{retained.push({...entry,reason:'Exact artifact recheck or removal failed.'});}
    }
    const complete=retained.length===0;
    if(complete){await finishMetricsTeamDeletion({workspace,teamId});const journal=await fileAt(workspace,plan.journalFile);if(journal)await unlink(journal.absolute);}
    else await saveJournal(workspace,{...plan,files:plan.files.filter(entry=>!removed.some(value=>value.path===entry.path)),retained});
    return {...plan,dryRun:false,removed,retained,complete,pending:!complete};
  }finally{await release();}
}

/** The LRU permanently removes evicted versions; blocked cleanup stays explicit. */
export async function cleanupEvictedTeams({workspace,teamIds=[]}={}){
  let pending;
  try{pending=[...(await listTeams({workspace,includeArchived:true})).filter(team=>team.active===false&&team.archiveReason==='capacity').map(team=>team.teamId),...(await listMetricsTeamDeletions({workspace})).map(team=>team.teamId)];}
  catch{return {results:[],complete:false,pendingTeams:teamIds,blockers:['Pending team cleanup could not be inventoried safely.']};}
  const results=[];
  for(const teamId of [...new Set([...teamIds,...pending])]){
    try{results.push(await deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true,capacityEviction:true}));}
    catch{results.push({teamId,complete:false,pending:true,blockers:['Evicted team cleanup could not finish; its retained artifacts need another cleanup attempt.']});}
  }
  return {results,complete:results.every(result=>result.complete||result.skipped),pendingTeams:results.filter(result=>result.pending).map(result=>result.teamId)};
}
