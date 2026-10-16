import {readFile,writeFile,mkdir,lstat,realpath,rename,rm} from 'node:fs/promises';
import {join,dirname,relative,isAbsolute,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {acquireMetricsBattleLock,assertMetricsTeamWritable} from '../metrics/catalog.mjs';
import {readCalculation} from '../workflow/calculations.mjs';

const HASH=/^[a-f0-9]{64}$/u, ROOM=/^battle-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*$/u;
const canonical=value=>String(value||'').replace(/-[a-z0-9]+pw$/u,'');
const text=(value,max=2000)=>String(value||'').replace(/[\u0000-\u001f\u007f]/gu,' ').replace(/https?:\/\/\S+/giu,'[URL removed]').slice(0,max);
function identity(teamId,room){if(!HASH.test(teamId||'')||!ROOM.test(canonical(room)))throw new Error('Decision notes require an exact team fingerprint and M-C child room');return canonical(room);}
async function location(workspace,teamId,room,{create=false}={}){
  room=identity(teamId,room);const root=await realpath(workspace);let current=root;
  for(const part of ['cache','team-metrics','decision-notes']){
    current=join(current,part);if(create)try{await mkdir(current);}catch(error){if(error.code!=='EEXIST')throw error;}
    const info=await lstat(current),rel=relative(root,await realpath(current));
    if(!info.isDirectory()||info.isSymbolicLink()||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new Error('Decision notes must remain in real workspace directories');
  }
  const path=join(current,teamId+'--'+room+'.json');
  try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>2*1024*1024)throw new Error('Invalid decision note journal');}catch(error){if(error.code!=='ENOENT')throw error;}
  return {path,room};
}
async function load(path,teamId,room){
  let value;try{value=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return {schemaVersion:1,kind:'agent-decision-notes',teamId,roomId:room,notes:[]};throw new Error('Decision note journal could not be read');}
  if(value?.schemaVersion!==1||value.teamId!==teamId||value.roomId!==room||!Array.isArray(value.notes)||value.notes.length>500)throw new Error('Decision note journal identity is invalid');
  return value;
}

/** Agent-provided reasoning is distinct from selected, accepted and executed actions. */
export async function saveDecisionNote({workspace,teamId,room,note}={}){
  room=identity(teamId,room);await assertMetricsTeamWritable({workspace,teamId});
  if(!note||!HASH.test(note.token||'')||typeof note.noteId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/u.test(note.noteId)||!Number.isSafeInteger(note.turn)||note.turn<0||!Number.isSafeInteger(note.rqid)||note.rqid<0)throw new Error('Decision note must identify one observed action token, turn and request');
  const clean={noteId:note.noteId,sessionId:text(note.sessionId,100),token:note.token,rqid:note.rqid,turn:note.turn,recordedAt:new Date().toISOString(),provenance:'Agent-provided reasoning and predictions are unverified. Included calculation references are separately verified against retained actual MCP tool results; they do not verify other numerical claims in the prose.',actionStatusAtNote:text(note.actionStatusAtNote||'unsubmitted',50),
    predictedOpposingActions:(note.predictedOpposingActions||[]).slice(0,2).map(value=>text(value,1000)),ourPlan:text(note.ourPlan),alternatives:(note.alternatives||[]).slice(0,3).map(value=>text(value,1000)),reason:text(note.reason),calculationRefs:[]};
  if(!clean.ourPlan.trim()&&!clean.reason.trim())throw new Error('Supply a plan or reason for the decision note');
  if(!Array.isArray(note.calculationRefs||[])||(note.calculationRefs||[]).length>10)throw new Error('Supply at most ten MCP calculation evidence IDs');
  for(const id of note.calculationRefs||[]){
    if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id))throw new Error('Calculation references must be MCP evidence IDs');
    const receipt=await readCalculation({workspace,teamId,id});
    if(receipt.roomId!==room||receipt.turn!==null&&receipt.turn!==note.turn)throw new Error('Calculation evidence belongs to a different battle or turn');
    clean.calculationRefs.push({id:receipt.id,teamId:receipt.teamId,roomId:receipt.roomId,turn:receipt.turn,tool:receipt.tool,path:receipt.path,sha256:receipt.sha256,provenance:'actual-mcp-tool'});
  }
  const release=await acquireMetricsBattleLock({workspace,teamId,roomId:room+'-decision-notes'});let temp;
  try{
    await assertMetricsTeamWritable({workspace,teamId});const {path}=await location(workspace,teamId,room,{create:true}),document=await load(path,teamId,room);
    const existing=document.notes.find(value=>value.noteId===clean.noteId);if(existing)return {teamId,roomId:room,note:existing,unchanged:true};
    if(document.notes.length>=500)throw new Error('Decision note journal limit reached');document.notes.push(clean);
    temp=join(dirname(path),'.pending-'+teamId+'-'+randomUUID()+'.tmp');await writeFile(temp,JSON.stringify(document)+'\n',{flag:'wx',mode:0o600});await rename(temp,path);
    return {teamId,roomId:room,note:clean,unchanged:false};
  }finally{if(temp)await rm(temp,{force:true});await release();}
}

/** Read saved reasoning after a game or process ends; never restore an evicted team. */
export async function readDecisionNotes({workspace,teamId,room,fromTurn=0,toTurn=10000}={}){
  room=identity(teamId,room);await assertMetricsTeamWritable({workspace,teamId});
  if(!Number.isSafeInteger(fromTurn)||!Number.isSafeInteger(toTurn)||fromTurn<0||toTurn<fromTurn||toTurn>10000)throw new Error('Invalid decision note turn range');
  let document;try{const {path}=await location(workspace,teamId,room);document=await load(path,teamId,room);}catch(error){if(error.code!=='ENOENT')throw error;document={notes:[]};}
  return {schemaVersion:1,teamId,roomId:room,fromTurn,toTurn,notes:document.notes.filter(note=>note.turn>=fromTurn&&note.turn<=toTurn),limitation:'Agent notes describe intent and predictions. Read game evidence separately for server acceptance, execution, defaults and outcomes.'};
}
