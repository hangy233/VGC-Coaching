import {createHash,randomUUID} from 'node:crypto';
import {mkdir,lstat,realpath,readFile,writeFile,readdir} from 'node:fs/promises';
import {join,relative,isAbsolute,sep} from 'node:path';
import {acquireMetricsBattleLock} from '../metrics/catalog.mjs';
import {loadMetricsTeam} from '../metrics/import.mjs';
import {timingSpan} from '../observability/timing.mjs';
import {packCalculationPayload,unpackCalculationPayload} from './calculation-archive.mjs';

const HASH=/^[a-f0-9]{64}$/u,ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u,ROOM=/^battle-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*$/u;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(root,path)=>{const value=relative(root,path);return value!==''&&value!=='..'&&!value.startsWith('..'+sep)&&!isAbsolute(value);};
function validate(context){if(!context||!HASH.test(context.teamId)||!ROOM.test(context.roomId)||context.turn!==undefined&&(!Number.isSafeInteger(context.turn)||context.turn<0||context.turn>10000))throw new Error('Calculation evidence requires an exact team, canonical M-C game and optional turn.');}
async function directory(workspace,create){
  const root=await realpath(workspace);let current=root;
  for(const part of ['cache','team-metrics','calculations']){
    current=join(current,part);let info;
    try{info=await lstat(current);}catch(error){if(error.code!=='ENOENT'||!create)throw error;try{await mkdir(current);}catch(created){if(created.code!=='EEXIST')throw created;}info=await lstat(current);}
    if(info.isSymbolicLink()||!info.isDirectory()||!inside(root,await realpath(current)))throw new Error('Calculation evidence must stay in real workspace cache directories.');
  }
  return {root,path:current};
}

/** Actual MCP numeric/simulation research, including explicitly unavailable diagnostics. */
export async function recordCalculation({workspace,tool,input,result,context}={}){
  return timingSpan('calculation_evidence',{tool}).run(async()=>{
  timingSpan('calculation_evidence.validation').run(()=>{validate(context);if(!['calculate_damage','calculate_damage_range','calculate_speed','simulate_turn','simulate_turn_batch','simulate_choices'].includes(tool))throw new Error('Unsupported calculation evidence tool.');});
  await timingSpan('calculation_evidence.team_load').run(()=>loadMetricsTeam({workspace,teamId:context.teamId}));
  const release=await timingSpan('calculation_evidence.lock_wait').run(()=>acquireMetricsBattleLock({workspace,teamId:context.teamId,roomId:'calculation-evidence'}));
  try{
    const target=await timingSpan('calculation_evidence.directory').run(async()=>{const target=await directory(workspace,true);if((await readdir(target.path)).filter(name=>name.startsWith(context.teamId+'--')).length>=10000)throw new Error('Calculation evidence limit reached for this team.');return target;});
    const payload=timingSpan('calculation_evidence.encode').run(()=>packCalculationPayload({tool,input,result}));
    const id=randomUUID(),document={schemaVersion:1,kind:'mcp-calculation-evidence',id,teamId:context.teamId,roomId:context.roomId,turn:context.turn??null,tool,createdAt:new Date().toISOString(),...payload,provenance:'actual-mcp-tool'};
    const content=timingSpan('calculation_evidence.serialize').run(()=>{const content=JSON.stringify(document)+'\n';if(Buffer.byteLength(content)>512*1024)throw new Error('Calculation evidence exceeds its size limit.');return content;});
    const path=join(target.path,context.teamId+'--'+id+'.json');
    await timingSpan('calculation_evidence.write').run(()=>writeFile(path,content,{flag:'wx',mode:0o600}));
    return {id,teamId:context.teamId,roomId:context.roomId,turn:context.turn??null,tool,path:relative(target.root,path).replaceAll('\\','/'),sha256:sha(content)};
  }finally{await timingSpan('calculation_evidence.lock_release').run(release);}
  });
}

export async function readCalculation({workspace,teamId,id}={}){
  timingSpan('calculation_evidence.validation',{stage:'read-identity'}).run(()=>{if(!HASH.test(teamId)||!ID.test(id))throw new Error('Use an exact team and calculation evidence ID.');});
  const {target,path,content}=await timingSpan('calculation_evidence.read').run(async()=>{const target=await directory(workspace,false),path=join(target.path,teamId+'--'+id+'.json'),info=await lstat(path);if(info.isSymbolicLink()||!info.isFile()||info.size>512*1024)throw new Error('Invalid calculation evidence file.');return {target,path,content:await readFile(path,'utf8')};});
  const value=timingSpan('calculation_evidence.validation',{stage:'read-document'}).run(()=>{const value=JSON.parse(content);if(value.schemaVersion!==1||value.kind!=='mcp-calculation-evidence'||value.teamId!==teamId||value.id!==id||value.provenance!=='actual-mcp-tool'||!['calculate_damage','calculate_damage_range','calculate_speed','simulate_turn','simulate_turn_batch','simulate_choices'].includes(value.tool))throw new Error('Calculation evidence identity is invalid.');validate({teamId:value.teamId,roomId:value.roomId,...(value.turn===null?{}:{turn:value.turn})});return value;});
  const payload=unpackCalculationPayload({tool:value.tool,input:value.input,result:value.result,payloadArchive:value.payloadArchive});
  const {payloadArchive,...document}=value;
  return {...document,...payload,sha256:sha(content),path:relative(target.root,path).replaceAll('\\','/')};
}
