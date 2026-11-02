import {EventEmitter} from 'node:events';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {ControllerLease} from './controller-lease.mjs';
import {DeadlineSupervisor} from './deadline-supervisor.mjs';
import {replacementOptions,legalReplacementPairs} from './choice-validation.mjs';
import {compactTurnBoard} from './turn-board.mjs';
import {selectEmergencyActions} from './emergency-choice.mjs';
import {compareTimerObservations,safeServerNotice} from './client.mjs';
import {createTurnPlanMemory,validateTurnPlan,validateTurnPlanBinding,validatePreviewPlan} from './turn-plan.mjs';
import {buildTurnFacts} from '../planning/board.mjs';
import {boardDigest,digest,requestDigest} from '../planning/identity.mjs';
import {observedPlanningSheet} from '../planning/source.mjs';
import {validateSelectedRecipientEffects} from '../planning/recipient-effects.mjs';
import {canonicalRecoveryRoom, restoredSetEvidence} from './restored-set.mjs';
import {createChoiceStateHistory,assembleChoiceState} from '../simulation/choice-state.mjs';

const {Teams,TeamValidator}=createRequire(import.meta.url)('pokemon-showdown');
const RUNTIME_REVISION=createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const RUNTIME_MODULES=Object.freeze({
  'showdown/agent-session.mjs':RUNTIME_REVISION,
  'showdown/client.mjs':createHash('sha256').update(readFileSync(new URL('./client.mjs',import.meta.url))).digest('hex'),
  'showdown/battle-state.mjs':createHash('sha256').update(readFileSync(new URL('./battle-state.mjs',import.meta.url))).digest('hex'),
  'simulation/choice-state.mjs':createHash('sha256').update(readFileSync(new URL('../simulation/choice-state.mjs',import.meta.url))).digest('hex'),
  'planning/research-budget.mjs':createHash('sha256').update(readFileSync(new URL('../planning/research-budget.mjs',import.meta.url))).digest('hex'),
  'simulation/choice-presentation.mjs':createHash('sha256').update(readFileSync(new URL('../simulation/choice-presentation.mjs',import.meta.url))).digest('hex'),
  'simulation/spread-observations.mjs':createHash('sha256').update(readFileSync(new URL('../simulation/spread-observations.mjs',import.meta.url))).digest('hex'),
  'simulation/spread-candidates.mjs':createHash('sha256').update(readFileSync(new URL('../simulation/spread-candidates.mjs',import.meta.url))).digest('hex'),
  'showdown/protocol-action.mjs':createHash('sha256').update(readFileSync(new URL('./protocol-action.mjs',import.meta.url))).digest('hex'),
  'showdown/deadline-supervisor.mjs':createHash('sha256').update(readFileSync(new URL('./deadline-supervisor.mjs',import.meta.url))).digest('hex'),
  'showdown/turn-plan.mjs':createHash('sha256').update(readFileSync(new URL('./turn-plan.mjs',import.meta.url))).digest('hex'),
  'showdown/restored-set.mjs':createHash('sha256').update(readFileSync(new URL('./restored-set.mjs',import.meta.url))).digest('hex'),
  'planning/recipient-effects.mjs':createHash('sha256').update(readFileSync(new URL('../planning/recipient-effects.mjs',import.meta.url))).digest('hex'),
  'planning/board.mjs':createHash('sha256').update(readFileSync(new URL('../planning/board.mjs',import.meta.url))).digest('hex'),
  'planning/order-evidence.mjs':createHash('sha256').update(readFileSync(new URL('../planning/order-evidence.mjs',import.meta.url))).digest('hex'),
  'planning/identity.mjs':createHash('sha256').update(readFileSync(new URL('../planning/identity.mjs',import.meta.url))).digest('hex'),
  'planning/source.mjs':createHash('sha256').update(readFileSync(new URL('../planning/source.mjs',import.meta.url))).digest('hex'),
  'simulation/observed-position.mjs':createHash('sha256').update(readFileSync(new URL('../simulation/observed-position.mjs',import.meta.url))).digest('hex'),
  'simulation/registered-identity.mjs':createHash('sha256').update(readFileSync(new URL('../simulation/registered-identity.mjs',import.meta.url))).digest('hex'),
});
const LOADED_AT=new Date().toISOString();
// Only the supervisor callbacks can grant this narrow control fallback. It is
// never represented by a command, turn plan or caller-provided metadata value.
const SUPERVISOR_EMERGENCY=Symbol('supervisor-emergency-default');

const normalized = text => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function simulationSemantic(value){
  if(Array.isArray(value))return value.map(simulationSemantic);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
    .filter(([key])=>!['sequence','observedAt','receivedAt','startedAt','updatedAt','at','sourceSha256','historySha256','journalSha256','frameSha256','historicalHistorySha256'].includes(key))
    .map(([key,entry])=>[key,simulationSemantic(entry)]));
  return value;
}
function publishedSheet(packed){
  const columns=String(packed).split(']').map(set=>set.split('|'));
  return (Teams.unpack(packed)||[]).map((set,index)=>({species:set.species,item:set.item||null,ability:set.ability||null,moves:set.moves,
    nature:columns[index]?.[5]?set.nature:null,level:columns[index]?.[10]?set.level:null,
    gender:columns[index]?.[7]?set.gender:null,shiny:!!set.shiny}));
}
const EVENTS = ['request','battle-event','sheet','timer','result','ready','server-error','server-notice','search-rejected','choice-status','action-status','forfeit-status','search-state','room-renamed','replay-url','replay-verified','replay-failed','disconnected'];
const SERVER_ERROR_CATEGORIES=new Set(['invalid-choice','unavailable-choice','unclassified']);
const SERVER_ERROR_REASONS=new Set(['too-late','game-over','not-your-turn','nothing-to-choose','nothing-to-cancel','trapped','move-disabled','battle-crashed','unclassified']);
const RESEARCH_LIMITS=Object.freeze({calculator:3,simulation:1,turnKeys:512,simulationCacheEntries:32,resultCacheEntries:96,resultBytes:1024*1024});
const RESEARCH_HASH=/^[a-f0-9]{64}$/u;
function ownedServerErrorDiagnostic(text,state){
  // Error strings may echo credentials, private room URLs or arbitrary input.
  // Keep only a known template's enum and contemporaneous state; no raw text,
  // substituted names, hashes or snippets enter control telemetry.
  const match=typeof text==='string'&&text.length<=4096 ? /^\[(Invalid|Unavailable) choice\] ([^\r\n\u0000-\u001f\u007f]*)$/u.exec(text) : null;
  const category=match ? match[1]==='Invalid'?'invalid-choice':'unavailable-choice' : 'unclassified';
  const body=match?.[2],templates=new Map([
    ['Sorry, too late to make a different move; the next turn has already started','too-late'],
    ['Sorry, too late to cancel; the next turn has already started','too-late'],
    ["Can't do anything: The game is over",'game-over'],["Can't do anything: It's not your turn",'not-your-turn'],
    ["There's nothing to choose",'nothing-to-choose'],["There's nothing to cancel",'nothing-to-cancel'],
    ["Can't switch: The active Pokémon is trapped",'trapped'],['The battle crashed','battle-crashed'],
  ]);
  const reason=templates.get(body) ?? (typeof body==='string'&&/^Can't move: .{1,100}'s .{1,100} is disabled$/u.test(body)?'move-disabled':'unclassified');
  return {serverErrorCategory:category,serverErrorReason:reason,serverErrorTextRetained:false,
    stateEndedAtError:state?.ended===true,requestPresentAtError:!!state?.request};
}

/** One explicitly bounded local session; emergency legal defaults are opt-in. */
export class AgentSession extends EventEmitter {
  constructor(client, {username, packed, authorizedSets = 1, autoReady = true, now = Date.now, replayFetchImpl = globalThis.fetch, replayBudgetMs = 25000,recorderFactory,decisionNoteWriter,replayPolicy=false,replayPreservationVerifier,timerPolicy=false,controllerRequired=true,controlTimers={},monotonicNow=()=>performance.now(),restoredSetProof} = {}) {
    super();
    check(typeof username === 'string' && normalized(username), 'Username required');
    check(typeof packed === 'string' && packed.length > 10, 'Approved packed team required');
    check(Number.isInteger(authorizedSets) && authorizedSets >= 1 && authorizedSets <= 100, 'Invalid set limit');
    check(createHash('sha256').update(packed).digest('hex') === client.expectedTeamHash, 'Team differs from approved fixed team');
    this.client = client; this.username = username; this.packed = packed;
    this.authorizedSets = authorizedSets; this.autoReady = autoReady; this.now = now;
    check(typeof replayFetchImpl==='function' && Number.isInteger(replayBudgetMs) && replayBudgetMs>0 && replayBudgetMs<=25000,'Invalid replay transport configuration');
    this.replayFetchImpl=replayFetchImpl;this.replayBudgetMs=replayBudgetMs;this.savingReplays=false;
    check(typeof replayPolicy==='boolean'&&(replayPreservationVerifier===undefined||typeof replayPreservationVerifier==='function'),'Invalid replay preservation policy');
    this.replayPreservationVerifier=replayPreservationVerifier;this.replayPolicy={enabled:replayPolicy,configuredAt:replayPolicy?new Date(this.now()).toISOString():null,fromSearch:1};this.replayPreservation=new Map();this.replayTasks=new Map();
    check(typeof timerPolicy==='boolean','Invalid owned battle timer policy');
    this.timerPolicy={enabled:timerPolicy,configuredAt:timerPolicy?new Date(this.now()).toISOString():null};this.timerPolicyAttempts=new Map();this.timerPolicyDeferred=null;this.previewTimerTaskQueued=false;
    this.id = randomUUID(); this.revision = 0; this.searchesSent = 0; this.stopped = false;
    this.choiceHistories=new Map();this.choiceHistorySequences=new Map();this.frozenChoiceContexts=new Map();
    this.researchBudgets=new Map();this.researchReservations=new Map();this.researchCacheClaims=new Set();this.researchResultClaims=new Set();this.researchBudgetIdentity=hash([this.id,client.expectedTeamHash]);
    this.commands = new Map();this.commandFingerprints=new Map(); this.readySent = new Set(); this.notices = []; this.listeners = [];
    this.ownedRooms = new Set(); this.ownedParents = new Set(); this.roomParents = new Map(); this.awaitingSet = false;
    this.restoredSetProof=restoredSetProof;
    this.restoredSetEvidence=restoredSetProof?restoredSetEvidence(restoredSetProof,{username,teamId:client.expectedTeamHash}):[];
    this.restoredSetObservationEnabled=false;
    this.restoredSetParent=null;
    this.roomTeams=new Map();this.actionContexts=new Map();this.recorderFactory=recorderFactory;this.decisionNoteWriter=decisionNoteWriter;this.switchingTeam=false;
    this.turnPlans=createTurnPlanMemory({now});this.turnPlanWrites=new Set();this.turnPlanWriteFailures=0;this.turnPlanWritesDropped=0;
    this.controller=new ControllerLease({now,required:controllerRequired});this.controlTrace=[];this.controlSequence=0;this.monotonicNow=monotonicNow;this.controlStartedAt=monotonicNow();this.tracedRequests=new Set();this.choiceSources=new Map();this.uncertainChoices=new Set();
    this.supervisor=new DeadlineSupervisor({now,...controlTimers,getActions:()=>this.actions({includePending:true}),validate:(action,choices,metadata,source)=>this.validateAction(action,choices,metadata,source==='emergency-default'?SUPERVISOR_EMERGENCY:undefined),submit:(action,choices,source,metadata)=>this.submitChoice(action,choices,source,10000,metadata?.turnPlan,source==='emergency-default'?SUPERVISOR_EMERGENCY:undefined,metadata?.previewPlan),selectDefault:action=>this.emergencyChoice(action),forfeit:(action,reason)=>this.containControlFailure(action,reason),onTrace:entry=>this.recordControlTrace({...entry,type:entry.type?.startsWith('watchdog-')?entry.type:`watchdog-${entry.type||'event'}`})});
    for (const event of EVENTS) {
      const listener = value => {
        if(event==='server-notice'){
          if(!client.authenticated)return;
          const notice=safeServerNotice(value?.text,{authenticated:true});notice.truncated ||= value?.truncated===true;
          this.notices.push({at:this.now(),kind:'server-notice',type:value?.type==='error'?'error':'popup',scope:value?.scope==='room'?'room':'global',...notice});
          this.notices=this.notices.slice(-20);
        }
        if(event==='search-rejected'){
          this.awaitingSet=false;
          this.notices.push({at:this.now(),kind:'search-rejected',reasonCode:value.reasonCode,generation:value.generation,contextBound:value.contextBound===true});
          this.notices=this.notices.slice(-20);
        }
        if (event === 'disconnected') {this.stopped = true;this.turnPlans.invalidate();for(const history of this.choiceHistories.values())history.invalidate('Native connection ended');this.frozenChoiceContexts.clear();this.clearResearchBudgets();}
        if(event==='room-renamed')this.migrateRoom(value);
        if(event==='result')this.releaseEndedResearchResults();
        if(event==='action-status'){
          const action=client.rooms.get(value.room)?.lastAction;
          for(const context of this.actionContexts.values())if(context.room===value.room&&context.rqid===action?.rqid)context.lastObservedStatus=value.status;
        }
        if(event==='search-state' && this.cancellation && value.searching.length===0 && !Object.keys(value.games || {}).length)this.cancellation.status='idle-observed';
        this.captureRooms();
        this.observeControlEvent(event,value);
        this.supervisor.refresh(event);
        this.revision++; this.emit('change', {revision:this.revision,event});
        if (this.autoReady && ['ready','search-state','request'].includes(event)) this.confirmPendingReady();
        // Publish the actionable board first. The enabled timer policy can then
        // acquire a real preview countdown without waiting for a preview choice.
        if(['request','search-state','battle-event','room-renamed'].includes(event))this.queuePreviewTimer();
        if(['result','search-state','room-renamed'].includes(event)||event==='battle-event'&&client.rooms.get(value.room)?.ended)queueMicrotask(()=>this.maybePreserveReplays());
      };
      client.on(event, listener); this.listeners.push([event,listener]);
    }
    const simulationLine=value=>this.observeSimulationLine(value);
    client.on('simulation-line',simulationLine);this.listeners.push(['simulation-line',simulationLine]);
  }
  observeSimulationLine(value){
    if(!this.ownedRooms.has(value?.room)||this.roomTeamId(value.room)!==this.client.expectedTeamHash)return;
    try{
      let history=this.choiceHistories.get(value.room);
      if(!history){
        history=createChoiceStateHistory({sessionId:this.id,room:value.room,teamId:this.roomTeamId(value.room),epoch:value.epoch,teamText:Teams.export(Teams.unpack(this.packed))});
        this.choiceHistories.set(value.room,history);this.choiceHistorySequences.set(value.room,0);
      }
      const sequence=(this.choiceHistorySequences.get(value.room)??0)+1;this.choiceHistorySequences.set(value.room,sequence);
      const metadata={sequence,epoch:value.epoch,connected:value.connected===true,observedAt:value.observedAt};
      if(value.type==='request')history.observeRequest(value.request,metadata);else history.observeLine(value.line,metadata);
    }catch{
      this.choiceHistories.get(value?.room)?.invalidate('Native structural feed could not be validated');
    }
  }
  simulationContext({source,mode='current',freezeId}={}){
    check(!this.stopped&&this.client.connected&&this.client.authenticated,'Simulation context requires the existing connected client');
    check(source&&source.sessionId===this.id&&source.teamId===this.client.expectedTeamHash,'Simulation context session/team differs');
    const room=this.client.resolveRoom(source.room);
    check(room===source.room&&this.ownedRooms.has(room)&&this.roomTeamId(room)===source.teamId,'Simulation context requires the exact owned room');
    if(mode==='frozen'){
      check(!this.client.rooms.get(room)?.ended,'Frozen simulation game has ended');
      const saved=this.frozenChoiceContexts.get(freezeId);
      check(saved&&saved.source.sessionId===source.sessionId&&saved.source.teamId===source.teamId&&saved.source.room===room&&saved.source.rqid===source.rqid&&saved.source.token===source.token,'Frozen simulation source differs');
      check(this.now()-saved.frozenAt<=90000,'Frozen simulation source expired');
      return structuredClone({...saved,liveFreshness:false,choiceAuthority:false});
    }
    check(mode==='current'&&freezeId===undefined,'Unknown simulation source mode');
    const observed=this.turnSnapshot(),matches=observed.actions.filter(a=>a.room===room&&a.rqid===source.rqid&&a.token===source.token);
    check(matches.length===1&&matches[0].kind==='turn'&&matches[0].actionable!==false&&!['sent','uncertain','accepted','execution-observed'].includes(matches[0].submissionStatus),'Simulation context request is stale or reserved');
    check(!observed.controlPolicy.pending.some(p=>p.token===source.token&&p.attempted),'Simulation context request has a send reservation');
    const board=observed.boards.find(b=>b.room===room),native=this.client.rooms.get(room),foe=board?.ownSide==='p1'?'p2':'p1';
    check(board&&native?.sheets?.[foe],'Simulation context requires the published opposing sheet');
    // A packed open sheet's empty item column means an explicitly itemless
    // registered set. Keep display nullability out of the strict mechanical
    // source contract; this does not infer an unrevealed current held item.
    const opposingSheet=publishedSheet(native.sheets[foe]).map(set=>({...set,item:set.item??''}));
    observed.opponentSheets={[foe]:opposingSheet};
    const {sessionId,...expected}=source,history=this.choiceHistories.get(room);
    check(history,'Complete simulation history tracker is unavailable');
    const assembly=assembleChoiceState(history.capture({observed,expected,opposingSheet}));
    const legal=matches[0].legalActions,boardHash=boardDigest(board,legal),legalHash=digest(legal);
    const semanticSha256=digest({boardHash,legalHash,known:simulationSemantic({facts:assembly.facts,hypotheses:assembly.hypotheses,unknowns:assembly.unknowns,
      observedOverrides:assembly.observedOverrides,coverage:{completeHistory:assembly.coverage.completeHistory,auditedHistory:assembly.coverage.auditedHistory,
        unsupportedCurrentState:assembly.coverage.unsupportedCurrentState,historyProblems:assembly.coverage.historyProblems}})});
    return {kind:'owned-simulation-context-v1',source:structuredClone(source),observed,opposingSheet,assembly,
      boardHash,legalHash,semanticSha256,frozenAt:this.now(),liveFreshness:true,choiceAuthority:false};
  }
  freezeSimulationContext(action){
    try{
      if(action.kind!=='turn')return null;
      const source={sessionId:this.id,teamId:this.roomTeamId(action.room),room:action.room,rqid:action.rqid,token:action.token};
      const value=this.simulationContext({source}),freezeId=randomUUID();
      this.frozenChoiceContexts.set(freezeId,{...value,freezeId});
      while(this.frozenChoiceContexts.size>12)this.frozenChoiceContexts.delete(this.frozenChoiceContexts.keys().next().value);
      return {freezeId,source,frozenAt:value.frozenAt,choiceAuthority:false};
    }catch{return null;}
  }
  clearResearchBudgets(){
    this.researchBudgets.clear();this.researchReservations.clear();this.researchCacheClaims.clear();this.researchResultClaims.clear();
    this.researchBudgetIdentity=hash([this.id,this.client.expectedTeamHash]);
  }
  releaseEndedResearchResults(){
    for(const row of this.researchReservations.values()){
      if(row.status!=='completed'||row.resultText===undefined)continue;
      const room=this.client.rooms.get(this.client.resolveRoom(row.room));
      if(room?.ended!==true||!['win','tie'].includes(room.result?.type))continue;
      delete row.resultText;row.resultReleased=true;this.researchResultClaims.delete(row.id);this.researchCacheClaims.delete(row.id);
    }
  }
  researchContext({source,analysis='current',freezeId}={}){
    if(this.researchBudgetIdentity!==hash([this.id,this.client.expectedTeamHash]))this.clearResearchBudgets();
    this.releaseEndedResearchResults();
    check(['current','frozen'].includes(analysis),'Unknown research source mode');
    let context;
    if(analysis==='current'){
      // Numeric research may accompany a fresh preview or replacement menu. This narrow
      // source check does not expand the simulation endpoint's turn contract.
      check(!this.stopped&&this.client.connected&&this.client.authenticated,'Research requires the existing connected client');
      check(source&&source.sessionId===this.id&&source.teamId===this.client.expectedTeamHash,'Research source session/team differs');
      const room=this.client.resolveRoom(source.room);
      check(room===source.room&&this.ownedRooms.has(room)&&this.roomTeamId(room)===source.teamId,'Research requires the exact owned room');
      check(freezeId===undefined,'Current research must omit freezeId');
      const observed=this.turnSnapshot(),matches=observed.actions.filter(a=>a.room===room&&a.rqid===source.rqid&&a.token===source.token);
      if(matches.length===1&&['switch','preview'].includes(matches[0].kind)){
        const action=matches[0],board=observed.boards.find(b=>b.room===room);
        check(board&&!this.client.rooms.get(room)?.ended&&action.actionable!==false&&!['sent','uncertain','accepted','execution-observed'].includes(action.submissionStatus),'Research preview/replacement source is stale or reserved');
        check(!observed.controlPolicy.pending.some(p=>p.token===source.token&&p.attempted),'Research source has a send reservation');
        const legalHash=digest(action.legalActions),boardHash=boardDigest(board,action.legalActions);
        context={source:structuredClone(source),observed,semanticSha256:digest({boardHash,legalHash,phase:action.kind}),liveFreshness:true};
      }
    }
    context??=this.simulationContext({source,mode:analysis,freezeId});
    const board=context.observed.boards.find(b=>b.room===source.room);
    check(board&&Number.isSafeInteger(board.turn)&&board.turn>=0&&RESEARCH_HASH.test(context.semanticSha256),'Research source has no exact native turn/facts binding');
    const game=canonicalRecoveryRoom(source.room),turn=board.turn;
    check(/^battle-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*$/u.test(game),'Research requires a native child game');
    const kind=context.observed.actions.find(a=>a.room===source.room&&a.rqid===source.rqid&&a.token===source.token)?.kind;
    return {context,turn,kind,key:digest([this.id,source.teamId,game,turn]),source:{teamId:source.teamId,room:game,rqid:source.rqid,turn,semanticSha256:context.semanticSha256,analysis,liveFreshness:context.liveFreshness===true}};
  }
  researchView(current,status,extra={}){
    const state=this.researchBudgets.get(current.key),calculatorsUsed=state?.calculators.length??0,simulationsUsed=state?.simulation?1:0;
    return {kind:'native-research-budget-v1',status,source:current.source,choiceAuthority:false,liveFreshness:false,
      budget:{calculatorsUsed,calculatorsRemaining:RESEARCH_LIMITS.calculator-calculatorsUsed,simulationsUsed,simulationsRemaining:RESEARCH_LIMITS.simulation-simulationsUsed,limits:{calculator:RESEARCH_LIMITS.calculator,simulation:RESEARCH_LIMITS.simulation}},...extra};
  }
  researchStatus({source,analysis='current',freezeId}={}){
    const current=this.researchContext({source,analysis,freezeId}),state=this.researchBudgets.get(current.key),row=state?.simulation;
    const view=value=>({status:value.status,reservationId:value.id,requestSha256:value.requestSha256,semanticSha256:value.semanticSha256,...(value.resultSha256?{resultSha256:value.resultSha256}:{}),...(value.calculationRef?{calculationRef:structuredClone(value.calculationRef)}:{})});
    return this.researchView(current,'status',{calculators:(state?.calculators??[]).map(view),...(row?{simulation:view(row)}:{})});
  }
  researchReserve({source,analysis='current',freezeId,category,requestSha256}={}){
    check(['calculator','simulation'].includes(category)&&RESEARCH_HASH.test(requestSha256),'Research requires a declared category and request SHA-256');
    const current=this.researchContext({source,analysis,freezeId}),cacheKey=digest([current.context.semanticSha256,requestSha256]);
    check(category!=='simulation'||current.kind!=='preview','Simulation research does not accept team preview');
    let state=this.researchBudgets.get(current.key);
    const prior=category==='simulation'?state?.simulation:state?.calculators.find(value=>value.cacheKey===cacheKey&&['pending','completed'].includes(value.status));
    if(prior){
      if(prior.cacheKey===cacheKey&&prior.status==='pending')return this.researchView(current,'pending',{reservationId:prior.id,requestSha256,cacheKey,backendAllowed:false});
      if(prior.cacheKey===cacheKey&&prior.status==='completed'&&typeof prior.resultText==='string')return this.researchView(current,'reused',{reservationId:prior.id,requestSha256,cacheKey,backendAllowed:false,result:JSON.parse(prior.resultText),resultSha256:prior.resultSha256,...(prior.calculationRef?{calculationRef:structuredClone(prior.calculationRef)}:{})});
      return this.researchView(current,'budget-used',{backendAllowed:false,reason:'simulation-trajectory-used',...(prior.resultSha256?{resultSha256:prior.resultSha256}:{}),...(prior.calculationRef?{calculationRef:structuredClone(prior.calculationRef)}:{})});
    }
    if(category==='calculator'&&(state?.calculators.length??0)>=RESEARCH_LIMITS.calculator)return this.researchView(current,'budget-used',{backendAllowed:false,reason:'calculator-invocations-used'});
    if(!state&&this.researchBudgets.size>=RESEARCH_LIMITS.turnKeys)return this.researchView(current,'budget-used',{backendAllowed:false,reason:'research-turn-storage-full'});
    // Reserve bounded cache capacity before starting any new invocation. No
    // spent marker or completed exact result is evicted to admit more work.
    if(category==='simulation'&&this.researchCacheClaims.size>=RESEARCH_LIMITS.simulationCacheEntries)return this.researchView(current,'budget-used',{backendAllowed:false,reason:'simulation-result-storage-full'});
    if(this.researchResultClaims.size>=RESEARCH_LIMITS.resultCacheEntries)return this.researchView(current,'budget-used',{backendAllowed:false,reason:'research-result-storage-full'});
    state??={calculators:[],simulation:null};this.researchBudgets.set(current.key,state);
    const row={id:randomUUID(),key:current.key,room:source.room,category,requestSha256,cacheKey,semanticSha256:current.context.semanticSha256,status:'pending',
      binding:digest({source,analysis,freezeId:freezeId??null,category,requestSha256}),reservedAt:this.now()};
    this.researchReservations.set(row.id,row);
    this.researchResultClaims.add(row.id);
    if(category==='simulation'){state.simulation=row;this.researchCacheClaims.add(row.id);}else state.calculators.push(row);
    return this.researchView(current,'reserved',{reservationId:row.id,requestSha256,cacheKey,backendAllowed:true});
  }
  researchSettle({reservationId,source,analysis='current',freezeId,category,requestSha256,result,failed}={}){
    check(typeof reservationId==='string'&&['calculator','simulation'].includes(category)&&RESEARCH_HASH.test(requestSha256)&&(failed===undefined||typeof failed==='boolean'),'Exact research reservation binding required');
    const current=this.researchContext({source,analysis,freezeId}),row=this.researchReservations.get(reservationId);
    check(row&&row.key===current.key&&row.semanticSha256===current.context.semanticSha256&&row.binding===digest({source,analysis,freezeId:freezeId??null,category,requestSha256}),'Research reservation source, facts or request differs');
    check(failed===true?result===undefined:result!==undefined,'Research settlement requires one complete result or an explicit failure');
    let text,snapshot;
    if(failed!==true){
      text=JSON.stringify(result);check(typeof text==='string','Research result must be complete JSON');snapshot=JSON.parse(text);
      check(snapshot?.isError!==true&&snapshot?.ok!==false&&snapshot?.structuredContent?.ok!==false,'Research error envelope requires an explicit failed settlement');
    }
    if(row.status!=='pending'){
      check(row.status===(failed===true?'failed':'completed')&&(failed===true||row.resultSha256===digest(JSON.parse(text))),'Research reservation already settled with a different outcome');
      return this.researchView(current,row.status,{reservationId:row.id,alreadySettled:true,backendAllowed:false,...(row.resultSha256?{resultSha256:row.resultSha256}:{})});
    }
    row.settledAt=this.now();
    if(failed===true||Buffer.byteLength(text)>RESEARCH_LIMITS.resultBytes){
      row.status='failed';this.researchCacheClaims.delete(row.id);this.researchResultClaims.delete(row.id);
      return this.researchView(current,'failed',{reservationId:row.id,backendAllowed:false,spent:true,...(failed!==true?{reason:'research-result-cache-limit'}:{})});
    }
    row.status='completed';row.resultSha256=digest(snapshot);
    const reference=snapshot?.calculationRef??snapshot?.structuredContent?.calculationRef;
    if(reference&&typeof reference==='object'&&Buffer.byteLength(JSON.stringify(reference))<=8192)row.calculationRef=structuredClone(reference);
    row.resultText=text;
    return this.researchView(current,'completed',{reservationId:row.id,backendAllowed:false,spent:true,resultSha256:row.resultSha256,...(row.calculationRef?{calculationRef:structuredClone(row.calculationRef)}:{})});
  }
  recordControlTrace(entry){
    const ownedRoom=typeof entry.room==='string' ? this.client.resolveRoom(entry.room) : undefined;
    if(entry.type==='server-error'&&(!this.client.authenticated||!ownedRoom?.startsWith('battle-')||!this.ownedRooms.has(ownedRoom)))return null;
    const controller=this.controller.status(),record={seq:++this.controlSequence,at:this.now(),elapsedMs:Math.max(0,this.monotonicNow()-this.controlStartedAt),controllerId:controller.owner?.replace(/[^A-Za-z0-9_.:-]/g,'_')||'none',generation:controller.generation};
    for(const key of ['type','source','status','kind','reasonCode','clockSource','observedClockSource','deadlineBasis'])if(typeof entry[key]==='string')record[key]=entry[key].replace(/[^A-Za-z0-9_.:-]/g,'_').slice(0,80);
    for(const key of ['rqid','revision','latencyMs','planningDeadlineAt','cutoffAt','emergencyAt','hardDeadlineAt','turnDeadlineAt','bankDeadlineAt','unknownCutoffAt','clockObservedAt','timerDisabledAt','recoveryStartedAt','requestPacketReceivedAt','decisionWindowStartedAt','clockContinuityOriginRqid','clockContinuityRejectedAt','closeCode'])if(Number.isFinite(entry[key]))record[key]=entry[key];
    for(const key of ['clockFreshForRequest','emergencyEligible','controlFailure','forfeited','retried','recovering','closeWasClean','localCloseRequested','reasonTextRetained'])if(typeof entry[key]==='boolean')record[key]=entry[key];
    if(typeof entry.room==='string'&&this.ownedRooms.has(this.client.resolveRoom(entry.room)))record.room=this.client.resolveRoom(entry.room);
    if(entry.type==='server-error'){
      if(SERVER_ERROR_CATEGORIES.has(entry.serverErrorCategory))record.serverErrorCategory=entry.serverErrorCategory;
      if(SERVER_ERROR_REASONS.has(entry.serverErrorReason))record.serverErrorReason=entry.serverErrorReason;
      record.serverErrorTextRetained=false;
      for(const key of ['stateEndedAtError','requestPresentAtError'])if(typeof entry[key]==='boolean')record[key]=entry[key];
    }
    this.controlTrace.push(record);if(this.controlTrace.length>2000)this.controlTrace.shift();
    this.client.emit('control-trace',record);return record;
  }
  recordControllerTransition(type){
    for(const room of this.client.rooms.values()){room.pendingRejectedRequest=null;room.rejectedClockWindow=null;}
    const rooms=[...this.client.rooms.values()].filter(room=>this.ownedRooms.has(room.id)&&room.id.startsWith('battle-')&&!room.ended);
    if(!rooms.length)this.recordControlTrace({type});
    for(const room of rooms)this.recordControlTrace({type,room:room.id,rqid:room.request?.rqid,revision:room.revision});
  }
  observeControlEvent(event,value={}){
    if(event==='disconnected')for(const state of this.client.rooms.values())if(this.ownedRooms.has(state.id)&&state.id.startsWith('battle-')&&!state.ended)this.recordControlTrace({type:'disconnected',room:state.id,closeCode:value.closeCode,closeWasClean:value.closeWasClean,localCloseRequested:value.localCloseRequested,reasonTextRetained:false,reasonCode:/^ws-close-(?:normal|going-away|abnormal|policy|server-error|unclassified)$/u.test(value.reasonCode||'')?value.reasonCode:'ws-close-unclassified',controlFailure:true});
    const room=value.room&&this.client.resolveRoom(value.room),state=room&&this.client.rooms.get(room);
    if(room&&!this.ownedRooms.has(room))return;
    if(event==='request')for(const action of this.actions({includePending:true})){
      if(action.kind==='ready'||this.tracedRequests.has(action.token))continue;
      this.tracedRequests.add(action.token);this.recordControlTrace({type:'request',...action});
      if(this.tracedRequests.size>2000)this.tracedRequests.delete(this.tracedRequests.values().next().value);
    }
    if(event==='action-status'){
      const action=state?.lastAction;
      const source=this.choiceSources.get(room)||'operator';
      this.recordControlTrace({type:value.status==='sent'&&['fallback','emergency-default'].includes(source)?`${source}-sent`:value.status,room,rqid:action?.rqid,revision:action?.revision,source,status:value.status,...(source==='emergency-default'?{controlFailure:true}:{}),latencyMs:value.status==='sent'?Math.max(0,this.now()-(state.receivedAt||this.now())):undefined});
      if(action&&['sent','accepted','rejected','execution-observed','resolution-observed'].includes(value.status)){
        const evidence=value.evidence||{};
        const observed=this.turnPlans.observe({teamId:this.roomTeamId(room),room,rqid:action.rqid,revision:action.revision,status:value.status,...(['operator','fallback','emergency-default'].includes(source)?{selectionSource:source}:{}),...(value.status==='sent'?{actions:action.actions}:{}),...(['move','cant','switch'].includes(evidence.type)?{type:evidence.type,slot:evidence.slot,executed:evidence.executed}:{})});
        if(observed)this.queueTurnPlanNote(observed,{observation:observed.observations.at(-1)});
      }
    }
    if(event==='server-error'&&state)this.recordControlTrace({type:'server-error',room,rqid:state.request?.rqid,revision:state.revision,reasonCode:'inspect-fresh-request',...ownedServerErrorDiagnostic(value.text,state)});
    if(event==='battle-event'&&['start','turn','win','tie'].includes(value.type))this.recordControlTrace({type:'server-advance',room,rqid:state?.request?.rqid,revision:state?.revision,status:value.type});
    if(event==='disconnected')this.recordControlTrace({type:'disconnected'});
  }
  recipientContext(action){
    const room=this.client.rooms.get(action.room),board=compactTurnBoard(this.client.battleSnapshot?.(action.room),{request:room?.request,events:room?.battleLog||[]});
    let opponentSheet;
    try{opponentSheet=observedPlanningSheet(board,{rooms:[{id:action.room,sheets:room?.sheets}]},action.room);}catch{/* Missing published data cannot authorize a recipient read. */}
    let ownTeam;try{ownTeam=Teams.unpack(this.packed);}catch{/* Unknown current move typing remains unverified. */}
    const boardHash=boardDigest(board,action.legalActions),source={kind:'bound-observed-turn',sessionId:this.id,teamId:this.roomTeamId(action.room),room:action.room,rqid:action.rqid,boardHash,
      ...(opponentSheet?{opposingSheetSha256:digest(opponentSheet)}:{})};
    source.requestDigest=requestDigest({...source,token:action.token});
    return {context:buildTurnFacts({board,legalActions:action.legalActions,ownTeam,opponentSheet}),source};
  }
  validateRecipientActions(action,choices,plan,authority){
    if(action.kind!=='turn')return;
    // Emergency defaults are separately authorized control recovery. They keep
    // all native legality/deadline checks and never earn authored plan credit.
    if(authority===SUPERVISOR_EMERGENCY&&this.supervisor.config.emergencyDefaultChoice)return;
    const {context,source}=this.recipientContext(action);
    const audit=validateSelectedRecipientEffects(context,choices,plan?.recipientReads,{source,ineffectiveActions:plan?.ineffectiveActions});
    return audit.ineffectiveActions.length?{...audit,validationScope:'session-current-snapshot'}:undefined;
  }
  prepareFallbackTurnPlan(action,value,canonical){
    const plan=validateTurnPlan(value),bound=this.client.validateChoice(action.room,{rqid:action.rqid,revision:action.revision,actions:plan.chosenPair,deadlineAt:this.now()+1000}).actions;
    check(JSON.stringify(bound)===JSON.stringify(canonical),'Fallback turn plan differs from the staged canonical actions');
    // Named switches may compile to numeric slots. Retain the exact authored
    // plan while checking its canonical pair against the protected fallback.
    return this.prepareTurnPlan(action,plan,plan.chosenPair);
  }
  validateAction(action,choices,metadata,authority){
    const fresh=this.actions().find(current=>current.token===action.token);
    check(fresh,'Action token is stale or no longer actionable; inspect fresh state');
    const canonical=this.client.validateChoice(fresh.room,{rqid:fresh.rqid,revision:fresh.revision,actions:choices,deadlineAt:this.now()+1000}).actions;
    const prepared=metadata?.turnPlan===undefined?null:this.prepareFallbackTurnPlan(fresh,metadata.turnPlan,canonical);
    if(metadata?.previewPlan!==undefined)this.preparePreviewPlan(fresh,metadata.previewPlan,canonical);
    this.validateRecipientActions(fresh,canonical,prepared?.plan,authority);
    return canonical;
  }
  emergencyChoice(action){
    this.assertLive();
    if(this.controller.required&&!this.controller.status().owner)return null;
    const fresh=this.actions().find(current=>current.token===action.token);
    if(!fresh)return null;
    const room=this.client.rooms.get(fresh.room),request=room?.request;
    const snapshot=this.client.battleSnapshot?.(fresh.room);
    const foeSlots=(snapshot?.sides||[]).filter(side=>side.id!==request?.side?.id).flatMap(side=>(side.active||[]).flatMap(active=>{
      const pokemon=side.pokemon.find(value=>value.id===active.pokemon);
      return pokemon&&pokemon.fainted!==true&&['a','b'].includes(active.slot)?[active.slot==='a'?1:2]:[];
    }));
    return selectEmergencyActions(request,{foeSlots:[...new Set(foeSlots)]});
  }
  submitChoice(action,choices,source='operator',validForMs=10000,turnPlan,authority,previewPlan){
    const fresh=this.actions().find(current=>current.token===action.token);
    check(fresh,'Action token is stale or no longer actionable; inspect fresh state');
    check(Number.isInteger(validForMs)&&validForMs>=100&&validForMs<=30000,'Decision validity must be 100–30000 ms');
    const deadlineAt=Math.min(this.now()+validForMs,fresh.clock.deadlineAt===null?Infinity:fresh.clock.deadlineAt-1000);
    check(deadlineAt>this.now(),'Observed turn countdown has expired; inspect fresh state');
    const canonical=this.client.validateChoice(fresh.room,{rqid:fresh.rqid,revision:fresh.revision,actions:choices,deadlineAt}).actions;
    const prepared=turnPlan===undefined?null:source==='fallback'?this.prepareFallbackTurnPlan(fresh,turnPlan,canonical):this.prepareTurnPlan(fresh,turnPlan,choices);
    const preview=previewPlan===undefined?null:this.preparePreviewPlan(fresh,previewPlan,choices);
    const recipientEffectAudit=this.validateRecipientActions(fresh,canonical,prepared?.plan,authority);
    if(prepared)this.recordPreparedTurnPlan(prepared,'selected');
    if(preview)this.recordPreparedPreviewPlan(preview,'selected');
    this.recordControlTrace({type:'selected',...fresh,source});this.choiceSources.set(fresh.room,source);
    this.client.authorize('choose',{room:fresh.room,confirmed:true});
    // Capture a read-only pre-send boundary. Failure never withholds the actual
    // choice, and a frozen reference cannot be used to send or revise a move.
    const frozenSimulation=this.freezeSimulationContext(fresh);
    try{
      const result=this.client.choose(fresh.room,{rqid:fresh.rqid,revision:fresh.revision,actions:canonical,deadlineAt});
      if(frozenSimulation&&this.client.rooms.get(fresh.room)?.lastAction)this.client.rooms.get(fresh.room).lastAction.frozenSimulation=frozenSimulation;
      // The socket choice is sent first. This synchronous hook runs before a
      // later network frame can deliver another actionable request.
      this.ensureTimerAfterChoice(fresh,result);return {...result,...(recipientEffectAudit?{recipientEffectAudit}:{}),...(frozenSimulation?{frozenSimulation}:{})};
    }
    catch(error){
      const key=`choose:${fresh.room}:${fresh.rqid}:${fresh.revision}`;
      if(this.client.sent.has(key)){this.uncertainChoices.add(fresh.token);this.recordControlTrace({type:'watchdog-uncertain',...fresh,source,reasonCode:'socket-write-uncertain'});}
      else this.recordControlTrace({type:'validation-rejected',...fresh,source,reasonCode:'inspect-fresh-request'});
      throw error;
    }finally{this.supervisor.refresh('choice-attempt');}
  }
  containControlFailure(action,reason){
    const c=this.client,parent=c.resolveRoom(action.parentId||this.roomParents.get(action.room));
    this.assertLive();check(this.ownedParents.has(parent)&&!c.rooms.get(parent)?.ended,'No live owned parent for control recovery');
    if(c.pendingForfeit(parent))return {status:'pending-forfeit'};
    this.recordControlTrace({type:'watchdog-forfeit',...action,reasonCode:reason||'control-timeout',source:'watchdog'});
    c.authorize('forfeit',{room:parent,confirmed:true});return c.forfeitSet(parent);
  }
  turnSnapshot(){
    const observedAt=this.now(),controlPolicy=this.controlPolicySnapshot();
    const rooms=[...this.client.rooms.values()].filter(room=>this.ownedRooms.has(room.id)&&!room.ended&&!this.client.rooms.get(this.roomParents.get(room.id))?.ended);
    const actions=this.actions().map(action=>{
      if(action.kind!=='turn')return action;
      try{
        const {source}=this.recipientContext(action);
        check(['boardHash','requestDigest'].every(name=>/^[a-f0-9]{64}$/u.test(source[name])),'Current recipient source is unavailable');
        check(source.opposingSheetSha256===undefined||/^[a-f0-9]{64}$/u.test(source.opposingSheetSha256),'Current recipient sheet source is unavailable');
        return {...action,recipientEffectSource:Object.fromEntries(['boardHash','requestDigest','opposingSheetSha256'].filter(name=>source[name]!==undefined).map(name=>[name,source[name]]))};
      }catch{return {...action,recipientEffectSourceStatus:'unavailable'};}
    }),previewRooms=new Set(actions.filter(action=>action.kind==='preview').map(action=>action.room));
    const boards=rooms.filter(room=>room.id.startsWith('battle-')).map(room=>({room:room.id,parentId:this.roomParents.get(room.id),
      requestAgeMs:Number.isFinite(room.receivedAt)?Math.max(0,this.now()-room.receivedAt):null,clock:this.clock(room,room.request?.teamPreview?'preview':'turn'),timer:this.client.timerStatus(room.id),
      ...compactTurnBoard(this.client.battleSnapshot?.(room.id),{request:room.request,events:room.battleLog}),
      actionPlan:this.turnPlans.snapshot({teamId:this.roomTeamId(room.id),room:room.id,rqid:room.request?.rqid,revision:room.revision}),
      ...(previewRooms.has(room.id)?{opponentSheets:Object.fromEntries(Object.entries(room.sheets||{}).filter(([side])=>side!==room.request.side?.id).map(([side,packed])=>[side,publishedSheet(packed)])),opponentSheetUncertainty:'Registered six and published sets only; selected four, stat investments and next actions are unknown.'}:{})}));
    return {sessionId:this.id,revision:this.revision,observedAt,connected:this.client.connected,authenticated:this.client.authenticated,stopped:this.stopped,transport:this.client.transportStatus?.()||null,controller:this.controller.status(),controlPolicy,timerPolicy:this.timerPolicySnapshot(),actions,
      autoReady:this.autoReady,savingReplays:this.savingReplays,awaitingSet:this.awaitingSet,searchPending:!!this.client.searchPending,switchingTeam:this.switchingTeam,search:this.client.searchState||null,
      rooms:[...this.client.rooms.values()].filter(room=>this.ownedRooms.has(room.id)).map(room=>({id:room.id,parentId:this.roomParents.get(room.id),ended:room.ended,result:room.result||null})),
      timing:{observedAt,requests:this.actions({includePending:true}).filter(action=>action.kind!=='ready').map(action=>{
        const record=controlPolicy.pending.find(value=>value.token===action.token),remaining=value=>Number.isFinite(value)?Math.max(0,value-observedAt):null;
        return {token:action.token,room:action.room,rqid:action.rqid,revision:action.revision,receivedAt:action.receivedAt,
          requestAgeMs:Number.isFinite(action.receivedAt)?Math.max(0,observedAt-action.receivedAt):null,firstChoiceMissing:action.actionable!==false&&!record?.hasFallback,
          planningDeadlineAt:record?.planningDeadlineAt??null,planningRemainingMs:remaining(record?.planningDeadlineAt),cutoffAt:record?.cutoffAt??null,cutoffRemainingMs:remaining(record?.cutoffAt),
          hardDeadlineAt:record?.hardDeadlineAt??null,hardRemainingMs:remaining(record?.hardDeadlineAt),deadlineBasis:record?.deadlineBasis??null,
          state:record?.state??null,hasFallback:record?.hasFallback??false,submissionStatus:action.submissionStatus??null,
          urgency:action.actionable===false?'submission-reserved':record?.recovering||Number.isFinite(record?.cutoffAt)&&record.cutoffAt<=observedAt?'plan-overdue':'planning'};
      }),limitation:'Planning and cutoff times are local control budgets. Only observed server clock evidence establishes a turn or bank countdown; a missing first choice never authorizes a retry or forfeit.'},
      boards,actionPlanPersistence:this.turnPlanPersistence(),
      choices:rooms.filter(room=>room.lastAction).map(room=>({room:room.id,...room.lastAction}))};
  }
  actionFailure(command,error){
    const reply={id:command.id,ok:false,error:error.message};
    if(!['stage-fallback','choose'].includes(command.op)||command.confirmed!==true)return reply;
    // A rejected controller must not obtain a new action token through a
    // mutation response. Read-only observations retain their existing access.
    try{this.controller.assert(command.controllerLease);}catch{return reply;}
    const context=this.actionContexts.get(command.token),room=context&&this.client.resolveRoom(context.room),state=room&&this.client.rooms.get(room);
    const reservation=!!context&&this.client.sent.has(`choose:${room}:${context.rqid}:${context.revision}`);
    const matching=context&&state?.lastAction?.rqid===context.rqid&&state?.lastAction?.revision===context.revision?state.lastAction:null;
    const uncertain=reservation&&this.uncertainChoices.has(command.token);
    return {...reply,recovery:{operation:command.op,outcome:uncertain?'send-uncertain':reservation?'submission-reserved':'not-sent',retry:false,rebind:false,requiresNewDecision:true,
      attempted:context?{token:command.token,room,rqid:context.rqid,revision:context.revision,reservation,submissionStatus:uncertain?'uncertain':matching?.status??(reservation?'sent':null)}:null,
      state:this.turnSnapshot()}};
  }
  controlPolicySnapshot(){const {recentEvents,...policy}=this.supervisor.status();return policy;}
  readControlTrace({room,limit=50}={}){
    check(Number.isInteger(limit)&&limit>=1&&limit<=200,'Trace limit must be 1–200');
    if(room){room=this.client.resolveRoom(room);check(this.ownedRooms.has(room),'Trace room is not owned by this session');}
    return {sessionId:this.id,controller:this.controller.status(),controlPolicy:this.controlPolicySnapshot(),entries:this.controlTrace.filter(entry=>!room||entry.room===room||this.roomParents.get(entry.room)===room).slice(-limit),limitation:'Local control observations distinguish attempts, sends and server responses; they do not guarantee server acceptance.'};
  }
  migrateRoom({oldRoom,room}) {
    // A server rename moves existing authority; it never acquires another set.
    if(!this.ownedRooms.has(oldRoom))return;
    this.choiceHistories.get(oldRoom)?.invalidate('Native room renamed; history must be re-established');this.choiceHistories.delete(oldRoom);this.choiceHistorySequences.delete(oldRoom);this.frozenChoiceContexts.clear();
    this.ownedRooms.delete(oldRoom);this.ownedRooms.add(room);
    if(this.ownedParents.delete(oldRoom))this.ownedParents.add(room);
    const parent=this.roomParents.get(oldRoom);this.roomParents.delete(oldRoom);
    if(this.roomTeams.has(oldRoom)){this.roomTeams.set(room,this.roomTeams.get(oldRoom));this.roomTeams.delete(oldRoom);}
    if(this.replayPreservation.has(oldRoom)){const entry=this.replayPreservation.get(oldRoom);entry.parentId=room;this.replayPreservation.set(room,entry);this.replayPreservation.delete(oldRoom);}
    if(this.replayTasks.has(oldRoom)){this.replayTasks.set(room,this.replayTasks.get(oldRoom));this.replayTasks.delete(oldRoom);}
    for(const context of this.actionContexts.values())if(context.room===oldRoom)context.room=room;
    this.turnPlans.migrateRoom(oldRoom,room);
    if(parent)this.roomParents.set(room,parent===oldRoom?room:parent);
    for(const [child,owner] of this.roomParents)if(owner===oldRoom)this.roomParents.set(child,room);
    for(const key of [...this.readySent])if(key.startsWith(`ready:${oldRoom}:`))this.readySent.add(`ready:${room}:${key.slice(`ready:${oldRoom}:`.length)}`);
  }
  captureRooms() {
    this.captureRestoredSet();
    if (!this.searchesSent && !this.restoredSetParent) return;
    if(this.awaitingSet) {
      const candidates=Object.keys(this.client.searchState?.games || {}).filter(room=>/^game-bestof3-gen9championsvgc2026regmcbo3-\d+(?:-[a-z0-9]+pw)?$/.test(room) && !this.ownedParents.has(room));
      // An ambiguous set list never grants control over an arbitrary battle.
      if(candidates.length===1){this.ownedParents.add(candidates[0]);this.ownedRooms.add(candidates[0]);this.roomParents.set(candidates[0],candidates[0]);this.roomTeams.set(candidates[0],this.client.expectedTeamHash);this.awaitingSet=false;if(this.cancellation)this.cancellation.status='match-observed';if(this.replayPolicy.enabled)this.replayPreservation.set(candidates[0],{parentId:candidates[0],teamId:this.client.expectedTeamHash,status:'awaiting-completion',required:true,attempted:false,verifiedChildIds:[],preservedChildIds:[],failures:[]});}
    }
    // Private sets may advertise only their ID while child requests arrive
    // independently. Join the acquired parent to obtain its trusted child links.
    // Also cover a parent acquired before this observation path became available.
    if(!this.stopped && this.client.connected && this.client.authenticated)for(const parent of this.ownedParents) {
      if(this.client.rooms.get(parent)?.ended || this.client.sent.has(`join:${this.client.epoch}:${parent}`))continue;
      try{this.client.joinRoom(parent);}catch{
        this.notices.push({at:this.now(),kind:'parent-join-not-confirmed',room:parent,message:'Inspect fresh state before acting; no automatic retry was made.'});
        this.notices=this.notices.slice(-20);
      }
    }
    for (const r of this.client.rooms.values()) {
      if (this.ownedRooms.has(r.id)) for (const child of r.children) if(/^battle-gen9championsvgc2026regmcbo3-\d+(?:-[a-z0-9]+pw)?$/.test(child)){
        if(this.isRestoredRoom(r.id)&&!this.validateRestoredChild(child))continue;
        const newlyRestored=this.isRestoredRoom(r.id)&&!this.ownedRooms.has(child);
        this.ownedRooms.add(child);this.roomParents.set(child,this.roomParents.get(r.id));this.roomTeams.set(child,this.roomTeamId(r.id));
        if(newlyRestored)this.recordControlTrace({type:'restored-parent-child-verified',room:child,source:'restored-set-forfeit',reasonCode:'trusted-parent-link'});
      }
    }
  }
  enableRestoredSetObservation(){
    if(!this.restoredSetProof)return;
    check(this.metricsRecorder,'Restored-set recovery requires the live metrics recorder');
    this.restoredSetObservationEnabled=true;this.captureRooms();this.metricsRecorder.restoreObserved?.();queueMicrotask(()=>this.maybePreserveReplays());
  }
  isRestoredRoom(room){return !!this.restoredSetProof&&(canonicalRecoveryRoom(room)===this.restoredSetProof.parentId||canonicalRecoveryRoom(this.roomParents.get(this.client.resolveRoom(room)))===this.restoredSetProof.parentId);}
  restoredEvidenceForRoom(room){return this.restoredSetEvidence.find(entry=>entry.record.roomId===canonicalRecoveryRoom(room));}
  captureRestoredSet(){
    const proof=this.restoredSetProof,c=this.client;
    if(!proof||!this.restoredSetObservationEnabled||this.stopped||!c.connected||!c.authenticated)return;
    check(c.expectedUser===proof.account,'Authenticated account differs from restored-set recovery');
    const current=Object.keys(c.searchState?.games||{}).filter(room=>canonicalRecoveryRoom(room)===proof.parentId);
    check(current.length<=1,'Ambiguous restored parent aliases');
    const parent=c.resolveRoom(current[0]||this.restoredSetParent||proof.parentId);
    check(canonicalRecoveryRoom(parent)===proof.parentId,'Restored parent identity changed');
    if(this.restoredSetParent&&this.restoredSetParent!==parent)this.migrateRoom({oldRoom:this.restoredSetParent,room:parent});
    this.restoredSetParent=parent;
    this.ownedParents.add(parent);this.ownedRooms.add(parent);this.roomParents.set(parent,parent);this.roomTeams.set(parent,proof.teamId);
    if(this.replayPolicy.enabled&&!this.replayPreservation.has(parent))this.replayPreservation.set(parent,{parentId:parent,teamId:proof.teamId,status:'awaiting-completion',required:true,attempted:false,verifiedChildIds:[],preservedChildIds:[],failures:[]});
    if(!c.sent.has(`join:${c.epoch}:${parent}`)&&c.rooms.get(parent)?.subscriptionEpoch!==c.epoch){
      try{c.joinRoom(parent);}catch{this.notices.push({at:this.now(),kind:'restored-parent-join-not-confirmed',room:parent,message:'Inspect the exact restored parent; no automatic retry was made.'});}
    }
    for(const child of c.rooms.get(parent)?.children||[]){
      if(!/^battle-gen9championsvgc2026regmcbo3-\d+(?:-[a-z0-9]+pw)?$/u.test(child))continue;
      if(!c.sent.has(`join:${c.epoch}:${child}`)&&c.rooms.get(child)?.subscriptionEpoch!==c.epoch){try{c.joinRoom(child);}catch{}}
    }
  }
  validateRestoredChild(child){
    const state=this.client.rooms.get(this.client.resolveRoom(child)),lines=state?.battleLog||[];
    const players=lines.filter(line=>line.startsWith('|player|')).map(line=>line.split('|')[3]);
    const tier=lines.find(line=>line.startsWith('|tier|'))?.slice(6);
    return players.some(player=>normalized(player)===this.restoredSetProof.account)&&normalized(tier)==='gen9championsvgc2026regmcbo3';
  }
  assertRestoredSetSettled(){
    if(!this.restoredSetProof)return;
    const parent=this.client.rooms.get(this.restoredSetParent);
    check(parent?.ended&&['win','tie'].includes(parent.result?.type)&&parent.children.length>0&&parent.children.length<=3&&parent.children.every(child=>this.ownedRooms.has(this.client.resolveRoom(child))&&this.client.rooms.get(this.client.resolveRoom(child))?.ended),'Finish restored-set result and linked-child preservation before another search or team change');
  }
  roomTeamId(room){return this.roomTeams.get(this.client.resolveRoom(room))||this.client.expectedTeamHash;}
  capabilities(){return {schemaVersion:2,runtime:'champions-headless-session',buildRevision:RUNTIME_REVISION,modules:{...RUNTIME_MODULES},loadedAt:LOADED_AT,operations:['status','turn-status','simulation-context','research-reserve','research-settle','research-status','control-trace','control-claim','control-release','set-control-policy','stage-fallback','withdraw-fallback','capabilities','wait','metrics-status','metrics-sync','start','authorize-sets','choose','ready','cancel-search','set-timer','set-timer-policy','forfeit','save-replays','set-replay-policy','stop',...(this.decisionNoteWriter?['note-decision']:[]),...(this.recorderFactory?['switch-team']:[])],features:{controllerLease:this.controller.required,deadlineSupervisor:true,deadlinePlanningRecovery:true,previewPlanningBudget:true,emergencyDefaultChoice:true,compactTurnBoard:true,mechanicalSimulationSource:true,frozenSimulationSource:true,nativeResearchBudget:true,sharedCurrentFrozenResearchBudget:true,compactTurnWait:true,actionFailureRecovery:true,requestTiming:true,namedReplacements:true,controlTrace:true,ownedBattleServerErrorDiagnostics:true,safeDisconnectDiagnostics:true,restoredSetForfeitRecovery:true,ownedBattleTimer:true,ownedBattleTimerPolicy:true,ownedBattlePreviewTimer:true,recordingSchemaVersion:this.metricsStatus().recordingSchemaVersion??null,previewDecisionEvidence:this.metricsStatus().features?.previewDecisionEvidence===true,metricsRecorder:!!this.metricsRecorder,decisionNotes:!!this.decisionNoteWriter,turnPlanPairFromExplicitActions:true,atomicPreviewPlan:true,currentRecipientTypeImmunityGate:true,stagedTurnPlanMetadata:true,exactFallbackWithdrawal:true,sourceBoundIneffectiveActions:true,idleTeamSwitch:!!this.recorderFactory,authorizedReplayPolicy:!!this.replayPreservationVerifier},sourceChangesRequireNewSession:true};}
  rememberAction(action){
    const state=this.client.rooms.get(action.room),turn=state?.battle?.turn;
    if(!this.actionContexts.has(action.token))this.actionContexts.set(action.token,{room:action.room,teamId:this.roomTeamId(action.room),rqid:action.rqid,revision:action.revision,turn:Number(turn)||0,sessionId:this.id,token:action.token,lastObservedStatus:state?.lastAction?.rqid===action.rqid?state.lastAction.status:'unsubmitted'});
    while(this.actionContexts.size>1000)this.actionContexts.delete(this.actionContexts.keys().next().value);
  }
  assertLive() {
    check(!this.stopped && this.client.connected && this.client.authenticated, 'Session is disconnected or stopped; sign in again in the user terminal');
  }
  token(room, kind, extra) {
    return hash([this.id,this.client.epoch,room,this.roomParents.get(room) || room,kind,extra]);
  }
  clock(r, kind) {
    // Parent timer history survives child games. A ready countdown belongs to
    // this prompt only when it was observed after that prompt on this connection.
    // Repeated copies of the same prompt do not reset its observation boundary.
    const continuation=r.rejectedClockWindow;
    const window=continuation?.epoch===this.client.epoch&&continuation.turn===r.battle.turn&&continuation.rqid===r.request?.rqid?continuation:null;
    const boundaryAt=window?.receivedAt??r.receivedAt??0;
    const readyObservation = entry => Number.isFinite(r.readyPrompt?.at) && r.readyPrompt.epoch === this.client.epoch && compareTimerObservations(entry,r.readyPrompt)>=0;
    const observation = [...r.timers].reverse().find(entry => {
      if (entry.type === 'inactiveoff' || entry.epoch!==undefined&&entry.epoch!==this.client.epoch || (kind === 'ready' ? !readyObservation(entry) : entry.at < boundaryAt)) return false;
      if (/^Time left: \d+ sec this turn(?: \||$)/.test(entry.text)) return kind !== 'ready';
      const match = entry.text.match(/^(.*?) has (\d+) seconds (left\.|to confirm battle start!)/);
      return match && normalized(match[1]) === normalized(this.username) && (kind === 'ready' ? match[3].startsWith('to confirm') : match[3] === 'left.');
    });
    // A timer-off observation cancels earlier countdown evidence.
    const timerOff = [...r.timers].reverse().find(entry => entry.type === 'inactiveoff' && (kind !== 'ready' || readyObservation(entry)));
    if(timerOff && timerOff.at >= boundaryAt && (!observation || compareTimerObservations(timerOff,observation)>=0))return {source:'server-timer-disabled',observedAt:timerOff.at,deadlineAt:null,remainingMs:null,bankDeadlineAt:null,bankRemainingMs:null};
    if (!observation || timerOff && compareTimerObservations(timerOff,observation)>=0) return {source:'unavailable',deadlineAt:null,remainingMs:null,bankDeadlineAt:null,bankRemainingMs:null};
    const match = observation.text.match(/^Time left: (\d+) sec this turn/) || observation.text.match(/ has (\d+) seconds /);
    const deadlineAt = Math.min(observation.at + Number(match[1]) * 1000,window?.deadlineAt??Infinity);
    const bank=observation.text.match(/\| (\d+) sec total(?: \||$)/),bankValues=[bank?observation.at+Number(bank[1])*1000:null,window?.bankDeadlineAt].filter(Number.isFinite),bankDeadlineAt=bankValues.length?Math.min(...bankValues):null;
    return {source:'server-timer-observation',observedAt:observation.at,text:observation.text,deadlineAt,remainingMs:Math.max(0,deadlineAt-this.now()),bankDeadlineAt,bankRemainingMs:bankDeadlineAt===null?null:Math.max(0,bankDeadlineAt-this.now()),uncertainty:'Server/network delay can shorten the available time; this is an observed countdown, not an exact server deadline.'};
  }
  actions({includePending=false}={}) {
    if (this.stopped || !this.client.connected || !this.client.authenticated) return [];
    const c = this.client, output = [];
    for (const r of c.rooms.values()) {
      if (!this.ownedRooms.has(r.id) || this.isRestoredRoom(r.id) || r.ended || c.rooms.get(this.roomParents.get(r.id))?.ended || c.pendingForfeit(r.id)) continue;
      const q = r.request;
      if (r.epoch === c.epoch && q && normalized(q.side?.name)===normalized(this.username) && !q.wait && !r.confirmedChoice) {
        const key = `choose:${r.id}:${q.rqid}:${r.revision}`;
        const pending=c.sent.has(key);
        if(pending&&(!includePending||r.lastAction?.rqid===q.rqid&&['accepted','execution-observed','resolution-observed'].includes(r.lastAction.status)))continue;
        const kind = q.teamPreview ? 'preview' : q.forceSwitch ? 'switch' : 'turn';
        const actionToken=this.token(r.id,kind,[q.rqid,r.revision]);
        const window=r.rejectedClockWindow,continued=window?.epoch===c.epoch&&window.turn===r.battle.turn&&window.rqid===q.rqid;
        output.push({kind,room:r.id,parentId:this.roomParents.get(r.id),token:actionToken,rqid:q.rqid,revision:r.revision,receivedAt:continued?window.receivedAt:r.receivedAt,...(continued?{requestPacketReceivedAt:r.receivedAt,requestClockContinuity:{source:'explicit-trapped-choice-replacement',originRqid:window.originRqid,rejectedRqid:window.rejectedRqid,rejectedAt:window.rejectedAt}}:{}),...(pending?{actionable:false,submissionStatus:this.uncertainChoices.has(actionToken)?'uncertain':'sent'}:{}),clock:this.clock(r,kind),legalActions:{teamPreview:!!q.teamPreview,maxChosenTeamSize:q.maxChosenTeamSize || q.maxTeamSize || (q.teamPreview ? 4 : undefined),active:q.active || null,forceSwitch:q.forceSwitch || null,pokemon:q.side?.pokemon || [],replacements:replacementOptions(q),replacementPairs:legalReplacementPairs(q),targetConvention:'Positive 1/2 = opposing slots; negative -1/-2 = own slots.'}});
      }
    }
    for (const r of c.rooms.values()) {
      if (!this.ownedRooms.has(r.id) || this.isRestoredRoom(r.id) || r.ended || r.readyPrompt?.epoch !== c.epoch || c.pendingForfeit(r.id)) continue;
      const key = `ready:${r.id}:${r.readyPrompt.token}`;
      if (c.sent.has(key) || this.readySent.has(key)) continue;
      if (r.children.some(child => output.some(action => action.room === child))) continue;
      output.unshift({kind:'ready',room:r.id,token:this.token(r.id,'ready',r.readyPrompt.token),clock:this.clock(r,'ready')});
    }
    for(const action of output)if(action.kind!=='ready')this.rememberAction(action);
    return output;
  }
  confirmPendingReady() {
    if (this.stopped || !this.searchesSent) return;
    for (const action of this.actions().filter(action => action.kind === 'ready')) {
      const r = this.client.state(action.room), key = `ready:${r.id}:${r.readyPrompt.token}`;
      // Reserve before sending. An ambiguous send never becomes a retry loop.
      this.readySent.add(key);
      try {
        this.client.authorize('ready',{room:r.id,confirmed:true});
        this.client.confirmReady(r.id);
        this.notices.push({at:this.now(),kind:'ready-sent',room:r.id});
      } catch {
        this.notices.push({at:this.now(),kind:'ready-not-confirmed',room:r.id,message:'Inspect fresh state before acting; no retry was made.'});
      }
      this.notices = this.notices.slice(-20);
      this.revision++; this.emit('change',{revision:this.revision,event:'readiness'});
    }
  }
  snapshot() {
    this.captureRooms();
    return {
      sessionId:this.id,revision:this.revision,connected:this.client.connected,authenticated:this.client.authenticated,stopped:this.stopped,
      username:this.username,teamSha256:this.client.expectedTeamHash,authorizedSets:this.authorizedSets,searchesSent:this.searchesSent,autoReady:this.autoReady,
      restoredSetRecovery:this.restoredSetProof?{parentId:this.restoredSetProof.parentId,currentParent:this.restoredSetParent,authority:this.restoredSetProof.authority,observationEnabled:this.restoredSetObservationEnabled,priorChildIds:this.restoredSetProof.childIds,searchesAdded:0}:null,
      savingReplays:this.savingReplays,awaitingSet:this.awaitingSet,searchPending:!!this.client.searchPending,
      replayPolicy:this.replayPolicySnapshot(),timerPolicy:this.timerPolicySnapshot({includeChildren:true}),
      switchingTeam:this.switchingTeam,capabilities:this.capabilities(),transport:this.client.transportStatus?.()||null,
      controller:this.controller.status(),controlPolicy:this.controlPolicySnapshot(),
      metrics:this.metricsStatus(),
      search:this.client.searchState || null,cancellation:this.cancellation || null,actions:this.actions(),notices:this.notices,
      rooms:[...this.client.rooms.values()].filter(r=>this.ownedRooms.has(r.id)).map(r=>({
        id:r.id,teamId:this.roomTeamId(r.id),ended:r.ended,result:r.result || null,children:r.children,sheets:r.sheets,
        state:this.client.battleSnapshot?.(r.id) || null,
        choice:r.lastAction || null,clock:this.clock(r,'turn'),timer:this.client.timerStatus(r.id),recentEvents:r.battleLog.slice(-12),
        forfeit:r.forfeitPending || null,
      })),
    };
  }
  attachMetricsRecorder(recorder) {
    check(!this.metricsRecorder,'A metrics recorder is already attached');
    check(typeof recorder?.status==='function' && typeof recorder?.flush==='function','Metrics recorder must expose status and flush');
    check(recorder.status().teamId===this.client.expectedTeamHash,'Metrics recorder differs from the approved fixed team');
    this.metricsRecorder=recorder;
    this.detachMetrics=recorder.onChange?.(()=>this.emit('change',{revision:++this.revision,event:'metrics'}));
  }
  turnPlanPersistence(){return {enabled:!!this.decisionNoteWriter,pending:this.turnPlanWrites.size,failures:this.turnPlanWriteFailures,dropped:this.turnPlanWritesDropped};}
  async settleTurnPlanWrites({timeoutMs=25000}={}){
    check(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=25000,'Turn plan settlement requires a bounded timeout');let timer;
    try{
      await Promise.race([(async()=>{while(this.turnPlanWrites.size)await Promise.all([...this.turnPlanWrites]);})(),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Turn plan persistence did not settle within its bounded budget. Retain the old team and local evidence.')),timeoutMs);})]);
      check(!this.turnPlanWriteFailures&&!this.turnPlanWritesDropped,'Turn plan persistence is incomplete. Retain the old team and local evidence before switching.');
    }finally{clearTimeout(timer);}
  }
  prepareTurnPlan(action,value,actions){
    check(action&&['turn','switch'].includes(action.kind),'Turn plan metadata is supported only for active battle turns and replacements; submit preview without turnPlan.');
    const plan=validateTurnPlan(value,{actions}),context=this.actionContexts.get(action.token);
    check(context&&context.rqid===action.rqid&&context.revision===action.revision&&context.sessionId===this.id&&this.client.resolveRoom(context.room)===this.client.resolveRoom(action.room)&&context.teamId===this.roomTeamId(action.room),'Turn plan must bind to the current observed request');
    validateTurnPlanBinding({teamId:context.teamId,room:context.room,rqid:context.rqid,revision:context.revision,turn:context.turn});
    return structuredClone({context,plan,actions});
  }
  preparePreviewPlan(action,value,actions){
    check(action?.kind==='preview','previewPlan metadata requires the exact current preview request');
    const previewPlan=validatePreviewPlan(value,{actions}),context=this.actionContexts.get(action.token);
    check(context&&context.rqid===action.rqid&&context.revision===action.revision&&context.sessionId===this.id&&this.client.resolveRoom(context.room)===this.client.resolveRoom(action.room)&&context.teamId===this.roomTeamId(action.room),'Preview plan must bind to the current observed request');
    validateTurnPlanBinding({teamId:context.teamId,room:context.room,rqid:context.rqid,revision:context.revision,turn:context.turn});
    return structuredClone({context,previewPlan,actions});
  }
  recordPreparedPreviewPlan({context,previewPlan,actions},stage){
    const record=this.turnPlans.recordPreview({...context,previewPlan,actions,stage});
    if(!record.unchanged)this.queueTurnPlanNote(record);
    return record;
  }
  recordPreparedTurnPlan({context,plan,actions},stage){
    const record=this.turnPlans.record({...context,plan,actions,stage});
    if(!record.unchanged)this.queueTurnPlanNote(record);
    return record;
  }
  captureTurnPlan(action,value,actions,stage){return this.recordPreparedTurnPlan(this.prepareTurnPlan(action,value,actions),stage);}
  queueTurnPlanNote(record,{observation}={}){
    if(!this.decisionNoteWriter)return;
    // Persistence is optional and never awaited on the stage/send path. Bound
    // even a failed or indefinitely stalled writer; surface failure for review.
    if(this.turnPlanWrites.size>=32){this.turnPlanWritesDropped++;return;}
    const canonical=value=>value.replace(/-[a-z0-9]+pw$/u,''),context=[...this.actionContexts.values()].find(value=>value.teamId===record.teamId&&canonical(value.room)===record.room&&value.rqid===record.rqid&&value.revision===record.revision);
    if(!context){this.turnPlanWriteFailures++;return;}
    const requestRef=hash([context.sessionId,record.room,record.rqid,record.revision]);
    if(record.previewPlan){
      if(observation)return; // Observed sends stay separate from the original intent note.
      const note={...context,noteId:'preview-plan-'+hash([requestRef,record.planHash]).slice(0,48),ourPlan:record.previewPlan.objective,actionStatusAtNote:record.intentStatus,
        previewPlan:record.previewPlan,previewPlanCapture:{capturedAt:record.recordedAt,intentStatus:record.intentStatus,planHash:record.planHash}};
      let task;task=Promise.resolve().then(()=>this.decisionNoteWriter({teamId:record.teamId,room:context.room,note})).catch(()=>{this.turnPlanWriteFailures++;}).finally(()=>this.turnPlanWrites.delete(task));
      this.turnPlanWrites.add(task);return;
    }
    const noteId=(observation?'plan-observed-':'plan-')+hash([requestRef,record.planHash,observation||null]).slice(0,48);
    const note={...context,noteId,ourPlan:record.plan.objective,actionStatusAtNote:observation?.status||record.intentStatus,
      ...(observation?{turnPlanResolution:{planHash:record.planHash,...observation}}:{turnPlan:record.plan,turnPlanMeta:{planHash:record.planHash,intentStatus:record.intentStatus}})};
    let task;task=Promise.resolve().then(()=>this.decisionNoteWriter({teamId:record.teamId,room:context.room,note})).catch(()=>{this.turnPlanWriteFailures++;}).finally(()=>this.turnPlanWrites.delete(task));
    this.turnPlanWrites.add(task);
  }
  async noteDecision({id,token,...fields}){
    check(fields.previewPlan===undefined&&fields.previewPlanCapture===undefined,'Atomic previewPlan is accepted only with the same preview stage/choose command; later notes cannot backdate first intent');
    check(this.decisionNoteWriter,'Decision notes are unavailable in this loaded session; use the next normal client start');
    this.actions();const context=this.actionContexts.get(token);
    check(context && this.ownedRooms.has(context.room),'Decision note token was not observed in this session');
    if(fields.turnPlan!==undefined)fields.turnPlan=validateTurnPlan(fields.turnPlan);
    // Actual resolution fields can only originate in the observed event path.
    delete fields.turnPlanResolution;delete fields.turnPlanMeta;
    const state=this.client.rooms.get(context.room),action=state?.lastAction;
    const actionStatusAtNote=action?.rqid===context.rqid?action.status:context.lastObservedStatus||'not-observed';
    return this.decisionNoteWriter({teamId:context.teamId,room:context.room,note:{...fields,...context,noteId:id,actionStatusAtNote}});
  }
  assertIdleForTeamSwitch(){
    this.assertLive();const c=this.client;
    check(!this.savingReplays,'Finish replay preservation before switching teams');
    this.assertReplayPreserved();
    check(!this.awaitingSet&&!c.searchPending&&c.searchState&&!c.searchState.searching.length&&!Object.keys(c.searchState.games||{}).length,'Server must confirm idle with no pending search or match before switching teams');
    check(![...this.ownedParents].some(room=>!c.rooms.get(room)?.ended),'Finish the owned BO3 before switching teams');
  }
  async switchTeam({teamText,teamId,name,controllerLease}){
    const assertControl=()=>this.controller.assert(controllerLease);assertControl();
    check(!this.switchingTeam,'A team switch is already running');this.assertIdleForTeamSwitch();
    check(this.recorderFactory,'Team switching is unavailable in this loaded session; use the next normal client start');
    check(typeof teamText==='string'&&Buffer.byteLength(teamText,'utf8')<=128*1024,'Supply a bounded legal team export');
    const team=Teams.import(teamText);check(team?.length===6,'Expected a legal six-Pokemon team');
    const problems=new TeamValidator('gen9championsvgc2026regmc').validateTeam(team);check(!problems?.length,'Team failed M-C validation');
    const packed=Teams.pack(team),nextId=createHash('sha256').update(packed).digest('hex');check(nextId===teamId,'Approved team fingerprint differs from its full export');
    if(nextId===this.client.expectedTeamHash)return {teamId:nextId,unchanged:true,queued:false,authenticated:this.client.authenticated,authorizedSets:this.authorizedSets,searchesSent:this.searchesSent};
    for(const room of this.ownedRooms)if(!this.roomTeams.has(room))this.roomTeams.set(room,this.client.expectedTeamHash);
    this.switchingTeam=true;this.emit('change',{revision:++this.revision,event:'team-switch-started'});let nextRecorder,previousClosed=false;
    const previous=this.metricsRecorder,previousTeamId=this.client.expectedTeamHash;
    try{
      if(previous){const oldStatus=await previous.flush({savePending:true});assertControl();check(!['error','closed'].includes(oldStatus.state),'Old team observations could not be preserved; team was retained');}
      // Prepare the exact next report before replacing any account/team state.
      nextRecorder=await this.recorderFactory({team,teamId:nextId,name:name||'M-C team',session:this,approvedTeamChange:true});
      assertControl();
      check(nextRecorder&&typeof nextRecorder.status==='function','New team recorder is unavailable');
      const prepared=await nextRecorder.flush();assertControl();check(prepared.teamId===nextId&&prepared.state==='ready','New team report could not be prepared; team was retained');
      this.assertIdleForTeamSwitch();
      // Closing has no socket side effects. New observations cannot be acquired
      // during this idle-only operation; start/authorization are separately held.
      const planWriteDeadline=performance.now()+25000;
      await this.settleTurnPlanWrites();assertControl();this.assertIdleForTeamSwitch();
      if(previous){previousClosed=true;await previous.close();}
      // A final late old-room observation during recorder.close still belongs
      // to the old team and must settle before releasing its ephemeral intent.
      await this.settleTurnPlanWrites({timeoutMs:Math.max(1,Math.floor(planWriteDeadline-performance.now()))});
      assertControl();
      this.assertIdleForTeamSwitch();
      check(previous?.status().state!=='error','Old team recorder did not close cleanly; approved team was retained');
      this.detachMetrics?.();this.detachMetrics=null;this.metricsRecorder=null;
      this.client.expectedTeamHash=nextId;this.client.teamHash=null;this.packed=packed;
      for(const history of this.choiceHistories.values())history.invalidate('Locked team changed');
      this.choiceHistories.clear();this.choiceHistorySequences.clear();this.frozenChoiceContexts.clear();this.clearResearchBudgets();
      this.client.grants.delete('upload-team:');this.client.grants.delete('search:');
      for(const key of [...this.client.sent])if(key.startsWith(`team:${this.client.epoch}:`))this.client.sent.delete(key);
      this.attachMetricsRecorder(nextRecorder);nextRecorder=null;
      this.turnPlans.clearTeam(previousTeamId);
      return {teamId:nextId,previousTeamId,queued:false,uploaded:false,authenticated:this.client.authenticated,authorizedSets:this.authorizedSets,searchesSent:this.searchesSent,metrics:this.metricsStatus()};
    }catch(error){
      if(previousClosed&&this.client.expectedTeamHash===previousTeamId){
        try{await previous.reopen?.();this.detachMetrics?.();this.detachMetrics=previous.onChange?.(()=>this.emit('change',{revision:++this.revision,event:'metrics'}));}catch{this.notices.push({at:this.now(),kind:'old-team-recorder-needs-sync',message:'Approved team was retained. Inspect metrics status and preserve local evidence.'});}
      }
      throw error;
    }finally{try{await nextRecorder?.close();}finally{this.switchingTeam=false;this.emit('change',{revision:++this.revision,event:'team-switch-finished'});}}
  }
  metricsStatus() {
    return this.metricsRecorder?.status()||{enabled:false,teamId:this.client.expectedTeamHash,state:'disabled',pending:0,lastSavedAt:null,lastError:null,stableReport:null,message:'Live metrics recording is unavailable in this session. Use report imports or enable recording on the next normal client start.'};
  }
  replayPolicySnapshot(){
    const sets=[...this.replayPreservation.values()].map(entry=>({...entry,parentId:entry.parentId.replace(/-[a-z0-9]+pw$/u,''),verifiedChildIds:entry.verifiedChildIds.map(room=>room.replace(/-[a-z0-9]+pw$/u,'')),preservedChildIds:entry.preservedChildIds.map(room=>room.replace(/-[a-z0-9]+pw$/u,''))}));
    return {...this.replayPolicy,scope:'Future owned BO3s acquired after enabling; existing room privacy is preserved.',requiresPreservationBeforeNextSearch:true,sets,pendingParents:sets.filter(entry=>entry.required&&entry.status!=='complete').map(entry=>entry.parentId),attentionParents:sets.filter(entry=>entry.status==='attention-required').map(entry=>entry.parentId),active:this.replayTasks.size>0,capable:!!this.replayPreservationVerifier};
  }
  replayPolicyChanged(){this.emit('change',{revision:++this.revision,event:'replay-policy'});}
  assertReplayPreserved(){check(![...this.replayPreservation.values()].some(entry=>entry.required&&entry.status!=='complete'),'Finish authorized completed-set replay preservation before another search or team switch; inspect replayPolicy and retry battle_save_replays without repeating uploads.');}
  setReplayPolicy(enabled){
    this.assertIdleForTeamSwitch();check(typeof enabled==='boolean','Replay policy enabled must be boolean');
    if(enabled){check(this.replayPreservationVerifier,'Reliable replay preservation is unavailable in this loaded session; use its next normal start');check(this.metricsStatus().enabled,'Replay policy requires the live metrics recorder and retained report evidence');}
    this.replayPolicy={enabled,configuredAt:new Date(this.now()).toISOString(),fromSearch:this.searchesSent+1};this.replayPolicyChanged();
    return {...this.replayPolicySnapshot(),queued:false,uploaded:false,authorizedSets:this.authorizedSets,searchesSent:this.searchesSent};
  }
  timerPolicySnapshot({includeChildren=false}={}){
    const children=[...this.timerPolicyAttempts.values()].map(({key,...entry})=>({...entry,room:entry.room.replace(/-[a-z0-9]+pw$/u,'')}));
    return {...this.timerPolicy,after:'owned-preview-observed-or-successful-owned-choice-send',scope:'Once per live owned child: after publishing an owned preview, otherwise after its complete choice is sent. Never infer a numerical clock from the timer request.',
      requestAttempts:children.filter(entry=>entry.attempted).length,lastChild:children.at(-1)||null,lastDeferred:this.timerPolicyDeferred,
      ...(includeChildren?{children}:{}),limitation:'A timer request is not server confirmation or a numerical countdown. Existing or uncertain requests are never repeated.'};
  }
  setTimerPolicy(enabled){
    this.assertIdleForTeamSwitch();check(typeof enabled==='boolean','Timer policy enabled must be boolean');
    check(typeof this.client.setTimer==='function'&&typeof this.client.timerStatus==='function','Owned battle timer support is unavailable in this loaded session');
    this.timerPolicy={enabled,configuredAt:new Date(this.now()).toISOString()};
    this.recordControlTrace({type:'timer-policy-configured',status:enabled?'enabled':'disabled'});
    this.emit('change',{revision:++this.revision,event:'timer-policy'});
    return {...this.timerPolicySnapshot(),queued:false,timerSent:false,authorizedSets:this.authorizedSets,searchesSent:this.searchesSent};
  }
  ownedTimerChild(room){
    this.assertLive();const c=this.client,child=c.resolveRoom(room),parent=this.roomParents.get(child),state=c.rooms.get(child),parentState=c.rooms.get(parent);
    check(typeof child==='string' && /^battle-gen9championsvgc2026regmcbo3-\d+(?:-[a-z0-9]+pw)?$/.test(child),'Expected the current authorized M-C child battle room');
    check(this.ownedRooms.has(child) && this.ownedParents.has(parent) && this.ownedRooms.has(parent) && this.roomParents.get(parent)===parent && parentState?.children.includes(child),'Child battle is not linked to an owned authorized BO3 parent');
    check(!parentState.ended && Object.hasOwn(c.searchState?.games || {},parent),'BO3 parent is not live in the current server search state');
    const liveChildren=parentState.children.filter(id=>this.ownedRooms.has(id) && this.roomParents.get(id)===parent && !c.rooms.get(id)?.ended && c.rooms.get(id)?.epoch===c.epoch && c.rooms.get(id)?.request);
    check(liveChildren.length===1 && liveChildren[0]===child && state?.epoch===c.epoch && state.request && !state.ended,'No unambiguous current live owned child battle request');
    check(!state.request.side?.name || normalized(state.request.side.name)===normalized(this.username),'Child battle request belongs to another player');
    check(!c.pendingForfeit(child),'BO3 forfeit was sent or is uncertain; await the official parent result');
    return child;
  }
  queuePreviewTimer(){
    if(!this.timerPolicy.enabled||this.stopped||this.previewTimerTaskQueued)return;
    this.previewTimerTaskQueued=true;
    queueMicrotask(()=>{
      this.previewTimerTaskQueued=false;
      if(!this.timerPolicy.enabled||this.stopped||!this.client.connected||!this.client.authenticated)return;
      try{for(const action of this.actions())if(action.kind==='preview')this.ensureOwnedTimer(action,{preview:true});}
      catch{this.timerPolicyDeferred={at:this.now(),reason:'preview-state-unavailable'};}
    });
  }
  ensureTimerAfterChoice(action,result){return this.ensureOwnedTimer(action,{result});}
  ensureOwnedTimer(action,{preview=false,result}={}){
    if(!this.timerPolicy.enabled)return;
    const c=this.client;
    // Timer acquisition is separate from board publication or a sent choice.
    // Its failure must not hide the actionable board or taint a move operation.
    const changed=(entry,type)=>{
      this.timerPolicyAttempts.set(entry.key,entry);this.timerPolicyDeferred=null;this.revision++;
      try{this.recordControlTrace({type,room:entry.room,rqid:action.rqid,revision:action.revision,kind:action.kind,status:entry.status,source:'timer-policy'});this.emit('change',{revision:this.revision,event:'timer-policy-request'});}catch{}
    };
    const defer=reason=>{this.timerPolicyDeferred={room:String(action.room).replace(/-[a-z0-9]+pw$/u,''),rqid:action.rqid,at:this.now(),reason};};
    let child,key,entry;
    try{
      if(this.controller.required&&!this.controller.status().owner){defer('no-current-controller');return;}
      child=this.ownedTimerChild(action.room);
      key=`${c.epoch}:${child.replace(/-[a-z0-9]+pw$/u,'')}`;
      if(this.timerPolicyAttempts.has(key))return;
      const state=c.rooms.get(child),requestKey=`choose:${child}:${action.rqid}:${action.revision}`;
      if(preview){
        // A queued task holds no old request authority. Choices, takeover,
        // results and renames may have changed it since board publication.
        if(action.kind!=='preview'||!state.request.teamPreview||c.sent.has(requestKey)||!this.actions().some(current=>current.kind==='preview'&&current.token===action.token)){
          defer('preview-no-longer-actionable');return;
        }
      }else{
        // A synchronous transport callback may have delivered a newer request
        // during send. Ordinary turns/replacements still get their choice first.
        if(result?.status!=='sent-not-acknowledged'||state.request.rqid!==action.rqid||state.revision!==action.revision||!c.sent.has(requestKey)){
          defer('fresh-request-not-protected');return;
        }
      }
      const timer=c.timerStatus(child);
      entry={key,room:child,at:this.now(),attempted:false,status:'not-attempted',trigger:preview?'owned-preview-observed':'successful-owned-choice-send'};
      if(timer.request){changed({...entry,status:timer.request.status||'existing-request'},'timer-policy-existing-request');return;}
      if(timer.serverObservation?.type==='inactive'&&/\bbattle timer is (?:now )?on\b|\btime left:\s*\d+\s*sec/i.test(timer.serverObservation.text||'')){
        changed({...entry,status:'already-server-on'},'timer-policy-already-on');return;
      }
      entry={...entry,attempted:true,status:'send-uncertain'};
      // Reserve before authorize/I/O, including unconfirmed failures. No retry
      // loop is allowed on another turn, handoff, alias or timer-off message.
      this.timerPolicyAttempts.set(key,entry);
      c.authorize('set-timer',{room:child,confirmed:true});
      const sent=c.setTimer(child,{enabled:true});
      changed({...entry,status:sent.status},'timer-policy-sent');
    }catch{
      if(entry?.attempted){
        const status=c.timerStatus?.(child)?.request?.status||'not-confirmed';
        changed({...entry,status},'timer-policy-not-confirmed');
      }else defer('current-owned-choice-unavailable');
    }
  }
  maybePreserveReplays(){
    if(this.stopped||!this.client.connected||!this.client.authenticated||this.savingReplays||this.switchingTeam||this.replayTasks.size)return;
    for(const [parent,entry]of this.replayPreservation){
      if(entry.attempted||entry.status==='complete'||!this.client.rooms.get(parent)?.ended)continue;
      if(entry.status!=='awaiting-idle'){entry.status='awaiting-idle';this.replayPolicyChanged();}
      const c=this.client;
      if(this.awaitingSet||c.searchPending||!c.searchState||c.searchState.searching.length||Object.keys(c.searchState.games||{}).length)return;
      const children=c.rooms.get(parent)?.children;
      if(!Array.isArray(children)||!children.length||children.length>3||children.some(room=>!this.ownedRooms.has(room)||this.roomParents.get(room)!==parent||!c.rooms.get(room)?.ended||!['win','tie'].includes(c.rooms.get(room)?.result?.type))){if(entry.status!=='awaiting-child-results'){entry.status='awaiting-child-results';this.replayPolicyChanged();}return;}
      void this.preserveSetReplays(parent,{automatic:true}).catch(()=>{});return;
    }
  }
  async preserveSetReplays(parent,{automatic=false,assertControl=()=>{}}={}){
    if(this.replayTasks.has(parent))return this.replayTasks.get(parent);
    if(!this.replayPreservationVerifier)return this.saveSetReplays(parent,{assertControl});
    check(this.ownedParents.has(parent)&&this.ownedRooms.has(parent)&&this.roomParents.get(parent)===parent,'BO3 parent is not owned by this authorized session');
    check(this.client.rooms.get(parent)?.ended&&['win','tie'].includes(this.client.rooms.get(parent)?.result?.type),'Official BO3 parent result is not confirmed');
    let entry=this.replayPreservation.get(parent);
    if(!entry){entry={parentId:parent,teamId:this.roomTeamId(parent),status:'saving',required:false,attempted:false,verifiedChildIds:[],preservedChildIds:[],failures:[]};this.replayPreservation.set(parent,entry);}
    const task=(async()=>{
      const deadline=Date.now()+this.replayBudgetMs;entry.status='saving';entry.attempted=true;entry.automatic=automatic;entry.lastAttemptAt=new Date(this.now()).toISOString();entry.failures=[];this.replayPolicyChanged();
      let saved;
      try{
        saved=await this.saveSetReplays(parent,{deadline,assertControl});entry.verifiedChildIds=saved.replays.map(replay=>replay.roomId);entry.failures=saved.failures.map(failure=>({roomId:failure.roomId.replace(/-[a-z0-9]+pw$/u,''),reason:failure.error}));
        entry.status='preserving';this.replayPolicyChanged();
        const withinBudget=async operation=>{let timer;try{check(deadline>Date.now(),'Replay preservation budget exhausted; retain local evidence and retry the existing request');return await Promise.race([Promise.resolve().then(operation),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Replay report preservation did not complete within its bounded budget; retain local evidence')),Math.max(1,deadline-Date.now()));})]);}finally{clearTimeout(timer);}};
        // A historical parent keeps its original report identity. External
        // exact-team imports can satisfy preservation without the current recorder.
        if(!saved.requiresReplayImport)await withinBudget(()=>this.syncMetrics({timeoutMs:Math.max(1,Math.min(25000,deadline-Date.now()))}));
        const parentState=this.client.rooms.get(this.client.resolveRoom(parent)),children=parentState?.children;
        check(Array.isArray(children)&&children.length>0&&children.length<=3,'Completed parent child coverage is unavailable; retain local evidence');
        const officialOutcome=parentState.result.type==='tie'?'tie':normalized(parentState.result.winner)===normalized(this.username)?'win':'loss';
        const preservation=await withinBudget(()=>this.replayPreservationVerifier({teamId:entry.teamId,parentId:this.client.resolveRoom(parent),roomIds:children,officialOutcome}));
        check(preservation?.teamId===entry.teamId&&preservation.parentId===this.client.resolveRoom(parent).replace(/-[a-z0-9]+pw$/u,''),'Replay report preservation identity was not confirmed');
        entry.preservedChildIds=preservation.preserved||[];entry.status=saved.complete&&preservation.complete?'complete':'attention-required';entry.failures.push(...(preservation.failures||[]));entry.completedAt=entry.status==='complete'?new Date(this.now()).toISOString():null;this.replayPolicyChanged();
        return {...saved,transportComplete:saved.complete,preservation,complete:entry.status==='complete',requiresReplayImport:!preservation.complete};
      }catch{
        entry.status='attention-required';entry.failures.push({reason:'Saved replay/report preservation is incomplete. Retain local evidence, inspect existing replay requests and retry battle_save_replays; no automatic upload retry was scheduled.'});this.replayPolicyChanged();
        if(saved)return {...saved,transportComplete:saved.complete,complete:false,requiresReplayImport:true,preservation:{teamId:entry.teamId,parentId:this.client.resolveRoom(parent).replace(/-[a-z0-9]+pw$/u,''),complete:false,preserved:[],missing:entry.verifiedChildIds,failures:entry.failures}};
        throw new Error('Replay preservation is incomplete; inspect replayPolicy and retained evidence before the next search. Retry battle_save_replays for the same parent without repeating uploads.');
      }
    })();
    this.replayTasks.set(parent,task);try{return await task;}finally{for(const [key,value]of this.replayTasks)if(value===task)this.replayTasks.delete(key);this.replayPolicyChanged();this.maybePreserveReplays();}
  }
  async syncMetrics({timeoutMs=25000}={}) {
    check(this.metricsRecorder,'Live metrics recording is unavailable in this session; use report imports or enable recording on the next normal client start');
    check(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=25000,'Metrics sync requires a bounded timeout');
    let timer;
    try {
      const result=await Promise.race([Promise.all([this.metricsRecorder.flush({savePending:true}),...this.turnPlanWrites]).then(([metrics])=>metrics),new Promise((_resolve,reject)=>{
        timer=setTimeout(()=>reject(new Error('Metrics sync did not finish within its bounded budget. Recording continues in the background; inspect metrics status before cleanup.')),timeoutMs);
      })]);
      check(result.state!=='error' && result.state!=='closed','Team metrics persistence is not confirmed. Retain local battle evidence and inspect metrics status before cleanup.');
      check(!this.turnPlanWriteFailures&&!this.turnPlanWritesDropped,'Turn plan persistence is incomplete. Retain local battle evidence and inspect decision notes before cleanup.');
      return {...result,actionPlanPersistence:this.turnPlanPersistence()};
    } finally {clearTimeout(timer);}
  }
  async wait({afterRevision = this.revision, timeoutMs = 25000, format = 'full', signal} = {}) {
    check(Number.isInteger(afterRevision) && afterRevision >= 0, 'Invalid revision');
    check(Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 30000, 'Wait must be 0–30000 ms');
    check(['full','compact'].includes(format),'Wait format must be full or compact');
    const snapshot=()=>format==='compact'?this.turnSnapshot():this.snapshot();
    if (this.revision > afterRevision || this.stopped || timeoutMs === 0) return snapshot();
    await new Promise(resolve => {
      let timer;
      const done = () => { clearTimeout(timer);this.off('change',done);signal?.removeEventListener('abort',done);resolve(); };
      this.on('change',done);signal?.addEventListener('abort',done,{once:true});timer=setTimeout(done,timeoutMs);
      if (signal?.aborted || this.revision > afterRevision) done();
    });
    return snapshot();
  }
  execute(command, {signal} = {}) {
    if (!command || typeof command.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(command.id)) return Promise.resolve({ok:false,error:'A unique command id is required'});
    if (command.op === 'status') return Promise.resolve({id:command.id,ok:true,result:this.snapshot()});
    if (command.op === 'metrics-status') return Promise.resolve({id:command.id,ok:true,result:this.metricsStatus()});
    if (command.op === 'capabilities') return Promise.resolve({id:command.id,ok:true,result:this.capabilities()});
    if(command.op==='turn-status')return Promise.resolve({id:command.id,ok:true,result:this.turnSnapshot()});
    if(command.op==='simulation-context'){try{return Promise.resolve({id:command.id,ok:true,result:this.simulationContext(command)});}catch(error){return Promise.resolve({id:command.id,ok:false,error:error.message});}}
    if(['research-reserve','research-settle','research-status'].includes(command.op)){try{const method={'research-reserve':'researchReserve','research-settle':'researchSettle','research-status':'researchStatus'}[command.op];return Promise.resolve({id:command.id,ok:true,result:this[method](command)});}catch(error){return Promise.resolve({id:command.id,ok:false,error:error.message});}}
    if(command.op==='control-trace'){try{return Promise.resolve({id:command.id,ok:true,result:this.readControlTrace(command)});}catch(error){return Promise.resolve({id:command.id,ok:false,error:error.message});}}
    // Long polling is read-only and can be cancelled independently of other calls.
    if (command.op === 'wait') return this.wait({...command,signal}).then(result=>({id:command.id,ok:true,result}));
    const fingerprint=hash(command);
    if(this.commands.has(command.id)){
      if(this.commandFingerprints.get(command.id)!==fingerprint)return Promise.resolve({id:command.id,ok:false,error:'Command ID already belongs to different arguments'});
      if(!['control-claim','control-release','note-decision','metrics-sync'].includes(command.op))try{this.controller.assert(command.controllerLease);}catch(error){return Promise.resolve({id:command.id,ok:false,error:error.message});}
      return this.commands.get(command.id);
    }
    const task = Promise.resolve().then(()=>this.dispatch(command)).then(result=>({id:command.id,ok:true,result}),error=>this.actionFailure(command,error));
    this.commands.set(command.id,task);this.commandFingerprints.set(command.id,fingerprint);return task;
  }
  async saveSetReplays(parent,{deadline:outerDeadline=Infinity,assertControl=()=>{}}={}) {
    const c=this.client;
    check(!this.savingReplays,'A completed-set replay operation is already running');
    check(typeof parent==='string' && /^game-bestof3-gen9championsvgc2026regmcbo3-\d+(?:-[a-z0-9]+pw)?$/.test(parent),'Expected a completed authorized BO3 parent room');
    check(this.ownedParents.has(parent) && this.ownedRooms.has(parent) && this.roomParents.get(parent)===parent,'BO3 parent is not owned by this authorized session');
    check(c.rooms.get(parent)?.ended && ['win','tie'].includes(c.rooms.get(parent)?.result?.type),'Official BO3 parent result is not confirmed');
    check(!this.awaitingSet && !c.searchPending && c.searchState && !c.searchState.searching.length && !Object.keys(c.searchState.games || {}).length,'Server must confirm an idle session before saving completed-set replays');
    const children=[...this.roomParents].filter(([child,owner])=>owner===parent && child!==parent && this.ownedRooms.has(child)).map(([child])=>child);
    check(children.length>0 && children.length<=3,'Completed BO3 must have one to three known owned child battles');
    this.savingReplays=true;this.emit('change',{revision:++this.revision,event:'replays-started'});
    const replays=[],failures=[],deadline=Math.min(outerDeadline,Date.now()+this.replayBudgetMs);
    try {
      for(const child of children) {
        const roomId=c.resolveRoom(child),state=c.rooms.get(roomId);
        try {
          this.assertLive();
          assertControl();
          check(state?.ended && ['win','tie'].includes(state.result?.type),'Child battle has no official finished result; retain its local evidence');
          const remaining=()=>deadline-Date.now();
          let pending=c.replayRequests.get(roomId);
          if(!pending) {
            check(remaining()>0,'Completed-set replay budget exhausted; retain local evidence');
            c.authorize('save-replay',{room:roomId,confirmed:true});pending=c.saveReplay(roomId);
          }
          if(!pending.verified) {
            check(remaining()>0,'Completed-set replay budget exhausted; retain local evidence');
            if(!pending.url)await c.waitReplayURL(roomId,{timeoutMs:Math.min(5000,remaining())});
            check(remaining()>0,'Completed-set replay budget exhausted; retain local evidence');
            pending=await c.verifyReplay({room:roomId,username:this.username,fetchImpl:this.replayFetchImpl,timeoutMs:Math.min(10000,remaining())});
          }
          replays.push({roomId:c.resolveRoom(roomId),url:pending.url,verifiedAt:pending.verifiedAt,verified:true});
        } catch(error) {
          // No transport exception or private URL enters a failure field.
          const safe=/^(?:Child battle has|Completed-set replay budget|Replay |Session is disconnected|Authenticated connection|Duplicate or uncertain)/.test(error.message)?error.message:'Replay save was not confirmed; retain local evidence and inspect the same command before continuing';
          failures.push({roomId:c.resolveRoom(roomId),error:safe});
        } finally {c.releaseReplayWait(roomId);}
      }
      const teamId=this.roomTeamId(parent),metrics=this.metricsStatus();
      return {parentId:c.resolveRoom(parent),teamId,requiresReplayImport:teamId!==this.client.expectedTeamHash||!metrics.enabled||metrics.teamId!==teamId,replays,failures,complete:failures.length===0};
    } finally {this.savingReplays=false;this.emit('change',{revision:++this.revision,event:'replays-finished'});}
  }
  dispatch(command) {
    const {op,confirmed,token,actions,room,additionalSets,validForMs = 10000}=command;
    const c = this.client;
    if (op === 'status') return this.snapshot();
    // Local observation persistence grants no socket, login, roster or search authority.
    if (op === 'metrics-sync') return this.syncMetrics();
    if (op === 'note-decision') return this.noteDecision(command);
    check(confirmed === true, 'Explicit session control confirmation required');
    if(op==='control-claim'){
      this.assertLive();const result=this.controller.claim(command);this.supervisor.invalidateStaged('controller-changed');this.turnPlans.invalidate();this.recordControllerTransition('controller-claimed');this.revision++;this.emit('change',{revision:this.revision,event:'controller'});this.queuePreviewTimer();return result;
    }
    this.controller.assert(command.controllerLease);
    if(op==='control-release'){const result=this.controller.release(command.controllerLease);this.supervisor.invalidateStaged('controller-released');this.turnPlans.invalidate();this.recordControllerTransition('controller-released');this.revision++;this.emit('change',{revision:this.revision,event:'controller'});return result;}
    if (op === 'stop') { this.supervisor.dispose();this.stopped=true;this.clearResearchBudgets();c.close();this.revision++;this.emit('change',{revision:this.revision,event:'stopped'});return {stopped:true}; }
    this.assertLive();
    if(op==='set-control-policy'){
      this.assertIdleForTeamSwitch();const policy={enabled:command.enabled,forfeitIfStuck:command.forfeitIfStuck,emergencyDefaultChoice:command.emergencyDefaultChoice??false,planningMs:command.planningMs??20000,previewPlanningMs:command.previewPlanningMs??command.planningMs??20000,safetyMarginMs:command.safetyMarginMs??5000,unknownClockMs:command.unknownClockMs??20000};
      for(const key of ['planningMs','previewPlanningMs'])check(Number.isInteger(policy[key])&&policy[key]>=100&&policy[key]<=120000,'Control planning budgets must be 100–120000 ms');
      check(Number.isInteger(policy.unknownClockMs)&&policy.unknownClockMs>=100&&policy.unknownClockMs<=30000,'Unknown-clock budget must be 100–30000 ms');
      check(Number.isInteger(policy.safetyMarginMs)&&policy.safetyMarginMs>=1000&&policy.safetyMarginMs<=15000,'Control safety margin must be 1000–15000 ms');
      this.supervisor.configure(policy);this.recordControlTrace({type:'control-policy-configured'});this.revision++;this.emit('change',{revision:this.revision,event:'control-policy'});return this.controlPolicySnapshot();
    }
    if(op==='withdraw-fallback'){
      check(this.controller.status().owner,'Fallback withdrawal requires an exclusive controller lease');
      check(typeof room==='string'&&Number.isInteger(command.rqid)&&typeof token==='string','Exact fallback room, rqid and token are required');
      const action=this.actions({includePending:true}).find(value=>value.token===token&&value.room===room&&value.rqid===command.rqid);
      check(action&&action.kind!=='ready','Fallback withdrawal source is stale or unavailable');
      const canonical=c.validateChoice(action.room,{rqid:action.rqid,revision:action.revision,actions,deadlineAt:this.now()+1000}).actions;
      this.controller.assert(command.controllerLease);
      const result=this.supervisor.withdraw({room,rqid:command.rqid,token,actions:canonical});
      if(result.withdrawn)this.turnPlans.invalidate({teamId:this.roomTeamId(room),room,rqid:action.rqid,revision:action.revision});
      this.recordControlTrace({type:'fallback-withdrawal-result',room,token,rqid:command.rqid,reason:result.outcome});
      return result;
    }
    if(op==='stage-fallback'){
      const action=this.actions().find(value=>value.token===token);
      check(action,'Fallback token is stale or unavailable');
      const preparedPlan=command.turnPlan===undefined?null:this.prepareTurnPlan(action,command.turnPlan,actions);
      const preparedPreview=command.previewPlan===undefined?null:this.preparePreviewPlan(action,command.previewPlan,actions);
      const recipientEffectAudit=preparedPlan?.plan.ineffectiveActions?.length?this.validateRecipientActions(action,actions,preparedPlan.plan):undefined;
      this.supervisor.stage(token,actions,preparedPlan?{turnPlan:preparedPlan.plan}:preparedPreview?{previewPlan:preparedPreview.previewPlan}:undefined);
      if(preparedPlan)this.recordPreparedTurnPlan(preparedPlan,'staged');
      if(preparedPreview)this.recordPreparedPreviewPlan(preparedPreview,'staged');
      return {...this.controlPolicySnapshot(),...(recipientEffectAudit?{recipientEffectAudit}:{})};
    }
    if(op==='set-replay-policy')return this.setReplayPolicy(command.enabled);
    if(op==='set-timer-policy')return this.setTimerPolicy(command.enabled);
    if(op==='switch-team'){this.assertRestoredSetSettled();return this.switchTeam(command);}
    if(['start','authorize-sets','save-replays'].includes(op))check(!this.switchingTeam,'Finish the approved team switch before this operation');
    if(op==='save-replays')return this.preserveSetReplays(c.resolveRoom(room),{assertControl:()=>this.controller.assert(command.controllerLease)});
    if(op==='set-timer'){
      check(!this.isRestoredRoom(room),'Restored-set authority permits only forfeit and preservation, not timer or gameplay');
      check(command.enabled===undefined||command.enabled===true,'Only enabling the battle timer is supported');
      const child=this.ownedTimerChild(room);
      c.authorize('set-timer',{room:child,confirmed:true});
      try{return c.setTimer(child,{enabled:true});}
      finally{this.revision++;this.emit('change',{revision:this.revision,event:'timer-request'});}
    }
    if(op==='forfeit'){
      const parent=c.resolveRoom(room);
      check(typeof parent==='string' && /^game-bestof3-gen9championsvgc2026regmcbo3-\d+(?:-[a-z0-9]+pw)?$/.test(parent), 'Expected the current authorized BO3 parent room');
      check(this.ownedParents.has(parent) && this.ownedRooms.has(parent) && this.roomParents.get(parent)===parent, 'BO3 parent is not owned by this authorized session');
      c.authorize('forfeit',{room:parent,confirmed:true});
      return c.forfeitSet(parent);
    }
    if (op === 'authorize-sets') {
      check(!this.savingReplays,'Finish completed-set replay preservation before authorizing more sets');
      check(Number.isInteger(additionalSets) && additionalSets >= 1 && additionalSets <= 100, 'Additional sets must be 1–100');
      check(this.authorizedSets + additionalSets <= 100, 'Total authorized set limit cannot exceed 100');
      check(!this.awaitingSet && !c.searchPending && c.searchState && !c.searchState.searching.length && !Object.keys(c.searchState.games || {}).length, 'Server must confirm an idle session with no pending search or match');
      this.authorizedSets+=additionalSets;
      this.revision++;this.emit('change',{revision:this.revision,event:'sets-authorized'});
      return {authorizedSets:this.authorizedSets,searchesSent:this.searchesSent,remainingSets:this.authorizedSets-this.searchesSent,queued:false};
    }
    if (op === 'start') {
      this.assertRestoredSetSettled();
      check(!this.controller.required||this.supervisor.status().enabled,'Enable the client deadline control policy while idle before searching');
      check(!this.supervisor.status().halted,'Control recovery halted further searches; review the failure and explicitly reset control policy while idle');
      check(!this.savingReplays,'Finish completed-set replay preservation before starting another set');
      check(!this.replayTasks.size,'Finish completed-set replay report preservation before starting another set');
      this.assertReplayPreserved();
      if(this.replayPolicy.enabled)check(this.replayPreservationVerifier&&this.metricsStatus().enabled&&this.metricsStatus().state==='ready','Authorized replay policy needs a ready live recorder and preservation verifier before searching');
      check(this.searchesSent < this.authorizedSets, 'Authorized set limit reached');
      check(!c.searchPending && (!c.searchState || !c.searchState.searching.length && !Object.keys(c.searchState.games || {}).length), 'Search or set is still active or unacknowledged');
      if (!c.teamHash) { c.authorize('upload-team',{confirmed:true});c.uploadTeam(this.packed); }
      // Count before network I/O: uncertain sends must not queue extra sets.
      c.authorize('search',{confirmed:true});
      check(c.formats.split('|').some(entry => normalized(entry.split(',')[0]) === 'gen9championsvgc2026regmcbo3'), 'Live server has not advertised requested format');
      this.searchesSent++;this.awaitingSet=true;this.cancellation=null;
      c.search();this.revision++;this.emit('change',{revision:this.revision,event:'search-sent'});
      return {status:'sent-not-acknowledged',searchesSent:this.searchesSent,authorizedSets:this.authorizedSets};
    }
    if (op === 'cancel-search') {
      check(this.searchesSent>0,'This session has not started a search');
      c.authorize('cancel-search',{confirmed:true});c.cancelSearch();
      // Matchmaking emits a transient idle update before announcing a matched set.
      // Keep acquisition pending so cancellation cannot strand a racing battle.
      this.cancellation={requestedAt:this.now(),status:'sent-not-acknowledged'};
      return {status:'sent-not-acknowledged'};
    }
    check(['choose','ready'].includes(op), 'Unsupported operation');
    const action = this.actions().find(action => action.token === token);
    check(action && (op === 'ready' ? action.kind === 'ready' : action.kind !== 'ready'), 'Action token is stale or no longer actionable; inspect fresh state');
    if (op === 'ready') { c.authorize('ready',{room:action.room,confirmed:true});c.confirmReady(action.room);return {status:'sent-not-acknowledged',room:action.room}; }
    return this.submitChoice(action,actions,'operator',validForMs,command.turnPlan,undefined,command.previewPlan);
  }
  dispose() {
    this.supervisor.dispose();
    this.clearResearchBudgets();
    this.turnPlans.clear();
    this.detachMetrics?.();this.detachMetrics=null;
    for (const [event,listener] of this.listeners) this.client.off(event,listener);
    this.listeners=[];this.stopped=true;this.emit('change',{revision:++this.revision,event:'disposed'});
  }
}
