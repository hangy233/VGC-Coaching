// Pure orchestration fakes. No model, authentication, MCP or battle is called.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runRunner,validateScopeConfiguration} from './runner.mjs';
import {digest} from '../planning/identity.mjs';

const TEAM='a'.repeat(64),PARENT='game-bestof3-gen9championsvgc2026regmcbo3-901',VERSION='ponder-runner-fixture';
const identity={version:1,sessionId:'ponder-runner',teamId:TEAM,account:'Fixture',teamFile:'unused-team.txt'};
const policy={enabled:true,forfeitIfStuck:false,emergencyDefaultChoice:false,planningMs:45000,previewPlanningMs:60000,unknownClockMs:20000,safetyMarginMs:5000};
const scope=()=>({version:1,authorization:'Explicit one-set fixture scope, no real allowance.',sessionId:identity.sessionId,teamId:TEAM,account:'Fixture',maxSets:1,allowSearch:true,allowGenerationProbe:true,allowPonder:true,manualReady:true,saveReplays:false,controlPolicy:policy});
const hash=text=>createHash('sha256').update(text).digest('hex');
const files=[{path:'SKILL.md',content:`Cycle revision: **${VERSION}**.\n`},{path:'references/headless-battle-cycle.md',content:'Fixture cycle.'}].map(file=>({...file,sha256:hash(file.content)}));
const folder=(()=>{const rows=[{path:'references',type:'directory'},...files.map(file=>({...file,type:'file'}))].sort((a,b)=>a.path<b.path?-1:1);return hash(rows.map(file=>`${file.type}:${Buffer.byteLength(file.path)}:${file.path}:${file.sha256??''}\n`).join(''));})();
const args=['--run','--provider','codex-cli','--model','gpt-6.1-sol','--reasoning-effort','low','--codex-context-mode','session','--codex-service-tier','fast','--session','unused-session.json','--scope','unused-scope.json'];
const workspaces=[];after(()=>Promise.all(workspaces.map(path=>rm(path,{recursive:true,force:true}))));
function fixture({allowPonder=true,failure=false,throwLoop=false,prepareFails=false,drainHangs=false}={}){
  const root=fileURLToPath(new URL('../cache/isolated-test-fixtures/',import.meta.url));mkdirSync(root,{recursive:true});const workspace=mkdtempSync(join(root,'ponder-runner-'));workspaces.push(workspace);
  const events=[];let ended=false,proof,ponderOptions,operatorOptions,controllerOptions;
  const native=()=>({sessionId:identity.sessionId,teamSha256:TEAM,username:'Fixture',connected:true,authenticated:true,stopped:false,authorizedSets:1,searchesSent:ended?1:0,autoReady:false,search:{games:null,searching:[]},actions:[],rooms:ended?[{id:PARENT,teamId:TEAM,ended:true,result:{type:'win',winner:'Fixture'}}]:[],controlPolicy:{...policy,halted:false},actionPlanPersistence:{pending:0,failures:0,dropped:0}});
  const ponder={async prepare(){events.push('ponder.prepare');if(prepareFails)throw Error('Fixture shadow unavailable');return{prepared:true};},observeState(){events.push('ponder.observe');},setMainBusy(){},setDecisionContext(){},notesFor(){return null;},stop(){events.push('ponder.stop');},async drain(options){events.push('ponder.drain');assert.equal(options.timeoutMs,250);return drainHangs?new Promise(()=>{}):{cleanupConfirmed:true};},status:()=>({closed:true,shadowModelPending:false,shadowClosePending:false,shadowPreflightPending:false,nativeCallsPending:0,core:{cleanupPending:0}}),privateEvidence:()=>{events.push('ponder.archive');return{kind:'private-frozen-ponder-journal',records:[],bytes:0,maxBytes:16*1024*1024,droppedByBound:0,complete:true};}};
  const operator={getGuidanceReadProof:({commandId})=>proof?.commandId===commandId?proof:null,async dispatch(q){
    events.push(q.op==='call'?q.name:q.op);
    if(q.op==='status'||q.op==='turn'){const value=native();operatorOptions.onState?.(value);return{result:value};}
    if(q.op==='start-next')return{result:{sent:true}};
    if(q.op==='arm')return{result:{armed:true}};
    if(q.op==='call'){
      if(q.name==='battle_skill_status')return{result:{synchronized:true,sourceSha256:folder,installedSha256:folder,files:files.length}};
      if(q.name==='battle_skill_read'){const value={skill:'champions-mc-matchups',synchronized:true,sourceSha256:folder,installedSha256:folder,files:files.length,filesRead:files,receiptExpiresAt:new Date(Date.now()+600000).toISOString()};
        proof={kind:'operator-retained-skill-read-proof',version:1,commandId:q.id,skill:value.skill,sourceSha256:folder,installedSha256:folder,files:files.length,deliverySha256:hash(JSON.stringify(files.map(f=>[f.path,f.sha256,Buffer.byteLength(f.content)]).sort(([a],[b])=>a<b?-1:1))),receiptExpiresAt:value.receiptExpiresAt,receiptRetained:true};return{result:value};}
      if(q.name==='battle_review_status')return{result:{teamId:TEAM,required:false,exists:false,parentId:null,complete:true,blockers:[]}};
      if(q.name==='battle_preflight')return{result:{ready:true,blockers:[]}};
      if(q.name==='team_metrics_sync_battles')return{result:{teamId:TEAM,recording:{state:'ready'}}};
      return{result:{ok:true}};
    }
    throw Error('Unexpected fixture '+q.op);
  }};
  const selectedScope=scope();if(allowPonder===undefined)delete selectedScope.allowPonder;else selectedScope.allowPonder=allowPonder;
  const dependencies={workspace,write(){},configurationReader:async()=>({identity,scope:selectedScope,ownTeamText:'Unused fixture team'}),apiLoader:()=>assert.fail('No API fallback'),
    codexProviderFactory:async options=>({contextMode:'session',decisionProvider:{kind:'codex-cli',model:options.model,reasoningEffort:options.reasoningEffort,callDecision:()=>assert.fail('No fixture model')},preflight:async()=>{events.push('main.preflight');return{authMode:'chatgpt',contextMode:'session'};},reset:async()=>{events.push('main.reset');},close:async()=>{events.push('main.close');}}),
    qualifyCodex:async({decisionProvider})=>({qualified:true,providerKind:'codex-cli',requestedModel:decisionProvider.model,reasoningEffort:decisionProvider.reasoningEffort,authenticationMethod:'chatgpt',generationObserved:true,savedPositionQualified:true,decisionMode:'model-tools',modelToolWorkflowQualified:true,modelRequestedMcpQualified:true,pairedSimulationQualified:true,liveObservedSimulationQualified:true,rangeWorkflowQualified:true,teamId:TEAM,contextMode:'session',sessionContinuityQualified:true}),
    // Trusted dependency fakes exercise orchestration only, never admission proof.
    qualifyPonder:async({decisionProvider,mainQualification})=>{events.push('ponder.qualify');assert.equal(decisionProvider.model,'gpt-6.1-sol');assert.equal(mainQualification.qualified,true);return{qualified:true,teamId:TEAM};},
    verifyPonderQualification:async(_provider,result)=>{events.push('ponder.verify');return result.qualified===true;},
    verifyPolicy:()=>({verified:true,skillVersion:VERSION,skillSha256:folder}),connect:async()=>({client:{async close(){events.push('sdk.close');}}}),
    timingFactory:async()=>({recorder:{run:(_meta,fn)=>fn(),event(){}},async flush(){events.push('timing.flush');},async close(){events.push('timing.close');},status:()=>({})}),
    ponderRuntimeFactory:options=>{events.push('ponder.construct');ponderOptions=options;return ponder;},
    operatorFactory:options=>{operatorOptions=options;return operator;},
    controllerFactory:options=>{controllerOptions=options;return{async initialize(){events.push('controller.initialize');},async runSet(){events.push('controller.run');if(throwLoop)throw Error('Fixture loop exception');if(failure)return{status:'decision-unavailable',parentId:PARENT};ended=true;return{status:'review-required',parentId:PARENT};},status:()=>({parentId:PARENT})};},
    attentionHandler:async()=>{events.push('attention');assert(events.indexOf('ponder.stop')<events.indexOf('attention'));assert(events.indexOf('ponder.drain')<events.indexOf('attention'));return{resolved:true};}};
  return{dependencies,events,ponder,workspace,get ponderOptions(){return ponderOptions;},get operatorOptions(){return operatorOptions;},get controllerOptions(){return controllerOptions;}};
}

test('ponder scope is boolean and defaults false without changing old scope permission',()=>{
  const old=scope();delete old.allowPonder;assert.equal(validateScopeConfiguration(old,identity).allowPonder,false);assert.equal(validateScopeConfiguration({...old,allowPonder:true},identity).allowPonder,true);
  assert.throws(()=>validateScopeConfiguration({...old,allowPonder:'true'},identity),{code:'configuration'});
});

test('explicit pondering prepares before live controller/search, receives native observations and shuts down before post-set review',async()=>{
  const f=fixture(),value=await runRunner(args,f.dependencies).catch(error=>{error.message+=' '+JSON.stringify(f.events);throw error;});assert.equal(value.state,'review-required');assert.equal(f.controllerOptions.background,f.ponder);assert.equal(f.controllerOptions.ponderRuntime,undefined);assert.equal(typeof f.operatorOptions.onState,'function');assert(f.events.includes('ponder.observe'));
  assert.equal(f.ponderOptions.mainDecisionProvider.kind,'codex-cli');assert.deepEqual(f.ponderOptions.profile,{provider:'codex-cli',model:'gpt-6.1-sol',reasoningEffort:'low',contextMode:'session',serviceTier:'fast'});
  assert.equal(f.operatorOptions.returnAfterModelSend,true);
  assert(f.events.indexOf('ponder.qualify')<f.events.indexOf('ponder.prepare'));assert(f.events.indexOf('ponder.verify')<f.events.indexOf('start-next'));
  assert(f.events.indexOf('ponder.prepare')<f.events.indexOf('controller.initialize'));assert(f.events.indexOf('ponder.prepare')<f.events.indexOf('start-next'));
  const stop=f.events.indexOf('ponder.stop');assert(stop>f.events.indexOf('controller.run'));assert(stop<f.events.indexOf('team_metrics_sync_battles'));assert.equal(f.events.filter(x=>x==='ponder.stop').length,1);assert.equal(f.events.filter(x=>x==='ponder.drain').length,1);
  assert.equal(value.ponderEvidence.preserved,true);assert(f.events.indexOf('ponder.archive')>f.events.indexOf('battle_control_release'));
  const saved=JSON.parse(await readFile(join(f.workspace,value.ponderEvidence.path),'utf8'));assert.equal(saved.entries.at(-1).phase,'ponder-analysis');assert.equal(saved.entries.at(-1).analysis.frozenOnly,true);assert.equal(saved.entries.at(-1).analysis.actualSDKReceiptsNotMinted,true);
  assert.equal(saved.entries.filter(row=>row.phase==='ponder-analysis').length,1);assert.equal(f.events.filter(value=>value==='ponder.archive').length,1);
});

test('legacy false scope creates no shadow and adds no operator/controller hooks',async()=>{
  const f=fixture({allowPonder:false}),value=await runRunner(args,f.dependencies);assert.equal(value.state,'review-required');assert(!f.events.includes('ponder.construct'));assert.equal(f.operatorOptions.onState,undefined);assert.equal(f.operatorOptions.returnAfterModelSend,false);assert.equal(f.controllerOptions.background,undefined);
});

test('failed shadow preparation cannot search and is stopped before idle SDK cleanup',async()=>{
  const f=fixture({prepareFails:true});await assert.rejects(runRunner(args,f.dependencies));assert(!f.events.includes('start-next'));assert(!f.events.includes('controller.run'));assert(f.events.indexOf('ponder.stop')<f.events.indexOf('sdk.close'));assert.equal(f.events.filter(x=>x==='ponder.stop').length,1);
});

test('returned or thrown loop failures stop pondering before retained attention without another search',async()=>{
  for(const options of [{failure:true},{throwLoop:true}]){const f=fixture(options),value=await runRunner(args,f.dependencies);assert.equal(value.state,'attention-resolved');assert.equal(f.events.filter(x=>x==='start-next').length,1);assert.equal(f.events.filter(x=>x==='ponder.stop').length,1);assert(f.events.indexOf('ponder.drain')<f.events.indexOf('attention'));assert(!f.events.includes('ponder.archive'));}
});

function populatedJournal(){
  const frozenSource={sessionId:identity.sessionId,teamId:TEAM,room:'battle-gen9championsvgc2026regmcbo3-902',rqid:1,token:'b'.repeat(64)},authoredArguments={species:'Pikachu'},input={...authoredArguments,gen:0},nativeResult={structuredContent:{name:'Pikachu',fixtureOnly:true}},modelResult=structuredClone(nativeResult);
  const record={name:'get_pokemon',source:{sessionId:identity.sessionId,teamId:TEAM,parentId:PARENT,gameId:frozenSource.room,sourceSha256:'c'.repeat(64)},frozenSource,sourceSha256:'c'.repeat(64),factsSha256:'d'.repeat(64),turn:1,freezeId:'00000000-0000-4000-8000-000000000003',analysis:'frozen',evidenceScope:'frozen-pre-submission-only',liveFreshness:false,choiceAuthority:false,startedAt:1000,deadlineAt:2000,settledAt:1500,inputSha256:digest(input),authoredArgumentsSha256:digest(authoredArguments),nativeResultSha256:digest(nativeResult),modelResultSha256:digest(modelResult),timely:true,outcome:'returned',authoredArguments,input,nativeResult,modelResult};
  return {kind:'private-frozen-ponder-journal',records:[record],bytes:Buffer.byteLength(JSON.stringify(record)),maxBytes:16*1024*1024,droppedByBound:0,complete:true};
}

test('verified native attention stop preserves populated frozen work once, after recovery and before process cleanup',async()=>{
  const f=fixture({failure:true}),journal=populatedJournal();let stopProven=false;
  f.ponder.privateEvidence=()=>{assert.equal(stopProven,true,'No journal work before attention resolves');f.events.push('ponder.archive');return journal;};
  f.dependencies.attentionHandler=async()=>{f.events.push('attention');assert(!f.events.includes('ponder.archive'));stopProven=true;return{resolved:true,clientStopped:true};};
  const result=await runRunner(args,f.dependencies);assert.equal(result.state,'attention-resolved');assert.equal(result.clientStopped,true);assert.equal(result.ponderEvidence.preserved,true);
  const saved=JSON.parse(await readFile(join(f.workspace,result.ponderEvidence.path),'utf8')),rows=saved.entries.filter(e=>e.phase==='ponder-analysis');assert.equal(rows.length,1);assert.equal(rows[0].binding.parentId,PARENT);assert.equal(rows[0].analysis.journal.records.length,1);assert.equal(rows[0].analysis.noCurrentAuthority,true);assert.equal(rows[0].analysis.actualSDKReceiptsNotMinted,true);assert.equal(rows[0].analysis.completeAtCapture,true);
  assert.equal(rows[0].analysis.journal.records[0].storedNativeResultSha256,digest(rows[0].analysis.journal.records[0].nativeResult));assert.equal(f.events.filter(e=>e==='ponder.archive').length,1);assert(f.events.indexOf('ponder.archive')>f.events.indexOf('attention'));assert(f.events.indexOf('ponder.archive')<f.events.indexOf('sdk.close'));assert.equal(f.events.filter(e=>e==='start-next').length,1);
});

test('verified stop preserves an empty journal, without inventing completed pending work',async()=>{
  for(const pending of [false,true]){
    const resolution={resolved:true,clientStopped:true};
    const f=fixture({failure:true});f.dependencies.attentionHandler=async handles=>{assert.equal(handles.failure.liveOwnershipRetained,true);assert.equal(handles.failure.affectedParentId,PARENT);f.events.push('attention');return resolution;};
    if(pending)f.ponder.status=()=>({closed:true,shadowModelPending:false,shadowClosePending:true,shadowPreflightPending:false,nativeCallsPending:1,core:{cleanupPending:1}});
    const result=await runRunner(args,f.dependencies);assert.equal(result.ponderEvidence.preserved,true);const saved=JSON.parse(await readFile(join(f.workspace,result.ponderEvidence.path),'utf8')),analysis=saved.entries[0].analysis;
    assert.deepEqual(analysis.journal.records,[]);assert.equal(analysis.completeAtCapture,!pending);assert.equal(analysis.noCurrentAuthority,true);assert.equal(f.events.filter(e=>e==='ponder.archive').length,1);assert(f.events.indexOf('ponder.archive')>f.events.indexOf('attention'));
  }
});

test('retired owner defers its journal instead of racing a successor shared-trace writer',async()=>{
  const f=fixture({failure:true}),path=join(f.workspace,'cache','bo3-runs',PARENT,'isolated-model-trace.json'),successorBytes='Synthetic successor-owned trace bytes; old owner must not read or replace them.';
  f.ponder.privateEvidence=()=>assert.fail('Retired owner cannot append the shared trace');
  f.dependencies.attentionHandler=async handles=>{assert.equal(handles.failure.affectedParentId,PARENT);f.events.push('attention');await mkdir(join(f.workspace,'cache','bo3-runs',PARENT),{recursive:true});await writeFile(path,successorBytes);return{resolved:true,ownershipLost:true};};
  const result=await runRunner(args,f.dependencies);assert.equal(result.state,'attention-ownership-lost');assert.equal(result.ownershipLost,true);assert.equal(result.operatorRetained,false);assert.equal(result.clientStopped,false);assert.equal(result.reservationsPreserved,true);
  assert.deepEqual(result.ponderEvidence,{preserved:false,deferred:true,code:'PONDER_ARCHIVAL_DEFERRED_OWNERSHIP_RETIRED'});assert.equal(await readFile(path,'utf8'),successorBytes);assert(!f.events.includes('ponder.archive'));assert(!f.events.includes('battle_stop'));assert(f.events.includes('sdk.close'));
});

test('unresolved attention and unproven generic resolution do not start optional archival ahead of live control',async()=>{
  for(const resolution of [{resolved:false},{resolved:true}]){
    const f=fixture({failure:true});f.ponder.privateEvidence=()=>assert.fail('No verified stop or authority retirement');f.dependencies.attentionHandler=async()=>{f.events.push('attention');return resolution;};
    const result=await runRunner(args,f.dependencies);assert.equal(result.ponderEvidence,undefined);assert.equal(f.events.filter(e=>e==='start-next').length,1);if(!resolution.resolved)assert(!f.events.includes('sdk.close'));
  }
});

test('post-attention invalid journal and unwritable destination remain explicit failures without delaying verified shutdown',async()=>{
  for(const blocked of [false,true]){
    const f=fixture({failure:true});
    if(!blocked)f.ponder.privateEvidence=()=>({kind:'invalid-private-journal'});
    f.dependencies.attentionHandler=async()=>{f.events.push('attention');if(blocked){await mkdir(join(f.workspace,'cache','bo3-runs'),{recursive:true});await writeFile(join(f.workspace,'cache','bo3-runs',PARENT),'Synthetic blocked archive directory');}return{resolved:true,clientStopped:true};};
    const result=await runRunner(args,f.dependencies);assert.equal(result.state,'attention-resolved');assert.equal(result.clientStopped,true);assert.equal(result.ponderEvidence.preserved,false);assert.equal(result.ponderEvidence.code,'PONDER_ARCHIVAL_FAILED');assert.equal(result.modelEvidence.failed,true);assert(f.events.includes('sdk.close'));assert(f.events.includes('main.close'));assert.equal(f.events.filter(e=>e==='start-next').length,1);
    if(!blocked){assert.equal(result.ponderEvidence.failureDiagnostic.preserved,true);assert.equal(result.ponderEvidence.failureDiagnostic.validated,false);assert.equal(result.ponderEvidence.failureDiagnostic.choiceAuthority,false);}
  }
});

test('verified attention stop without a bound affected parent creates no orphan journal file',async()=>{
  const f=fixture({failure:true});f.dependencies.controllerFactory=()=>({async initialize(){},async runSet(){return{status:'decision-unavailable'};},status:()=>({})});f.dependencies.attentionHandler=async()=>({resolved:true,clientStopped:true});f.ponder.privateEvidence=()=>assert.fail('Unknown parent cannot own a journal');
  const result=await runRunner(args,f.dependencies);assert.equal(result.ponderEvidence.preserved,false);assert.equal(result.ponderEvidence.code,'PONDER_PARENT_UNAVAILABLE');assert.equal(result.modelEvidence.path,null);assert(f.events.includes('sdk.close'));
});

test('a hung optional cleanup stays bounded before attention',async()=>{
  const f=fixture({failure:true,drainHangs:true}),began=Date.now();assert.equal((await runRunner(args,f.dependencies)).state,'attention-resolved');assert(Date.now()-began<2000);assert(f.events.includes('attention'));
});

test('post-result journal failure is explicit without claiming preservation or reopening the set',async()=>{
  const f=fixture();f.ponder.privateEvidence=()=>({kind:'invalid-private-journal'});const result=await runRunner(args,f.dependencies);
  assert.equal(result.state,'review-required');assert.equal(result.ponderEvidence.preserved,false);assert.equal(result.ponderEvidence.code,'PONDER_ARCHIVAL_FAILED');assert.equal(result.ponderEvidence.failureDiagnostic.validated,false);assert.equal(result.ponderEvidence.failureDiagnostic.choiceAuthority,false);assert.equal(result.modelEvidence.failed,true);assert.equal(f.events.filter(value=>value==='start-next').length,1);assert(!f.events.includes('attention'));
});

test('opt-in defaults fail closed for missing qualification or copied JSON without a genuine opaque receipt',async()=>{
  const missing=fixture();delete missing.dependencies.qualifyPonder;await assert.rejects(runRunner(args,missing.dependencies),{code:'provider_configuration'});assert(!missing.events.includes('main.preflight'));assert(!missing.events.includes('start-next'));
  const copied=fixture();delete copied.dependencies.verifyPonderQualification;await assert.rejects(runRunner(args,copied.dependencies),{code:'generation_unavailable'});assert(copied.events.includes('ponder.qualify'));assert(!copied.events.includes('ponder.prepare'));assert(!copied.events.includes('start-next'));assert(copied.events.includes('sdk.close'));
});

test('pondering rejects another effort, model, tier or provider before native connection/preflight',async()=>{
  for(const [field,replacement]of [['--reasoning-effort','medium'],['--model','gpt-6-luna'],['--codex-service-tier','standard']]){
    const f=fixture(),changed=[...args];changed[changed.indexOf(field)+1]=replacement;f.dependencies.connect=()=>assert.fail('No native connection for an unsupported pondering profile');await assert.rejects(runRunner(changed,f.dependencies),{code:'provider_configuration'});assert(!f.events.includes('main.preflight'));assert(!f.events.includes('ponder.construct'));
  }
});
