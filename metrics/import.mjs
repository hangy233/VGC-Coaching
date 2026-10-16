import {readFile,realpath,stat,lstat,mkdir,writeFile,rename,rm,link} from 'node:fs/promises';
import {resolve,relative,isAbsolute,extname,basename,join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {analyzeBattle} from './parser.mjs';
import {saveBattle,isMetricsTeamActive,registerMetricsTeam,listTeams} from './store.mjs';
import {updateTeamReport,ensureTeamReport} from './live-reports.mjs';

const require=createRequire(import.meta.url);
const {Teams,TeamValidator}=require('pokemon-showdown');
const normalized=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'');
export const canonicalRoom=value=>String(value||'').replace(/-[a-z0-9]+pw$/,'');
const battleRoom=value=>/^battle-[a-z0-9]+(?:-[a-z0-9]+)*-\d+$/.test(value);
const allowedProtocol=new Set(['player','poke','start','turn','upkeep','switch','drag','replace','detailschange','swap','move','cant','faint','win','tie','gen','gametype','tier','teamsize','teampreview']);

/** Local inputs only. Resolve links before checking containment, never echo data on errors. */
export async function readWorkspaceFile(workspace,file,{extensions=['.json','.jsonl','.log','.txt'],maxBytes=32*1024*1024}={}) {
  if(typeof file!=='string'||!file||file.includes('\0'))throw new Error('Expected a workspace file path');
  const root=await realpath(workspace),path=await realpath(resolve(root,file));
  const rel=relative(root,path);
  if(!rel||rel.startsWith('..')||isAbsolute(rel)||['.git','.aws','.codex','.agents','node_modules'].includes(rel.split(/[\\/]/)[0]))throw new Error('Input must be a regular file within the workspace');
  if(!extensions.includes(extname(path).toLowerCase()))throw new Error('Unsupported metrics input file type');
  const info=await stat(path);
  if(!info.isFile()||info.size>maxBytes)throw new Error('Metrics input must be a regular file no larger than 32 MiB');
  return {path,relative:rel.replaceAll('\\','/'),text:await readFile(path,'utf8')};
}

export async function loadMetricsTeam({workspace,teamFile,teamId:requestedId,name}) {
  if(Boolean(teamFile)===Boolean(requestedId))throw new Error('Supply exactly one teamFile or saved teamId');
  if(requestedId&&!/^[a-f0-9]{64}$/.test(requestedId))throw new Error('Use an exact saved team fingerprint');
  if(requestedId)teamFile='cache/team-metrics/teams/'+requestedId+'.txt';
  const input=await readWorkspaceFile(workspace,teamFile,{extensions:['.txt']});
  const {team,teamId}=validateMetricsTeam(input.text);
  if(requestedId&&teamId!==requestedId)throw new Error('Saved team snapshot does not match its fingerprint');
  const known=(await listTeams({workspace,includeArchived:true})).find(t=>t.teamId===teamId);
  return {team,teamId,teamFile:input.relative,descriptor:{name:name||known?.name||basename(teamFile,'.txt'),format:'gen9championsvgc2026regmc',roster:team.map(p=>p.species)}};
}

function validateMetricsTeam(text) {
  if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text,'utf8')>128*1024)throw new Error('Supply a team export no larger than 128 KiB');
  const team=Teams.import(text);
  if(!team||team.length!==6)throw new Error('Metrics require a complete six-Pokemon team');
  const problems=new TeamValidator('gen9championsvgc2026regmc').validateTeam(team);
  if(problems?.length)throw new Error('Metrics team failed M-C validation: '+problems.join('; '));
  return {team,teamId:createHash('sha256').update(Teams.pack(team)).digest('hex')};
}

/** Keep a private immutable export so a saved version survives edits to its source. */
export async function saveMetricsTeamSnapshot({workspace,teamId,team}) {
  if(!/^[a-f0-9]{64}$/.test(teamId)||createHash('sha256').update(Teams.pack(team)).digest('hex')!==teamId)throw new Error('Team snapshot does not match its fingerprint');
  const root=await realpath(workspace);let directory=root;
  for(const part of ['cache','team-metrics','teams']){
    directory=join(directory,part);try{await mkdir(directory);}catch(error){if(error.code!=='EEXIST')throw error;}
    const info=await lstat(directory),rel=relative(root,await realpath(directory));
    if(!info.isDirectory()||info.isSymbolicLink()||rel.startsWith('..')||isAbsolute(rel))throw new Error('Team snapshots must stay within real workspace directories');
  }
  const path=join(directory,teamId+'.txt'),content=Teams.export(team)+'\n';
  const verifyExisting=async()=>{
    const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>128*1024)throw new Error('Invalid team snapshot file');
    const existing=Teams.import(await readFile(path,'utf8'));
    if(!existing||new TeamValidator('gen9championsvgc2026regmc').validateTeam(existing)?.length||createHash('sha256').update(Teams.pack(existing)).digest('hex')!==teamId)throw new Error('Saved team snapshot is corrupt; existing file was retained');
  };
  try{await verifyExisting();return relative(root,path).replaceAll('\\','/');}catch(error){if(error.code!=='ENOENT')throw error;}
  const temp=join(directory,'.team-'+randomUUID()+'.tmp');
  try{
    await writeFile(temp,content,{flag:'wx',mode:0o600});
    // Publish without replacing another importer’s immutable snapshot. Windows
    // can refuse rename-overwrite while that other importer verifies the file.
    try{await link(temp,path);}catch(error){
      if(!['EEXIST','EPERM'].includes(error.code))throw error;
      try{await verifyExisting();}catch{throw error;}
    }
  }finally{await rm(temp,{force:true});}
  return relative(root,path).replaceAll('\\','/');
}

/** Register a legal team and its own report before playing or importing a game. */
export async function registerTeamFromFile({workspace,teamFile,name}={}) {
  const registration=await loadMetricsTeam({workspace,teamFile,name});
  const savedTeamFile=await saveMetricsTeamSnapshot({workspace,...registration});
  await registerMetricsTeam({workspace,teamId:registration.teamId,...registration.descriptor});
  const stableReport=await ensureTeamReport({workspace,teamId:registration.teamId});
  return {teamId:registration.teamId,team:registration.descriptor,savedTeamFile,stableReport};
}

/** MCP callers can register a pasted team without creating an intermediate file. */
export async function registerTeamFromText({workspace,teamText,name}={}) {
  const {team,teamId}=validateMetricsTeam(teamText);
  const known=(await listTeams({workspace,includeArchived:true})).find(value=>value.teamId===teamId);
  const descriptor={name:name||known?.name||'M-C team',format:'gen9championsvgc2026regmc',roster:team.map(p=>p.species)};
  const savedTeamFile=await saveMetricsTeamSnapshot({workspace,teamId,team});
  await registerMetricsTeam({workspace,teamId,...descriptor});
  return {teamId,team:descriptor,savedTeamFile,stableReport:await ensureTeamReport({workspace,teamId})};
}

function safeRequest(request) {
  if(!request||typeof request!=='object')return null;
  return {teamPreview:!!request.teamPreview,wait:!!request.wait,rqid:request.rqid,
    ...(Array.isArray(request.active)?{active:[]} : {}),...(Array.isArray(request.forceSwitch)?{forceSwitch:request.forceSwitch.map(Boolean)} : {}),
    side:request.side?{id:request.side.id,name:request.side.name,pokemon:(request.side.pokemon||[]).map(p=>({ident:p.ident,details:p.details,active:!!p.active,condition:p.condition}))}:undefined};
}

/** Reusable ingestion path for old JSONL wrappers and future live recording. */
export function collectBattleEvents(values,{defaultRoom}={}) {
  const rooms=new Map();
  const get=raw=>{const room=canonicalRoom(raw);if(!battleRoom(room))return null;if(!rooms.has(room))rooms.set(room,{events:[],sheets:{},warnings:[]});return rooms.get(room);};
  for(const value of values){
    const data=get(value.room||defaultRoom);if(!data)continue;
    if(value.event==='sheet'&&typeof value.side==='string'&&typeof value.packed==='string')data.sheets[value.side]=value.packed;
    else if(value.event==='request'||value.type==='request'){
      const request=safeRequest(value.request);if(request)data.events.push({type:'request',request,at:value.at});
    }else if(value.event==='result'&&['win','tie'].includes(value.type)){
      // Client emits a result callback immediately before the same protocol line.
      // Preserve only protocol results here; a callback fallback is added below.
      data.result={type:value.type,data:value.type==='win'?[value.winner]:[],at:value.at};
    }else if(typeof value.type==='string'&&(allowedProtocol.has(value.type)||value.type.startsWith('-'))&&Array.isArray(value.data)){
      // A server rejoin can resend a complete history. Retain the newest full
      // history, rather than counting earlier copies of the same turns twice.
      if(value.type==='gametype'&&data.events.some(e=>e.type==='gametype')){
        // Rejoins can send the player lines just before a new history boundary.
        // Keep those observed identities as a fallback when the resent history
        // omits them; they do not represent repeated battle actions.
        data.priorPlayers||=new Map();
        for(const event of data.events)if(event.type==='player'&&['p1','p2'].includes(event.data?.[0]))data.priorPlayers.set(event.data[0],event);
        data.events=[];data.warnings.push('Replayed server history reconciled at its new gametype marker.');
      }
      data.events.push({type:value.type,data:value.data.map(x=>String(x)),at:value.at});
    }
  }
  for(const data of rooms.values()){
    if(data.priorPlayers){
      const known=new Set(data.events.filter(event=>event.type==='player').map(event=>event.data?.[0]));
      data.events.unshift(...[...data.priorPlayers].filter(([side])=>!known.has(side)).map(([,event])=>event));
      delete data.priorPlayers;
    }
    if(data.result&&!data.events.some(e=>['win','tie'].includes(e.type)))data.events.push(data.result);
  }
  return rooms;
}

export function decodeInput(input){
  const text=input.text.replace(/^\uFEFF/,'').trim();if(!text)return [];
  if(extname(input.path)==='.json'){
    let replay;try{replay=JSON.parse(text);}catch{throw new Error('Invalid metrics JSON input');}
    if(!replay||typeof replay.log!=='string'||typeof replay.id!=='string')throw new Error('Replay JSON requires an id and a Showdown protocol log');
    const replayRoom=String(replay.id).startsWith('battle-')?replay.id:'battle-'+replay.id;
    return protocolValues(replay.log,replayRoom);
  }
  if(extname(input.path)==='.jsonl'){
    const values=[];for(const [index,line]of text.split(/\r?\n/).entries()){
      if(!line.trim())continue;
      try{values.push(JSON.parse(line));}catch{throw new Error('Invalid metrics JSONL at line '+(index+1));}
    }return values;
  }
  const fileId=basename(input.path,extname(input.path));
  return protocolValues(text,/^[a-z0-9]+-\d+(?:-[a-z0-9]+pw)?$/.test(fileId)?'battle-'+fileId:fileId);
}
function protocolValues(text,defaultRoom){
  let room=defaultRoom;const values=[];
  for(const line of text.split(/\r?\n/)){
    if(line.startsWith('>')){room=line.slice(1).trim();continue;}
    if(!line.startsWith('|'))continue;
    const [,type,...data]=line.split('|');
    // Requests may contain private information and are parsed only for selection.
    if(type==='request'){try{values.push({room,type,request:JSON.parse(data.join('|'))});}catch{throw new Error('Invalid request in protocol input');}}
    else if(type==='showteam')values.push({room,event:'sheet',side:data[0],packed:data.slice(1).join('|')});
    else values.push({room,type,data});
  }return values;
}

function ledgerIndex(ledger){
  const map=new Map();
  for(const set of [...(ledger?.sets||[]),...(ledger?.excludedRuns||[])]){
    const official=set.parentResult;
    const setResult=official?.ownResult?{outcome:official.ownResult,completed:true}:undefined;
    const children=set.children||set.childResults||[];
    for(const child of children){
      const room=canonicalRoom(child.id||child.room||'');if(!battleRoom(room))continue;
      const excluded=set.completedPlayed===false||set.countedTowardTarget===false;
      const operational=excluded||!!child.operationalErrors?.length||/inactivity|server-default/i.test(child.finishAttribution||'');
      map.set(room,{parentId:canonicalRoom(set.parentId),setResult,index:set.completedPlayedIndex,opponent:set.opponent,child,excluded,operational});
    }
  }return map;
}
function compatibleSheet(team,packed){
  let sheet;try{sheet=Teams.unpack(packed);}catch{return false;}
  if(!sheet||sheet.length!==team.length)return false;
  const shape=t=>t.map(p=>({species:normalized(p.species),item:normalized(p.item),ability:normalized(p.ability),nature:normalized(p.nature),moves:(p.moves||[]).map(normalized).sort()})).sort((a,b)=>a.species.localeCompare(b.species));
  return JSON.stringify(shape(team))===JSON.stringify(shape(sheet));
}

export async function importBattleFiles({workspace,files,username,teamFile,teamId,ledgerFile,name,remember=false,expectedTeamId}={}) {
  if(typeof username!=='string'||!normalized(username)||username.length>30)throw new Error('Supply the battle username');
  if(!Array.isArray(files)||!files.length||files.length>20)throw new Error('Supply 1–20 local battle files');
  const registration=await loadMetricsTeam({workspace,teamFile,teamId,name});
  if(expectedTeamId!==undefined&&registration.teamId!==expectedTeamId)throw new Error('The remembered team file changed. Register the intended team version explicitly; previous metrics were retained.');
  const inputs=await Promise.all(files.map(file=>readWorkspaceFile(workspace,file)));
  let ledger,ledgerSource;if(ledgerFile){const input=await readWorkspaceFile(workspace,ledgerFile,{extensions:['.json']});ledgerSource=input.relative;try{ledger=JSON.parse(input.text);}catch{throw new Error('Invalid metrics ledger JSON');}}
  const index=ledgerIndex(ledger),rooms=collectBattleEvents(inputs.flatMap(decodeInput));
  const savedTeamFile=await saveMetricsTeamSnapshot({workspace,...registration});
  const saved=[],skipped=[];
  for(const [roomId,data]of rooms){
    const observedName=data.events.find(e=>e.type==='request'&&normalized(e.request?.side?.name)===normalized(username));
    const ownSide=observedName?.request.side.id||data.events.find(e=>e.type==='player'&&normalized(e.data[1])===normalized(username))?.data[0];
    if(!ownSide){skipped.push({roomId,reason:'Username not observed in battle'});continue;}
    if(data.sheets[ownSide]&&!compatibleSheet(registration.team,data.sheets[ownSide])){skipped.push({roomId,reason:'Observed team sheet differs from supplied team version'});continue;}
    const entry=index.get(roomId);
    const record=analyzeBattle({roomId,username,teamId:registration.teamId,team:registration.team,events:data.events,parentId:entry?.parentId||null,metadata:{source:'local-import',operational:!!entry?.operational}});
    const opponentSide=record.ownSide==='p1'?'p2':'p1';
    if(!record.players[opponentSide]&&typeof entry?.opponent==='string')record.players[opponentSide]=entry.opponent;
    record.team=registration.descriptor;
    record.metadata={...(record.metadata||{}),sources:[...inputs.map(i=>i.relative),...(ledgerSource?[ledgerSource]:[])],...(entry?.setResult?{setResult:entry.setResult}:{}),...(entry?.index?{ledgerIndex:entry.index}:{}),attribution:entry?.child?.finishAttribution||'observed-protocol'};
    record.quality||={complete:false,operational:false,warnings:[]};record.quality.warnings||=[];
    record.quality.operational=record.quality.operational||!!entry?.operational;
    if(!entry)record.quality.warnings.push('No reviewed ledger entry: submission/default provenance was not verified; metrics describe observed execution.');
    if(entry?.operational)record.quality.warnings.push('Ledger flags operational/default/inactivity contamination; excluded from default team comparisons.');
    // A reviewed accepted preview may recover unobserved reserves; no opponent selection is inferred.
    if(entry?.child?.selection?.mcpTeamChoice){
      const selected=[...(entry.child.selection.lead||[]),...(entry.child.selection.reserves||[])];
      if(selected.length===4){record.selected=selected;record.selectionKnown=true;for(const p of record.pokemon)p.selected=selected.some(s=>normalized(s)===normalized(p.species));}
    }
    const result=await saveBattle({workspace,record});saved.push({roomId,...(result&&typeof result==='object'?result:{})});
  }
  if(remember)await rememberMetricsSource({workspace,source:{files:inputs.map(i=>i.relative),username,teamFile:registration.teamFile,expectedTeamId:registration.teamId,...(ledgerSource?{ledgerFile:ledgerSource}:{}),...(name?{name}:{})}});
  const stableReport=saved.length?await updateTeamReport({workspace,teamId:registration.teamId}):null;
  return {teamId:registration.teamId,imported:saved.length,skipped,battles:saved,team:registration.descriptor,savedTeamFile,stableReport,provenance:'Training points belong to the supplied validated team file; open sheets alone do not reveal them.'};
}

export async function rememberMetricsSource({workspace,source}) {
  const directory=join(workspace,'cache','team-metrics','sources');await mkdir(directory,{recursive:true});
  // Read/write only the generated registry; paths are rechecked again on every refresh.
  const root=await realpath(workspace),actual=await realpath(directory),rel=relative(root,actual);
  if(rel.startsWith('..')||isAbsolute(rel))throw new Error('Metrics source registry must stay in the workspace');
  const file=join(directory,'registry.json');let sources=[];
  try{sources=JSON.parse(await readFile(file,'utf8'));if(!Array.isArray(sources))throw new Error('Invalid metrics source registry');}catch(error){if(error.code!=='ENOENT')throw error;}
  const key=createHash('sha256').update(JSON.stringify([source.username,source.teamFile,source.files])).digest('hex');
  const value={key,...source};sources=[...sources.filter(s=>s.key!==key),value];
  const temporary=file+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(sources,null,2)+'\n',{flag:'wx'});await rename(temporary,file);
}

export async function refreshMetricsSources({workspace}) {
  let sources;try{sources=JSON.parse((await readWorkspaceFile(workspace,'cache/team-metrics/sources/registry.json',{extensions:['.json']})).text);}catch(error){if(error.code==='ENOENT')return {refreshed:0,warnings:[]};throw error;}
  if(!Array.isArray(sources)||sources.length>50)throw new Error('Invalid metrics source registry');
  let refreshed=0,skippedArchived=0;const warnings=[];
  for(const source of sources){try{
    if(source.expectedTeamId&&await isMetricsTeamActive({workspace,teamId:source.expectedTeamId})===false){skippedArchived++;continue;}
    await importBattleFiles({...source,workspace,remember:false});refreshed++;
  }catch{warnings.push('A registered local metrics source could not be refreshed; its previous records were retained.');}}
  return {refreshed,skippedArchived,warnings};
}
