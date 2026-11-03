// Offline source translation only. The caller separately proves ownership of
// the actual SDK and model generation; this adapter grants neither capability.
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {translateOfflineObservedSimulation} from '../observability/offline-observed-simulation.mjs';
import {boundAction} from '../planning/source.mjs';
import {digest,boardDigest} from '../planning/identity.mjs';
import {publishedSheetDigest} from '../simulation/observed-position.mjs';
import {canonicalEvidenceRoom} from '../showdown/evidence-room.mjs';
import {unpackToolResult} from '../showdown/operator-client.mjs';

const {Teams,Dex}=createRequire(import.meta.url)('pokemon-showdown'),adapters=new WeakMap();
const dex=Dex.forFormat('gen9championsvgc2026regmc'),id=value=>String(value??'').toLowerCase().replace(/[^a-z0-9]/gu,'');
const HASH=/^[a-f0-9]{64}$/u,copy=structuredClone;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const need=(ok,message)=>{if(!ok)throw Object.assign(new Error(`Observed model-tool qualification: ${message}`),{code:'MODEL_TOOL_OBSERVED_QUALIFICATION'});};
const sha=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>a!==undefined&&b!==undefined&&digest(a)===digest(b);
function stateCandidates(value,rows=[],depth=0,budget={nodes:0}){
  need(depth<=16&&++budget.nodes<=20000,'bounded archived source required');
  if(!object(value))return rows;
  if(typeof value.sessionId==='string'&&Array.isArray(value.actions)&&Array.isArray(value.boards))rows.push(value);
  // These are the maintained SDK publication wrappers, not a guessed menu.
  for(const key of ['payload','result','next','state','data'])if(object(value[key]))stateCandidates(value[key],rows,depth+1,budget);
  return rows;
}
async function verifyArchive(workspace,provenance,teamId,expectedState){
  need(object(provenance)&&provenance.kind==='retained-native-source'&&typeof provenance.archive==='string'&&typeof provenance.entryId==='string'&&
    ['archiveSha256','entrySha256','sourceStateSha256'].every(key=>HASH.test(provenance[key]??'')),'complete retained archive provenance required');
  const root=await realpath(workspace),path=resolve(root,provenance.archive),part=relative(root,path);
  need(part&&part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part),'archive must stay within its source workspace');
  const info=await lstat(path);need(info.isFile()&&!info.isSymbolicLink()&&info.size<=16*1024*1024,'bounded regular retained archive required');
  need(await realpath(path)===path,'retained archive cannot traverse a linked source');
  const bytes=await readFile(path);need(sha(bytes)===provenance.archiveSha256,'retained archive hash changed');
  const document=JSON.parse(gunzipSync(bytes,{maxOutputLength:32*1024*1024}));
  need(Array.isArray(document.entries)&&document.entries.length>0&&document.entries.length<=512,'bounded retained entry list required');
  const entries=document.entries.filter(row=>row.id===provenance.entryId);
  need(entries?.length===1&&typeof entries[0].contentUtf8==='string'&&sha(entries[0].contentUtf8)===provenance.entrySha256,'exact retained entry hash changed or is ambiguous');
  const matches=stateCandidates(JSON.parse(entries[0].contentUtf8)).filter(state=>digest(state)===provenance.sourceStateSha256);
  need(matches.length>=1,'retained entry lacks its declared complete native state');
  const archived=matches[0];need(archived.teamSha256===undefined||archived.teamSha256===teamId,'retained source team changed');
  if(expectedState)need(same({...copy(archived),teamSha256:teamId},expectedState),'supplied frozen state differs from its exact retained entry');
  return {state:copy(archived),entries:document.entries,declaredTeamId:document.teamId,proof:{kind:'verified-retained-archive-entry',archive:part.replaceAll('\\','/'),archiveSha256:provenance.archiveSha256,
    entryId:provenance.entryId,entrySha256:provenance.entrySha256,sourceStateSha256:provenance.sourceStateSha256,
    limitation:'Archive bytes and exact source state verified; historical origin remains the archive owner’s attribution.'}};
}
function verifiedSourceRegistration(archive,{foe,teamId,opponentSheet}){
  const sheet=archive.state.opponentSheets?.[foe];
  need(Array.isArray(sheet)&&sheet.length===6&&same(sheet,opponentSheet),'same-source published registration differs from the supplied opposing sheet');
  for(const value of [archive.declaredTeamId,archive.state.teamSha256,archive.state.teamId,archive.state.metrics?.teamId])
    need(value===undefined||value===teamId,'same-source published registration team attribution differs');
  let publishedOpposingSheetSha256;
  try{publishedOpposingSheetSha256=publishedSheetDigest(sheet);}catch{need(false,'same-source published registration is incomplete or invalid');}
  return {kind:'verified-same-source-native-published-registration',archive:archive.proof.archive,archiveSha256:archive.proof.archiveSha256,
    entryId:archive.proof.entryId,entrySha256:archive.proof.entrySha256,sourceStateSha256:archive.proof.sourceStateSha256,
    sourceField:`opponentSheets.${foe}`,publishedOpposingSheetSha256,originalRawStateUnchanged:true,
    limitation:'Exact published registration from the same verified archived state is carried into a separate reconstruction view. Historical origin remains the archive owner’s attribution; no selected reserves, lifecycle, investments, hypotheses or battle actions are supplied.'};
}
function verifiedPreviewRegistration(archive,reference,{original,team,teamId,opponentSheet}){
  need(object(reference)&&typeof reference.sourceEntryId==='string'&&reference.sourceEntryId.length>0&&reference.sourceEntryId.length<=200,
    'missing frozen opposing sheet requires an exact same-archive preview reference');
  need(reference.kind===undefined||reference.kind==='recorded-same-BO3-preview-registration','unsupported secondary registration provenance');
  need(reference.insertedIntoRawState!==true,'secondary registration must not be inserted into original raw state');
  need(reference.archive===undefined||reference.archive===archive.proof.archive,'secondary registration must use the same verified archive');
  need(reference.archiveSha256===undefined||reference.archiveSha256===archive.proof.archiveSha256,'secondary registration archive hash differs');
  const entries=archive.entries.filter(row=>row.id===reference.sourceEntryId);
  need(entries.length===1&&typeof entries[0].contentUtf8==='string','secondary preview entry is missing or ambiguous');
  const entry=entries[0],entrySha256=sha(entry.contentUtf8);
  for(const expected of [reference.sourceEntrySha256,reference.entrySha256,entry.originalFileSha256])
    need(expected===undefined||HASH.test(expected)&&expected===entrySha256,'secondary preview entry hash changed');
  const candidates=stateCandidates(JSON.parse(entry.contentUtf8)).filter(state=>state.actions.length===1&&state.boards.length===1&&
    state.actions[0]?.kind==='preview'&&state.actions[0]?.legalActions?.teamPreview===true);
  const unique=new Map(candidates.map(state=>[digest(state),state]));
  need(unique.size===1,'secondary entry must contain one unambiguous complete native preview');
  const preview=[...unique.values()][0],action=preview.actions[0],board=preview.boards[0],currentAction=original.actions[0],currentBoard=original.boards[0];
  need(preview.sessionId===original.sessionId,'secondary preview belongs to a different native client session');
  need(typeof action.parentId==='string'&&action.parentId===currentAction.parentId&&board.parentId===action.parentId,'secondary preview belongs to a different native BO3');
  need(board.room===action.room&&board.turn===0&&board.request?.rqid===action.rqid&&action.legalActions.maxChosenTeamSize===4,
    'secondary native preview/request identity is incomplete');
  need(board.ownSide===currentBoard.ownSide,'secondary preview own-side identity differs');
  for(const value of [archive.declaredTeamId,preview.teamSha256,preview.teamId,preview.metrics?.teamId])
    need(value===undefined||value===teamId,'secondary preview team attribution differs');
  const party=action.legalActions.pokemon,seen=new Set();
  need(Array.isArray(party)&&party.length===6,'secondary preview must retain the complete original own six');
  for(const pokemon of party){
    const species=pokemon.details?.split(',')[0],matches=team.filter(set=>dex.species.get(set.species).baseSpecies===dex.species.get(species).baseSpecies);
    need(matches.length===1&&!seen.has(matches[0]),'secondary preview own species differ from the locked team');
    const set=matches[0];seen.add(set);
    need(Array.isArray(pokemon.moves)&&same(pokemon.moves.map(id),set.moves.map(id))&&id(pokemon.ability)===id(set.ability)&&id(pokemon.item)===id(set.item),
      'secondary preview own moves, ability or item differ from the locked team');
  }
  const foe=board.ownSide==='p1'?'p2':'p1',sheet=board.opponentSheets?.[foe];
  need(Array.isArray(sheet)&&sheet.length===6&&same(sheet,opponentSheet),'secondary preview published registration differs from the supplied opposing sheet');
  return {kind:'verified-same-bo3-native-preview-registration',archive:archive.proof.archive,archiveSha256:archive.proof.archiveSha256,
    entryId:reference.sourceEntryId,entrySha256,sourceStateSha256:digest(preview),publishedOpposingSheetSha256:publishedSheetDigest(sheet),
    sameSessionVerified:true,sameTeamVerified:true,sameBo3Verified:true,originalRawStateUnchanged:true,
    limitation:'Only the actual recorded registration is carried into a separate reconstruction view. No selected reserves, lifecycle, investments, hypotheses or battle actions are supplied.'};
}
function verifyNativeStart(nativeEvidence,nativeStart,teamId,parentId){
  need(object(nativeEvidence)&&nativeEvidence.teamId===teamId&&nativeEvidence.parentId===parentId&&nativeEvidence.modelUsed===false,'exact native bootstrap evidence required');
  const records=nativeEvidence.runner?.numericCalls?.filter(row=>row.name==='simulate_turn'&&row.outcome==='completed');
  need(records?.length>=1,'completed frozen native bootstrap required');
  const record=records[0],value=unpackToolResult(record.result);
  need(record.nativeReceipt?.transport==='runner-owned-sdk-stdio'&&record.nativeReceipt.inputSha256===digest(record.input)&&record.nativeReceipt.resultSha256===digest(record.result)&&
    record.sourceValidation?.status==='revalidated','native bootstrap input/result receipts changed');
  need(value.engine?.gen===0&&value.engine.format==='gen9championsvgc2026regmc'&&value.source?.kind==='explicit-offline-snapshot'&&value.source.liveFreshness===false&&!value.calculationRef,
    'native bootstrap must remain an explicit offline M-C result');
  need(nativeStart&&same(value.samples?.[0]?.start,nativeStart),'nativeStart differs from its actual frozen MCP sample');
  return {kind:'verified-native-bootstrap-start',inputSha256:record.nativeReceipt.inputSha256,resultSha256:record.nativeReceipt.resultSha256,nativeStartSha256:digest(nativeStart),
    limitation:'Frozen owned-SDK journal verified with maintained receipt checks; caller independently proves the current SDK connection.'};
}
function verifyOwnNativeHp(state,nativeStart){
  const board=state.boards[0],side=board.sides.find(row=>row.id===board.ownSide),native=nativeStart.sides?.find(row=>row.id===board.ownSide);
  need(side?.pokemon?.length===4&&native?.pokemon?.length===4,'complete own four/native start required');
  for(const pokemon of side.pokemon){const matches=native.pokemon.filter(row=>row.id===pokemon.id);
    need(matches.length===1&&pokemon.hp?.precision==='server-own-exact'&&pokemon.hp.current===matches[0].hp&&pokemon.hp.max===matches[0].maxhp,'constructed own HP differs from its actual native bootstrap');}
}
function currentSource(state,source){
  need(state.actions.length===1&&state.boards.length===1,'one complete frozen native request required');
  const {action,board}=boundAction(state,source);
  need(action.kind==='turn'&&board.request?.rqid===action.rqid,'exact normal native turn/legality required');
  return {action,board};
}

function retainedReceipt(adapter,result){
  if(!object(result))return null;const proof=adapters.get(adapter)?.receipts.get(result);
  try{return proof&&proof.nativeResultSha256===digest(result)?proof:null;}catch{return null;}
}
export function hasModelToolObservedQualificationReceipt(adapter,result){return retainedReceipt(adapter,result)!==null;}

export async function createModelToolObservedQualificationAdapter({workspace=process.cwd(),state,ownTeamText,opponentSheet,provenance,nativeStart,nativeEvidence,now=Date.now}={}){
  need(object(state)&&typeof state.sessionId==='string'&&state.actions?.length===1&&state.boards?.length===1&&HASH.test(state.teamSha256??''),'complete original frozen state and team required');
  need(typeof ownTeamText==='string'&&Buffer.byteLength(ownTeamText)<=16000&&typeof now==='function','bounded exact team export and clock required');
  const team=Teams.import(ownTeamText);need(team?.length===6&&sha(Teams.pack(team))===state.teamSha256,'locked team export hash changed');
  const original=copy(state),action=original.actions[0],source={sessionId:original.sessionId,teamId:original.teamSha256,room:action.room,rqid:action.rqid,token:action.token};
  need(HASH.test(action.token??'')&&Number.isInteger(action.rqid)&&action.actionable!==false&&!['sent','uncertain','accepted','execution-observed'].includes(action.submissionStatus),
    'original request is incomplete or reserved');
  need(!(original.controlPolicy?.pending??[]).some(row=>row.token===action.token&&row.attempted),'original source already has a send reservation');
  const frozen=copy(original);
  // Archive clocks cannot be live clocks. Only the control countdown is removed;
  // the caller's fresh absolute deadline bounds every translation and SDK call.
  if(frozen.controlPolicy)frozen.controlPolicy={...frozen.controlPolicy,pending:[]};
  const {board}=currentSource(frozen,source),foe=board.ownSide==='p1'?'p2':'p1';
  need(Array.isArray(opponentSheet)&&opponentSheet.length===6,'complete exact frozen opposing sheet required');
  const embedded=object(board.opponentSheets)&&Object.hasOwn(board.opponentSheets,foe),
    sourcePublished=object(original.opponentSheets)&&Object.hasOwn(original.opponentSheets,foe);
  if(sourcePublished)need(Array.isArray(original.opponentSheets[foe])&&original.opponentSheets[foe].length===6&&same(original.opponentSheets[foe],opponentSheet),
    'same-source published registration conflicts with supplied opposing sheet');
  if(embedded)need(same(board.opponentSheets[foe],opponentSheet),'embedded frozen opposing sheet conflicts with supplied registration');
  else need(provenance?.kind==='retained-native-source'&&(sourcePublished||typeof provenance.sheetContext?.sourceEntryId==='string'),
    'complete exact frozen opposing sheet, same-source published registration or same-archive preview provenance required');
  let sourceProof,sourceKind,registrationProof=null;
  if(provenance?.kind==='retained-native-source'){
    const archive=await verifyArchive(workspace,provenance,state.teamSha256,original);
    sourceProof=archive.proof;sourceKind='retained-native-source';
    if(sourcePublished)registrationProof=verifiedSourceRegistration(archive,{foe,teamId:state.teamSha256,opponentSheet});
    else if(!embedded)registrationProof=verifiedPreviewRegistration(archive,provenance.sheetContext,{original,team,teamId:state.teamSha256,opponentSheet});
  }else{
    need(provenance?.constructedOpening===true&&provenance.savedBoardUsed===false&&provenance.ownHp==='actual-native-bootstrap-start','unsupported frozen source provenance');
    sourceProof=verifyNativeStart(nativeEvidence,nativeStart,state.teamSha256,action.parentId);verifyOwnNativeHp(frozen,nativeStart);
    need(provenance.sourceRegistrationSha256===publishedSheetDigest(opponentSheet),'constructed source registration digest changed');
    const registration=await verifyArchive(workspace,provenance.source,state.teamSha256);
    const archivedBoard=registration.state.boards?.find(row=>row.room===registration.state.actions?.[0]?.room),archivedFoe=archivedBoard?.ownSide==='p1'?'p2':'p1';
    need(same(archivedBoard?.opponentSheets?.[archivedFoe],opponentSheet),'constructed registration differs from retained native source');
    sourceProof={...sourceProof,registration:registration.proof};sourceKind='constructed-opening-from-verified-native-start';
  }
  const reconstruction=copy(frozen);
  if(registrationProof)reconstruction.boards[0].opponentSheets={...(reconstruction.boards[0].opponentSheets??{}),[foe]:copy(opponentSheet)};
  const reconstructionViewSha256=digest(reconstruction),frozenSourceSha256=digest(original),sourceFingerprint=digest({source,boardHash:boardDigest(board,action.legalActions),opposingSheetSha256:publishedSheetDigest(opponentSheet),teamSha256:state.teamSha256}),receipts=new WeakMap(),journal=[];
  const adapter={
    receipt(result){const proof=retainedReceipt(adapter,result);return proof?copy(proof):null;},
    status(){return {kind:'model-tool-observed-qualification-adapter',sourceKind,frozenSourceSha256,sourceFingerprint,reconstructionViewSha256,
      registrationSource:registrationProof?copy(registrationProof):{kind:'embedded-frozen-board'},provenanceVerified:true,
      executed:journal.length,journal:copy(journal),nativeSdkVerified:false,liveFreshness:false,serverAcceptance:false};},
    async execute({name,args,signal,deadlineAt,callNative}={}){
      need(['simulate_turn','battle_check_plan'].includes(name)&&typeof callNative==='function'&&object(args)&&args.request?.kind==='observed','model-authored observed simulation only');
      need(Number.isFinite(deadlineAt)&&now()<deadlineAt&&!signal?.aborted,'original offline simulation deadline unavailable');
      need(['sessionId','teamId','room','rqid','token'].every(key=>args.request.source?.[key]===source[key]),'model tool source differs from its exact frozen request');
      const authored=copy(args),stripped=copy(args),context=stripped.evidenceContext;
      if(context!==undefined){need(name==='simulate_turn'&&context.teamId===source.teamId&&context.roomId===canonicalEvidenceRoom(source.room)&&context.turn===board.turn&&
        Object.keys(context).every(key=>['teamId','roomId','turn'].includes(key)),'host-bound evidence metadata changed');delete stripped.evidenceContext;}
      const translated=translateOfflineObservedSimulation(name,stripped,{observed:reconstruction,teamText:ownTeamText,opposingSheet:opponentSheet});
      need(now()<deadlineAt&&!signal?.aborted,'original offline deadline elapsed during strict reconstruction');
      const entry={name,status:'pending',modelAuthoredHypotheses:true,authoredInput:authored,strippedInput:stripped,nativeInput:copy(translated.input),translation:copy(translated.translation),
        authoredInputSha256:digest(authored),strippedInputSha256:digest(stripped),nativeInputSha256:digest(translated.input),frozenSourceSha256,sourceFingerprint,startedAt:now(),deadlineAt};journal.push(entry);
      try{
        const result=await callNative({name,arguments:copy(translated.input)},undefined,{signal,timeout:Math.max(1,Math.floor(deadlineAt-now()))});
        entry.settledAt=now();entry.nativeResult=copy(result);entry.nativeResultSha256=digest(result);
        need(now()<deadlineAt&&!signal?.aborted,'native result missed its original offline deadline');
        const value=unpackToolResult(result);need(!result?.isError&&value?.ok!==false&&!value?.isError&&!value?.error,'native simulation refused or failed');
        if(name==='simulate_turn'){
          need(value.engine?.gen===0&&value.engine.format==='gen9championsvgc2026regmc'&&value.source?.kind==='explicit-offline-snapshot'&&value.source.liveFreshness===false&&!value.calculationRef,
            'native output must remain explicit offline evidence');
          need(same(value.submittedBranches,translated.input.request.branches)&&value.samples?.length===translated.input.request.branches.length*translated.input.request.seeds.length,
            'native output changed authored branches or omitted sample coverage');
          const seen=new Set(),request=translated.input.request;
          for(const sample of value.samples){const branch=request.branches.find(row=>row.id===sample.branchId),key=digest([sample.branchId,sample.seed]);
            need(branch&&request.seeds.some(seed=>same(seed,sample.seed))&&!seen.has(key)&&sample.accepted?.[request.position.ownSide]?.accepted===true,
              'native branch/seed coverage or paired acceptance differs');seen.add(key);}
        }else need(value.kind==='champions-delivery-check'||Array.isArray(value.checkedCandidates),'complete native delivery result required');
        entry.status='complete';
        const proof={version:1,kind:'model-tool-observed-offline-qualification-receipt',name,sourceKind,sourceFingerprint,frozenSourceSha256,reconstructionViewSha256,
          registrationSource:registrationProof?copy(registrationProof):{kind:'embedded-frozen-board'},
          provenanceVerified:true,sourceProvenanceVerified:true,readinessVerified:true,modelAuthoredHypotheses:true,sourceProof:copy(sourceProof),
          authoredInputSha256:entry.authoredInputSha256,strippedInputSha256:entry.strippedInputSha256,nativeInputSha256:entry.nativeInputSha256,nativeResultSha256:entry.nativeResultSha256,
          translation:copy(translated.translation),startedAt:entry.startedAt,settledAt:entry.settledAt,deadlineAt,evidenceWritten:false,nativeSdkVerified:false,
          liveFreshness:false,serverAcceptance:false,clockTreatment:'Only archived pending countdown removed; caller original fresh offline deadline unchanged.',
          limitation:'Strict observed-source reconstruction and returned native evidence validated; qualifying caller must independently verify actual owned SDK and model generation.'};
        receipts.set(result,proof);return result;
      }catch(error){entry.status='refused';entry.code=error?.code??'OBSERVED_NATIVE_FAILED';throw error;}
    },
  };
  adapters.set(adapter,{receipts,verifiedSource:{original:copy(original),reconstruction:copy(reconstruction),source:copy(source),sourceKind,
    sourceProof:copy(sourceProof),registrationProof:copy(registrationProof),frozenSourceSha256,reconstructionViewSha256,sourceFingerprint}});return Object.freeze(adapter);
}

/** Manager-only reuse of the maintained archive/registration verification.
 * Returned views grant neither a native SDK receipt nor live choice authority. */
export async function loadVerifiedSavedModelToolSource(options){
  const adapter=await createModelToolObservedQualificationAdapter(options);
  return copy(adapters.get(adapter).verifiedSource);
}
