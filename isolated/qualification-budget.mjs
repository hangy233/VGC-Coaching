// Pure posthoc journal accounting. It grants no provider/SDK/live receipt.
import {createHash} from 'node:crypto';
export const sha=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const NUMERIC=new Set(['calculate_damage','calculate_damage_range','calculate_speed']);
const STATIC=new Set(['get_pokemon','get_move','get_ability','get_movepool','get_type_effectiveness','search_item','search_ability']);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function invalidParameters(entry){
 const values=[entry.code,entry.result?.code,entry.result?.error?.code,entry.result?.structuredContent?.code,entry.result?.structuredContent?.error?.code];
 for(const c of entry.result?.content??[])if(c.type==='text'){try{const v=JSON.parse(c.text);values.push(v?.code,v?.error?.code);}catch{}}
 return values.some(v=>v===-32602||v==='-32602');
}
function rangeDispatches(entry){
 let value=entry.result;
 for(let i=0;i<10;i++){
  if(object(value)&&Number.isInteger(value.coverage?.dispatched)&&value.coverage.dispatched>=0)return {known:true,count:value.coverage.dispatched};
  if(object(value?.structuredContent)){value=value.structuredContent;continue;}
  if(object(value?.result)){value=value.result;continue;}
  const text=value?.content?.find?.(c=>c.type==='text')?.text;
  if(text){try{value=JSON.parse(text);continue;}catch{}}
  break;
 }
 return invalidParameters(entry)?{known:true,count:0,proof:'sdk-invalid-parameters--32602'}:{known:false};
}
export function frozenRequestCases(requests){
 if(!Array.isArray(requests)||requests.length<3)throw Error('Original complete saved cases required');
 return requests.map((r,i)=>{const state=r.state?.result??r.state,action=r.action??state?.actions?.find(a=>a.room===r.context?.binding?.room&&a.rqid===r.context?.binding?.rqid);if(!object(state)||!object(action))throw Error('Saved source/action missing');return {caseId:typeof r.caseId==='string'?r.caseId.slice(0,100):'saved-'+(i+1),sourceSha256:sha({state,action})};});
}
export function assessOfflineBudget({kind,result,requests,criteriaSha256,guardSha256}){
 const problems=[],cases=kind==='main'?frozenRequestCases(requests):result?.cases?.map(c=>({caseId:c.caseId}));
 if(!['main','shadow'].includes(kind)||!Array.isArray(cases)||!Array.isArray(result?.nativeJournal))return {kind:'offline-research-budget-conformance',conformant:false,problems:['Missing exact cases or actual native journal']};
 const ids=new Map(),sources=new Map();
 for(const c of cases){if(typeof c.caseId!=='string'||ids.has(c.caseId)||c.sourceSha256&&sources.has(c.sourceSha256))problems.push('Ambiguous case identity');ids.set(c.caseId,{...c,calculatorUnits:0,simulationDispatches:0,rows:[],problems:[]});if(c.sourceSha256)sources.set(c.sourceSha256,c.caseId);}
 if(kind==='main'){
  if(result.rows?.length!==cases.length)problems.push('Main returned case coverage differs');
  for(const c of cases)if(result.rows?.filter(r=>r.caseId===c.caseId&&r.sourceSha256===c.sourceSha256).length!==1)problems.push('Main source/case binding differs: '+c.caseId);
 }else if(cases.length!==2||!ids.has('complete-frozen-material')||!ids.has('preempt-during-frozen-tool'))problems.push('Shadow normal/preempt case coverage differs');
 for(const [index,entry]of result.nativeJournal.entries()){
  const id=kind==='main'?sources.get(entry.sourceSha256):entry.caseId,row=ids.get(id);
  if(!row||kind==='main'&&entry.caseId!==undefined&&entry.caseId!==id){problems.push('Unjoined native journal entry '+index);continue;}
  const record={index,name:entry.name,outcome:entry.outcome,inputSha256:entry.inputSha256??entry.argumentsSha256,resultSha256:entry.resultSha256};
  if(NUMERIC.has(entry.name)){
   record.outerCalculatorUnits=1;row.calculatorUnits++;
   if(entry.name==='calculate_damage_range'){
    const nested=rangeDispatches(entry);record.nestedDispatchCountKnown=nested.known;
    if(nested.known){record.nestedCalculatorUnits=nested.count;record.zeroInnerProof=nested.proof;row.calculatorUnits+=nested.count;}
    else row.problems.push('Unknown nested range dispatch count at journal '+index);
   }
  }else if(entry.name==='simulate_turn'){record.simulationDispatches=1;row.simulationDispatches++;}
  else if(!STATIC.has(entry.name))row.problems.push('Unrecognized native tool at journal '+index+': '+entry.name);
  row.rows.push(record);
 }
 for(const row of ids.values()){if(row.calculatorUnits>3)row.problems.push('Calculator units exceed3');if(row.simulationDispatches>1)row.problems.push('Simulation dispatches exceed1');}
 return {kind:'offline-research-budget-conformance',schemaVersion:1,qualificationCaseKind:kind,criteriaSha256,guardSha256,conformant:problems.length===0&&[...ids.values()].every(c=>c.problems.length===0),cases:[...ids.values()],problems,liveQuotaExercised:false,providerQualificationMinted:false,modelCallsByGuard:0,limits:'Additional posthoc actual-journal conformance. Genuine opaque provider qualification remains mandatory. No actual live quota, tactical result or original-clock extension is claimed.'};
}
