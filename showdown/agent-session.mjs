import {EventEmitter} from 'node:events';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {ControllerLease} from './controller-lease.mjs';
import {DeadlineSupervisor} from './deadline-supervisor.mjs';
import {replacementOptions,legalReplacementPairs} from './choice-validation.mjs';
import {compactTurnBoard} from './turn-board.mjs';
import {selectEmergencyActions} from './emergency-choice.mjs';
import {compareTimerObservations} from './client.mjs';

const {Teams,TeamValidator}=createRequire(import.meta.url)('pokemon-showdown');
const RUNTIME_REVISION=createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const LOADED_AT=new Date().toISOString();

const normalized = text => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function publishedSheet(packed){
  const columns=String(packed).split(']').map(set=>set.split('|'));
  return (Teams.unpack(packed)||[]).map((set,index)=>({species:set.species,item:set.item||null,ability:set.ability||null,moves:set.moves,
    nature:columns[index]?.[5]?set.nature:null,level:columns[index]?.[10]?set.level:null,
    gender:columns[index]?.[7]?set.gender:null,shiny:!!set.shiny}));
}
const EVENTS = ['request','battle-event','sheet','timer','result','ready','server-error','choice-status','action-status','forfeit-status','search-state','room-renamed','replay-url','replay-verified','replay-failed','disconnected'];

/** One explicitly bounded local session; emergency legal defaults are opt-in. */
export class AgentSession extends EventEmitter {
  constructor(client, {username, packed, authorizedSets = 1, autoReady = true, now = Date.now, replayFetchImpl = globalThis.fetch, replayBudgetMs = 25000,recorderFactory,decisionNoteWriter,replayPolicy=false,replayPreservationVerifier,controllerRequired=true,controlTimers={},monotonicNow=()=>performance.now()} = {}) {
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
    this.id = randomUUID(); this.revision = 0; this.searchesSent = 0; this.stopped = false;
    this.commands = new Map();this.commandFingerprints=new Map(); this.readySent = new Set(); this.notices = []; this.listeners = [];
    this.ownedRooms = new Set(); this.ownedParents = new Set(); this.roomParents = new Map(); this.awaitingSet = false;
    this.roomTeams=new Map();this.actionContexts=new Map();this.recorderFactory=recorderFactory;this.decisionNoteWriter=decisionNoteWriter;this.switchingTeam=false;
    this.controller=new ControllerLease({now,required:controllerRequired});this.controlTrace=[];this.controlSequence=0;this.monotonicNow=monotonicNow;this.controlStartedAt=monotonicNow();this.tracedRequests=new Set();this.choiceSources=new Map();this.uncertainChoices=new Set();
    this.supervisor=new DeadlineSupervisor({now,...controlTimers,getActions:()=>this.actions({includePending:true}),validate:(action,choices)=>this.validateAction(action,choices),submit:(action,choices,source)=>this.submitChoice(action,choices,source),selectDefault:action=>this.emergencyChoice(action),forfeit:(action,reason)=>this.containControlFailure(action,reason),onTrace:entry=>this.recordControlTrace({...entry,type:entry.type?.startsWith('watchdog-')?entry.type:`watchdog-${entry.type||'event'}`})});
    for (const event of EVENTS) {
      const listener = value => {
        if (event === 'disconnected') this.stopped = true;
        if(event==='room-renamed')this.migrateRoom(value);
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
        if(['result','search-state','room-renamed'].includes(event)||event==='battle-event'&&client.rooms.get(value.room)?.ended)queueMicrotask(()=>this.maybePreserveReplays());
      };
      client.on(event, listener); this.listeners.push([event,listener]);
    }
  }
  recordControlTrace(entry){
    const controller=this.controller.status(),record={seq:++this.controlSequence,at:this.now(),elapsedMs:Math.max(0,this.monotonicNow()-this.controlStartedAt),controllerId:controller.owner?.replace(/[^A-Za-z0-9_.:-]/g,'_')||'none',generation:controller.generation};
    for(const key of ['type','source','status','kind','reasonCode','clockSource','observedClockSource','deadlineBasis'])if(typeof entry[key]==='string')record[key]=entry[key].replace(/[^A-Za-z0-9_.:-]/g,'_').slice(0,80);
    for(const key of ['rqid','revision','latencyMs','planningDeadlineAt','cutoffAt','emergencyAt','hardDeadlineAt','turnDeadlineAt','bankDeadlineAt','unknownCutoffAt','clockObservedAt','timerDisabledAt','recoveryStartedAt'])if(Number.isFinite(entry[key]))record[key]=entry[key];
    for(const key of ['clockFreshForRequest','emergencyEligible','controlFailure','forfeited','retried','recovering'])if(typeof entry[key]==='boolean')record[key]=entry[key];
    if(typeof entry.room==='string'&&this.ownedRooms.has(this.client.resolveRoom(entry.room)))record.room=this.client.resolveRoom(entry.room);
    this.controlTrace.push(record);if(this.controlTrace.length>2000)this.controlTrace.shift();
    this.client.emit('control-trace',record);return record;
  }
  recordControllerTransition(type){
    const rooms=[...this.client.rooms.values()].filter(room=>this.ownedRooms.has(room.id)&&room.id.startsWith('battle-')&&!room.ended);
    if(!rooms.length)this.recordControlTrace({type});
    for(const room of rooms)this.recordControlTrace({type,room:room.id,rqid:room.request?.rqid,revision:room.revision});
  }
  observeControlEvent(event,value={}){
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
    }
    if(event==='server-error')this.recordControlTrace({type:'server-error',room,rqid:state?.request?.rqid,revision:state?.revision,reasonCode:'inspect-fresh-request'});
    if(event==='battle-event'&&['start','turn','win','tie'].includes(value.type))this.recordControlTrace({type:'server-advance',room,rqid:state?.request?.rqid,revision:state?.revision,status:value.type});
    if(event==='disconnected')this.recordControlTrace({type:'disconnected'});
  }
  validateAction(action,choices){
    const fresh=this.actions().find(current=>current.token===action.token);
    check(fresh,'Action token is stale or no longer actionable; inspect fresh state');
    return this.client.validateChoice(fresh.room,{rqid:fresh.rqid,revision:fresh.revision,actions:choices,deadlineAt:this.now()+1000}).actions;
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
  submitChoice(action,choices,source='operator',validForMs=10000){
    const fresh=this.actions().find(current=>current.token===action.token);
    check(fresh,'Action token is stale or no longer actionable; inspect fresh state');
    check(Number.isInteger(validForMs)&&validForMs>=100&&validForMs<=30000,'Decision validity must be 100–30000 ms');
    const deadlineAt=Math.min(this.now()+validForMs,fresh.clock.deadlineAt===null?Infinity:fresh.clock.deadlineAt-1000);
    check(deadlineAt>this.now(),'Observed turn countdown has expired; inspect fresh state');
    const canonical=this.client.validateChoice(fresh.room,{rqid:fresh.rqid,revision:fresh.revision,actions:choices,deadlineAt}).actions;
    this.recordControlTrace({type:'selected',...fresh,source});this.choiceSources.set(fresh.room,source);
    this.client.authorize('choose',{room:fresh.room,confirmed:true});
    try{return this.client.choose(fresh.room,{rqid:fresh.rqid,revision:fresh.revision,actions:canonical,deadlineAt});}
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
    const rooms=[...this.client.rooms.values()].filter(room=>this.ownedRooms.has(room.id)&&!room.ended&&!this.client.rooms.get(this.roomParents.get(room.id))?.ended);
    const actions=this.actions(),previewRooms=new Set(actions.filter(action=>action.kind==='preview').map(action=>action.room));
    const boards=rooms.filter(room=>room.id.startsWith('battle-')).map(room=>({room:room.id,parentId:this.roomParents.get(room.id),
      requestAgeMs:Number.isFinite(room.receivedAt)?Math.max(0,this.now()-room.receivedAt):null,clock:this.clock(room,room.request?.teamPreview?'preview':'turn'),timer:this.client.timerStatus(room.id),
      ...compactTurnBoard(this.client.battleSnapshot?.(room.id),{request:room.request,events:room.battleLog}),
      ...(previewRooms.has(room.id)?{opponentSheets:Object.fromEntries(Object.entries(room.sheets||{}).filter(([side])=>side!==room.request.side?.id).map(([side,packed])=>[side,publishedSheet(packed)])),opponentSheetUncertainty:'Registered six and published sets only; selected four, stat investments and next actions are unknown.'}:{})}));
    return {sessionId:this.id,revision:this.revision,connected:this.client.connected,authenticated:this.client.authenticated,stopped:this.stopped,controller:this.controller.status(),controlPolicy:this.controlPolicySnapshot(),actions,
      boards,
      choices:rooms.filter(room=>room.lastAction).map(room=>({room:room.id,...room.lastAction}))};
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
    this.ownedRooms.delete(oldRoom);this.ownedRooms.add(room);
    if(this.ownedParents.delete(oldRoom))this.ownedParents.add(room);
    const parent=this.roomParents.get(oldRoom);this.roomParents.delete(oldRoom);
    if(this.roomTeams.has(oldRoom)){this.roomTeams.set(room,this.roomTeams.get(oldRoom));this.roomTeams.delete(oldRoom);}
    if(this.replayPreservation.has(oldRoom)){const entry=this.replayPreservation.get(oldRoom);entry.parentId=room;this.replayPreservation.set(room,entry);this.replayPreservation.delete(oldRoom);}
    if(this.replayTasks.has(oldRoom)){this.replayTasks.set(room,this.replayTasks.get(oldRoom));this.replayTasks.delete(oldRoom);}
    for(const context of this.actionContexts.values())if(context.room===oldRoom)context.room=room;
    if(parent)this.roomParents.set(room,parent===oldRoom?room:parent);
    for(const [child,owner] of this.roomParents)if(owner===oldRoom)this.roomParents.set(child,room);
    for(const key of [...this.readySent])if(key.startsWith(`ready:${oldRoom}:`))this.readySent.add(`ready:${room}:${key.slice(`ready:${oldRoom}:`.length)}`);
  }
  captureRooms() {
    if (!this.searchesSent) return;
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
      if (this.ownedRooms.has(r.id)) for (const child of r.children) if(/^battle-gen9championsvgc2026regmcbo3-\d+(?:-[a-z0-9]+pw)?$/.test(child)){this.ownedRooms.add(child);this.roomParents.set(child,this.roomParents.get(r.id));this.roomTeams.set(child,this.roomTeamId(r.id));}
    }
  }
  roomTeamId(room){return this.roomTeams.get(this.client.resolveRoom(room))||this.client.expectedTeamHash;}
  capabilities(){return {schemaVersion:2,runtime:'champions-headless-session',buildRevision:RUNTIME_REVISION,loadedAt:LOADED_AT,operations:['status','turn-status','control-trace','control-claim','control-release','set-control-policy','stage-fallback','capabilities','wait','metrics-status','metrics-sync','start','authorize-sets','choose','ready','cancel-search','set-timer','forfeit','save-replays','set-replay-policy','stop',...(this.decisionNoteWriter?['note-decision']:[]),...(this.recorderFactory?['switch-team']:[])],features:{controllerLease:this.controller.required,deadlineSupervisor:true,deadlinePlanningRecovery:true,emergencyDefaultChoice:true,compactTurnBoard:true,namedReplacements:true,controlTrace:true,ownedBattleTimer:true,recordingSchemaVersion:this.metricsStatus().recordingSchemaVersion??null,previewDecisionEvidence:this.metricsStatus().features?.previewDecisionEvidence===true,metricsRecorder:!!this.metricsRecorder,decisionNotes:!!this.decisionNoteWriter,idleTeamSwitch:!!this.recorderFactory,authorizedReplayPolicy:!!this.replayPreservationVerifier},sourceChangesRequireNewSession:true};}
  rememberAction(action){
    const state=this.client.rooms.get(action.room),turn=state?.battle?.turn;
    if(!this.actionContexts.has(action.token))this.actionContexts.set(action.token,{room:action.room,teamId:this.roomTeamId(action.room),rqid:action.rqid,turn:Number(turn)||0,sessionId:this.id,token:action.token,lastObservedStatus:state?.lastAction?.rqid===action.rqid?state.lastAction.status:'unsubmitted'});
    while(this.actionContexts.size>1000)this.actionContexts.delete(this.actionContexts.keys().next().value);
  }
  assertLive() {
    check(!this.stopped && this.client.connected && this.client.authenticated, 'Session is disconnected or stopped; sign in again in the user terminal');
  }
  token(room, kind, extra) {
    return hash([this.id,this.client.epoch,room,this.roomParents.get(room) || room,kind,extra]);
  }
  clock(r, kind) {
    const observation = [...r.timers].reverse().find(entry => {
      if (entry.type === 'inactiveoff' || entry.at < (r.receivedAt || 0) && kind !== 'ready') return false;
      if (/^Time left: \d+ sec this turn(?: \||$)/.test(entry.text)) return kind !== 'ready';
      const match = entry.text.match(/^(.*?) has (\d+) seconds (left\.|to confirm battle start!)/);
      return match && normalized(match[1]) === normalized(this.username) && (kind === 'ready' ? match[3].startsWith('to confirm') : match[3] === 'left.');
    });
    // A timer-off observation cancels earlier countdown evidence.
    const timerOff = [...r.timers].reverse().find(entry => entry.type === 'inactiveoff');
    if(timerOff && timerOff.at >= (r.receivedAt || 0) && (!observation || compareTimerObservations(timerOff,observation)>=0))return {source:'server-timer-disabled',observedAt:timerOff.at,deadlineAt:null,remainingMs:null,bankDeadlineAt:null,bankRemainingMs:null};
    if (!observation || timerOff && compareTimerObservations(timerOff,observation)>=0) return {source:'unavailable',deadlineAt:null,remainingMs:null,bankDeadlineAt:null,bankRemainingMs:null};
    const match = observation.text.match(/^Time left: (\d+) sec this turn/) || observation.text.match(/ has (\d+) seconds /);
    const deadlineAt = observation.at + Number(match[1]) * 1000;
    const bank=observation.text.match(/\| (\d+) sec total(?: \||$)/),bankDeadlineAt=bank?observation.at+Number(bank[1])*1000:null;
    return {source:'server-timer-observation',observedAt:observation.at,text:observation.text,deadlineAt,remainingMs:Math.max(0,deadlineAt-this.now()),bankDeadlineAt,bankRemainingMs:bankDeadlineAt===null?null:Math.max(0,bankDeadlineAt-this.now()),uncertainty:'Server/network delay can shorten the available time; this is an observed countdown, not an exact server deadline.'};
  }
  actions({includePending=false}={}) {
    if (this.stopped || !this.client.connected || !this.client.authenticated) return [];
    const c = this.client, output = [];
    for (const r of c.rooms.values()) {
      if (!this.ownedRooms.has(r.id) || r.ended || c.rooms.get(this.roomParents.get(r.id))?.ended || c.pendingForfeit(r.id)) continue;
      const q = r.request;
      if (r.epoch === c.epoch && q && normalized(q.side?.name)===normalized(this.username) && !q.wait && !r.confirmedChoice) {
        const key = `choose:${r.id}:${q.rqid}:${r.revision}`;
        const pending=c.sent.has(key);
        if(pending&&(!includePending||r.lastAction?.rqid===q.rqid&&['accepted','execution-observed','resolution-observed'].includes(r.lastAction.status)))continue;
        const kind = q.teamPreview ? 'preview' : q.forceSwitch ? 'switch' : 'turn';
        const actionToken=this.token(r.id,kind,[q.rqid,r.revision]);
        output.push({kind,room:r.id,parentId:this.roomParents.get(r.id),token:actionToken,rqid:q.rqid,revision:r.revision,receivedAt:r.receivedAt,...(pending?{actionable:false,submissionStatus:this.uncertainChoices.has(actionToken)?'uncertain':'sent'}:{}),clock:this.clock(r,kind),legalActions:{teamPreview:!!q.teamPreview,maxChosenTeamSize:q.maxChosenTeamSize || q.maxTeamSize || (q.teamPreview ? 4 : undefined),active:q.active || null,forceSwitch:q.forceSwitch || null,pokemon:q.side?.pokemon || [],replacements:replacementOptions(q),replacementPairs:legalReplacementPairs(q),targetConvention:'Positive 1/2 = opposing slots; negative -1/-2 = own slots.'}});
      }
    }
    for (const r of c.rooms.values()) {
      if (!this.ownedRooms.has(r.id) || r.ended || r.readyPrompt?.epoch !== c.epoch || c.pendingForfeit(r.id)) continue;
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
      savingReplays:this.savingReplays,awaitingSet:this.awaitingSet,searchPending:!!this.client.searchPending,
      replayPolicy:this.replayPolicySnapshot(),
      switchingTeam:this.switchingTeam,capabilities:this.capabilities(),
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
  async noteDecision({id,token,...fields}){
    check(this.decisionNoteWriter,'Decision notes are unavailable in this loaded session; use the next normal client start');
    this.actions();const context=this.actionContexts.get(token);
    check(context && this.ownedRooms.has(context.room),'Decision note token was not observed in this session');
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
      if(previous){previousClosed=true;await previous.close();}
      assertControl();
      this.assertIdleForTeamSwitch();
      check(previous?.status().state!=='error','Old team recorder did not close cleanly; approved team was retained');
      this.detachMetrics?.();this.detachMetrics=null;this.metricsRecorder=null;
      this.client.expectedTeamHash=nextId;this.client.teamHash=null;this.packed=packed;
      this.client.grants.delete('upload-team:');this.client.grants.delete('search:');
      for(const key of [...this.client.sent])if(key.startsWith(`team:${this.client.epoch}:`))this.client.sent.delete(key);
      this.attachMetricsRecorder(nextRecorder);nextRecorder=null;
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
      const result=await Promise.race([this.metricsRecorder.flush({savePending:true}),new Promise((_resolve,reject)=>{
        timer=setTimeout(()=>reject(new Error('Metrics sync did not finish within its bounded budget. Recording continues in the background; inspect metrics status before cleanup.')),timeoutMs);
      })]);
      check(result.state!=='error' && result.state!=='closed','Team metrics persistence is not confirmed. Retain local battle evidence and inspect metrics status before cleanup.');
      return result;
    } finally {clearTimeout(timer);}
  }
  async wait({afterRevision = this.revision, timeoutMs = 25000, signal} = {}) {
    check(Number.isInteger(afterRevision) && afterRevision >= 0, 'Invalid revision');
    check(Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 30000, 'Wait must be 0–30000 ms');
    if (this.revision > afterRevision || this.stopped || timeoutMs === 0) return this.snapshot();
    await new Promise(resolve => {
      let timer;
      const done = () => { clearTimeout(timer);this.off('change',done);signal?.removeEventListener('abort',done);resolve(); };
      this.on('change',done);signal?.addEventListener('abort',done,{once:true});timer=setTimeout(done,timeoutMs);
      if (signal?.aborted || this.revision > afterRevision) done();
    });
    return this.snapshot();
  }
  execute(command, {signal} = {}) {
    if (!command || typeof command.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(command.id)) return Promise.resolve({ok:false,error:'A unique command id is required'});
    if (command.op === 'status') return Promise.resolve({id:command.id,ok:true,result:this.snapshot()});
    if (command.op === 'metrics-status') return Promise.resolve({id:command.id,ok:true,result:this.metricsStatus()});
    if (command.op === 'capabilities') return Promise.resolve({id:command.id,ok:true,result:this.capabilities()});
    if(command.op==='turn-status')return Promise.resolve({id:command.id,ok:true,result:this.turnSnapshot()});
    if(command.op==='control-trace'){try{return Promise.resolve({id:command.id,ok:true,result:this.readControlTrace(command)});}catch(error){return Promise.resolve({id:command.id,ok:false,error:error.message});}}
    // Long polling is read-only and can be cancelled independently of other calls.
    if (command.op === 'wait') return this.wait({...command,signal}).then(result=>({id:command.id,ok:true,result}));
    const fingerprint=hash(command);
    if(this.commands.has(command.id)){
      if(this.commandFingerprints.get(command.id)!==fingerprint)return Promise.resolve({id:command.id,ok:false,error:'Command ID already belongs to different arguments'});
      if(!['control-claim','control-release','note-decision','metrics-sync'].includes(command.op))try{this.controller.assert(command.controllerLease);}catch(error){return Promise.resolve({id:command.id,ok:false,error:error.message});}
      return this.commands.get(command.id);
    }
    const task = Promise.resolve().then(()=>this.dispatch(command)).then(result=>({id:command.id,ok:true,result}),error=>({id:command.id,ok:false,error:error.message}));
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
      this.assertLive();const result=this.controller.claim(command);this.supervisor.invalidateStaged('controller-changed');this.recordControllerTransition('controller-claimed');this.revision++;this.emit('change',{revision:this.revision,event:'controller'});return result;
    }
    this.controller.assert(command.controllerLease);
    if(op==='control-release'){const result=this.controller.release(command.controllerLease);this.supervisor.invalidateStaged('controller-released');this.recordControllerTransition('controller-released');this.revision++;this.emit('change',{revision:this.revision,event:'controller'});return result;}
    if (op === 'stop') { this.supervisor.dispose();this.stopped=true;c.close();this.revision++;this.emit('change',{revision:this.revision,event:'stopped'});return {stopped:true}; }
    this.assertLive();
    if(op==='set-control-policy'){
      this.assertIdleForTeamSwitch();const policy={enabled:command.enabled,forfeitIfStuck:command.forfeitIfStuck,emergencyDefaultChoice:command.emergencyDefaultChoice??false,planningMs:command.planningMs??20000,safetyMarginMs:command.safetyMarginMs??5000,unknownClockMs:command.unknownClockMs??20000};
      for(const key of ['planningMs','unknownClockMs'])check(Number.isInteger(policy[key])&&policy[key]>=100&&policy[key]<=30000,'Control planning budgets must be 100–30000 ms');
      check(Number.isInteger(policy.safetyMarginMs)&&policy.safetyMarginMs>=1000&&policy.safetyMarginMs<=15000,'Control safety margin must be 1000–15000 ms');
      this.supervisor.configure(policy);this.recordControlTrace({type:'control-policy-configured'});this.revision++;this.emit('change',{revision:this.revision,event:'control-policy'});return this.controlPolicySnapshot();
    }
    if(op==='stage-fallback'){this.supervisor.stage(token,actions);return this.controlPolicySnapshot();}
    if(op==='set-replay-policy')return this.setReplayPolicy(command.enabled);
    if(op==='switch-team')return this.switchTeam(command);
    if(['start','authorize-sets','save-replays'].includes(op))check(!this.switchingTeam,'Finish the approved team switch before this operation');
    if(op==='save-replays')return this.preserveSetReplays(c.resolveRoom(room),{assertControl:()=>this.controller.assert(command.controllerLease)});
    if(op==='set-timer'){
      check(command.enabled===undefined||command.enabled===true,'Only enabling the battle timer is supported');
      const child=c.resolveRoom(room),parent=this.roomParents.get(child),state=c.rooms.get(child),parentState=c.rooms.get(parent);
      check(typeof child==='string' && /^battle-gen9championsvgc2026regmcbo3-\d+(?:-[a-z0-9]+pw)?$/.test(child),'Expected the current authorized M-C child battle room');
      check(this.ownedRooms.has(child) && this.ownedParents.has(parent) && this.ownedRooms.has(parent) && this.roomParents.get(parent)===parent && parentState?.children.includes(child),'Child battle is not linked to an owned authorized BO3 parent');
      check(!parentState.ended && Object.hasOwn(c.searchState?.games || {},parent),'BO3 parent is not live in the current server search state');
      const liveChildren=parentState.children.filter(id=>this.ownedRooms.has(id) && this.roomParents.get(id)===parent && !c.rooms.get(id)?.ended && c.rooms.get(id)?.epoch===c.epoch && c.rooms.get(id)?.request);
      check(liveChildren.length===1 && liveChildren[0]===child && state?.epoch===c.epoch && state.request && !state.ended,'No unambiguous current live owned child battle request');
      check(!state.request.side?.name || normalized(state.request.side.name)===normalized(this.username),'Child battle request belongs to another player');
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
    return this.submitChoice(action,actions,'operator',validForMs);
  }
  dispose() {
    this.supervisor.dispose();
    this.detachMetrics?.();this.detachMetrics=null;
    for (const [event,listener] of this.listeners) this.client.off(event,listener);
    this.listeners=[];this.stopped=true;this.emit('change',{revision:++this.revision,event:'disposed'});
  }
}
