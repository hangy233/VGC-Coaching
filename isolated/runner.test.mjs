import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough, Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createTimingRecorder} from '../observability/timing.mjs';
import {createOperator} from '../showdown/operator-client.mjs';
import {loadMaintainedMatchupGuidance,renderMatchupGuidance} from './matchup-guidance.mjs';
import {ISOLATED_POLICY_SOURCE} from './decision-context.mjs';
import {parseRunnerArgs, validateSessionConfiguration, validateScopeConfiguration, readRunnerConfiguration,
  createModelTraceStore, runBattleWorkflow, runRunner, recordControllerTiming, serveAttentionMode, controllerAttentionNotice, waitForPostResultQuiescence,manualContainmentTemplate} from './runner.mjs';

const TEAM = 'a'.repeat(64), SHA = 'b'.repeat(64), PARENT = 'game-bestof3-gen9championsvgc2026regmcbo3-123', ROOM = 'battle-gen9championsvgc2026regmcbo3-124';
const identity = () => ({version: 1, sessionId: 'fixture-session', teamId: TEAM, account: 'Fixture User', teamFile: 'team.txt'});
const policy = () => ({enabled: true, forfeitIfStuck: false, emergencyDefaultChoice: false, planningMs: 20000, previewPlanningMs: 20000, unknownClockMs: 20000, safetyMarginMs: 5000});
const scope = () => ({version: 1, authorization: 'User approved one isolated live BO3 in this existing session.', sessionId: 'fixture-session', teamId: TEAM, account: 'Fixture User', maxSets: 1, allowSearch: true, allowGenerationProbe: true, saveReplays: false, controlPolicy: policy()});
const PRIVATE_FIXTURE_TEXT='TEST-ONLY-NONSECRET-MARKER';
const CLI_SELECTION=['--provider','codex-cli','--model','gpt-6.1-sol','--reasoning-effort','low','--codex-context-mode','session'];
const fixtureCliProvider=async options=>({contextMode:'session',decisionProvider:{kind:'codex-cli',model:options.model,reasoningEffort:options.reasoningEffort,callDecision:()=>assert.fail('No model generation in orchestration fixture')},preflight:async()=>({authMode:'chatgpt',contextMode:'session'})});
const runId = '11111111-1111-4111-8111-111111111111';
const GUIDANCE_VERSION='fixture-guidance';
const GUIDANCE_FILES=[{path:'SKILL.md',content:`Current skill fixture\nCycle revision: **${GUIDANCE_VERSION}**.\n`},{path:'references/headless-battle-cycle.md',content:'Current cycle fixture'}]
  .map(file=>({...file,sha256:createHash('sha256').update(file.content).digest('hex')}));
const GUIDANCE_SHA=(()=>{const hash=createHash('sha256'),entries=[{path:'references',type:'directory'},...GUIDANCE_FILES.map(file=>({...file,type:'file'}))].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);for(const file of entries)hash.update(`${file.type}:${Buffer.byteLength(file.path)}:${file.path}:${file.sha256??''}\n`);return hash.digest('hex');})();
function guidanceFixture(){
  const filesRead=structuredClone(GUIDANCE_FILES);
  return {skill:'champions-mc-matchups',synchronized:true,sourceSha256:GUIDANCE_SHA,installedSha256:GUIDANCE_SHA,files:filesRead.length,
    receiptExpiresAt:new Date(Date.now()+3600000).toISOString(),filesRead};
}
function fixtureGuidanceProof(guidance,commandId){
  const rows=guidance.filesRead.map(file=>[file.path,file.sha256,Buffer.byteLength(file.content,'utf8')]).sort(([a],[b])=>a<b?-1:a>b?1:0);
  return {kind:'operator-retained-skill-read-proof',version:1,commandId,skill:guidance.skill,sourceSha256:guidance.sourceSha256,installedSha256:guidance.installedSha256,
    files:guidance.files,deliverySha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),receiptExpiresAt:guidance.receiptExpiresAt,receiptRetained:true};
}
async function workspace(t) {
  const root = fileURLToPath(new URL('../cache/isolated-test-fixtures/', import.meta.url));
  await mkdir(root, {recursive: true});
  const path = await mkdtemp(join(root, 'runner-'));
  t.after(() => rm(path, {recursive: true, force: true}));
  return path;
}

function workflowFixture({priorComplete = true, preflightReady = true, stateChange, metricsReady = true, runResult} = {}) {
  const calls = []; let ended = false;
  const status = () => ({sessionId: 'fixture-session', teamSha256: TEAM, username: 'Fixture User', connected: true, authenticated: true, authorizedSets: 1, searchesSent: ended ? 1 : 0,
    search: {games: null, searching: []}, actions: [], rooms: ended ? [{id: PARENT, ended: true, result: {type: 'win', winner: 'Fixture User'}}] : [], controlPolicy: {...policy(), halted: false}});
  let guidanceProof;
  const operator = {getGuidanceReadProof:({commandId})=>guidanceProof?.commandId===commandId?structuredClone(guidanceProof):null,async dispatch(q) {
    calls.push(structuredClone(q));
    if (q.op === 'status' || q.op === 'turn') {const value = status(); if(q.op === 'turn') value.actionPlanPersistence={pending:0,failures:0,dropped:0}; stateChange?.(value); return {result: value};}
    if (q.op === 'arm') return {result: {armed: true}};
    if (q.op === 'start-next') return {result: {search: 'sent'}};
    if (q.op === 'call') {
      if (q.name === 'battle_skill_status') return {result: {synchronized: true, sourceSha256: GUIDANCE_SHA,installedSha256:GUIDANCE_SHA,files:2}};
      if (q.name === 'battle_skill_read') {const guidance=guidanceFixture();guidanceProof=fixtureGuidanceProof(guidance,q.id);return {result:guidance};}
      if (q.name === 'battle_review_status') return {result: {teamId:TEAM,required:false,exists:false,parentId:null,complete: q.args.parentId ? false : priorComplete, blockers: q.args.parentId || !priorComplete ? ['Review needed'] : []}};
      if (q.name === 'battle_preflight') return {result: {ready: preflightReady, blockers: preflightReady ? [] : ['Not ready']}};
      if (q.name === 'team_metrics_sync_battles') return {result: {teamId: TEAM, recording: {state: metricsReady ? 'ready' : 'error'}}};
      return {result: {ok: true}};
    }
    throw new Error('Unexpected fixture operation');
  }};
  const createController = config => ({async initialize() {calls.push({op: 'controller-initialize', configKeys: Object.keys(config),manualReady:config.manualReady});}, async runSet() {
    calls.push({op: 'controller-run'}); ended = true; return runResult ?? {status: 'review-required', parentId: PARENT, officialResult: {type: 'win'}};
  }});
  return {operator, createController, calls, args: {operator, createController, identity: identity(), scope: scope(), ownTeamText: 'fixture team',decisionProvider:{kind:'codex-cli',model:'gpt-6.1-sol',reasoningEffort:'low',callDecision:()=>assert.fail('Workflow fixture never generates')},contextMode:'session', onEvidence: async () => {}, runId, verifyPolicy: () => ({verified: true, skillVersion: GUIDANCE_VERSION, skillSha256: GUIDANCE_SHA}), qualifyCodex:async()=>({qualified:true,requestedModel:'gpt-6.1-sol',reasoningEffort:'low',providerKind:'codex-cli',authenticationMethod:'chatgpt',generationObserved:true,savedPositionQualified:true,decisionMode:'model-tools',modelToolWorkflowQualified:true,modelRequestedMcpQualified:true,pairedSimulationQualified:true,liveObservedSimulationQualified:true,rangeWorkflowQualified:true,teamId:TEAM,contextMode:'session',sessionContinuityQualified:true})}};
}

function codexWorkflowFixture(options={}){return workflowFixture(options);}
test('every live provider receives the complete verified native skill in its controller options',async()=>{
  for(const make of [workflowFixture,codexWorkflowFixture]){
    const f=make(),original=f.args.createController;let bundle;
    f.args.createController=config=>{bundle=config.matchupGuidance;assert.equal(Object.isFrozen(bundle),true);assert.equal(Object.isFrozen(bundle.files),true);assert.equal(Object.isFrozen(bundle.files[0]),true);assert.equal(bundle.version,GUIDANCE_VERSION);assert.equal(bundle.sha256,GUIDANCE_SHA);assert.deepEqual(bundle.files,GUIDANCE_FILES);assert.match(renderMatchupGuidance(bundle),/Current cycle fixture/u);assert.equal(Object.hasOwn(bundle,'readReceipt'),false);return original(config);};
    f.args.onGuidance=guidance=>{guidance.filesRead[0].content='A host read must not replace the prepared model guidance.';};
    assert.equal((await runBattleWorkflow(f.args)).state,'review-required');assert.equal(bundle.files[0].content,GUIDANCE_FILES[0].content);assert.equal(f.calls.filter(q=>q.op==='start-next').length,1);
  }
});

test('a content-bound read with a wrong whole-folder pin is refused before claiming or searching',async()=>{
  const f=workflowFixture(),dispatch=f.operator.dispatch;let proof;
  f.operator.dispatch=async q=>{const value=await dispatch(q);if(q.name==='battle_skill_read'){const g=value.result;g.filesRead[0].content+='\nChanged fixture text';g.filesRead[0].sha256=createHash('sha256').update(g.filesRead[0].content).digest('hex');proof=fixtureGuidanceProof(g,q.id);}return value;};
  f.operator.getGuidanceReadProof=({commandId})=>proof?.commandId===commandId?proof:null;
  await assert.rejects(runBattleWorkflow(f.args),{code:'skill'});
  assert.equal(f.calls.some(q=>q.op==='arm'||q.op==='start-next'||q.name==='battle_control_claim'),false);
});

test('retained CLI mode is explicit and old stateless qualification cannot authorize a session search',async()=>{
 const args=['--check','--provider','codex-cli','--model','gpt-6.1-sol','--reasoning-effort','low','--codex-context-mode','session','--codex-service-tier','fast'];
 assert.equal(parseRunnerArgs(args).contextMode,'session');assert.equal(parseRunnerArgs(args).serviceTier,'fast');
 const high=args.map(value=>value==='low'?'high':value);assert.equal(parseRunnerArgs(high).reasoningEffort,'high');
 assert.throws(()=>parseRunnerArgs(['--check','--codex-context-mode','session']),{code:'arguments'});
 assert.throws(()=>parseRunnerArgs([...args.slice(0,-4),'--codex-context-mode','unknown']),{code:'arguments'});
 const f=codexWorkflowFixture(),qualify=f.args.qualifyCodex;f.args.qualifyCodex=async args=>({...await qualify(args),contextMode:'stateless'});let resets=0;f.args.resetDecisionContext=async()=>{resets++;};
 await assert.rejects(runBattleWorkflow(f.args),{code:'generation_unavailable'});assert.equal(resets,0);
 assert.equal(f.calls.some(row=>row.op==='start-next'),false);
});

test('a matching retained-mode pass resets offline context before live preparation',async()=>{
 const f=codexWorkflowFixture(),qualify=f.args.qualifyCodex;f.args.contextMode='session';let resets=0;
 f.args.qualifyCodex=async options=>({...await qualify(options),contextMode:'session',sessionContinuityQualified:true,sessionLiveQualified:true});
 f.args.resetDecisionContext=async()=>{resets++;};
 assert.equal((await runBattleWorkflow(f.args)).state,'review-required');assert.equal(resets,1);
});

test('production direct-mode admission rejects unbranded JSON qualification before control or search',async()=>{
  const f=codexWorkflowFixture();f.args.requireModelToolReceipt=true;
  await assert.rejects(runBattleWorkflow(f.args),{code:'generation_unavailable'});
  assert.equal(f.calls.length,0);
  const parsed=parseRunnerArgs(['--run','--session','fixture-session.json','--scope','fixture-scope.json','--provider','codex-cli','--model','gpt-6.1-sol','--reasoning-effort','medium','--model-tool-qualification','cache/prepared.json']);
  assert.equal(parsed.contextMode,'session');assert.equal(parsed.modelToolQualificationFile,'cache/prepared.json');
  assert.throws(()=>parseRunnerArgs(['--check','--model-tool-qualification','cache/prepared.json']),{code:'arguments'});
});



test('explicit Luna Low CLI eligibility preserves its exact qualification, research and one-set gates',async()=>{
  const make=()=>{
    const f=codexWorkflowFixture(),qualify=f.args.qualifyCodex;
    f.args.decisionProvider.model='gpt-6-luna';f.args.decisionProvider.reasoningEffort='low';
    f.args.qualifyCodex=async args=>({...await qualify(args),requestedModel:'gpt-6-luna',reasoningEffort:'low'});
    return f;
  };
  const f=make();let configured;
  const create=f.args.createController;f.args.createController=config=>{configured=config;return create(config);};
  assert.equal((await runBattleWorkflow(f.args)).state,'review-required');
  assert.equal(configured.decisionProvider.model,'gpt-6-luna');assert.equal(configured.decisionProvider.reasoningEffort,'low');
  assert.equal(configured.singleCallResearch,false);assert.equal(configured.fastFirst,false);assert.equal(configured.decisionMode,'model-tools');assert.equal(configured.automaticTacticalEvidence,false);
  assert.equal(configured.maxRichContextBytes,8388608);assert.equal(configured.maxContextBytes,8388608);
  assert.equal(Object.hasOwn(configured,'apiConfig'),false);assert.equal(f.calls.filter(q=>q.op==='start-next').length,1);
  for(const changes of [{qualified:false},{generationObserved:false},{savedPositionQualified:false},{modelRequestedMcpQualified:false},{requestedModel:'gpt-6.1-sol'},{reasoningEffort:'medium'}]){
    const g=make(),qualify=g.args.qualifyCodex;g.args.qualifyCodex=async args=>({...await qualify(args),...changes});
    await assert.rejects(runBattleWorkflow(g.args),{code:'generation_unavailable'});assert.equal(g.calls.length,0);
  }
});

test('Codex CLI live search rejects old host-planned evidence and missing direct model-tool qualification',async()=>{
  for(const changes of [
    {modelToolWorkflowQualified:undefined,modelRequestedMcpQualified:undefined,decisionMode:undefined},
    {modelToolWorkflowQualified:false},
    {modelRequestedMcpQualified:false},
    {modelRequestedMcpQualified:undefined},
    {pairedSimulationQualified:false},
    {rangeWorkflowQualified:false},
    {rangeWorkflowQualified:undefined},
    {pairedSimulationQualified:undefined},
    {liveObservedSimulationQualified:false},
    {decisionMode:'fast-first-two-stage'},
    {decisionMode:'single-call-research'},
    {decisionMode:'host-adoption'},
    {decisionMode:undefined},
    {sessionContinuityQualified:false},
    {contextMode:'stateless'},
    {teamId:'f'.repeat(64)},
  ]){
    const f=codexWorkflowFixture(),qualify=f.args.qualifyCodex;
    f.args.qualifyCodex=async args=>({...await qualify(args),...changes});
    await assert.rejects(runBattleWorkflow(f.args),{code:'generation_unavailable'});
    assert.equal(f.calls.length,0,'Rejected qualification must precede native control and search.');
  }
});



test('live Codex startup preflights the selected provider before native connection even with an injected qualification',async()=>{
 const order=[],stop=new Error('Offline boundary before native connection');
 const args=['--run','--session','fixture-session.json','--scope','fixture-scope.json','--provider','codex-cli','--model','gpt-6.1-sol','--reasoning-effort','low'];
 await assert.rejects(runRunner(args,{write:()=>assert.fail('No result before offline boundary'),
  configurationReader:async()=>({identity:identity(),scope:scope(),ownTeamText:'Fixture export'}),
  codexProviderFactory:async options=>({contextMode:options.contextMode,decisionProvider:{kind:'codex-cli',model:options.model,reasoningEffort:options.reasoningEffort,callDecision:()=>assert.fail('No model generation')},
   preflight:async()=>{order.push('provider-preflight');return{authMode:'chatgpt',contextMode:options.contextMode};}}),
  qualifyCodex:async()=>{order.push('injected-qualification');return{qualified:true};},
  connect:async()=>{order.push('native-connect');throw stop;}}),error=>error===stop);
 assert.deepEqual(order,['provider-preflight','native-connect']);
});

test('an injected qualification cannot bypass failed or non-ChatGPT selected-provider startup',async()=>{
 const args=['--run','--session','fixture-session.json','--scope','fixture-scope.json','--provider','codex-cli','--model','gpt-6.1-sol','--reasoning-effort','low'];
 for(const mode of ['throw','api-key','missing']){
  let checks=0;
  await assert.rejects(runRunner(args,{write:()=>assert.fail('No startup success'),
   configurationReader:async()=>({identity:identity(),scope:scope(),ownTeamText:'Fixture export'}),
   codexProviderFactory:async options=>({contextMode:options.contextMode,decisionProvider:{kind:'codex-cli',model:options.model,reasoningEffort:options.reasoningEffort,callDecision:()=>assert.fail('No generation')},
    preflight:async()=>{checks++;if(mode==='throw')throw Object.assign(new Error('Private CLI diagnostic is not exposed'),{code:'preflight_required'});return mode==='api-key'?{authMode:'api-key'}:{};}}),
   qualifyCodex:async()=>assert.fail('A retained qualification cannot prepare the selected provider'),
   connect:async()=>assert.fail('No native SDK connection or search before subscription preflight')}),error=>error.code==='provider_configuration'&&
    (mode!=='throw'||error.providerErrorCode==='preflight_required')&&!error.message.includes('Private CLI diagnostic'));
  assert.equal(checks,1);
 }
});





test('CLI has no implicit live mode or unbounded allowance', () => {
  assert.deepEqual(parseRunnerArgs(['--check',...CLI_SELECTION]), {mode:'check',provider:'codex-cli',model:'gpt-6.1-sol',reasoningEffort:'low',contextMode:'session'});
  assert.deepEqual(parseRunnerArgs(['--run','--session','session.json','--scope','scope.json',...CLI_SELECTION]), {mode:'run',session:'session.json',scope:'scope.json',provider:'codex-cli',model:'gpt-6.1-sol',reasoningEffort:'low',contextMode:'session'});
  assert.throws(()=>parseRunnerArgs(['--check']),{code:'arguments'});
  assert.throws(()=>parseRunnerArgs(['--run','--session','session.json','--scope','scope.json']),{code:'arguments'});
  for (const args of [[], ['--run'], ['--run', '--offline'], ['--offline', '--session', 'x', '--scope', 'y'], ['--check', '--session', 'x'], ['--run', '--session', 'x', '--scope', 'y', '--max-sets', '2'], ['--check', '--check']]) assert.throws(() => parseRunnerArgs(args), {code: 'arguments'});
  for (const mutate of [value => value.maxSets = 2, value => value.allowSearch = false, value => value.teamId = SHA, value => value.controlPolicy.emergencyDefaultChoice = 'true', value => value.allowManualForfeit = 'true', value => value.manualReady='true', value => value.unknownField = true]) {
    const value = scope(); mutate(value); assert.throws(() => validateScopeConfiguration(value, identity()), {code: 'configuration'});
  }
  assert.throws(() => validateSessionConfiguration({...identity(), password: 'disallowed'}), {code: 'configuration'});
});

test('successive runner workflows keep native mutation command IDs distinct on a kept client',async()=>{
  const nativeCommands=new Map();
  for(let invocation=0;invocation<2;invocation++){
    const f=workflowFixture(),dispatch=f.operator.dispatch.bind(f.operator);
    f.operator.dispatch=async query=>{
      if(query.op==='call'&&['battle_control_claim','battle_set_control_policy','battle_control_release'].includes(query.name)){
        const commandId=query.args.commandId;
        assert.match(commandId,/^[A-Za-z0-9_-]{1,80}$/u);
        assert.equal(nativeCommands.has(commandId),false,'A kept native client can replay a prior claim or reject reused IDs with different arguments');
        nativeCommands.set(commandId,{name:query.name,invocation});
      }
      return dispatch(query);
    };
    const result=await runBattleWorkflow(f.args);
    assert.equal(result.state,'review-required');
  }
  assert.equal(nativeCommands.size,6);
});

test('explicit local files bind the exact approved six and reject paths outside the workspace', async t => {
  const dir = await workspace(t);
  const names = ['Golisopod', 'Hydreigon', 'Rillaboom', 'Politoed', 'Farigiraf', 'Sylveon'];
  const text = names.map(name => `${name}\n- Protect`).join('\n\n');
  const {Teams} = createRequire(import.meta.url)('pokemon-showdown');
  const teamId = createHash('sha256').update(Teams.pack(Teams.import(text))).digest('hex');
  const configuredIdentity = {...identity(), teamId}; const configuredScope = {...scope(), teamId};
  await writeFile(join(dir, 'team.txt'), text); await writeFile(join(dir, 'session.json'), JSON.stringify(configuredIdentity)); await writeFile(join(dir, 'scope.json'), JSON.stringify(configuredScope));
  const result = await readRunnerConfiguration({workspace: dir, sessionFile: 'session.json', scopeFile: 'scope.json'});
  assert.equal(result.identity.teamId, teamId); assert.equal(result.ownTeamText, text);
  await writeFile(join(dir, 'team.txt'), text.replace('Golisopod', 'Pikachu'));
  await assert.rejects(readRunnerConfiguration({workspace: dir, sessionFile: 'session.json', scopeFile: 'scope.json'}), {code: 'configuration'});
  await assert.rejects(readRunnerConfiguration({workspace: dir, sessionFile: '../session.json', scopeFile: 'scope.json'}), {code: 'configuration'});
});







test('one official BO3 ends at native review with reports, lease release and client retained', async () => {
  const f = workflowFixture(); const result = await runBattleWorkflow(f.args);
  assert.equal(result.state, 'review-required'); assert.equal(result.parentId, PARENT); assert.equal(result.searchesAttempted, 1); assert.equal(result.clientRetained, true); assert.equal(result.nativeReviewComplete, false);
  assert.equal(f.calls.filter(q => q.op === 'start-next').length, 1);
  assert.equal(f.calls.filter(q => q.name === 'battle_stop' || q.name === 'battle_review_save' || q.name === 'battle_authorize_sets').length, 0);
  const index = name => f.calls.findIndex(q => q.name === name || q.op === name);
  assert(index('battle_skill_read') < index('arm')); assert(index('battle_review_status') < index('battle_control_claim'));
  assert(index('controller-initialize') < index('battle_preflight')); assert(index('battle_preflight') < index('start-next'));
  assert(index('team_metrics_sync_battles') < index('team_metrics_agent_report')); assert(index('team_metrics_agent_report') < index('battle_control_release'));
  assert.equal(f.calls.find(q => q.op === 'controller-initialize').configKeys.includes('onEvidence'), true);
});

function postResultFixture(change = () => {}) {
  const calls = []; let time = 1000, step = 0;
  const state = compact => {
    const value = {sessionId:'fixture-session',teamSha256:TEAM,username:'Fixture User',connected:true,authenticated:true,stopped:false,
      revision:10+step,actions:[],search:{searching:[],games:null},savingReplays:false,
      rooms:[{id:PARENT,teamId:TEAM,ended:true,result:{type:'win'},children:[ROOM]},{id:ROOM,parentId:PARENT,ended:true,result:{type:'win'}}],
      ...(compact ? {actionPlanPersistence:{pending:0,failures:0,dropped:0}} : {replayPolicy:{active:false,pendingParents:[],attentionParents:[],sets:[]}})};
    change(value,{compact,step}); return value;
  };
  return {calls,now:()=>time,async dispatch(q) {
    calls.push(structuredClone(q));
    if(q.op==='status')return state(false);
    if(q.op==='turn')return state(true);
    assert.equal(q.op,'call');assert.equal(q.name,'battle_wait');assert.equal(q.args.format,'compact');
    assert.equal(q.args.afterRevision,10+step);time+=q.args.timeoutMs;step++;
    return state(true);
  }};
}

test('post-result quiescence drains delayed automatic replays and action-plan writes through same-owner read-only waits',async()=>{
  const f=postResultFixture((value,{compact,step})=>{
    value.savingReplays=step===0;
    if(compact)value.actionPlanPersistence.pending=step<2?2:0;
    else{value.replayPolicy.active=step<2;value.replayPolicy.pendingParents=step<2?[PARENT]:[];}
  });
  const result=await waitForPostResultQuiescence({...f,identity:identity(),parentId:PARENT,timeoutMs:5000});
  assert.equal(result.savingReplays,false);assert.equal(f.calls.filter(q=>q.name==='battle_wait').length,2);
  assert(f.calls.every(q=>['status','turn'].includes(q.op)||q.op==='call'&&q.name==='battle_wait'));
});

test('post-result normal idle needs no wait and delayed exact-parent child completion is observed before review',async()=>{
  const normal=postResultFixture();await waitForPostResultQuiescence({...normal,identity:identity(),parentId:PARENT});
  assert.deepEqual(normal.calls.map(q=>q.op),['status','turn']);
  const delayed=postResultFixture((value,{step})=>{value.rooms[1].ended=step>0;});
  await waitForPostResultQuiescence({...delayed,identity:identity(),parentId:PARENT});
  assert.equal(delayed.calls.filter(q=>q.name==='battle_wait').length,1);
});

test('post-result disconnect fresh request unknown parent replay failure and lost writes cannot count as idle',async()=>{
  const cases=[value=>{value.connected=false;},value=>{value.actions=[{kind:'turn',room:ROOM,actionable:true}];},
    value=>{value.rooms[0].id=PARENT+'9';},value=>{value.rooms.push({id:PARENT+'9',ended:false});},
    (value,{compact})=>{if(!compact)value.replayPolicy.attentionParents=[PARENT];},
    (value,{compact})=>{if(compact)value.actionPlanPersistence.failures=1;},
    (value,{compact})=>{if(compact)value.actionPlanPersistence.dropped=1;},
    (value,{compact})=>{if(compact)delete value.actionPlanPersistence;}];
  for(const change of cases){
    const f=postResultFixture(change);
    await assert.rejects(waitForPostResultQuiescence({...f,identity:identity(),parentId:PARENT}));
    assert.equal(f.calls.some(q=>q.name==='battle_wait'),false);
  }
});

test('post-result bounded timeout and refused read preserve the searched workflow owner without another choice or search',async()=>{
  const timeout=workflowFixture({runResult:{status:'post-result-pending',parentId:PARENT}}),base=timeout.operator.dispatch.bind(timeout.operator);
  let time=1000;
  timeout.args.now=()=>time;timeout.args.postResultTimeoutMs=10;
  timeout.operator.dispatch=async q=>{
    if(q.name==='battle_wait'){timeout.calls.push(structuredClone(q));time+=10;return {result:{sessionId:'fixture-session',connected:true,authenticated:true,revision:12,actions:[],
      search:{games:null,searching:[]},rooms:[{id:PARENT,ended:true,result:{type:'win'}}],savingReplays:true,actionPlanPersistence:{pending:1,failures:0,dropped:0}}};}
    const reply=await base(q);
    if(['status','turn'].includes(q.op)&&reply.result.rooms.length){reply.result.savingReplays=true;reply.result.revision=11;}
    return reply;
  };
  await assert.rejects(runBattleWorkflow(timeout.args),error=>error.code==='idle'&&error.liveOwnershipRetained===true&&error.affectedParentId===PARENT);
  assert.equal(timeout.calls.filter(q=>q.op==='start-next').length,1);
  assert.equal(timeout.calls.some(q=>['battle_control_release','battle_stop','battle_choose'].includes(q.name)),false);
  const refused=workflowFixture(),original=refused.operator.dispatch.bind(refused.operator);
  refused.operator.dispatch=async q=>q.op==='turn'?{error:'Read refused',retry:false}:original(q);
  await assert.rejects(runBattleWorkflow(refused.args),error=>error.code==='operator'&&error.liveOwnershipRetained===true);
  assert.equal(refused.calls.some(q=>q.name==='battle_control_release'),false);
});

test('an unresolved post-result read times out with its serial slot retained through attention',async()=>{
  const f=workflowFixture(),base=f.operator.dispatch.bind(f.operator);let statuses=0,settle;
  const pending=new Promise(resolve=>{settle=resolve;});
  f.args.postResultTimeoutMs=15;
  f.operator.dispatch=async q=>{
    if(q.op==='status'&&++statuses===4){f.calls.push(structuredClone(q));return pending;}
    return base(q);
  };
  let failure;
  await assert.rejects(runBattleWorkflow(f.args),error=>{failure=error;return error.code==='idle'&&error.liveOwnershipRetained===true;});
  assert(failure.pendingPostResultRead instanceof Promise);assert.equal(f.calls.some(q=>q.name==='battle_control_release'),false);
  const input=new PassThrough(),output=[];let handoffs=0;
  await serveAttentionMode({operator:f.operator,identity:identity(),scope:scope(),runId,input,failure,
    prepareHandoff:async()=>{handoffs++;return {state:'recovery-context',binding:{parentId:PARENT}};},
    write:value=>{output.push(value);if(value.state==='recovery-context-unavailable'){
      assert.equal(handoffs,0);settle({result:{}});
      setTimeout(()=>{input.write(JSON.stringify({id:'after-read',op:'recovery-context'})+'\n');input.end();},5);
    }}});
  assert.equal(handoffs,1);assert(output.some(value=>value.state==='recovery-context'));
  assert.equal(f.calls.some(q=>q.name==='battle_stop'||q.name==='battle_control_release'),false);
});

test('explicit manual-ready scope requires observed autoReady false before control and search, then retains the one-search limit',async()=>{
  for(const observed of [undefined,true]){
    const f=workflowFixture({stateChange:value=>{if(observed!==undefined)value.autoReady=observed;}});f.args.scope.manualReady=true;
    await assert.rejects(runBattleWorkflow(f.args),{code:'readiness'});
    assert.equal(f.calls.some(q=>q.op==='arm'||q.op==='start-next'||q.name==='battle_control_claim'),false);
  }
  const f=workflowFixture({stateChange:value=>{value.autoReady=false;}});f.args.scope.manualReady=true;
  assert.equal((await runBattleWorkflow(f.args)).state,'review-required');
  assert.equal(f.calls.find(q=>q.op==='controller-initialize').manualReady,true);assert.equal(f.calls.filter(q=>q.op==='start-next').length,1);
  assert.equal(f.calls.some(q=>q.name==='battle_ready'),false,'readiness belongs to the healthy timed controller, not an outer search retry');
  let statuses=0;
  const changed=workflowFixture({stateChange:value=>{value.autoReady=++statuses<3?false:true;}});changed.args.scope.manualReady=true;
  await assert.rejects(runBattleWorkflow(changed.args),{code:'readiness'});assert.equal(changed.calls.some(q=>q.op==='start-next'),false);
});

test('runner reads the actual nested maintained-operator and native IPC reply envelopes', async () => {
  const f = workflowFixture(), original = f.operator.dispatch;
  f.operator.dispatch = async query => {
    const reply = await original(query);
    if (query.op === 'status' || query.op === 'call' && query.name?.startsWith('battle_') && !['battle_skill_status', 'battle_skill_read', 'battle_review_status', 'battle_preflight', 'battle_timing_report'].includes(query.name)) return {result: {id: 'native-ipc-fixture', ok: true, result: reply.result}, elapsedMs: 1};
    return reply;
  };
  const result = await runBattleWorkflow(f.args);
  assert.equal(result.state, 'review-required'); assert.equal(result.searchesAttempted, 1);
});

test('real workflow SDK and maintained operator deliver complete guidance with a private retained receipt before the runner review gate',async t=>{
  const [{McpServer},{Client},{InMemoryTransport},{registerWorkflowTools}]=await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),import('@modelcontextprotocol/sdk/client/index.js'),import('@modelcontextprotocol/sdk/inMemory.js'),import('../workflow/mcp-tools.mjs')]);
  const dir=await workspace(t),source=join(dir,'skills','champions-mc-matchups'),target=join(dir,'installed-matchup');
  for(const root of [source,target]){
    await mkdir(join(root,'references'),{recursive:true});
    for(const file of guidanceFixture().filesRead)await writeFile(join(root,file.path),file.content);
  }
  const server=new McpServer({name:'readonly-skill-regression',version:'1'}),sdk=new Client({name:'readonly-runner-regression',version:'1'});
  registerWorkflowTools(server,{workspace:dir,skillOptions:{target}});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await sdk.connect(clientTransport);
  try{
    const nativeStatus=await sdk.callTool({name:'battle_skill_status',arguments:{}}),status=JSON.parse(nativeStatus.content[0].text);
    const f=workflowFixture({priorComplete:false}),nativeCalls=[],queries=[];let receivedGuidance,delivered=false,nativeReceiptObserved=false;
    const actual=createOperator({responseFile:'unused-readonly-guidance-regression',publish:async()=>{},client:{async callTool(request,schema,options){
      nativeCalls.push(request.name);
      if(['battle_skill_status','battle_skill_read'].includes(request.name)){
        const value=await sdk.callTool(request,schema,options);
        if(request.name==='battle_skill_read')nativeReceiptObserved=typeof JSON.parse(value.content[0].text).readReceipt==='string';
        return value;
      }
      if(request.name==='battle_status')return {structuredContent:{ok:true,result:(await f.operator.dispatch({id:'native-status',op:'status'})).result}};
      if(request.name==='battle_review_status')return {structuredContent:{complete:false,blockers:['Fixture stops before every control mutation.']}};
      assert.fail(`Read-only regression must not call ${request.name}`);
    }}});
    const operator={getGuidanceReadProof:actual.getGuidanceReadProof,async dispatch(q,options){queries.push(q);const value=await actual.dispatch(q,options);if(q.name==='battle_skill_read')receivedGuidance=value.result;return value;}};
    await assert.rejects(runBattleWorkflow({...f.args,operator,onGuidance:async guidance=>{delivered=true;assert.equal(guidance.filesRead.length,2);},
      verifyPolicy:()=>({verified:true,skillVersion:GUIDANCE_VERSION,skillSha256:status.sourceSha256})}),{code:'review'});
    assert.equal(delivered,true);assert.equal(nativeReceiptObserved,true);assert.equal(receivedGuidance.readReceipt,undefined);
    const command=queries.find(q=>q.name==='battle_skill_read'),proof=operator.getGuidanceReadProof({commandId:command.id});
    assert.equal(proof.receiptRetained,true);assert.equal(proof.files,2);assert.equal(proof.sourceSha256,status.sourceSha256);
    assert.equal(Object.hasOwn(proof,'readReceipt'),false);assert.equal(operator.getGuidanceReadProof({commandId:'old-read'}),null);
    assert.deepEqual(nativeCalls,['battle_status','battle_skill_status','battle_skill_read','battle_review_status']);
    assert.equal(queries.some(q=>['arm','start-next'].includes(q.op)),false);
  }finally{await Promise.allSettled([sdk.close(),server.close()]);}
});

test('runner refuses missing expired forged or changed receipt/content proof before any control mutation',async()=>{
  const variants=[
    {name:'missing-private-receipt',change:g=>{delete g.readReceipt;}},
    {name:'redacted-string-is-not-a-receipt',change:g=>{g.readReceipt='[redacted]';}},
    {name:'expired',change:g=>{g.receiptExpiresAt=new Date(Date.now()-1000).toISOString();}},
    {name:'changed-source',change:g=>{g.sourceSha256='c'.repeat(64);}},
    {name:'missing-file',change:g=>{g.filesRead.pop();}},
    {name:'duplicate-file',change:g=>{g.filesRead[1]=structuredClone(g.filesRead[0]);}},
    {name:'metadata-only',change:g=>{delete g.filesRead[0].content;}},
    {name:'wrong-content-hash',change:g=>{g.filesRead[0].content+=' altered';}},
    {name:'forged-native-proof-marker',change:g=>{delete g.readReceipt;g.guidanceReadProof=fixtureGuidanceProof(g,'forged-read');}},
    {name:'changed-after-operator-capture',returned:g=>{g.filesRead[0].content+=' altered';g.filesRead[0].sha256=createHash('sha256').update(g.filesRead[0].content).digest('hex');}},
    {name:'expired-after-capture',advance:true},
  ];
  for(const variant of variants){
    const f=workflowFixture({priorComplete:false}),nativeCalls=[];let time=Date.now();
    const actual=createOperator({responseFile:'unused-refused-guidance-regression',publish:async()=>{},now:()=>time,client:{async callTool(request){
      nativeCalls.push(request.name);
      if(request.name==='battle_status')return {structuredContent:{ok:true,result:(await f.operator.dispatch({id:'status',op:'status'})).result}};
      if(request.name==='battle_skill_status')return {structuredContent:{synchronized:true,sourceSha256:GUIDANCE_SHA,installedSha256:GUIDANCE_SHA,files:2}};
      if(request.name==='battle_skill_read'){
        const guidance={...guidanceFixture(),readReceipt:'51d70d21-3a42-4b6d-82f4-110a7e8fdd43'};variant.change?.(guidance);return {structuredContent:guidance};
      }
      assert.fail(`Rejected skill proof must stop before ${request.name}`);
    }}});
    const operator={getGuidanceReadProof:actual.getGuidanceReadProof,async dispatch(q,options){const reply=await actual.dispatch(q,options);if(q.name==='battle_skill_read'){variant.returned?.(reply.result);if(variant.advance)time+=3600001;}return reply;}};
    await assert.rejects(runBattleWorkflow({...f.args,operator,now:()=>time}),{code:'skill'},variant.name);
    assert.deepEqual(nativeCalls,['battle_status','battle_skill_status','battle_skill_read'],variant.name);
  }
});

test('unfinished prior review and identity/idle/allowance/halts prevent search without control mutations', async () => {
  const cases = [
    [{priorComplete: false}, 'review'],
    [{stateChange: value => value.username = 'Other User'}, 'identity'],
    [{stateChange: value => value.searchPending = true}, 'idle'],
    [{stateChange: value => value.authorizedSets = 0}, 'allowance'],
    [{stateChange: value => value.controlPolicy.halted = true}, 'policy'],
  ];
  for (const [options, code] of cases) {
    const f = workflowFixture(options); await assert.rejects(runBattleWorkflow(f.args), {code});
    assert(!f.calls.some(q => q.op === 'start-next' || q.name === 'battle_control_claim' || q.name === 'battle_set_control_policy'));
  }
});

test('blocked preflight releases idle ownership and never searches', async () => {
  const f = workflowFixture({preflightReady: false}); await assert.rejects(runBattleWorkflow(f.args), {code: 'preflight'});
  assert(!f.calls.some(q => q.op === 'start-next')); assert.equal(f.calls.filter(q => q.name === 'battle_control_release').length, 1);
});

test('pre-search cancellation or EOF releases only freshly verified idle ownership and sends no search',async()=>{
  for(const reason of ['manager-cancelled','manager-input-closed']){
    const f=workflowFixture({stateChange:state=>{state.controller={required:true,owner:'isolated-native-runner',generation:1};}});let gates=0;
    const result=await runBattleWorkflow({...f.args,beforeSearch:async()=>{gates++;assert(f.calls.some(q=>q.name==='battle_preflight'));assert.equal(f.calls.some(q=>q.op==='start-next'),false);return {cancelled:true,reason};}});
    assert.equal(gates,1);assert.equal(result.state,'cancelled-before-search');assert.equal(result.reason,reason);
    assert.equal(result.searchesAttempted,0);assert.equal(result.searchDispatched,false);assert.equal(result.ownerReleased,true);assert.equal(result.clientRetained,true);assert.equal(result.clientStopped,false);
    const release=f.calls.findIndex(q=>q.name==='battle_control_release');assert.equal(f.calls[release-1].op,'status');
    assert.equal(f.calls.filter(q=>q.name==='battle_control_release').length,1);
    assert.equal(f.calls.some(q=>q.op==='start-next'||q.op==='controller-run'||['battle_stop','battle_choose','battle_forfeit'].includes(q.name)),false);
  }
});

test('normal pre-search gate release preserves the one search and official review path',async()=>{
  const f=workflowFixture();let gates=0;
  const result=await runBattleWorkflow({...f.args,beforeSearch:async()=>{gates++;assert.equal(f.calls.some(q=>q.op==='start-next'),false);}});
  assert.equal(gates,1);assert.equal(result.state,'review-required');assert.equal(result.searchesAttempted,1);
  assert.equal(f.calls.filter(q=>q.op==='start-next').length,1);assert.equal(f.calls.filter(q=>q.name==='battle_control_release').length,1);
});

test('cancellation cannot release a newly active or changed owner and never retries an uncertain release',async()=>{
  for(const problem of ['active','owner','release-uncertain']){
    let cancellation=false;const f=workflowFixture({stateChange:state=>{
      state.controller={required:true,owner:cancellation&&problem==='owner'?'successor':'isolated-native-runner',generation:cancellation&&problem==='owner'?2:1};
      if(cancellation&&problem==='active')state.searchPending=true;
    }}),dispatch=f.operator.dispatch;
    f.operator.dispatch=async query=>{if(query.name==='battle_control_release'&&problem==='release-uncertain'){f.calls.push(structuredClone(query));throw new Error('Synthetic release uncertainty');}return dispatch(query);};
    await assert.rejects(runBattleWorkflow({...f.args,beforeSearch:async()=>{cancellation=true;return {cancelled:true};}}),error=>{
      assert.equal(error.liveOwnershipRetained,true);assert.equal(error.searchesAttempted,0);assert.equal(error.searchDispatchAttempted,false);assert.equal(error.searchDispatched,false);return true;
    });
    assert.equal(f.calls.filter(q=>q.name==='battle_control_release').length,problem==='release-uncertain'?1:0);
    assert.equal(f.calls.some(q=>q.op==='start-next'||q.name==='battle_stop'),false);
  }
});

test('a possibly dispatched search retains ownership and cannot be reclassified as pre-search cancellation',async()=>{
  const f=workflowFixture(),dispatch=f.operator.dispatch;let gates=0;
  f.operator.dispatch=async query=>{if(query.op==='start-next'){f.calls.push(structuredClone(query));throw new Error('Synthetic uncertain search');}return dispatch(query);};
  await assert.rejects(runBattleWorkflow({...f.args,beforeSearch:async()=>{gates++;}}),error=>{
    assert.equal(error.liveOwnershipRetained,true);assert.equal(error.searchesAttempted,1);assert.equal(error.searchDispatchAttempted,true);assert.equal(Object.hasOwn(error,'searchDispatched'),false);return true;
  });
  assert.equal(gates,1);assert.equal(f.calls.filter(q=>q.op==='start-next').length,1);
  assert.equal(f.calls.some(q=>['battle_control_release','battle_stop','battle_choose'].includes(q.name)),false);
});

test('an unsuccessful selected CLI qualification blocks every native operation before a search', async () => {
  const f = workflowFixture();
  const qualify=f.args.qualifyCodex;f.args.qualifyCodex=async options=>({...await qualify(options),qualified:false});
  await assert.rejects(runBattleWorkflow(f.args), {code: 'generation_unavailable'});
  assert.equal(f.calls.length, 0);
});

test('post-set persistence failure preserves client and never repeats the search or closes it', async () => {
  const f = workflowFixture({metricsReady: false}); await assert.rejects(runBattleWorkflow(f.args), {code: 'operator'});
  assert.equal(f.calls.filter(q => q.op === 'start-next').length, 1); assert(!f.calls.some(q => q.name === 'battle_stop'));
  assert.equal(f.calls.filter(q => q.name === 'battle_control_release').length, 1);
});

test('live decision failure is never interpreted as idle or permission for another model loop', async () => {
  const f = workflowFixture({runResult: {status: 'evidence-unavailable'}}); await assert.rejects(runBattleWorkflow(f.args), {code: 'operator'});
  assert.equal(f.calls.filter(q => q.op === 'start-next').length, 1); assert(!f.calls.some(q => q.name === 'battle_control_release' || q.name === 'battle_stop'));
});

test('the CLI retains the same SDK and private operator when post-search attention is unresolved', async () => {
  const f = workflowFixture({runResult: {status: 'evidence-unavailable'}}), output = [];
  let sdkClosed = 0, timingClosed = 0, handled = false;
  const client = {async close() {sdkClosed++;}};
  const recorder = createTimingRecorder({component: 'isolated_runner'});
  const result = await runRunner(['--run', '--session', 'fixture-session.json', '--scope', 'fixture-scope.json',...CLI_SELECTION], {
    codexProviderFactory:fixtureCliProvider, configurationReader: async () => ({identity: identity(), scope: scope(), ownTeamText: 'fixture team'}),
    connect: async () => ({client}), operatorFactory: () => f.operator, controllerFactory: f.createController,
    verifyPolicy: f.args.verifyPolicy, qualifyCodex: f.args.qualifyCodex,
    timingFactory: async () => ({recorder, async flush() {}, async close() {timingClosed++;}, status: () => ({})}),
    attentionHandler: async handles => {handled = true; assert.equal(handles.operator, f.operator); assert.equal(handles.sdk, client); assert.equal(sdkClosed, 0); return {resolved: false};},
    write: value => output.push(value),
  });
  assert(handled); assert.equal(result.state, 'attention-retained'); assert.equal(sdkClosed, 0); assert.equal(timingClosed, 0);
  assert(!JSON.stringify(output).includes(PRIVATE_FIXTURE_TEXT));
});

test('proven attention ownership loss closes only the old provider, timing and SDK',async()=>{
  const f=workflowFixture({runResult:{status:'decision-unavailable'},stateChange:value=>{value.controller={required:true,owner:'original-owner',generation:1};}});
  let sdkClosed=0,timingClosed=0,providerClosed=0;
  const result=await runRunner(['--run','--session','fixture-session.json','--scope','fixture-scope.json',...CLI_SELECTION],{
    codexProviderFactory:async options=>({...await fixtureCliProvider(options),close:async()=>{providerClosed++;}}),
    configurationReader:async()=>({identity:identity(),scope:scope(),ownTeamText:'fixture'}),connect:async()=>({client:{close:async()=>{sdkClosed++;}}}),
    operatorFactory:()=>f.operator,controllerFactory:f.createController,verifyPolicy:f.args.verifyPolicy,qualifyCodex:f.args.qualifyCodex,
    timingFactory:async()=>({recorder:createTimingRecorder({component:'isolated_runner'}),flush:async()=>{},close:async()=>{timingClosed++;},status:()=>({})}),
    attentionHandler:async handles=>{
      assert.deepEqual(handles.failure.ownedControllerProof,{owner:'original-owner',generation:1});
      const input=new PassThrough();
      const result=await serveAttentionMode({...handles,input,ownershipPollMs:5,prepareHandoff:async({operator})=>{
        const dispatch=f.operator.dispatch;f.operator.dispatch=async query=>query.op==='turn'?{result:{sessionId:identity().sessionId,teamId:TEAM,username:identity().account,
          observedAt:Date.now(),connected:true,authenticated:true,controller:{required:true,owner:'new-owner',generation:2}}}:dispatch(query);
        await operator.dispatch({id:'fresh-owner-observation',op:'turn'});return {state:'recovery-context',disposition:'unavailable'};
      }});input.destroy();return result;
    },write:()=>{}});
  assert.equal(result.state,'attention-ownership-lost');assert.equal(result.operatorRetained,false);assert.equal(result.clientStopped,false);
  assert.deepEqual([providerClosed,timingClosed,sdkClosed],[1,1,1]);
  assert.equal(f.calls.filter(query=>query.op==='start-next').length,1);
  assert(!f.calls.some(query=>query.name==='battle_control_release'||query.name==='battle_stop'||query.name==='battle_forfeit'||query.name==='battle_choose'));
});

test('idle pre-search failure closes the SDK without entering live attention mode', async () => {
  const f = workflowFixture({preflightReady: false}); let sdkClosed = 0, timingClosed = 0;
  await assert.rejects(runRunner(['--run', '--session', 'fixture-session.json', '--scope', 'fixture-scope.json',...CLI_SELECTION], {
    codexProviderFactory:fixtureCliProvider, configurationReader: async () => ({identity: identity(), scope: scope(), ownTeamText: 'fixture team'}),
    connect: async () => ({client: {async close() {sdkClosed++;}}}), operatorFactory: () => f.operator, controllerFactory: f.createController,
    verifyPolicy: f.args.verifyPolicy, qualifyCodex: f.args.qualifyCodex,
    timingFactory: async () => ({recorder: createTimingRecorder({component: 'isolated_runner'}), async flush() {}, async close() {timingClosed++;}, status: () => ({})}),
    attentionHandler: () => assert.fail('No live ownership'), write: () => {},
  }), {code: 'preflight'});
  assert.equal(sdkClosed, 1); assert.equal(timingClosed, 1);
});

test('the runner closes its resources after verified pre-search cancellation while retaining the native client',async()=>{
  for(const reason of ['manager-cancelled','manager-input-closed']){
    const f=workflowFixture();let sdkClosed=0,timingClosed=0,providerClosed=0,flushes=0;const output=[];
    const result=await runRunner(['--run','--session','fixture-session.json','--scope','fixture-scope.json',...CLI_SELECTION],{
      codexProviderFactory:async options=>({...await fixtureCliProvider(options),close:async()=>{providerClosed++;}}),
      configurationReader:async()=>({identity:identity(),scope:scope(),ownTeamText:'fixture team'}),connect:async()=>({client:{close:async()=>{sdkClosed++;}}}),
      operatorFactory:()=>f.operator,controllerFactory:f.createController,verifyPolicy:f.args.verifyPolicy,qualifyCodex:f.args.qualifyCodex,
      beforeSearch:async()=>({cancelled:true,reason}),attentionHandler:()=>assert.fail('Verified no-search cancellation needs no attention loop'),
      timingFactory:async()=>({recorder:createTimingRecorder({component:'isolated_runner'}),flush:async()=>{flushes++;},close:async()=>{timingClosed++;},status:()=>({})}),write:value=>output.push(value)});
    assert.equal(result.state,'cancelled-before-search');assert.equal(result.searchesAttempted,0);assert.equal(result.clientRetained,true);
    assert.deepEqual([providerClosed,timingClosed,sdkClosed],[1,1,1]);assert.equal(flushes,1);assert.equal(result.ponderEvidence,undefined);
    assert.equal(output.some(value=>value.state.startsWith('attention')),false);assert.equal(f.calls.some(q=>q.name==='battle_stop'||q.op==='start-next'),false);
  }
});

const HISTORICAL_PARENT = 'game-bestof3-gen9championsvgc2026regmcbo3-122';
function appliedFinalizerResult() {
  const retained = {path: `cache/bo3-runs/${PARENT}/isolated-model-trace.json`, eligible: false, reason: 'Useful private model evidence remains explicitly retained.'};
  return {parentId: PARENT, teamId: TEAM, dryRun: false, refresh: {}, archived: [], archiveFailures: [], replays: [], replayFailures: [],
    cleanup: {schemaVersion: 1, parentId: PARENT, teamId: TEAM, checkpointFile: 'cache/reviews/current.json',
      ready: true, blockers: [], childIds: [ROOM], reviewValidation: {complete: true, mode: 'structured-current-review', blockers: []},
      files: [retained], blocked: [retained], removed: [], kept: [retained], removedCount: 0, keptCount: 1},
    stableReport: {teamId: TEAM, path: `cache/team-metrics/reports/teams/${TEAM}.html`, revision: SHA, changed: false, games: 2}};
}
async function manualRecovery({mutateFinalizer, commands, configuredScope = scope(), failure = {code: 'operator', message: 'Fixture live attention', affectedParentId: PARENT, preSearchParentIds: [HISTORICAL_PARENT]}, rooms} = {}) {
  const calls = [], output = [], finalized = appliedFinalizerResult(); mutateFinalizer?.(finalized);
  const parents = rooms ?? [{id: PARENT, teamId: TEAM, ended: true, result: {type: 'win'}}, {id: HISTORICAL_PARENT, teamId: TEAM, ended: true, result: {type: 'win'}}];
  const operator = {async dispatch(query) {
    calls.push(structuredClone(query));
    let value;
    if (query.name === 'battle_status') value = {sessionId: identity().sessionId, teamSha256: TEAM, username: identity().account, connected: true, authenticated: true,
      search: {games: null, searching: []}, actions: [], rooms: parents};
    else if (query.name === 'team_metrics_finalize_bo3') value = finalized;
    else if (query.name === 'battle_review_status') value = {teamId: TEAM, parentId: query.args.parentId, complete: true, blockers: []};
    else if (query.name === 'team_metrics_sync_battles') value = {teamId: TEAM, recording: {state: 'ready', lastError: null}};
    else if (query.name === 'battle_stop') value = {stopped: true};
    else if (query.name === 'battle_forfeit') value = {forfeitRequested: true};
    else throw new Error('Unexpected manual recovery fixture command');
    return {result: {id: query.id, ok: true, result: value}, elapsedMs: 1};
  }};
  const queries = commands ?? [
    {id: 'finalize-current', op: 'call', name: 'team_metrics_finalize_bo3', args: {teamId: TEAM, parentId: PARENT, dryRun: false, confirmed: true, saveReplays: false}},
    {id: 'review-current', op: 'call', name: 'battle_review_status', args: {teamId: TEAM, parentId: PARENT}},
    {id: 'stop-current', op: 'call', name: 'battle_stop', args: {confirmed: true, commandId: 'stop-current'}},
  ];
  const result = await serveAttentionMode({operator, identity: identity(), scope: configuredScope, runId, failure,
    input: Readable.from(queries.map(query => JSON.stringify(query) + '\n')), write: value => output.push(value)});
  return {result, calls, output};
}

test('attention cue orders same-owner fresh-pair protection before reports and preserves model-owned MCP checks and manual readiness',async()=>{
  const f=await manualRecovery({commands:[]});const cue=f.output.find(value=>value.state==='attention-required');
  assert.match(cue.recovery,/Keep this same owner/u);assert.match(cue.recovery,/protect a fresh complete useful pair before reports or forensics/u);
  assert.match(cue.recovery,/actual model-requested MCP checks remain active/u);assert.match(cue.recovery,/prepare the next plan before confirming/u);
  assert.match(cue.recovery,/No further model decisions, readiness acknowledgements or searches run automatically/u);
  assert.equal(f.calls.some(q=>q.name==='battle_ready'),false);
});

test('attention prefetches current context before early input and explicit recovery keeps the original controller', async () => {
  const output = [], calls = [], reads = [], expectedRequest = {room: ROOM, rqid: 9, token: 'd'.repeat(64)};
  const query = {id: 'resume-owned', op: 'recover-current', expectedRequest, continueSet: true};
  let time = 1000;
  const controller = {
    async recoverCurrent(args) {calls.push(structuredClone(args)); time += 12; return {status: 'submitted', parentId: PARENT};},
    async runSet() {calls.push('continue-same-set'); return {status: 'review-required', parentId: PARENT};},
  };
  await serveAttentionMode({operator: {dispatch() {assert.fail('No manual native operation is needed');}}, identity: identity(), scope: scope(),
    runId, controller, now: () => time, failure: {code: 'operator', message: 'fixture', affectedParentId: PARENT},
    prepareHandoff: async args => {reads.push(args); await Promise.resolve(); time += 3;
      return {state: 'recovery-context', disposition: 'actionable', binding: expectedRequest};},
    input: Readable.from([JSON.stringify(query) + '\n', JSON.stringify(query) + '\n']), write: value => output.push(value)});
  assert.equal(reads[0].parentId, PARENT); assert.equal(reads[0].identity.sessionId, identity().sessionId);
  assert.deepEqual(calls, [{expectedRequest}, 'continue-same-set']);
  assert.deepEqual(output.slice(0, 3).map(row => row.state), ['attention-required', 'recovery-context', 'recovery-input-received']);
  assert.equal(output.find(row => row.state === 'recovery-context').handoffDelayMs, 3);
  assert.equal(output.find(row => row.state === 'recovery-result').completedAt, 1015);
  assert.equal(output.filter(row => row.state === 'isolated-resumed').length, 1);
  assert(output.some(row => row.state === 'recovery-result' && row.cached === true));
  assert(output.some(row => row.state === 'isolated-resume-result' && row.reviewRequired));
  assert(!JSON.stringify(output).includes(PRIVATE_FIXTURE_TEXT));
});

test('refused recovery never resumes a loop and host cannot widen recovery scope', async () => {
  const output = [], calls = [], expectedRequest = {room: ROOM, rqid: 9, token: 'd'.repeat(64)};
  const commands = [
    {id: 'reserved', op: 'recover-current', expectedRequest, continueSet: true},
    {id: 'reserved', op: 'recover-current', expectedRequest: {...expectedRequest, rqid: 10}},
    {id: 'wider', op: 'recover-current', expectedRequest, model: 'other-model'},
    {id: 'bad-boolean', op: 'recover-current', expectedRequest, continueSet: 'true'},
  ];
  await serveAttentionMode({operator: {dispatch() {assert.fail('Not a generic proxy');}}, identity: identity(), scope: scope(), runId,
    controller: {async recoverCurrent(args) {calls.push(args); return {status: 'recovery-blocked', reason: 'already-reserved'};},
      runSet() {assert.fail('Refusal is not submission');}},
    failure: {code: 'operator', message: 'fixture', affectedParentId: PARENT},
    prepareHandoff: async () => ({state: 'recovery-context', disposition: 'wait'}),
    input: Readable.from(commands.map(query => JSON.stringify(query) + '\n')), write: value => output.push(value)});
  assert.equal(calls.length, 1); assert.equal(output.filter(row => row.state === 'manual-command-blocked').length, 3);
  assert(!output.some(row => row.state === 'isolated-resumed'));
});

test('fault notification is emitted without private source before handoff preparation', () => {
  const event = {type: 'controller.unavailable', at: 1234, code: 'ISOLATED_CONTEXT_OVERFLOW', stage: 'first-context', apiAttempted: false,
    token: 'secret-token', source: {apiKey: PRIVATE_FIXTURE_TEXT}, binding: {sessionId: 'private-session'}};
  const notice = controllerAttentionNotice(event, runId);
  assert.equal(notice.detectedAt, 1234); assert.equal(notice.apiAttempted, false);
  for (const secret of ['secret-token', PRIVATE_FIXTURE_TEXT, 'private-session']) assert(!JSON.stringify(notice).includes(secret));
  assert.equal(controllerAttentionNotice({type: 'decision.complete'}, runId), null);
  assert(controllerAttentionNotice({...event, type: 'controller.preparation-failed'}, runId));
});

test('a fresh native takeover retires the old attention owner without releasing or mutating reservations',async()=>{
  const input=new PassThrough(),output=[],calls=[],proof={owner:'original-owner',generation:1};
  const pending={attempted:true,state:'uncertain',token:'PRIVATE-RESERVATION'};
  const result=await serveAttentionMode({operator:{async dispatch(query){calls.push(query);return {result:{sessionId:identity().sessionId,teamId:TEAM,username:identity().account,
    observedAt:Date.now(),connected:true,authenticated:true,controller:{required:true,owner:'new-owner',generation:2},controlPolicy:{pending:[pending]}}};}},
    identity:identity(),scope:scope(),runId,input,write:value=>output.push(value),ownershipPollMs:5,
    failure:{code:'generation_failed',message:'fixture',affectedParentId:PARENT,ownedControllerProof:proof},
    prepareHandoff:async()=>({state:'recovery-context',disposition:'unavailable'})});
  input.destroy();
  assert.deepEqual(result,{resolved:true,ownershipLost:true,clientStopped:false,reservationsPreserved:true});
  assert.equal(calls.length,1);assert.equal(calls[0].op,'turn');assert.equal(calls[0].full,true);
  assert.equal(pending.attempted,true);assert.equal(pending.state,'uncertain');
  assert(output.some(value=>value.state==='attention-ownership-lost'&&value.operatorRetained===false));
  assert(!JSON.stringify(output).includes('PRIVATE-RESERVATION'));
});

test('the actual native compact turn through the maintained operator carries enough fresh ownership proof',async()=>{
  const [{AgentSession},{ShowdownClient}]=await Promise.all([import('../showdown/agent-session.mjs'),import('../showdown/client.mjs')]);
  const packed='FixtureSpecies|fixtureitem|fixtureability|fixturemove',team=createHash('sha256').update(packed).digest('hex');
  const client=new ShowdownClient({expectedTeamHash:team});client.connected=true;client.authenticated=true;
  const session=new AgentSession(client,{username:'Fixture User',packed,authorizedSets:1,autoReady:false});
  const old=session.controller.claim({controllerId:'original-owner'}),proof={owner:old.owner,generation:old.generation};
  session.controller.claim({controllerId:'new-owner',takeover:true,expectedGeneration:old.generation});
  const calls=[],input=new PassThrough(),output=[];
  const operator=createOperator({responseFile:'in-memory-only',publish:async()=>{},client:{async callTool(request){calls.push(request.name);
    assert(['battle_turn_status','battle_status'].includes(request.name));
    const value=request.name==='battle_turn_status'?session.turnSnapshot():session.snapshot();
    if(request.name==='battle_turn_status'){assert.equal(value.teamId,undefined);assert.equal(value.teamSha256,undefined);assert(Number.isSafeInteger(value.observedAt));}
    else{assert.equal(value.teamSha256,team);assert.equal(value.observedAt,undefined);}
    return {structuredContent:{ok:true,result:value}};}}});
  try{
    const result=await serveAttentionMode({operator,identity:{...identity(),sessionId:session.id,teamId:team},scope:scope(),runId,input,write:value=>output.push(value),
      ownershipPollMs:5,failure:{code:'generation_failed',message:'fixture',affectedParentId:PARENT,ownedControllerProof:proof}});
    assert.equal(result.ownershipLost,true);assert.equal(result.clientStopped,false);assert.deepEqual(calls,['battle_turn_status','battle_status']);
    assert(!output.some(value=>value.disposition==='actionable'));assert.equal(session.controller.status().owner,'new-owner');assert.equal(session.stopped,false);
  }finally{input.destroy();session.dispose();}
});

test('failed, stale, foreign and incomplete reads never establish a takeover or a safe resend',async()=>{
  for(const change of [value=>{value.observedAt=0;},value=>{value.sessionId='foreign';},value=>{value.teamId='c'.repeat(64);},
    value=>{value.controller.generation=0;},value=>{delete value.controller;},value=>{value.ok=false;},value=>{value.controller={required:true,owner:'original-owner',generation:1};}]){
    const input=new PassThrough(),output=[];let calls=0,allowValid=false;
    const serving=serveAttentionMode({operator:{async dispatch(query){calls++;assert.equal(query.op,'turn');const value={sessionId:identity().sessionId,teamId:TEAM,username:identity().account,
      observedAt:Date.now(),connected:true,authenticated:true,controller:{required:true,owner:'new-owner',generation:2}};if(!allowValid)change(value);return {result:value};}},
      identity:identity(),scope:scope(),runId,input,write:value=>output.push(value),ownershipPollMs:5,
      failure:{code:'operator',message:'fixture',affectedParentId:PARENT,ownedControllerProof:{owner:'original-owner',generation:1}},
      prepareHandoff:async()=>({state:'recovery-context',disposition:'unavailable'})});
    await delay(18);input.end();assert(!output.some(value=>value.state==='attention-ownership-lost'));assert(calls>=1);
    allowValid=true;assert.equal((await serving).ownershipLost,true);
  }
});

test('unsettled attention reads retain their serialization slot and never cause another read or mutation',async()=>{
  const input=new PassThrough(),output=[];let settle,calls=0;
  const pending=new Promise(resolve=>{settle=resolve;});
  const serving=serveAttentionMode({operator:{async dispatch(){calls++;await pending;return {result:{sessionId:identity().sessionId,teamId:TEAM,username:identity().account,
    observedAt:Date.now(),connected:true,authenticated:true,controller:{required:true,owner:'new-owner',generation:2}}}; }},identity:identity(),scope:scope(),runId,input,
    write:value=>output.push(value),ownershipPollMs:5,failure:{code:'operator',message:'fixture',affectedParentId:PARENT,ownedControllerProof:{owner:'original-owner',generation:1}},
    prepareHandoff:async({operator})=>{void operator.dispatch({id:'initial-read',op:'turn'});return {state:'recovery-context',disposition:'unavailable'};}});
  await delay(25);input.end();await delay(15);assert.equal(calls,1);assert(!output.some(value=>value.state==='attention-ownership-lost'));
  settle();assert.equal((await serving).ownershipLost,true);assert.equal(calls,1);
});

test('a queued command cannot cross a takeover that settles during its handoff drain',async()=>{
  for(const query of [{id:'queued-forfeit',op:'call',name:'battle_forfeit',args:{confirmed:true,room:PARENT,commandId:'queued-forfeit'}},
    {id:'queued-recovery',op:'recover-current',expectedRequest:{room:ROOM,rqid:3,token:'b'.repeat(64)}}]){
    const input=new PassThrough(),output=[];let settle,dispatches=0;
    const pending=new Promise(resolve=>{settle=resolve;});
    const result=await serveAttentionMode({operator:{async dispatch(q){dispatches++;assert.equal(q.op,'turn');await pending;
      return {result:{sessionId:identity().sessionId,teamId:TEAM,username:identity().account,observedAt:Date.now(),connected:true,authenticated:true,
        controller:{required:true,owner:'new-owner',generation:2}}};}},identity:identity(),scope:{...scope(),allowManualForfeit:true},runId,input,write:value=>output.push(value),ownershipPollMs:5,
      controller:{recoverCurrent:()=>assert.fail('Revoked owner cannot invoke a recovery author')},
      failure:{code:'operator',message:'fixture',affectedParentId:PARENT,ownedControllerProof:{owner:'original-owner',generation:1}},
      prepareHandoff:async({operator})=>{void operator.dispatch({id:'pending-read',op:'turn'});input.write(JSON.stringify(query)+'\n');setTimeout(settle,15);return {state:'recovery-context',disposition:'unavailable'};}});
    input.destroy();assert.equal(result.ownershipLost,true);assert.equal(dispatches,1);assert(!output.some(value=>value.state==='manual-result'||value.state==='recovery-input-received'));
  }
});

test('compact takeover without a team hash requires a timely matching full-status confirmation, including after EOF',async()=>{
  for(const variant of ['missing-team','wrong-account','stale-status','changed-again','late-status']){
    const input=new PassThrough(),output=[];let valid=false,at=1000,statusReads=0;
    const native=()=>({sessionId:identity().sessionId,connected:true,authenticated:true,controller:{required:true,owner:'new-owner',generation:valid&&variant==='changed-again'?3:2}});
    const serving=serveAttentionMode({operator:{async dispatch(query){
      if(query.op==='turn')return {result:{...native(),observedAt:at}};
      assert.equal(query.op,'status');statusReads++;
      const value={...native(),teamSha256:TEAM,username:identity().account};
      if(!valid){
        if(variant==='missing-team')delete value.teamSha256;
        if(variant==='wrong-account')value.username='Foreign';
        if(variant==='stale-status')value.observedAt=0;
        if(variant==='changed-again')value.controller.generation=3;
        if(variant==='late-status')at+=1500;
      }
      return {result:value};
    }},identity:identity(),scope:scope(),runId,input,now:()=>at,write:value=>output.push(value),ownershipPollMs:5,
      failure:{code:'operator',message:'fixture',affectedParentId:PARENT,ownedControllerProof:{owner:'original-owner',generation:1}},
      prepareHandoff:async()=>({state:'recovery-context',disposition:'unavailable'})});
    await delay(18);input.end();await delay(8);assert(statusReads>=1,variant);assert(!output.some(value=>value.state==='attention-ownership-lost'),variant);
    assert(output.some(value=>value.state==='attention-input-closed'),variant);
    valid=true;assert.equal((await serving).ownershipLost,true,variant);
  }
});

test('a timed-out full-status confirmation blocks queued recovery without consuming its command ID',async()=>{
  const input=new PassThrough(),output=[],query={id:'same-after-confirmation',op:'recover-current',expectedRequest:{room:ROOM,rqid:3,token:'b'.repeat(64)}};
  let releaseCompact,releaseStatus,preparations=0,recoveries=0,released=false,statusCalls=0;
  const compactPending=new Promise(resolve=>{releaseCompact=resolve;}),statusPending=new Promise(resolve=>{releaseStatus=resolve;});
  const changed=()=>({sessionId:identity().sessionId,username:identity().account,observedAt:Date.now(),connected:true,authenticated:true,
    controller:{required:true,owner:'new-owner',generation:2}});
  const result=await serveAttentionMode({operator:{async dispatch(q){
    if(q.op==='status'){statusCalls++;await statusPending;return {result:{}};}
    assert.equal(q.op,'turn');if(!released)await compactPending;
    return {result:{...changed(),...(released?{teamId:TEAM}:{})}};
  }},identity:identity(),scope:scope(),runId,input,ownershipPollMs:5000,
    failure:{code:'operator',message:'fixture',affectedParentId:PARENT,ownedControllerProof:{owner:'original-owner',generation:1}},
    controller:{async recoverCurrent(){assert.equal(released,true,'No author may start behind an unsettled confirmation');recoveries++;return {status:'refused'};}},
    prepareHandoff:async({operator})=>{
      if(preparations++===0){void operator.dispatch({id:'deferred-compact',op:'turn'});input.write(JSON.stringify(query)+'\n');setTimeout(releaseCompact,10);}
      else await operator.dispatch({id:'fresh-after-recovery',op:'turn'});
      return {state:'recovery-context',disposition:'unavailable'};
    },write:value=>{
      output.push(value);
      if(value.state==='manual-command-blocked'&&value.id===query.id){
        assert.equal(value.code,'operator-busy');assert.equal(recoveries,0);assert(!output.some(row=>row.state==='recovery-input-received'));
        released=true;releaseStatus();setTimeout(()=>input.write(JSON.stringify(query)+'\n'),10);
      }
    }});
  input.destroy();assert.equal(result.ownershipLost,true);assert.equal(statusCalls,1);assert.equal(recoveries,1);
  assert.equal(output.filter(value=>value.state==='recovery-input-received').length,1);
  assert.equal(output.filter(value=>value.state==='recovery-result').length,1);assert(!output.some(value=>value.cached===true));
});

test('timed-out prefetch drains before recovery without spending a token on a busy read', async () => {
  const output = [], expectedRequest = {room: ROOM, rqid: 9, token: 'd'.repeat(64)};
  let busy = false, recovered = 0, reads = 0;
  await serveAttentionMode({operator: {async dispatch() {assert.equal(busy, false); busy = true; await delay(50); busy = false; return {}; }},
    identity: identity(), scope: scope(), runId, failure: {code: 'operator', message: 'fixture', affectedParentId: PARENT},
    prepareHandoff: async ({operator}) => {
      if (reads++ === 0) {void operator.dispatch({id: 'prefetch', op: 'turn'}); await delay(5);}
      return {state: 'recovery-context', disposition: 'unavailable', reason: 'native-read-timeout'};
    },
    controller: {async recoverCurrent() {assert.equal(busy, false); recovered++; return {status: 'submitted'};}},
    input: Readable.from([JSON.stringify({id: 'after-prefetch', op: 'recover-current', expectedRequest}) + '\n']), write: value => output.push(value)});
  assert.equal(recovered, 1); assert(!output.some(row => row.code === 'operator-busy'));
});

test('hung prefetch refuses early input without reserving its recovery command ID', async () => {
  const output = [], expectedRequest = {room: ROOM, rqid: 9, token: 'd'.repeat(64)};
  const line = JSON.stringify({id: 'same-after-drain', op: 'recover-current', expectedRequest}) + '\n';
  let busy = false, recovered = 0, reads = 0;
  async function* commands() {yield line; await delay(650); yield line;}
  await serveAttentionMode({operator: {async dispatch() {busy = true; await delay(550); busy = false; return {}; }},
    identity: identity(), scope: scope(), runId, failure: {code: 'operator', message: 'fixture', affectedParentId: PARENT},
    prepareHandoff: async ({operator}) => {if (reads++ === 0) void operator.dispatch({id: 'prefetch', op: 'turn'});
      return {state: 'recovery-context', disposition: 'unavailable', reason: 'native-read-timeout'};},
    controller: {async recoverCurrent() {assert.equal(busy, false); recovered++; return {status: 'submitted'};}},
    input: Readable.from(commands()), write: value => output.push(value)});
  assert.equal(recovered, 1); assert(output.some(row => row.code === 'operator-busy'));
  assert(!output.some(row => row.cached === true));
});

test('input arrival and processing timestamps retain time queued during handoff', async () => {
  const input = new PassThrough(), output = []; let time = 1000;
  await serveAttentionMode({operator: {async dispatch() {return {result: {ok: true}};}}, identity: identity(), scope: scope(), runId,
    now: () => time, failure: {code: 'operator', message: 'fixture', affectedParentId: PARENT},
    prepareHandoff: async () => {input.end(JSON.stringify({id: 'queued', op: 'turn'}) + '\n'); time = 1050;
      return {state: 'recovery-context', disposition: 'unavailable'};},
    input, write: value => output.push(value)});
  const result = output.find(row => row.state === 'manual-result');
  assert.equal(result.inputReceivedAt, 1000); assert.equal(result.inputProcessedAt, 1050); assert.equal(result.inputQueuedMs, 50);
});

test('actual-shaped applied native finalization permits exact-parent review and stop with protected files retained', async () => {
  const f = await manualRecovery();
  assert.deepEqual(f.result, {resolved: true, clientStopped: true});
  assert.equal(f.calls.filter(query => query.name === 'battle_stop').length, 1);
  assert(f.calls.filter(query => query.name === 'battle_review_status').every(query => query.args.parentId === PARENT));
  assert(!f.output.some(value => value.state === 'manual-command-blocked'));
});

test('manual stuck forfeits have separate explicit scope and never enable automatic forfeits', async () => {
  const query = {id: 'manual-forfeit', op: 'call', name: 'battle_forfeit', args: {room: PARENT, confirmed: true, commandId: 'manual-forfeit'}};
  const allowedScope = {...scope(), allowManualForfeit: true};
  assert.equal(validateScopeConfiguration(allowedScope, identity()).controlPolicy.forfeitIfStuck, false);
  const allowed = await manualRecovery({configuredScope: allowedScope, commands: [query]});
  assert.equal(allowed.calls.filter(call => call.name === 'battle_forfeit').length, 1);
  assert(!allowed.output.some(row => row.state === 'manual-command-blocked'));
  assert(!allowed.calls.some(call => call.name === 'battle_set_control_policy'));
  for (const configuredScope of [scope(), {...scope(), allowManualForfeit: false}, {...scope(), controlPolicy: {...policy(), forfeitIfStuck: true}}]) {
    const denied = await manualRecovery({configuredScope, commands: [query]});
    assert.equal(denied.calls.filter(call => call.name === 'battle_forfeit').length, 0);
    assert(denied.output.some(row => row.state === 'manual-command-blocked' && row.code === 'configuration'));
  }
});

test('attention prepares an exact-parent manual containment command only with the existing grant and never sends it by itself',async()=>{
  const configuredScope={...scope(),allowManualForfeit:true},before=structuredClone(configuredScope);
  const template=manualContainmentTemplate({identity:identity(),scope:configuredScope,parentId:PARENT,runId});
  assert.equal(template.manualOnly,true);assert.equal(template.command.name,'battle_forfeit');
  assert.equal(template.command.args.room,PARENT);assert.equal(template.command.args.commandId,template.command.id);
  assert.equal(Object.hasOwn(template.command.args,'controllerLease'),false);
  assert.deepEqual(manualContainmentTemplate({identity:identity(),scope:configuredScope,parentId:PARENT,runId}),template);
  assert.notEqual(manualContainmentTemplate({identity:identity(),scope:configuredScope,parentId:PARENT,runId:'different-run'}).command.id,template.command.id);
  const prepared=await manualRecovery({configuredScope,commands:[]});
  assert.deepEqual(prepared.output.find(row=>row.state==='attention-required').manualContainment,template);
  assert.equal(prepared.calls.some(row=>['battle_forfeit','battle_ready','battle_start','battle_set_control_policy'].includes(row.name)),false);
  assert.deepEqual(configuredScope,before);assert.equal(configuredScope.controlPolicy.forfeitIfStuck,false);
});

test('containment templates cannot infer a grant from automatic policy or bind a different session/team/account or malformed parent',()=>{
  const granted={...scope(),allowManualForfeit:true};
  for(const configuredScope of [scope(),{...scope(),controlPolicy:{...policy(),forfeitIfStuck:true}},{...granted,allowManualForfeit:false},{...granted,allowManualForfeit:'true'},{...granted,sessionId:'other'},{...granted,teamId:SHA},{...granted,account:'Other'},{...granted,maxSets:2}]) {
    assert.equal(manualContainmentTemplate({identity:identity(),scope:configuredScope,parentId:PARENT,runId}),null);
  }
  for(const parentId of [undefined,ROOM,PARENT+'\nextra',PARENT+';bad'])assert.equal(manualContainmentTemplate({identity:identity(),scope:granted,parentId,runId}),null);
  for(const broken of [{...identity(),sessionId:null},{...identity(),teamId:null},{...identity(),account:''}])assert.equal(manualContainmentTemplate({identity:broken,scope:{...granted,...broken},parentId:PARENT,runId}),null);
  const privateParent=PARENT+'-privatepw';
  assert.equal(manualContainmentTemplate({identity:identity(),scope:granted,parentId:privateParent,runId}).command.args.room,privateParent);
});

test('dry-run, failed preservation, blocked cleanup and wrong native identity cannot qualify shutdown', async () => {
  const countercases = [
    value => {value.dryRun = true; delete value.cleanup.removed; delete value.cleanup.kept;},
    value => value.archiveFailures.push({roomId: ROOM, error: 'Evidence unavailable'}),
    value => value.replayFailures.push({roomId: ROOM, error: 'Replay unavailable'}),
    value => {value.cleanup.ready = false; value.cleanup.blockers.push('Missing durable child');},
    value => value.cleanup.reviewValidation.complete = false,
    value => value.parentId = HISTORICAL_PARENT,
    value => value.teamId = SHA,
    value => value.cleanup.parentId = HISTORICAL_PARENT,
    value => {value.stableReport.archived = true; value.stableReport.path = null;},
  ];
  for (const mutateFinalizer of countercases) {
    const f = await manualRecovery({mutateFinalizer});
    assert.deepEqual(f.result, {resolved: false});
    assert.equal(f.calls.filter(query => query.name === 'battle_stop').length, 0);
    assert(f.output.some(value => value.id === 'stop-current' && value.state === 'manual-command-blocked' && value.code === 'review'));
  }
});

test('historical finalization cannot substitute for the failed controller parent even when that room is last', async () => {
  const f = await manualRecovery({commands: [
    {id: 'finalize-history', op: 'call', name: 'team_metrics_finalize_bo3', args: {teamId: TEAM, parentId: HISTORICAL_PARENT, dryRun: false, confirmed: true}},
    {id: 'stop-current', op: 'call', name: 'battle_stop', args: {confirmed: true, commandId: 'stop-current'}},
  ]});
  assert.deepEqual(f.result, {resolved: false});
  assert(!f.calls.some(query => ['team_metrics_finalize_bo3', 'battle_stop'].includes(query.name)));
  assert(f.calls.filter(query => query.name === 'battle_review_status').every(query => query.args.parentId === PARENT));
  assert(f.output.some(value => value.id === 'finalize-history' && value.state === 'manual-command-blocked'));
});

test('manual recovery can bind one uniquely new parent but refuses missing or ambiguous provenance', async () => {
  const unique = await manualRecovery({failure: {code: 'operator', message: 'Fixture attention', preSearchParentIds: [HISTORICAL_PARENT]}});
  assert.equal(unique.result.resolved, true);
  const noBaseline = await manualRecovery({failure: {code: 'operator', message: 'Fixture attention'}});
  assert.equal(noBaseline.result.resolved, false); assert(!noBaseline.calls.some(query => query.name === 'battle_stop'));
  const ambiguous = await manualRecovery({failure: {code: 'operator', message: 'Fixture attention', preSearchParentIds: []}});
  assert.equal(ambiguous.result.resolved, false); assert(!ambiguous.calls.some(query => ['team_metrics_finalize_bo3', 'battle_stop'].includes(query.name)));
});

test('live failure carries the controller parent and pre-search parent set into retained recovery', async () => {
  const f = workflowFixture({runResult: {status: 'evidence-unavailable', parentId: `${PARENT}-privatepw`},
    stateChange: value => {if (!value.rooms.length) value.rooms.push({id: HISTORICAL_PARENT, ended: true, result: {type: 'win'}});}});
  await assert.rejects(runBattleWorkflow(f.args), error => error.liveOwnershipRetained === true && error.affectedParentId === PARENT &&
    JSON.stringify(error.preSearchParentIds) === JSON.stringify([HISTORICAL_PARENT]));
});

test('controller preparation and diagnostic-write failures retain specific safe attention metadata and ownership',async()=>{
  for(const [status,expectedCode,diagnosticPreserved]of [['controller-unavailable','controller_preparation',true],['diagnostic-evidence-unavailable','trace',false]]){
    const f=workflowFixture({runResult:{status,parentId:PARENT,stage:'first-context',code:status==='controller-unavailable'?'ISOLATED_CONTEXT_OVERFLOW':'CONTROLLER_DIAGNOSTIC_WRITE_FAILED',diagnosticPreserved}});
    await assert.rejects(runBattleWorkflow(f.args),error=>error.code===expectedCode&&error.liveOwnershipRetained===true&&error.controllerStage==='first-context'&&
      error.controllerErrorCode===(diagnosticPreserved?'ISOLATED_CONTEXT_OVERFLOW':'CONTROLLER_DIAGNOSTIC_WRITE_FAILED')&&error.diagnosticPreserved===diagnosticPreserved);
  }
});

test('live model deadline retains generation taxonomy, original code and same-owner controller instead of native operator failure',async()=>{
  const f=workflowFixture({runResult:{status:'decision-unavailable',parentId:PARENT,stage:'model-tool-cycle',code:'MODEL_PROVIDER_DEADLINE_EXCEEDED',providerFailureCode:'deadline_exceeded',detectedAt:1000,diagnosticPreserved:true}});
  await assert.rejects(runBattleWorkflow(f.args),error=>error.code==='generation_failed'&&error.controllerErrorCode==='MODEL_PROVIDER_DEADLINE_EXCEEDED'&&error.controllerStage==='model-tool-cycle'&&error.providerFailureCode==='deadline_exceeded'&&
    error.liveOwnershipRetained===true&&error.diagnosticPreserved===true&&Boolean(error.recoveryController));
  assert.equal(f.calls.some(q=>q.name==='battle_control_release'),false);
  const first=controllerAttentionNotice({type:'decision.provider-failed',decisionPhase:'first',providerKind:'codex-cli',code:'deadline_exceeded',providerAttempted:true,apiAttempted:false,at:1000},runId);
  assert.equal(first.stage,'first-provider');assert.equal(first.code,'deadline_exceeded');assert.equal(first.apiAttempted,false);assert.equal(first.providerAttempted,true);
  assert.equal(controllerAttentionNotice({type:'decision.provider-failed',decisionPhase:'rich',providerKind:'codex-cli',code:'deadline_exceeded'},runId),null);
});

test('only an explicit 60s preview scope opts into bounded clock acquisition; turn45/unknown20 remain unchanged',async()=>{
  for(const previewPlanningMs of [20000,60000]){
    const f=workflowFixture(),seen=[];f.args.scope.controlPolicy={...f.args.scope.controlPolicy,planningMs:45000,previewPlanningMs};
    const controller=f.args.createController;f.args.createController=config=>{seen.push(config);return controller(config);};
    f.operator.dispatch=((base)=>async q=>{const result=await base(q);if(['status','turn'].includes(q.op))Object.assign(result.result.controlPolicy,f.args.scope.controlPolicy);return result;})(f.operator.dispatch.bind(f.operator));
    await runBattleWorkflow(f.args);assert.equal(seen[0].previewClockWaitMs,previewPlanningMs===60000?2000:undefined);assert.equal(seen[0].maxModelMs,previewPlanningMs===60000?60000:undefined);
    assert.equal(f.args.scope.controlPolicy.planningMs,45000);assert.equal(f.args.scope.controlPolicy.unknownClockMs,20000);assert.equal(f.args.scope.controlPolicy.safetyMarginMs,5000);
  }
  const invalid=scope();invalid.controlPolicy.previewPlanningMs=60000;invalid.controlPolicy.unknownClockMs=19000;
  assert.throws(()=>validateScopeConfiguration(invalid,identity()),{code:'configuration'});
});

test('an unresolved preview admission read is retained into attention before any handoff read',async()=>{
  let settle;const pending=new Promise(resolve=>{settle=resolve;}),input=new PassThrough(),output=[];let reads=0;
  const serving=serveAttentionMode({operator:{dispatch:()=>assert.fail('No dispatch around an unresolved read')},identity:identity(),scope:scope(),runId,input,
    failure:{code:'controller_preparation',message:'Fixture admission timeout',pendingOperatorRead:pending},
    prepareHandoff:async()=>{reads++;return{state:'recovery-context'};},write:value=>{output.push(value);if(value.state==='recovery-context-unavailable'){
      assert.equal(reads,0);settle({});setTimeout(()=>{input.write(JSON.stringify({id:'refresh',op:'recovery-context'})+'\n');input.end();},5);
    }}});
  await serving;assert.equal(reads,1);assert(output.some(row=>row.state==='recovery-context-unavailable'));assert(output.some(row=>row.state==='recovery-context'));
});

function evidence(overrides = {}) {
  return {phase: 'decision',provider:{kind:'codex-cli',model:'gpt-6.1-sol',reasoningEffort:'low',selectionEvidence:'host-declared-request'}, context: {instructions: 'Fixture policy', input: JSON.stringify({board: 'current', apiKey: 'DROP-ME', text: PRIVATE_FIXTURE_TEXT}), schema: {type: 'object'}, promptMetadata: {totalBytes: 100}},
    decision: {actions: [{type: 'move', slot: 1}], reason: 'Bounded selected intent', token: 'DROP-REQUEST-TOKEN'},
    telemetry: {requestWallTimeMs: 7.5, inputTokens: 30, processingMs: null, authorization: 'DROP-ME', arbitraryRawResponse: 'DROP-ME'},
    binding: {teamId: TEAM, parentId: PARENT, room: `${ROOM}-secretpw`, rqid: 3, requestDigest: SHA, requestKey: SHA, token: 'DROP-REQUEST-TOKEN'}, ...overrides};
}

test('durable trace preserves sanitized prompt, selection and telemetry with exact native-parent ownership', async t => {
  const dir = await workspace(t), trace = createModelTraceStore({workspace: dir, teamId: TEAM, runId, secrets: [PRIVATE_FIXTURE_TEXT]});
  const saved = await trace.append(evidence()); const text = await readFile(join(dir, saved.path), 'utf8'), document = JSON.parse(text);
  assert.equal(document.teamId, TEAM); assert.equal(document.parentId, PARENT); assert.equal(document.entries[0].binding.room, ROOM);
  assert.equal(document.entries[0].telemetry.requestWallTimeMs, 7.5); assert.equal(document.entries[0].telemetry.processingMs, undefined);
  for (const secret of [PRIVATE_FIXTURE_TEXT, 'DROP-ME', 'DROP-REQUEST-TOKEN', 'secretpw', 'arbitraryRawResponse']) assert(!text.includes(secret), secret);
  assert.equal(trace.status().appended, 1); assert.equal(saved.path, `cache/bo3-runs/${PARENT}/isolated-model-trace.json`);
});







function controllerFailureEvidence(){
  return {phase:'controller-failure',binding:evidence().binding,diagnostic:{version:1,engineeringOnly:true,apiAttempted:false,stage:'first-context',code:'ISOLATED_CONTEXT_OVERFLOW',capturedAt:1000,
    promptMetadata:{totalBytes:30378,maxBytes:24000},source:{kind:'controller-preparation-source-v1',engineeringOnly:true,
      state:{teamId:TEAM,sessionId:'DROP-SESSION',actions:[{room:ROOM,parentId:PARENT,rqid:3,token:'DROP-REQUEST-TOKEN',legalActions:{active:[{moves:[{move:'Protect',pp:2,disabled:false}]}]}}],
        boards:[{room:ROOM,turn:2,field:{weather:null},controllerLease:'DROP-LEASE',controlLease:'DROP-LEASE',readReceipt:'DROP-RECEIPT',assertion:'DROP-ASSERTION'}]},
      opponentSheet:[{species:'Fixture',moves:['Protect']}],strategicMemory:{claims:{objective:'Retain useful pressure'}},ownTeamText:'Fixture team',apiKey:'DROP-ME',text:PRIVATE_FIXTURE_TEXT}}};
}

test('engineering controller failure is durable, parent-owned and separate from authored model decisions',async t=>{
  const dir=await workspace(t),trace=createModelTraceStore({workspace:dir,teamId:TEAM,runId,secrets:[PRIVATE_FIXTURE_TEXT]});
  await trace.append(evidence());const saved=await trace.append(controllerFailureEvidence());
  const text=await readFile(join(dir,saved.path),'utf8'),document=JSON.parse(text),failure=document.entries[1];
  assert.equal(document.entries[0].phase,'decision');assert.equal(failure.phase,'controller-failure');assert.equal(failure.diagnostic.apiAttempted,false);
  assert.equal(failure.diagnostic.stage,'first-context');assert.equal(failure.diagnostic.code,'ISOLATED_CONTEXT_OVERFLOW');
  assert.equal(failure.diagnostic.source.state.actions[0].legalActions.active[0].moves[0].pp,2);
  assert.deepEqual(failure.diagnostic.source.opponentSheet,[{species:'Fixture',moves:['Protect']}]);
  assert.equal(Object.hasOwn(failure,'decision'),false);assert.equal(Object.hasOwn(failure,'context'),false);assert.equal(failure.binding.room,ROOM);
  for(const secret of ['DROP-SESSION','DROP-REQUEST-TOKEN','DROP-LEASE','DROP-RECEIPT','DROP-ASSERTION','DROP-ME',PRIVATE_FIXTURE_TEXT])assert(!text.includes(secret),secret);
});

function completedResponseEvidence(phase='decision-rejected'){
  const {decision,...base}=evidence();
  return {...base,phase,modelOutput:{selectedRefs:['a1','b1'],objective:'Unexecuted output',token:'DROP-REQUEST-TOKEN',apiKey:'DROP-ME',text:PRIVATE_FIXTURE_TEXT},
    validation:{version:1,engineeringOnly:true,choiceAuthority:false,stage:phase==='decision-superseded'?'request-freshness':'model-validation',
      code:phase==='decision-superseded'?'REQUEST_CHILD_ENDED':'MODEL_DECISION_INVALID',capturedAt:1000,message:'Completed response has no choice authority',
      source:{sessionId:'DROP-SESSION',rooms:[{id:ROOM,ended:true,result:{type:'win',winner:'Fixture'}}]}}};
}

function failedResponseEvidence(){
  const{decision,...base}=evidence();return{...base,phase:'decision-failed',telemetry:{telemetrySource:'codex-cli-session',startedAt:1000,firstTextAt:null,completedAt:null,outputBytes:0,requestWallTimeMs:14982,arbitraryRawResponse:'DROP-ME'},
    validation:{version:1,engineeringOnly:true,choiceAuthority:false,apiAttempted:false,providerAttempted:true,stage:'single-provider',code:'deadline_exceeded',capturedAt:16000,message:'No completed authorized model output'}};
}










test('Codex failed traces preserve safe stream-bound diagnostics without retaining raw protocol frames',async t=>{
  const dir=await workspace(t),trace=createModelTraceStore({workspace:dir,teamId:TEAM,runId}),row=failedResponseEvidence();
  row.provider={kind:'codex-cli',model:'gpt-6.1-sol',reasoningEffort:'low',selectionEvidence:'host-declared-request'};
  row.validation={...row.validation,apiAttempted:false,providerAttempted:true,stage:'single-provider',code:'stream_limit'};
  const counters={streamBytes:153900,eventCount:12,streamCountersScope:'session-lifetime-with-current-turn-deltas',streamTurnBytes:153800,streamTurnEvents:8,
    streamLineLimitBytes:144028,streamMaxLineBytes:153609,streamLastChunkBytes:10000,streamMaxChunkBytes:65536,
    streamLimitKind:'line-complete',streamLimitObserved:153609,streamLimitValue:144028};
  row.telemetry={telemetrySource:'codex-cli-session',...counters,rawProtocolFrame:'DROP-RAW-FRAME',rawToolResult:'DROP-RAW-RESULT'};
  const saved=await trace.append(row),text=await readFile(join(dir,saved.path),'utf8'),entry=JSON.parse(text).entries[0];
  for(const [key,value]of Object.entries(counters))assert.equal(entry.telemetry[key],value,key);
  assert.equal(entry.validation.code,'stream_limit');assert.equal(entry.validation.choiceAuthority,false);assert.equal(entry.decision,undefined);
  assert.equal(text.includes('DROP-RAW'),false);assert.equal(entry.telemetry.rawProtocolFrame,undefined);assert.equal(entry.telemetry.rawToolResult,undefined);
});

test('failed traces retain bounded CLI activity and intermediate token timing without implying completion',async t=>{
  const dir=await workspace(t),trace=createModelTraceStore({workspace:dir,teamId:TEAM,runId}),row=failedResponseEvidence();
  row.provider={kind:'codex-cli',model:'gpt-6.1-sol',reasoningEffort:'low',selectionEvidence:'host-declared-request'};
  row.validation={...row.validation,apiAttempted:false,providerAttempted:true,stage:'single-provider',code:'deadline_exceeded'};
  const cliActivity={schemaVersion:1,scope:'current-turn-parsed-wire',payloadsRetained:false,counts:{legacy:5860,toolRequest:2},lastEventAt:4000};
  row.telemetry={telemetrySource:'codex-cli-session',cliActivity,tokenUsageObservedAt:1500,tokenUsageTurnCompleteAtObservation:false,requestedModelVerbosity:'low',
    modelToolCalls:[{name:'get_pokemon',itemCompletedAt:1600}],rawWireText:'DROP-ME'};
  const saved=await trace.append(row),text=await readFile(join(dir,saved.path),'utf8'),entry=JSON.parse(text).entries[0];
  assert.deepEqual(entry.telemetry.cliActivity,cliActivity);assert.equal(entry.telemetry.tokenUsageObservedAt,1500);
  assert.equal(entry.telemetry.tokenUsageTurnCompleteAtObservation,false);assert.equal(entry.telemetry.modelToolCalls[0].itemCompletedAt,1600);
  assert.equal(entry.telemetry.requestedModelVerbosity,'low');
  assert.equal(entry.telemetry.completedAt,undefined);assert(!text.includes('DROP-ME'));assert.equal(entry.decision,undefined);
});



test('model trace refuses malformed CLI model identities without replacing prior durable bytes',async t=>{
  for(const model of ['','../model','x'.repeat(101),undefined]){
    const dir=await workspace(t),trace=createModelTraceStore({workspace:dir,teamId:TEAM,runId}),saved=await trace.append(evidence()),before=await readFile(join(dir,saved.path),'utf8'),row=failedResponseEvidence();
    row.provider={kind:'codex-cli',model,reasoningEffort:'low',selectionEvidence:'host-declared-request'};
    row.validation={...row.validation,apiAttempted:false,providerAttempted:true,stage:'first-provider'};
    await assert.rejects(trace.append(row),{code:'trace'});assert.equal(await readFile(join(dir,saved.path),'utf8'),before);
  }
});
test('durable failed-model trace retains actual controller guard provenance without fabricating transport phases',async t=>{
  const dir=await workspace(t),trace=createModelTraceStore({workspace:dir,teamId:TEAM,runId,secrets:[PRIVATE_FIXTURE_TEXT]});
  const row=failedResponseEvidence();row.telemetry={telemetrySource:'controller-deadline-guard',controllerModelStartedAt:1000,
    controllerModelDeadlineAt:16000,controllerModelFailedAt:16001,controllerAbortSettledAt:null,controllerAbortGraceMs:25,
    controllerErrorCode:'deadline_exceeded',arbitraryRawResponse:PRIVATE_FIXTURE_TEXT};
  row.context.promptMetadata.controllerBudget={version:1,cutoffAt:21000,modelDeadlineAt:16000,commitReserveMs:5000,
    previewClockAdmission:{verifiedLongClock:false,reconciled:true,unknownCutoffAt:21000}};
  const saved=await trace.append(row),text=await readFile(join(dir,saved.path),'utf8'),entry=JSON.parse(text).entries[0];
  assert.equal(entry.telemetry.telemetrySource,'controller-deadline-guard');assert.equal(entry.telemetry.controllerModelDeadlineAt,16000);
  assert.equal(entry.telemetry.controllerAbortSettledAt,null);assert.equal(entry.context.promptMetadata.controllerBudget.cutoffAt,21000);
  assert.equal(entry.telemetry.attempts,undefined);assert.equal(entry.telemetry.headersReceivedAt,undefined);
  assert.equal(entry.telemetry.completedAt,undefined);assert.equal(Object.hasOwn(entry,'decision'),false);
  assert(!text.includes(PRIVATE_FIXTURE_TEXT));assert(!text.includes('arbitraryRawResponse'));
});


test('completed rejected and superseded outputs remain sanitized and distinct from validated decisions',async t=>{
  const dir=await workspace(t),trace=createModelTraceStore({workspace:dir,teamId:TEAM,runId,secrets:[PRIVATE_FIXTURE_TEXT]});
  await trace.append(evidence());await trace.append(completedResponseEvidence());const saved=await trace.append(completedResponseEvidence('decision-superseded'));
  const text=await readFile(join(dir,saved.path),'utf8'),document=JSON.parse(text);
  assert.deepEqual(document.entries.map(row=>row.phase),['decision','decision-rejected','decision-superseded']);
  for(const row of document.entries.slice(1)){assert.equal(Object.hasOwn(row,'decision'),false);assert(row.modelOutput);assert.equal(row.validation.choiceAuthority,false);assert.equal(row.validation.engineeringOnly,true);}
  for(const secret of ['DROP-SESSION','DROP-REQUEST-TOKEN','DROP-ME',PRIVATE_FIXTURE_TEXT])assert(!text.includes(secret),secret);
});

test('completed response diagnostics refuse authority claims ambiguous shape oversized output and fabricated supersession',async t=>{
  for(const mutate of [row=>{row.validation.choiceAuthority=true;},row=>{row.validation.engineeringOnly=false;},row=>{row.decision={actions:[]};},
    row=>{delete row.modelOutput;},row=>{row.modelOutput='x'.repeat(256001);},row=>{row.phase='decision-superseded';},row=>{row.validation.stage='arbitrary secret prose';}]){
    const dir=await workspace(t),trace=createModelTraceStore({workspace:dir,teamId:TEAM,runId}),saved=await trace.append(evidence()),before=await readFile(join(dir,saved.path),'utf8');
    const row=completedResponseEvidence();mutate(row);await assert.rejects(trace.append(row),{code:'trace'});assert.equal(await readFile(join(dir,saved.path),'utf8'),before);
  }
});

test('failure diagnostics refuse fabricated model shape, missing engineering declaration and oversized source without replacing evidence',async t=>{
  for(const mutate of [value=>{value.decision={actions:[]};},value=>{value.diagnostic.engineeringOnly=false;},value=>{value.diagnostic.source.text='x'.repeat(256001);},value=>{value.binding.teamId=SHA;},
    value=>{value.diagnostic.source.state.teamId=SHA;},value=>{value.diagnostic.source.state.actions[0].rqid=4;},value=>{value.diagnostic.source.state.boards[0].room=ROOM+'9';}]){
    const dir=await workspace(t),trace=createModelTraceStore({workspace:dir,teamId:TEAM,runId});const saved=await trace.append(evidence()),before=await readFile(join(dir,saved.path),'utf8');
    const failure=controllerFailureEvidence();mutate(failure);await assert.rejects(trace.append(failure),{code:'trace'});
    assert.equal(await readFile(join(dir,saved.path),'utf8'),before);assert.equal(trace.status().failed,true);
  }
});

test('trace capacity and ownership failures keep the previous durable bytes and halt later appends', async t => {
  const dir = await workspace(t), trace = createModelTraceStore({workspace: dir, teamId: TEAM, runId, maxEntries: 1});
  const saved = await trace.append(evidence()), before = await readFile(join(dir, saved.path), 'utf8');
  await assert.rejects(trace.append(evidence()), {code: 'trace'}); assert.equal(await readFile(join(dir, saved.path), 'utf8'), before); assert.equal(trace.status().failed, true);
  await assert.rejects(trace.append(evidence({binding: {...evidence().binding, parentId: `${PARENT}9`}})), {code: 'trace'});
  const other = createModelTraceStore({workspace: dir, teamId: SHA, runId});
  await assert.rejects(other.append(evidence({binding: {...evidence().binding, teamId: SHA}})), {code: 'trace'});
  assert.equal(await readFile(join(dir, saved.path), 'utf8'), before);
});

test('durable trace preserves the complete verified skill exactly while other private input remains redacted',async t=>{
  const dir=await workspace(t),trace=createModelTraceStore({workspace:dir,teamId:TEAM,runId,secrets:[PRIVATE_FIXTURE_TEXT]}),bundle=loadMaintainedMatchupGuidance(ISOLATED_POLICY_SOURCE),row=evidence();
  row.context.input=JSON.stringify({matchupSkill:structuredClone(bundle),current:{unknown:null,externalUrl:'https://private.invalid/retain-no-url',secret:PRIVATE_FIXTURE_TEXT,readReceipt:'private-receipt'}});
  const saved=await trace.append(row),text=await readFile(join(dir,saved.path),'utf8'),entry=JSON.parse(text).entries[0],input=JSON.parse(entry.context.input);
  assert.deepEqual(input.matchupSkill,bundle);assert.equal(input.current.externalUrl,'[redacted-url]');assert.equal(input.current.secret,'[redacted-secret]');assert.equal(Object.hasOwn(input.current,'readReceipt'),false);
  assert(bundle.files.some(f=>f.content.includes('https://')));for(const file of input.matchupSkill.files)assert.equal(createHash('sha256').update(file.content).digest('hex'),file.sha256);
  const before=await readFile(join(dir,saved.path),'utf8'),bad=structuredClone(row);const payload=JSON.parse(bad.context.input);payload.matchupSkill.files[0].content+='\nUntrusted URL https://untrusted.invalid/private';bad.context.input=JSON.stringify(payload);
  await assert.rejects(trace.append(bad),{code:'trace'});assert.equal(await readFile(join(dir,saved.path),'utf8'),before);
});

test('the bounded64MiB trace retains many full-skill frames beyond8MiB and honors an explicit smaller cap',async t=>{
  const bundle=loadMaintainedMatchupGuidance(ISOLATED_POLICY_SOURCE),row=evidence();row.context.input=JSON.stringify({matchupSkill:bundle,currentFacts:{unknown:null}});
  const dir=await workspace(t),trace=createModelTraceStore({workspace:dir,teamId:TEAM,runId});assert.equal(trace.status().maxBytes,64*1024*1024);assert.equal(trace.status().maxEntries,100);
  const frames=Math.ceil(9*1024*1024/Buffer.byteLength(row.context.input));assert(frames<=100);let saved;for(let i=0;i<frames;i++)saved=await trace.append(row);
  const retained=await readFile(join(dir,saved.path),'utf8');assert(Buffer.byteLength(retained)>8*1024*1024);assert.equal(JSON.parse(retained).entries.length,frames);
  const smaller=await workspace(t),smallCap=Buffer.byteLength(JSON.stringify(row))+10000,limited=createModelTraceStore({workspace:smaller,teamId:TEAM,runId,maxBytes:smallCap}),first=await limited.append(row),before=await readFile(join(smaller,first.path),'utf8');
  await assert.rejects(limited.append(row),{code:'trace'});assert.equal(limited.status().maxBytes,smallCap);assert.equal(await readFile(join(smaller,first.path),'utf8'),before);assert.equal(limited.status().failed,true);
  assert.throws(()=>createModelTraceStore({workspace:dir,teamId:TEAM,runId,maxBytes:64*1024*1024+1}),{code:'trace'});assert.throws(()=>createModelTraceStore({workspace:dir,teamId:TEAM,runId,maxEntries:101}),{code:'trace'});
});

test('trace refuses linked cache directories rather than writing through them', async t => {
  const dir = await workspace(t), outside = await workspace(t);
  try {await symlink(outside, join(dir, 'cache'), process.platform === 'win32' ? 'junction' : 'dir');}
  catch (error) {if (['EPERM', 'EACCES'].includes(error.code)) {t.skip('Creating links is unavailable'); return;} throw error;}
  const trace = createModelTraceStore({workspace: dir, teamId: TEAM, runId});
  await assert.rejects(trace.append(evidence()), {code: 'trace'});
});



test('controller preparation timing retains safe stage, typed code and actual overflow bytes',()=>{
  const recorder=createTimingRecorder({component:'isolated_runner'});
  recordControllerTiming(recorder,{type:'controller.unavailable',binding:{requestKey:SHA,room:ROOM,rqid:6},stage:'first-context',code:'ISOLATED_CONTEXT_OVERFLOW',promptMetadata:{totalBytes:30378},source:{password:'DROP-ME'}},TEAM,runId);
  const event=recorder.snapshot()[0];assert.equal(event.stage,'first-context');assert.equal(event.outcome,'ISOLATED_CONTEXT_OVERFLOW');assert.equal(event.promptBytes,30378);
  assert(!JSON.stringify(event).includes('DROP-ME'));
});

test('recovery timings preserve input queue and native read intervals separately from event time', () => {
  const recorder = createTimingRecorder({component: 'isolated_runner'});
  recordControllerTiming(recorder, {type: 'recovery.host-input', at: 1100, inputReceivedAt: 1000, inputProcessedAt: 1050,
    inputQueuedMs: 50, detectedAt: 900, contextCapturedAt: 950, handoffDelayMs: 60, readStartedAt: 930, readCompletedAt: 950}, TEAM, runId);
  const event = recorder.snapshot()[0];
  for (const [key, value] of Object.entries({eventAt: 1100, inputReceivedAt: 1000, inputProcessedAt: 1050, inputQueuedMs: 50,
    detectedAt: 900, contextCapturedAt: 950, handoffDelayMs: 60, readStartedAt: 930, readCompletedAt: 950})) assert.equal(event[key], value, key);
  recordControllerTiming(recorder, {type: 'recovery.started', at: 1200}, TEAM, runId);
  assert.equal(recorder.snapshot()[1].inputReceivedAt, undefined, 'event time must not invent input arrival');
});
