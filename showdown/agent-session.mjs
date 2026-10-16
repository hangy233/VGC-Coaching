import {EventEmitter} from 'node:events';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';

const {Teams,TeamValidator}=createRequire(import.meta.url)('pokemon-showdown');
const RUNTIME_REVISION=createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const LOADED_AT=new Date().toISOString();

const normalized = text => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const EVENTS = ['request','battle-event','sheet','timer','result','ready','server-error','choice-status','action-status','forfeit-status','search-state','room-renamed','replay-url','replay-verified','replay-failed','disconnected'];

/** One explicitly bounded local session. It never logs in or chooses strategy. */
export class AgentSession extends EventEmitter {
  constructor(client, {username, packed, authorizedSets = 1, autoReady = true, now = Date.now, replayFetchImpl = globalThis.fetch, replayBudgetMs = 25000,recorderFactory,decisionNoteWriter} = {}) {
    super();
    check(typeof username === 'string' && normalized(username), 'Username required');
    check(typeof packed === 'string' && packed.length > 10, 'Approved packed team required');
    check(Number.isInteger(authorizedSets) && authorizedSets >= 1 && authorizedSets <= 100, 'Invalid set limit');
    check(createHash('sha256').update(packed).digest('hex') === client.expectedTeamHash, 'Team differs from approved fixed team');
    this.client = client; this.username = username; this.packed = packed;
    this.authorizedSets = authorizedSets; this.autoReady = autoReady; this.now = now;
    check(typeof replayFetchImpl==='function' && Number.isInteger(replayBudgetMs) && replayBudgetMs>0 && replayBudgetMs<=25000,'Invalid replay transport configuration');
    this.replayFetchImpl=replayFetchImpl;this.replayBudgetMs=replayBudgetMs;this.savingReplays=false;
    this.id = randomUUID(); this.revision = 0; this.searchesSent = 0; this.stopped = false;
    this.commands = new Map(); this.readySent = new Set(); this.notices = []; this.listeners = [];
    this.ownedRooms = new Set(); this.ownedParents = new Set(); this.roomParents = new Map(); this.awaitingSet = false;
    this.roomTeams=new Map();this.actionContexts=new Map();this.recorderFactory=recorderFactory;this.decisionNoteWriter=decisionNoteWriter;this.switchingTeam=false;
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
        this.revision++; this.emit('change', {revision:this.revision,event});
        if (this.autoReady && ['ready','search-state','request'].includes(event)) this.confirmPendingReady();
      };
      client.on(event, listener); this.listeners.push([event,listener]);
    }
  }
  migrateRoom({oldRoom,room}) {
    // A server rename moves existing authority; it never acquires another set.
    if(!this.ownedRooms.has(oldRoom))return;
    this.ownedRooms.delete(oldRoom);this.ownedRooms.add(room);
    if(this.ownedParents.delete(oldRoom))this.ownedParents.add(room);
    const parent=this.roomParents.get(oldRoom);this.roomParents.delete(oldRoom);
    if(this.roomTeams.has(oldRoom)){this.roomTeams.set(room,this.roomTeams.get(oldRoom));this.roomTeams.delete(oldRoom);}
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
      if(candidates.length===1){this.ownedParents.add(candidates[0]);this.ownedRooms.add(candidates[0]);this.roomParents.set(candidates[0],candidates[0]);this.roomTeams.set(candidates[0],this.client.expectedTeamHash);this.awaitingSet=false;if(this.cancellation)this.cancellation.status='match-observed';}
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
  capabilities(){return {schemaVersion:2,runtime:'champions-headless-session',buildRevision:RUNTIME_REVISION,loadedAt:LOADED_AT,operations:['status','capabilities','wait','metrics-status','metrics-sync','start','authorize-sets','choose','ready','cancel-search','forfeit','save-replays','stop',...(this.decisionNoteWriter?['note-decision']:[]),...(this.recorderFactory?['switch-team']:[])],features:{metricsRecorder:!!this.metricsRecorder,decisionNotes:!!this.decisionNoteWriter,idleTeamSwitch:!!this.recorderFactory},sourceChangesRequireNewSession:true};}
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
    if (!observation || timerOff && timerOff.at >= observation.at) return {source:'unavailable',deadlineAt:null,remainingMs:null};
    const match = observation.text.match(/^Time left: (\d+) sec this turn/) || observation.text.match(/ has (\d+) seconds /);
    const deadlineAt = observation.at + Number(match[1]) * 1000;
    return {source:'server-timer-observation',observedAt:observation.at,text:observation.text,deadlineAt,remainingMs:Math.max(0,deadlineAt-this.now()),uncertainty:'Server/network delay can shorten the available time; this is an observed countdown, not an exact server deadline.'};
  }
  actions() {
    if (this.stopped || !this.client.connected || !this.client.authenticated) return [];
    const c = this.client, output = [];
    for (const r of c.rooms.values()) {
      if (!this.ownedRooms.has(r.id) || r.ended || c.rooms.get(this.roomParents.get(r.id))?.ended || c.pendingForfeit(r.id)) continue;
      const q = r.request;
      if (r.epoch === c.epoch && q && normalized(q.side?.name)===normalized(this.username) && !q.wait && !r.confirmedChoice) {
        const key = `choose:${r.id}:${q.rqid}:${r.revision}`;
        if (c.sent.has(key)) continue;
        const kind = q.teamPreview ? 'preview' : q.forceSwitch ? 'switch' : 'turn';
        output.push({kind,room:r.id,token:this.token(r.id,kind,[q.rqid,r.revision]),rqid:q.rqid,revision:r.revision,receivedAt:r.receivedAt,clock:this.clock(r,kind),legalActions:{teamPreview:!!q.teamPreview,maxChosenTeamSize:q.maxChosenTeamSize || q.maxTeamSize || (q.teamPreview ? 4 : undefined),active:q.active || null,forceSwitch:q.forceSwitch || null,pokemon:q.side?.pokemon || [],targetConvention:'Positive 1/2 = opposing slots; negative -1/-2 = own slots.'}});
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
      switchingTeam:this.switchingTeam,capabilities:this.capabilities(),
      metrics:this.metricsStatus(),
      search:this.client.searchState || null,cancellation:this.cancellation || null,actions:this.actions(),notices:this.notices,
      rooms:[...this.client.rooms.values()].filter(r=>this.ownedRooms.has(r.id)).map(r=>({
        id:r.id,teamId:this.roomTeamId(r.id),ended:r.ended,result:r.result || null,children:r.children,sheets:r.sheets,
        state:this.client.battleSnapshot?.(r.id) || null,
        choice:r.lastAction || null,clock:this.clock(r,'turn'),recentEvents:r.battleLog.slice(-12),
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
    check(!this.awaitingSet&&!c.searchPending&&c.searchState&&!c.searchState.searching.length&&!Object.keys(c.searchState.games||{}).length,'Server must confirm idle with no pending search or match before switching teams');
    check(![...this.ownedParents].some(room=>!c.rooms.get(room)?.ended),'Finish the owned BO3 before switching teams');
  }
  async switchTeam({teamText,teamId,name}){
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
      if(previous){const oldStatus=await previous.flush({savePending:true});check(!['error','closed'].includes(oldStatus.state),'Old team observations could not be preserved; team was retained');}
      // Prepare the exact next report before replacing any account/team state.
      nextRecorder=await this.recorderFactory({team,teamId:nextId,name:name||'M-C team',session:this,approvedTeamChange:true});
      check(nextRecorder&&typeof nextRecorder.status==='function','New team recorder is unavailable');
      const prepared=await nextRecorder.flush();check(prepared.teamId===nextId&&prepared.state==='ready','New team report could not be prepared; team was retained');
      this.assertIdleForTeamSwitch();
      // Closing has no socket side effects. New observations cannot be acquired
      // during this idle-only operation; start/authorization are separately held.
      if(previous){previousClosed=true;await previous.close();}
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
  async syncMetrics() {
    check(this.metricsRecorder,'Live metrics recording is unavailable in this session; use report imports or enable recording on the next normal client start');
    let timer;
    try {
      const result=await Promise.race([this.metricsRecorder.flush({savePending:true}),new Promise((_resolve,reject)=>{
        timer=setTimeout(()=>reject(new Error('Metrics sync did not finish within 25 seconds. Recording continues in the background; inspect metrics status before cleanup.')),25000);
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
    // Long polling is read-only and can be cancelled independently of other calls.
    if (command.op === 'wait') return this.wait({...command,signal}).then(result=>({id:command.id,ok:true,result}));
    if (this.commands.has(command.id)) return this.commands.get(command.id);
    const task = Promise.resolve().then(()=>this.dispatch(command)).then(result=>({id:command.id,ok:true,result}),error=>({id:command.id,ok:false,error:error.message}));
    this.commands.set(command.id,task);return task;
  }
  async saveSetReplays(parent) {
    const c=this.client;
    check(!this.savingReplays,'A completed-set replay operation is already running');
    check(typeof parent==='string' && /^game-bestof3-gen9championsvgc2026regmcbo3-\d+(?:-[a-z0-9]+pw)?$/.test(parent),'Expected a completed authorized BO3 parent room');
    check(this.ownedParents.has(parent) && this.ownedRooms.has(parent) && this.roomParents.get(parent)===parent,'BO3 parent is not owned by this authorized session');
    check(c.rooms.get(parent)?.ended && ['win','tie'].includes(c.rooms.get(parent)?.result?.type),'Official BO3 parent result is not confirmed');
    check(!this.awaitingSet && !c.searchPending && c.searchState && !c.searchState.searching.length && !Object.keys(c.searchState.games || {}).length,'Server must confirm an idle session before saving completed-set replays');
    const children=[...this.roomParents].filter(([child,owner])=>owner===parent && child!==parent && this.ownedRooms.has(child)).map(([child])=>child);
    check(children.length>0 && children.length<=3,'Completed BO3 must have one to three known owned child battles');
    this.savingReplays=true;this.emit('change',{revision:++this.revision,event:'replays-started'});
    const replays=[],failures=[],deadline=Date.now()+this.replayBudgetMs;
    try {
      for(const child of children) {
        const roomId=c.resolveRoom(child),state=c.rooms.get(roomId);
        try {
          this.assertLive();
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
    if (op === 'stop') { this.stopped=true;c.close();this.revision++;this.emit('change',{revision:this.revision,event:'stopped'});return {stopped:true}; }
    this.assertLive();
    if(op==='switch-team')return this.switchTeam(command);
    if(['start','authorize-sets','save-replays'].includes(op))check(!this.switchingTeam,'Finish the approved team switch before this operation');
    if(op==='save-replays')return this.saveSetReplays(c.resolveRoom(room));
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
      check(!this.savingReplays,'Finish completed-set replay preservation before starting another set');
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
    check(Number.isInteger(validForMs) && validForMs >= 100 && validForMs <= 30000, 'Decision validity must be 100–30000 ms');
    const deadlineAt = Math.min(this.now()+validForMs, action.clock.deadlineAt === null ? Infinity : action.clock.deadlineAt-1000);
    check(deadlineAt > this.now(), 'Observed turn countdown has expired; inspect fresh state');
    c.authorize('choose',{room:action.room,confirmed:true});
    return c.choose(action.room,{rqid:action.rqid,revision:action.revision,actions,deadlineAt});
  }
  dispose() {
    this.detachMetrics?.();this.detachMetrics=null;
    for (const [event,listener] of this.listeners) this.client.off(event,listener);
    this.listeners=[];this.stopped=true;this.emit('change',{revision:++this.revision,event:'disposed'});
  }
}
