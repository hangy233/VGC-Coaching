const DEFAULTS = Object.freeze({enabled:false,forfeitIfStuck:false,planningMs:20000,safetyMarginMs:5000,unknownClockMs:20000});
const finite = value => typeof value === 'number' && Number.isFinite(value);
const copy = value => structuredClone(value);

/**
 * A local deadline guard, not a strategy engine. It can only use a complete,
 * explicitly staged action or invoke the session's authorized containment path.
 * All callbacks must be synchronous so checking and reserving a send is atomic
 * with respect to other session commands in the same JavaScript event loop.
 */
export class DeadlineSupervisor {
  constructor({now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,getActions,validate,submit,forfeit,onTrace=()=>{}}={}) {
    for (const [name,callback] of Object.entries({now,setTimer,clearTimer,getActions,validate,submit,forfeit,onTrace})) {
      if (typeof callback !== 'function') throw new TypeError(`${name} must be a function`);
    }
    Object.assign(this,{now,setTimer,clearTimer,getActions,validate,submit,forfeit,onTrace});
    this.config={...DEFAULTS};this.records=new Map();this.history=[];this.timer=null;
    this.halted=false;this.haltReason=null;this.disposed=false;this.refreshing=false;
    this.forfeitedParents=new Set();
  }

  configure(options={}) {
    if(this.disposed)throw new Error('Deadline supervisor is disposed');
    const config={...this.config,...options};
    for(const key of ['enabled','forfeitIfStuck'])if(typeof config[key]!=='boolean')throw new TypeError(`${key} must be boolean`);
    for(const key of ['planningMs','safetyMarginMs','unknownClockMs'])if(!Number.isInteger(config[key])||config[key]<1||config[key]>300000)throw new TypeError(`${key} must be an integer from 1 to 300000`);
    this.config=config;this.halted=false;this.haltReason=null;
    // Explicit configuration permits future searches; it never retries a send
    // or a forfeit for an already handled request/parent.
    this.trace('configured',{...config});
    this.refresh('configure');
    return this.status();
  }

  trace(state,fields={}) {
    const event={at:this.now(),type:state,state,status:state,...fields};
    if(event.reason)event.reasonCode=event.reason;
    this.history.push(event);if(this.history.length>100)this.history.shift();
    try{this.onTrace(copy(event));}catch{/* Diagnostics cannot block a deadline. */}
  }

  halt(reason,action) {
    this.halted=true;this.haltReason=reason;
    this.trace('halted',{reason,...this.identity(action)});
  }

  identity(action) {
    return action?{token:action.token,room:action.room,parentId:action.parentId??null,rqid:action.rqid??null,revision:action.revision??null}:{};
  }

  readActions() {
    const actions=this.getActions();
    if(actions&&typeof actions.then==='function')throw new TypeError('getActions must be synchronous');
    if(!Array.isArray(actions))throw new TypeError('getActions must return an array');
    return actions.filter(action=>action&&typeof action.token==='string'&&action.token&&action.kind!=='ready'&&!['accepted','execution-observed'].includes(action.submissionStatus));
  }

  refresh(reason='state-change') {
    if(this.disposed||this.refreshing)return this.status();
    this.refreshing=true;
    try{
      if(!this.config.enabled){this.clearPendingTimer();this.records.clear();return this.status();}
      let actions;
      try{actions=this.readActions();}catch(error){
        this.halt('state-observation-failed');this.clearPendingTimer();
        this.trace('observation-error',{reason,message:String(error.message||error)});return this.status();
      }
      const current=new Set(actions.map(action=>action.token));
      for(const [token,record] of this.records)if(!current.has(token)){
        this.trace('request-retired',{...this.identity(record.action),previousState:record.state,reason,submissionConfirmed:false});
        this.records.delete(token);
      }
      for(const action of actions){
        let record=this.records.get(action.token);
        if(!record){
          const receivedAt=finite(action.receivedAt)?action.receivedAt:this.now();
          record={action:copy(action),receivedAt,cutoffAt:Infinity,hardDeadlineAt:null,clockSource:null,state:'waiting-for-plan',staged:null,attempted:false,containmentAt:null,contained:false};
          this.records.set(action.token,record);
          this.trace('request-observed',{...this.identity(action),receivedAt});
        }
        record.action=copy(action);
        this.updateDeadline(record);
        // The session also supplies sent-but-unacknowledged requests. Their
        // sender reservation must suppress another choice without suppressing
        // the deadline check. Positive acknowledgment/advancement retires them.
        if(action.actionable===false){
          record.attempted=true;record.staged=null;
          const uncertain=action.submissionStatus==='uncertain';
          if(!['forfeit-attempted','forfeit-send-returned','forfeit-uncertain'].includes(record.state))record.state=uncertain?'send-uncertain':'submission-pending';
          if(!record.contained&&!this.forfeitedParents.has(action.parentId))record.containmentAt=Math.min(record.containmentAt??Infinity,this.containmentDeadline(record));
          if(uncertain&&!this.halted)this.halt('send-uncertain',action);
        }
      }
      this.schedule();
      return this.status();
    }finally{this.refreshing=false;}
  }

  updateDeadline(record) {
    const now=this.now(),clock=record.action.clock||{};
    const deadlines=[];
    if(finite(clock.deadlineAt))deadlines.push(clock.deadlineAt);
    if(finite(clock.remainingMs))deadlines.push(now+Math.max(0,clock.remainingMs));
    if(finite(clock.bankRemainingMs))deadlines.push(now+Math.max(0,clock.bankRemainingMs));
    if(finite(clock.bankDeadlineAt))deadlines.push(clock.bankDeadlineAt);
    const serverDeadline=deadlines.length?Math.min(...deadlines):null;
    if(serverDeadline!==null)record.hardDeadlineAt=Math.min(record.hardDeadlineAt??Infinity,serverDeadline);
    const source=record.hardDeadlineAt===null?'local-unknown-clock-budget':'observed-server-clock';
    const budget=record.receivedAt+(source==='local-unknown-clock-budget'?Math.min(this.config.planningMs,this.config.unknownClockMs):this.config.planningMs);
    const cutoff=Math.min(budget,record.hardDeadlineAt===null?Infinity:record.hardDeadlineAt-this.config.safetyMarginMs);
    // Later observations/configuration may shorten a request, never extend it.
    const updated=Math.min(record.cutoffAt,Math.max(record.receivedAt,cutoff));
    if(updated!==record.cutoffAt||source!==record.clockSource){
      record.cutoffAt=updated;record.clockSource=source;
      this.trace('deadline-armed',{...this.identity(record.action),cutoffAt:updated,hardDeadlineAt:record.hardDeadlineAt,clockSource:source,exactServerDeadline:false});
    }
  }

  stage(token,actions) {
    if(this.disposed||!this.config.enabled)throw new Error('Deadline supervisor is not enabled');
    if(this.halted)throw new Error('Deadline supervisor is halted; explicitly configure it after recovery');
    this.refresh('stage');
    const record=this.records.get(token);
    if(!record)throw new Error('Fallback token is stale or unavailable');
    if(record.attempted)throw new Error('A fallback was already attempted for this request');
    const action=this.readActions().find(value=>value.token===token);
    if(!action)throw new Error('Fallback request changed before staging');
    if(action.actionable===false)throw new Error('Fallback request already has a reserved submission');
    const canonical=this.validate(action,copy(actions));
    if(canonical&&typeof canonical.then==='function')throw new TypeError('validate must be synchronous');
    if(!Array.isArray(canonical)||!canonical.length)throw new TypeError('validate must return a complete canonical action array');
    record.staged=copy(canonical);record.state='fallback-staged';
    this.trace('fallback-staged',{...this.identity(action),cutoffAt:record.cutoffAt});
    // A short clock may already have expired while the caller prepared its plan.
    this.schedule();
    return this.status();
  }

  invalidateStaged(reason='controller-changed') {
    for(const record of this.records.values())if(record.staged&&!record.attempted){
      record.staged=null;record.state='waiting-for-plan';
      this.trace('fallback-invalidated',{...this.identity(record.action),reason,cutoffAt:record.cutoffAt});
    }
    return this.status();
  }

  clearPendingTimer() {
    if(this.timer!==null){this.clearTimer(this.timer);this.timer=null;}
  }

  containmentDeadline(record) {
    // An agent planning cutoff is not an acknowledgment cutoff. Allow bounded
    // reconciliation time after a send, limited by the observed server/bank
    // deadline, and shorten (never extend) this on later observations.
    const now=this.now();
    return Math.max(now,Math.min(now+5000,record.hardDeadlineAt===null?Infinity:record.hardDeadlineAt-1000));
  }

  schedule() {
    this.clearPendingTimer();
    if(this.disposed||!this.config.enabled)return;
    const pending=[...this.records.values()].filter(record=>record.containmentAt!==null||!this.halted&&!record.attempted);
    if(!pending.length)return;
    const due=Math.min(...pending.map(record=>record.containmentAt??record.cutoffAt));
    this.timer=this.setTimer(()=>{this.timer=null;this.onTimer();},Math.max(0,due-this.now()));
    this.timer?.unref?.();
  }

  onTimer() {
    if(this.disposed||!this.config.enabled)return;
    this.refresh('deadline-check');
    // refresh cancels manual submissions, old requests, results and disconnects
    // before any choice or forfeit authority is consulted.
    for(const record of [...this.records.values()]){
      if(record.containmentAt!==null&&record.containmentAt<=this.now()){
        record.containmentAt=null;
        this.contain(record,'submission-not-confirmed');
      }else if(!this.halted&&!record.attempted&&record.cutoffAt<=this.now())this.handleCutoff(record);
    }
    this.schedule();
  }

  handleCutoff(record) {
    let action;
    try{action=this.readActions().find(value=>value.token===record.action.token);}catch{
      this.halt('state-observation-failed',record.action);return;
    }
    if(!action){this.refresh('request-changed-at-cutoff');return;}
    record.attempted=true;
    if(!record.staged){
      record.state='no-fallback';this.halt('planning-timeout-without-fallback',action);
      this.contain(record,'planning-timeout-without-fallback');return;
    }
    let canonical;
    try{
      canonical=this.validate(action,copy(record.staged));
      if(canonical&&typeof canonical.then==='function')throw new Error('validate must be synchronous');
      if(!Array.isArray(canonical)||!canonical.length)throw new Error('Invalid canonical fallback');
    }catch(error){
      record.state='fallback-invalid';this.trace('fallback-invalid',{...this.identity(action),message:String(error.message||error)});
      this.halt('fallback-no-longer-legal',action);this.contain(record,'fallback-no-longer-legal');return;
    }
    // Validation may invoke session hooks. Recheck before entering the single
    // sender, whose own reservation/deduplication handles a reentrant manual send.
    let fresh;
    try{fresh=this.readActions().find(value=>value.token===action.token);}catch{
      this.halt('state-observation-failed',record.action);return;
    }
    if(!fresh||fresh.actionable===false){this.refresh('manual-send-won-race');return;}
    record.state='submitting';this.trace('fallback-send-attempted',{...this.identity(fresh),source:'fallback'});
    try{
      const result=this.submit(fresh,canonical,'fallback');
      if(result&&typeof result.then==='function')throw new Error('submit must be synchronous');
      record.state='send-returned';this.trace('fallback-send-returned',{...this.identity(fresh),serverAcceptanceConfirmed:false});
    }catch(error){
      record.state='send-uncertain';this.trace('fallback-send-uncertain',{...this.identity(fresh),message:String(error.message||error),retried:false});
      this.halt('fallback-send-uncertain',fresh);
    }
    // Even a successful local send is not proof of acceptance. The session's
    // sender supplies reserved-but-unacknowledged contexts; only an unresolved
    // exact request can trigger containment. Never resubmit the paired choice.
    record.containmentAt=Math.min(record.containmentAt??Infinity,this.containmentDeadline(record));
    this.refresh('after-fallback-send');
  }

  contain(record,reason) {
    let action;
    try{action=this.readActions().find(value=>value.token===record.action.token);}catch{
      this.halt('state-observation-failed',record.action);return;
    }
    if(!action){this.refresh('containment-request-retired');return;}
    record.contained=true;
    this.halt(reason,action);record.state='attention-required';
    if(!this.config.forfeitIfStuck){this.trace('containment-not-authorized',{...this.identity(action),reason});return;}
    if(!action.parentId){this.trace('containment-owner-unavailable',{...this.identity(action),reason});return;}
    if(this.forfeitedParents.has(action.parentId))return;
    // Reserve before sending; unknown forfeits must never become retry loops.
    this.forfeitedParents.add(action.parentId);record.state='forfeit-attempted';
    this.trace('forfeit-attempted',{...this.identity(action),reason,controlFailure:true});
    try{
      const result=this.forfeit(action,reason);
      if(result&&typeof result.then==='function')throw new Error('forfeit must be synchronous');
      record.state='forfeit-send-returned';this.trace('forfeit-send-returned',{...this.identity(action),controlFailure:true,officialResultConfirmed:false});
    }catch(error){
      record.state='forfeit-uncertain';this.trace('forfeit-uncertain',{...this.identity(action),message:String(error.message||error),controlFailure:true,retried:false});
    }
  }

  status() {
    return {enabled:this.config.enabled,forfeitIfStuck:this.config.forfeitIfStuck,planningMs:this.config.planningMs,safetyMarginMs:this.config.safetyMarginMs,unknownClockMs:this.config.unknownClockMs,halted:this.halted,haltReason:this.haltReason,disposed:this.disposed,pending:[...this.records.values()].map(record=>({...this.identity(record.action),receivedAt:record.receivedAt,cutoffAt:record.cutoffAt,hardDeadlineAt:record.hardDeadlineAt,clockSource:record.clockSource,state:record.state,hasFallback:!!record.staged,attempted:record.attempted,containmentAt:record.containmentAt})),recentEvents:copy(this.history)};
  }

  dispose() {
    this.clearPendingTimer();this.records.clear();this.disposed=true;
  }
}
