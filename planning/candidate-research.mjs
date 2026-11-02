// Prepare existing research references only. No numerical engine, source reader,
// native executor or choice sender is owned by this presentation helper.
import {isDeepStrictEqual} from 'node:util';
import {championsDex} from './board.mjs';
import {validateChoice} from '../showdown/choice-validation.mjs';
import {requestDigest,boardDigest,digest} from './identity.mjs';
import {projectCandidateEvidenceRows} from './candidate-evidence.mjs';

export const CANDIDATE_RESEARCH_MAX_BYTES=3072;
const LIMITS='Preparation references only; no calculations, delivery/removal, usefulness, staging or execution credit. Unknown inputs remain unknown. Resolve current catalog IDs before execution.';
const HASH=/^[a-f0-9]{64}$/u,CATALOG=/^catalog-[a-f0-9]{24}$/u,RESEARCH=/^research-[a-f0-9]{24}$/u;
const STATUSES=new Set(['prepared','partial','unprepared','not-needed']);
const QUESTION_STATUSES=new Set(['unprepared','ready','unavailable','ambiguous','missing']);
const PROTECT=new Set(['protect','detect','kingsshield','spikyshield','banefulbunker','obstruct','silktrap','burningbulwark']);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const copy=v=>structuredClone(v),bytes=v=>Buffer.byteLength(JSON.stringify(v));
const identifier=v=>typeof v==='string'&&v.length>0&&v.length<=200;
const semantic=source=>Object.fromEntries(Object.entries(source??{}).filter(([key])=>!['observedAt','liveFreshness'].includes(key)));
const exact=(v,keys)=>plain(v)&&Object.keys(v).every(k=>keys.includes(k));
const action=v=>exact(v,['type','slot','target','mega','pokemonId'])&&(
  v.type==='move'&&Number.isInteger(v.slot)&&v.slot>=1&&v.slot<=24&&v.pokemonId===undefined&&
    (v.target===undefined||[-2,-1,1,2].includes(v.target))&&(v.mega===undefined||typeof v.mega==='boolean')||
  v.type==='switch'&&v.target===undefined&&v.mega===undefined&&((Number.isInteger(v.slot)&&v.slot>=1&&v.slot<=24&&v.pokemonId===undefined)||(identifier(v.pokemonId)&&v.slot===undefined))||
  v.type==='pass'&&Object.keys(v).length===1);
const pair=v=>Array.isArray(v)&&v.length===2&&v.every(action);
const selector=v=>exact(v,['kind','scenarioId','attackerId','defenderId','move','route'])&&v.scenarioId==='observed'&&(
  v.kind==='move-order'&&Object.keys(v).length===2||v.kind==='damage-range'&&Object.keys(v).length===6&&
    [v.attackerId,v.defenderId,v.move].every(identifier)&&v.route==='active');
const unique=values=>[...new Set(values)];
const key=v=>JSON.stringify(v);
function activeActorIds(actors){
  if(!Array.isArray(actors)||actors.length>24)return;
  const current=actors.filter(a=>a&&[1,2].includes(a.slot));
  if(!current.length||current.length>4||current.some(a=>!identifier(a.id)||typeof a.own!=='boolean')||new Set(current.map(a=>a.id)).size!==current.length||
    new Set(current.map(a=>`${a.own}:${a.slot}`)).size!==current.length)return;
  return current.map(a=>a.id);
}
function orderCoverage(actorIds,requestedActorIds){
  const covered=requestedActorIds.filter(id=>actorIds.includes(id)).length;
  return {requestedActorIds:copy(requestedActorIds),status:covered<2?'irrelevant':covered===requestedActorIds.length?'complete':'partial'};
}
const usable=q=>q?.status==='ready'&&q.orderCoverage?.status!=='irrelevant';

function validSource(value){
  if(!plain(value)||bytes(value)>8192||!HASH.test(value.boardHash??'')||!HASH.test(value.opposingSheetSha256??''))return false;
  if(value.kind==='explicit-hypothetical-snapshot')return identifier(value.label);
  return value.kind==='bound-observed-turn'&&identifier(value.sessionId)&&HASH.test(value.teamId??'')&&
    identifier(value.room)&&Number.isInteger(value.rqid)&&HASH.test(value.requestDigest??'');
}
function matchesRequest(source,request){
  if(!plain(request))return false;
  if(source.kind==='bound-observed-turn')return request.kind==='observed'&&
    ['sessionId','teamId','room','rqid'].every(k=>source[k]===request[k])&&
    requestDigest({...request,boardHash:source.boardHash})===source.requestDigest;
  return request.kind==='explicit'&&request.label===source.label&&
    boardDigest(request.board,request.legalActions)===source.boardHash&&digest(request.opponentSheet)===source.opposingSheetSha256;
}
function candidateStatus(row,questions){
  const selected=row.questionRefs.map(ref=>questions.find(q=>q.ref===ref));
  const ids=unique(selected.filter(usable).map(q=>q.id));
  if(ids.length)row.ids=ids;else delete row.ids;
  row.status=row.omittedQuestions||row.unknowns?.length?(ids.length?'partial':'unprepared'):
    !selected.length?'not-needed':selected.every(q=>usable(q)&&(!q.orderCoverage||q.orderCoverage.status==='complete'))?'prepared':ids.length?'partial':'unprepared';
}
function finish(result){
  const update=()=>{
    for(const c of result.candidates)candidateStatus(c,result.questions);
    const hasIds=result.candidates.some(c=>c.ids?.length);
    if(!result.questions.some(q=>q.status==='ready'))delete result.catalogId;
    result.status=result.reason?'unprepared':result.candidates.length&&result.candidates.every(c=>c.status==='not-needed')?'not-needed':
      result.candidates.length&&result.candidates.every(c=>['prepared','not-needed'].includes(c.status))?'prepared':hasIds?'partial':'unprepared';
    result.coverage.preparedQuestions=result.questions.filter(q=>q.status==='ready').length;
    result.coverage.usableQuestions=result.questions.filter(usable).length;
    result.coverage.displayedQuestions=result.questions.length;
    result.coverage.candidateCount=result.candidates.length;
  };
  update();
  while(bytes(result)>CANDIDATE_RESEARCH_MAX_BYTES&&result.questions.length){
    const dropped=result.questions.pop();result.coverage.omittedQuestions++;
    for(const c of result.candidates)if(c.questionRefs.includes(dropped.ref)){
      c.questionRefs=c.questionRefs.filter(ref=>ref!==dropped.ref);c.omittedQuestions++;
    }
    update();
  }
  if(bytes(result)>CANDIDATE_RESEARCH_MAX_BYTES){
    delete result.source;delete result.catalogId;result.reason='projection-budget';
    for(const q of result.questions){q.status='unprepared';delete q.id;delete q.actorIds;delete q.orderCoverage;delete q.missingActors;}
    update();
  }
  while(bytes(result)>CANDIDATE_RESEARCH_MAX_BYTES&&result.candidates.length){result.candidates.pop();result.coverage.omittedCandidates++;update();}
  return result;
}
function initial(report){
  const candidates=Array.isArray(report?.candidates)?report.candidates:[];
  const rows=candidates.slice(0,3).filter(c=>plain(c)&&identifier(c.id)&&pair(c.actions));
  return {schemaVersion:1,kind:'candidate-research-references',status:'unprepared',questions:[],
    candidates:rows.map(c=>({candidateId:c.id,actions:copy(c.actions),questionRefs:[],status:'unprepared',omittedQuestions:0})),
    coverage:{candidateCount:rows.length,omittedCandidates:candidates.length-rows.length,requestedQuestions:0,displayedQuestions:0,omittedQuestions:0,preparedQuestions:0,usableQuestions:0},limits:LIMITS};
}
function completeDamage(evidence,focus){
  return (evidence?.payoff?.mechanical??[]).some(row=>row.status==='supported'&&
    Object.entries(focus).every(([key,value])=>key==='kind'||row[key]===value));
}
function completeOrder(report,evidence){
  const requested=activeActorIds(report.actors);if(!requested||requested.length<2)return false;
  return (evidence?.order??[]).some(row=>{
    if(row.status!=='supported'||row.scenarioId!=='observed')return false;
    const checks=(report.numericChecks?.checks??[]).filter(check=>check.id===row.ref?.checkId);
    const input=checks.length===1?checks[0].input:null,labels=input?.pokemon?.map(actor=>actor.label);
    // The shared projector verifies exact native receipts/current context. A
    // supported subset still cannot answer the requested active comparison.
    return Array.isArray(labels)&&unique(labels).length===labels.length&&requested.every(actorId=>labels.includes(actorId));
  });
}
function chooseQuestions(report,legalActions,result){
  const actors=report.actors??[],own=actors.filter(a=>a.own===true&&[1,2].includes(a.slot)),foes=actors.filter(a=>a.own===false&&[1,2].includes(a.slot));
  const preserved=new Set(report.objective?.preserve??[]),needs=new Map(result.candidates.map(c=>[c.candidateId,[]])),incoming=[];
  let evidence=[];
  try{evidence=projectCandidateEvidenceRows(report,{legalActions,maxCandidates:3,maxBytes:32768});}catch{/* Missing proof conservatively keeps the question. */}
  const exactEvidence=c=>evidence.find(row=>row.candidateId===c.candidateId&&isDeepStrictEqual(row.actions,c.actions));
  const add=(c,focus)=>{if(!completeDamage(exactEvidence(c),focus)&&!needs.get(c.candidateId).some(q=>key(q)===key(focus)))needs.get(c.candidateId).push(focus);};
  const request={...legalActions,side:{...(legalActions?.side??{}),pokemon:legalActions?.pokemon??legalActions?.side?.pokemon??[]}};
  for(const c of result.candidates){
    try{if(!isDeepStrictEqual(validateChoice(request,c.actions).actions,c.actions))throw Error('noncanonical');}
    catch{c.unknowns=['current-pair-legality-unavailable'];continue;}
    if(c.actions.some(a=>a.mega===true)){c.unknowns=['future-mega-form-or-field-unresolved'];continue;}
    let attacking=false;
    for(const [index,a]of c.actions.entries()){
      const actor=own.filter(v=>v.slot===index+1);
      if(actor.length!==1){c.unknowns=unique([...(c.unknowns??[]),'active-actor-unavailable']);continue;}
      if(a.type!=='move')continue;
      // Move slots belong to the current request, never actor.moves/sheet order.
      const legal=legalActions?.active?.[index]?.moves?.[a.slot-1],move=championsDex.moves.get(legal?.id??legal?.move??legal?.name??'');
      if(!legal||legal.disabled||legal.pp===0||!move.exists){c.unknowns=unique([...(c.unknowns??[]),'legal-move-slot-unavailable']);continue;}
      if(preserved.has(actor[0].id)&&!PROTECT.has(move.id)){
        const options=(report.numericChecks?.damage??[]).filter(r=>r.scenarioId==='observed'&&r.route==='active'&&r.defenderId===actor[0].id&&
          foes.some(f=>f.id===r.attackerId)&&identifier(r.move));
        const row=options[0];
        if(row){const focus={kind:'damage-range',scenarioId:'observed',attackerId:row.attackerId,defenderId:row.defenderId,move:row.move,route:'active'};add(c,focus);incoming.push(focus);}
        else c.unknowns=unique([...(c.unknowns??[]),'preserved-actor-incoming-question-unavailable']);
      }
      if(move.category==='Status')continue;
      attacking=true;
      const recipients=a.target>0?foes.filter(f=>f.slot===a.target):['allAdjacentFoes','allAdjacent','all'].includes(legal.target??move.target)?foes:[];
      if(!recipients.length){c.unknowns=unique([...(c.unknowns??[]),'selected-recipient-unavailable']);continue;}
      for(const target of recipients)add(c,{kind:'damage-range',scenarioId:'observed',attackerId:actor[0].id,defenderId:target.id,move:move.name,route:'active'});
    }
    if(attacking&&!completeOrder(report,exactEvidence(c)))needs.get(c.candidateId).unshift({kind:'move-order',scenarioId:'observed'});
  }
  // Preserve a named exposed actor first, then one shared order question and
  // round-robin outgoing questions. Never expand to a full simulation.
  const all=unique([...needs.values()].flat().map(key)),selected=[];
  const select=q=>{const k=key(q);if(selected.length<4&&all.includes(k)&&!selected.some(x=>key(x)===k))selected.push(q);};
  incoming.forEach(select);select({kind:'move-order',scenarioId:'observed'});
  for(let i=0;i<8&&selected.length<4;i++)for(const c of result.candidates){const q=needs.get(c.candidateId)[i];if(q)select(q);}
  result.questions=selected.map((focus,i)=>({ref:`q${i+1}`,focus,status:'unprepared'}));
  result.coverage.requestedQuestions=all.length;result.coverage.omittedQuestions=all.length-selected.length;
  for(const c of result.candidates){const wanted=needs.get(c.candidateId);c.questionRefs=result.questions.filter(q=>wanted.some(x=>key(x)===key(q.focus))).map(q=>q.ref);c.omittedQuestions=wanted.length-c.questionRefs.length;}
}

/** No calculators run here. prepareChecks must be the existing source-revalidating
 * research.prepare callback; a source echo or self-built ID is not authority. */
export async function prepareCandidateResearch(report,{legalActions,prepareChecks,request,hypotheses=[],budgetMs=0,signal}={}){
  const started=performance.now(),result=initial(report);
  try{
    if(report?.status!=='advisory'||!validSource(report.source)||!matchesRequest(report.source,request)){result.reason='current-source-unavailable';return finish(result);}
    if(!Array.isArray(report.actors)||report.actors.length>24||!Array.isArray(hypotheses)||hypotheses.length>3||
      (report.numericChecks?.damage?.length??0)>2048||(report.numericChecks?.checks?.length??0)>2048){result.reason='current-inputs-unavailable';return finish(result);}
    if(new Set(result.candidates.map(c=>c.candidateId)).size!==result.candidates.length){result.reason='ambiguous-candidate-identity';return finish(result);}
    chooseQuestions(report,legalActions,result);
    if(!result.questions.length)return finish(result);
    if(signal?.aborted){result.reason='cancelled';return finish(result);}
    if(typeof prepareChecks!=='function'){result.reason='preparation-callback-unavailable';return finish(result);}
    const remaining=Math.floor(Math.min(250,Number.isFinite(budgetMs)?Math.max(0,budgetMs):0)-(performance.now()-started));
    if(remaining<100){result.reason='insufficient-original-budget';return finish(result);}
    const controller=new AbortController();let timer,abort;
    try{
      const cancelled=new Promise((_,reject)=>{abort=()=>{controller.abort();reject(Error('cancelled'));};signal?.addEventListener('abort',abort,{once:true});});
      const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('preparation-late'));},remaining);});
      const input={request:copy(request),hypotheses:copy(hypotheses),focus:result.questions.map(q=>copy(q.focus)),budgetMs:remaining};
      const menu=await Promise.race([Promise.resolve().then(()=>prepareChecks(input,{signal:controller.signal})),cancelled,expired]);
      if(signal?.aborted)throw Error('cancelled');
      if(performance.now()-started>=Math.min(250,budgetMs))throw Error('preparation-late');
      if(!plain(menu)||bytes(menu)>16384||menu.kind!=='champions-research-menu'||menu.status!==undefined||
        !CATALOG.test(menu.catalogId??'')||menu.coverage?.calculationsRun!==0||!validSource(menu.source)||
        !isDeepStrictEqual(semantic(menu.source),semantic(report.source))||!Array.isArray(menu.focus)||menu.focus.length!==result.questions.length||!Array.isArray(menu.tickets)||menu.tickets.length>128)throw Error('current-preparation-unverified');
      const ticketIds=menu.tickets.map(t=>t.id);if(new Set(ticketIds).size!==ticketIds.length)throw Error('malformed-preparation');
      const requestedActorIds=activeActorIds(report.actors),knownActors=new Set(report.actors.map(a=>a.id));
      for(const [i,q]of result.questions.entries()){
        const f=menu.focus[i];
        if(!plain(f)||!isDeepStrictEqual(f.question,q.focus)||!['ready','unavailable','ambiguous','missing'].includes(f.status)||!Array.isArray(f.ids))throw Error('malformed-preparation');
        q.status=f.status;
        if(Number.isInteger(f.unavailableQuestions)&&f.unavailableQuestions>0)q.unavailableQuestions=f.unavailableQuestions;
        if(f.status==='ready'){
          const ticket=f.ids.length===1&&menu.tickets.find(t=>t.id===f.ids[0]);
          if(!ticket||!RESEARCH.test(ticket.id??'')||ticket.name!==(q.focus.kind==='move-order'?'calculate_speed':'calculate_damage')||!Array.isArray(ticket.questions)||
            ticket.questions.filter(t=>Object.entries(q.focus).every(([k,v])=>t[k]===v)).length!==1||f.unavailableQuestions!==0)throw Error('malformed-ready-focus');
          q.id=ticket.id;
          const question=ticket.questions.find(t=>Object.entries(q.focus).every(([k,v])=>t[k]===v));
          if(q.focus.kind==='move-order'){
            if(!requestedActorIds||!Array.isArray(question.actorIds)||question.actorIds.length<1||question.actorIds.length>6||
              !question.actorIds.every(id=>identifier(id)&&knownActors.has(id))||unique(question.actorIds).length!==question.actorIds.length)throw Error('malformed-order-coverage');
            q.actorIds=copy(question.actorIds);q.orderCoverage=orderCoverage(q.actorIds,requestedActorIds);
            if(question.missingActors!==undefined){
              if(!Array.isArray(question.missingActors)||question.missingActors.length>24||question.missingActors.some(a=>!identifier(a?.actorId)||!knownActors.has(a.actorId)||q.actorIds.includes(a.actorId))||unique(question.missingActors.map(a=>a.actorId)).length!==question.missingActors.length)throw Error('malformed-order-coverage');
              if(question.missingActors.length)q.missingActors=question.missingActors.map(a=>a.actorId);
            }
          }
        }
      }
      result.source=copy(semantic(menu.source));
      if(result.questions.some(q=>q.status==='ready'))result.catalogId=menu.catalogId;
      if(signal?.aborted)throw Error('cancelled');
      if(performance.now()-started>=Math.min(250,budgetMs))throw Error('preparation-late');
      return finish(result);
    }finally{clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);}
  }catch(error){
    result.reason=['cancelled','preparation-late'].includes(error?.message)?error.message:'preparation-unverified';
    delete result.source;delete result.catalogId;
    for(const q of result.questions){q.status='unprepared';delete q.id;delete q.actorIds;delete q.orderCoverage;delete q.missingActors;delete q.unavailableQuestions;}
    return finish(result);
  }
}

/** Structural/current-binding admission for cache/view use. This does not prove
 * that an ephemeral catalog still exists; the existing resolver remains final. */
export function projectCandidateResearchReferences(value,{source,candidates,actors}={}){
  try{
    if(!exact(value,['schemaVersion','kind','status','source','catalogId','questions','candidates','coverage','limits','reason'])||value.schemaVersion!==1||value.kind!=='candidate-research-references'||!STATUSES.has(value.status)||value.limits!==LIMITS||bytes(value)>CANDIDATE_RESEARCH_MAX_BYTES||!Array.isArray(value.questions)||value.questions.length>4||!Array.isArray(value.candidates)||value.candidates.length>3||
      !exact(value.coverage,['candidateCount','omittedCandidates','requestedQuestions','displayedQuestions','omittedQuestions','preparedQuestions','usableQuestions'])||
      !Object.values(value.coverage).every(n=>Number.isInteger(n)&&n>=0)||value.coverage.requestedQuestions>32||
      value.coverage.displayedQuestions!==value.questions.length||value.coverage.omittedQuestions!==value.coverage.requestedQuestions-value.questions.length||
      value.reason!==undefined&&!identifier(value.reason))return;
    if(value.source!==undefined&&(!validSource(value.source)||!isDeepStrictEqual(semantic(value.source),semantic(source))))return;
    if(value.catalogId!==undefined&&(!CATALOG.test(value.catalogId)||!value.source))return;
    const refs=new Set(),requestedActorIds=activeActorIds(actors),knownActors=new Set((actors??[]).map(a=>a.id));
    for(const q of value.questions){
      if(!exact(q,['ref','focus','status','id','unavailableQuestions','missingActors','actorIds','orderCoverage'])||!/^q[1-4]$/.test(q.ref)||refs.has(q.ref)||!selector(q.focus)||!QUESTION_STATUSES.has(q.status))return;
      refs.add(q.ref);if(q.status==='ready'?(!RESEARCH.test(q.id??'')||!value.catalogId):q.id!==undefined)return;
      if(q.unavailableQuestions!==undefined&&(!Number.isInteger(q.unavailableQuestions)||q.unavailableQuestions<1||q.status==='ready'))return;
      if(q.focus.kind==='move-order'&&q.status==='ready'){
        if(!requestedActorIds||!Array.isArray(q.actorIds)||q.actorIds.length<1||q.actorIds.length>6||!q.actorIds.every(id=>identifier(id)&&knownActors.has(id))||unique(q.actorIds).length!==q.actorIds.length||!isDeepStrictEqual(q.orderCoverage,orderCoverage(q.actorIds,requestedActorIds)))return;
        if(q.missingActors!==undefined&&(!Array.isArray(q.missingActors)||q.missingActors.length>24||q.missingActors.some(id=>!identifier(id)||!knownActors.has(id)||q.actorIds.includes(id))||unique(q.missingActors).length!==q.missingActors.length))return;
      }else if(q.actorIds!==undefined||q.orderCoverage!==undefined||q.missingActors!==undefined)return;
    }
    const seen=new Set();
    for(const c of value.candidates){
      if(!exact(c,['candidateId','actions','questionRefs','ids','status','omittedQuestions','unknowns'])||!identifier(c.candidateId)||seen.has(c.candidateId)||!pair(c.actions)||!STATUSES.has(c.status)||!Number.isInteger(c.omittedQuestions)||c.omittedQuestions<0||!Array.isArray(c.questionRefs)||new Set(c.questionRefs).size!==c.questionRefs.length||!c.questionRefs.every(r=>refs.has(r)))return;
      seen.add(c.candidateId);if((candidates??[]).filter(x=>x.id===c.candidateId&&isDeepStrictEqual(x.actions,c.actions)).length!==1)return;
      if(c.unknowns!==undefined&&(!Array.isArray(c.unknowns)||c.unknowns.length>6||!c.unknowns.every(identifier)))return;
      const expected=copy(c);candidateStatus(expected,value.questions);if(!isDeepStrictEqual(expected,c))return;
    }
    if(!value.questions.some(q=>q.status==='ready')&&value.catalogId!==undefined)return;
    if(!isDeepStrictEqual(finish(copy(value)),value))return;
    return copy(value);
  }catch{return;}
}
