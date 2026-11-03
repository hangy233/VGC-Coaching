import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {PassThrough} from 'node:stream';
import {launchWorkflow,parseLaunchArgs,waitManagerGate} from './launch.mjs';
import {ISOLATED_POLICY_SOURCE} from './decision-context.mjs';
import {sha,assessOfflineBudget} from './qualification-budget.mjs';

const TEAM='a'.repeat(64),profile={model:'gpt-6.1-sol',reasoningEffort:'low',serviceTier:'fast',contextMode:'session'};
async function fixture(t){
  const root=resolve('cache');await mkdir(root,{recursive:true});
  const workspace=await mkdtemp(join(root,'vgc-cli-launch-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  const requests=[1,2,3].map(i=>({caseId:'saved-'+i,materialRequired:i===2,state:{actions:[],source:i},action:{room:'battle-fixture-'+i,rqid:i,token:'synthetic-source'}}));
  await writeFile(join(workspace,'requests.json'),JSON.stringify({kind:'saved-model-tool-qualification-requests',teamId:TEAM,skillSha256:ISOLATED_POLICY_SOURCE.skillSha256,profile,requests}));
  const options={mode:'qualify-only',requestFile:'requests.json',output:'cache/new-run'},events=[],closes=[];
  const main={qualified:true,compactChoiceSimulationQualified:true,rangeWorkflowQualified:true,rows:requests.map(row=>({caseId:row.caseId,sourceSha256:sha({state:row.state,action:row.action})})),nativeJournal:[]};
  const shadow={qualified:true,frozenRangeWorkflowQualified:true,cases:[{caseId:'complete-frozen-material'},{caseId:'preempt-during-frozen-tool'}],nativeJournal:[]};
  const provider={decisionProvider:{kind:'codex-cli',...profile,callDecision(){}},qualifyCodex:async args=>{events.push('main');assert.strictEqual(args.requests.length,3);return main;},close:async()=>closes.push(true)};
  const deps={workspace,write:value=>events.push(value.state),providerFactory:async args=>{assert.equal(args.contextMode,'session');assert.equal(args.model,profile.model);events.push('provider');return provider;},qualifyShadow:async args=>{assert.strictEqual(args.provider,provider);assert.strictEqual(args.mainQualification,main);events.push('shadow');return shadow;},verifyMain:(candidate,result)=>candidate===provider&&result===main,verifyShadow:async(candidate,result)=>candidate===provider&&result===shadow,sourcePins:async()=>({sha256:'b'.repeat(64),files:[]})};
  return {workspace,requests,options,events,closes,main,shadow,provider,deps};
}

test('public arguments expose only explicit offline qualification or one prepared live scope',()=>{
  assert.equal(parseLaunchArgs(['--qualify-only','--model-tool-qualification','manager/requests.json','--output','cache/new']).mode,'qualify-only');
  for(const args of [[],['--run','--output','cache/new'],['--qualify-only','--model-tool-qualification','x','--output','cache/new','--session','x'],['--run','--provider','openai-api']])assert.throws(()=>parseLaunchArgs(args),{code:'LAUNCH_ARGUMENTS'});
});
test('offline launcher holds both provider identities and the strict journal checks, never native control',async t=>{
  const f=await fixture(t),result=await launchWorkflow(f.options,{...f.deps,run:()=>assert.fail('Offline qualification cannot run a battle'),gate:()=>assert.fail('Offline needs no control gate')});
  assert.equal(result.battlesStarted,0);assert.deepEqual(f.closes,[true]);assert(f.events.indexOf('main')<f.events.indexOf('shadow'));
  const record=JSON.parse(await readFile(join(f.workspace,'cache/new-run/main-budget.json'),'utf8'));assert.equal(record.conformant,true);assert.equal(record.providerQualificationMinted,false);
});
test('copied successful JSON cannot satisfy the default opaque main or shadow verifier',async t=>{
  const f=await fixture(t);delete f.deps.verifyMain;await assert.rejects(launchWorkflow(f.options,f.deps),{code:'LAUNCH_MAIN_QUALIFICATION'});assert.deepEqual(f.closes,[true]);assert(!f.events.includes('shadow'));
});
test('a second actual simulation or nested range excess refuses before any live gate',async t=>{
  const f=await fixture(t),binding=f.main.rows[1];f.main.nativeJournal=[1,2].map(()=>({name:'simulate_turn',sourceSha256:binding.sourceSha256,outcome:'completed'}));
  await assert.rejects(launchWorkflow(f.options,{...f.deps,gate:()=>assert.fail('No live gate after budget failure')}),{code:'LAUNCH_MAIN_QUALIFICATION'});
  const numeric={...f.main,nativeJournal:[{name:'calculate_damage_range',sourceSha256:binding.sourceSha256,result:{coverage:{dispatched:3}}}]};
  const report=assessOfflineBudget({kind:'main',result:numeric,requests:f.requests});assert.equal(report.conformant,false);assert.equal(report.cases[1].calculatorUnits,4);
});
test('live input must be open and interactive before provider setup',async t=>{
  const f=await fixture(t);await assert.rejects(launchWorkflow({...f.options,mode:'run',session:'session.json',scope:'scope.json'},{...f.deps,input:{isTTY:false}}),{code:'LAUNCH_INPUT'});assert.deepEqual(f.events,[]);
});
test('both manager gates accept explicit cancellation and input closure without releasing the gate',async()=>{
  for(const expected of ['START_LIVE','START_SEARCH'])for(const reason of ['manager-cancelled','manager-input-closed']){
    const input=new PassThrough();input.isTTY=true;const messages=[],pending=waitManagerGate(expected,{input,output:{write:text=>messages.push(JSON.parse(text))}});
    if(reason==='manager-cancelled')input.write('CANCEL_LIVE\n');else input.end();
    assert.deepEqual(await pending,{cancelled:true,reason,gate:expected});assert.equal(messages[0].cancel,'CANCEL_LIVE');input.destroy();
  }
  for(const expected of ['START_LIVE','START_SEARCH']){
    assert.deepEqual(await waitManagerGate(expected,{input:{isTTY:true,readableEnded:true},output:{write(){}}}),{cancelled:true,reason:'manager-input-closed',gate:expected});
  }
  const input=new PassThrough();input.isTTY=true;
  const pending=waitManagerGate('START_SEARCH',{input,output:{write(){}}});input.write('wrong command\n');
  await assert.rejects(pending,{code:'LAUNCH_GATE'});input.destroy();
});
test('cancelling before live closes the qualified provider without opening native control',async t=>{
  for(const reason of ['manager-cancelled','manager-input-closed']){
    const f=await fixture(t),gates=[];
    const result=await launchWorkflow({...f.options,mode:'run',session:'session.json',scope:'scope.json'},{...f.deps,input:{isTTY:true},
      gate:async word=>{gates.push(word);return {cancelled:true,reason,gate:word};},run:()=>assert.fail('No runner on pre-live cancellation'),operatorFactory:()=>assert.fail('No native control')});
    assert.deepEqual(gates,['START_LIVE']);assert.equal(result.state,'cancelled-before-live');assert.equal(result.reason,reason);
    assert.equal(result.searchesAttempted,0);assert.equal(result.searchDispatched,false);assert.equal(result.nativeControlOpened,false);assert.deepEqual(f.closes,[true]);
    assert.deepEqual(JSON.parse(await readFile(join(f.workspace,'cache/new-run/live-result.json'),'utf8')),result);
    assert.equal(JSON.parse(await readFile(join(f.workspace,'cache/new-run/attention-alert.json'),'utf8')).active,false);
  }
});
test('one live launch gates source adoption and search, preserving the same provider receipts',async t=>{
  const f=await fixture(t),gates=[],calls=[];
  const recovery={state:'recovery-context',source:{frozen:true},commands:{manual:true},guidance:'Complete sanitized retained recovery context'};
  const delivered=[];
  const result=await launchWorkflow({...f.options,mode:'run',session:'session.json',scope:'scope.json'},{...f.deps,write:value=>delivered.push(value),input:{isTTY:true},readConfiguration:async()=>({identity:{teamId:TEAM},scope:{manualReady:true,allowPonder:true,maxSets:1}}),gate:async word=>gates.push(word),operatorFactory:()=>({dispatch:async q=>{calls.push(q.op);return {result:{ready:true}};}}),run:async(args,deps)=>{
    await deps.configurationReader({});deps.write(recovery);
    assert(args.includes('--codex-context-mode'));assert(args.includes('session'));const selected=deps.codexProviderFactory({});assert.strictEqual(selected.decisionProvider,f.provider.decisionProvider);
    assert.strictEqual(await selected.qualifyCodex({decisionMode:'model-tools',requests:f.requests}),f.main);assert.strictEqual(await deps.qualifyPonder(),f.shadow);
    const operator=deps.operatorFactory({});await operator.dispatch({op:'status'});await deps.beforeSearch();await operator.dispatch({op:'start-next'});await assert.rejects(operator.dispatch({op:'start-next'}),{code:'LAUNCH_SEARCH_RESERVED'});return {state:'review-required'};
  }});
  assert.equal(result.state,'review-required');assert.deepEqual(gates,['START_LIVE','START_SEARCH']);assert.deepEqual(calls,['status','start-next']);assert.deepEqual(f.closes,[]);
  assert(delivered.includes(recovery),'Maintained sanitized recovery envelopes must reach the manager unchanged.');
  const adoption=JSON.parse(await readFile(join(f.workspace,'cache/new-run/startup-adoption.json'),'utf8'));assert.equal(adoption.held,true);assert.equal(adoption.searchDispatched,false);
});
test('a cancelled pre-search gate never dispatches the native search or enables an alternate dispatch',async t=>{
  for(const reason of ['manager-cancelled','manager-input-closed']){
    const f=await fixture(t),calls=[],gates=[];
    const result=await launchWorkflow({...f.options,mode:'run',session:'session.json',scope:'scope.json'},{...f.deps,input:{isTTY:true},
      gate:async word=>{gates.push(word);if(word==='START_SEARCH')return {cancelled:true,reason,gate:word};},
      operatorFactory:()=>({dispatch:async q=>{calls.push(q.op);return {result:{ready:true}};}}),run:async(_args,deps)=>{
        const operator=deps.operatorFactory({});await operator.dispatch({op:'status'});
        const cancelled=await deps.beforeSearch();assert.deepEqual(cancelled,{cancelled:true,reason,gate:'START_SEARCH'});
        await assert.rejects(operator.dispatch({op:'start-next'}),{code:'LAUNCH_SEARCH_RESERVED'});
        return {state:'cancelled-before-search',reason,searchesAttempted:0,searchDispatched:false,ownerReleased:true,clientRetained:true};
      }});
    assert.equal(result.state,'cancelled-before-search');assert.deepEqual(calls,['status']);assert.deepEqual(gates,['START_LIVE','START_SEARCH']);
    assert.equal(JSON.parse(await readFile(join(f.workspace,'cache/new-run/attention-alert.json'),'utf8')).active,false);
    assert.equal(JSON.parse(await readFile(join(f.workspace,'cache/new-run/startup-adoption.json'),'utf8')).searchDispatched,false);
  }
});
test('search invocation remains reserved when native dispatch is uncertain',async t=>{
  const f=await fixture(t);let dispatches=0;
  const result=await launchWorkflow({...f.options,mode:'run',session:'session.json',scope:'scope.json'},{...f.deps,input:{isTTY:true},gate:async()=>{},
    operatorFactory:()=>({dispatch:async()=>{dispatches++;throw new Error('Synthetic uncertain dispatch');}}),run:async(_args,deps)=>{
      const operator=deps.operatorFactory({});await deps.beforeSearch();
      await assert.rejects(operator.dispatch({op:'start-next'}),/uncertain dispatch/u);
      await assert.rejects(operator.dispatch({op:'start-next'}),{code:'LAUNCH_SEARCH_RESERVED'});
      await assert.rejects(deps.beforeSearch(),{code:'LAUNCH_SEARCH_RESERVED'});
      return {state:'attention-retained'};
    }});
  assert.equal(dispatches,1);assert.equal(result.state,'attention-retained');
});
test('the public live workflow refuses nonmanual or different-team configuration before native setup',async t=>{
  for(const change of [{manualReady:false},{allowPonder:false},{maxSets:2}]){
    const f=await fixture(t);await assert.rejects(launchWorkflow({...f.options,mode:'run',session:'session.json',scope:'scope.json'},{...f.deps,input:{isTTY:true},gate:async()=>{},readConfiguration:async()=>({identity:{teamId:TEAM},scope:{manualReady:true,allowPonder:true,maxSets:1,...change}}),run:async(_args,deps)=>deps.configurationReader({})}),{code:'LAUNCH_SCOPE'});
    assert.deepEqual(f.closes,[true]);
  }
});
test('changed source and escaped output refuse without qualifying a copied report',async t=>{
  const f=await fixture(t);let reads=0;await assert.rejects(launchWorkflow(f.options,{...f.deps,sourcePins:async()=>({sha256:String(++reads).repeat(64)})}),{code:'LAUNCH_SOURCE_CHANGED'});
  const g=await fixture(t);await assert.rejects(launchWorkflow({...g.options,output:resolve(g.workspace,'../outside')},g.deps),{code:'LAUNCH_OUTPUT'});assert.deepEqual(g.events,[]);
});

test('a first attention cue is durable before a stalled handoff or manager stream read',async t=>{
  const f=await fixture(t),delivered=[];
  await launchWorkflow({...f.options,mode:'run',session:'session.json',scope:'scope.json'},{...f.deps,input:{isTTY:true},gate:async()=>{},write:value=>delivered.push(value),run:async(_args,deps)=>{
    deps.write({state:'controller-attention',code:'deadline_exceeded',detectedAt:1000,runId:'fixture-run',controllerLease:'PRIVATE'});
    const alarm=JSON.parse(await readFile(join(f.workspace,'cache/new-run/attention-alert.json'),'utf8'));
    assert.equal(alarm.active,true);assert.equal(alarm.firstDetectedAt,1000);assert.equal(alarm.code,'deadline_exceeded');
    assert(!JSON.stringify(alarm).includes('PRIVATE'));
    assert(delivered.some(value=>value.state==='controller-attention'));
    return {state:'attention-retained'};
  }});
});
