// A manager-readable alarm, independent of draining the interactive stream.
// It conveys no native capability and never dispatches a battle operation.
import {lstatSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const PARENT=/^game-bestof3-gen9championsvgc2026regmcbo3-[1-9]\d*$/u;
const CODE=/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u;
const RUN=/^[A-Za-z0-9_.:-]{1,100}$/u;
const epoch=value=>Number.isSafeInteger(value)&&value>=0;
const canonical=value=>typeof value==='string'?value.replace(/-[a-z0-9]+pw$/u,''):undefined;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));

function containment(value){
  const command=value?.command,args=command?.args;
  if(value?.manualOnly!==true||!exact(command,['id','op','name','args'])||!exact(args,['confirmed','commandId','room'])||
    !/^contain-[a-f0-9]{24}$/u.test(command.id??'')||command.op!=='call'||command.name!=='battle_forfeit'||
    args.confirmed!==true||args.commandId!==command.id||!PARENT.test(args.room??''))return undefined;
  return {manualOnly:true,command:{id:command.id,op:'call',name:'battle_forfeit',args:{confirmed:true,commandId:command.id,room:args.room}}};
}

/** The directory must already be a verified private launch output directory.
 * Small synchronous atomic writes precede stdout/evidence/cleanup awaits. */
export function createAttentionAlert({directory,now=Date.now}={}){
  const path=join(directory,'attention-alert.json');
  let record={schemaVersion:1,kind:'manager-attention-alert',status:'monitoring',active:false,
    choiceAuthority:false,automaticActions:false,sequence:0,updatedAt:now()};
  function persist(next){
    try{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Unsafe alert target');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    const text=JSON.stringify(next)+'\n';if(Buffer.byteLength(text)>8192)throw new Error('Alert bound exceeded');
    const temporary=join(directory,`.attention-alert-${randomUUID()}.tmp`);
    try{writeFileSync(temporary,text,{flag:'wx',mode:0o600});renameSync(temporary,path);}
    finally{try{unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
    record=next;
  }
  persist(record); // Refuse startup if the independent alarm cannot be prepared.
  return {path,accept(value){
    const attention=['controller-attention','attention-required','attention-input-closed'].includes(value?.state);
    const lost=value?.state==='attention-ownership-lost';
    const resolved=['attention-resolved','review-required'].includes(value?.state);
    if(!attention&&!lost&&!resolved)return {updated:false};
    const next={...record,sequence:record.sequence+1,updatedAt:now(),
      status:lost?'ownership-lost':resolved?'resolved':'attention-required',active:!lost&&!resolved};
    if(attention&&!epoch(next.firstDetectedAt))next.firstDetectedAt=epoch(value.detectedAt)?value.detectedAt:next.updatedAt;
    if(RUN.test(value.runId??''))next.runId=value.runId;
    if(CODE.test(value.code??'')){next.code=value.code;next.firstCode??=value.code;}
    if(CODE.test(value.providerFailureCode??''))next.providerFailureCode=value.providerFailureCode;
    if(CODE.test(value.stage??''))next.stage=value.stage;
    const manual=containment(value.manualContainment),parent=canonical(value.parentId??manual?.command.args.room);
    if(PARENT.test(parent??''))next.parentId=parent;
    if(manual)next.manualContainment=manual;
    if(lost){next.authorityRetired=true;next.cleanupVerified=false;delete next.manualContainment;}
    try{persist(next);return {updated:true,preserved:true};}
    catch{return {updated:true,preserved:false,code:'ATTENTION_ALERT_WRITE_FAILED'};}
  },status:()=>structuredClone(record)};
}
