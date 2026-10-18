const DEFAULTS = Object.freeze({enabled:false,forfeitIfStuck:false,emergencyDefaultChoice:false,planningMs:20000,safetyMarginMs:5000,unknownClockMs:20000});
const finite = value => typeof value === 'number' && Number.isFinite(value);
const copy = value => structuredClone(value);

/**
 * A local deadline guard. It prefers a complete explicitly staged action;
 * an opt-in synchronous selector can supply a legal emergency default.
 * All callbacks must be synchronous so checking and reserving a send is atomic
 * with respect to other session commands in the same JavaScript event loop.
 */
export class DeadlineSupervisor {
  constructor({now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,getActions,validate,submit,forfeit,selectDefault=()=>null,onTrace=()=>{}}={}) {
    for (const [name,callback] of Object.entries({now,setTimer,clearTimer,getActions,validate,submit,forfeit,selectDefault,onTrace})) {
      if (typeof callback !== 'function') throw new TypeError(`${name} must be a function`);
    }
    Object.assign(this,{now,setTimer,clearTimer,getActions,validate,submit,forfeit,selectDefault,onTrace});
    this.authorityEpoch=0;
    this.config={...DEFAULTS};this.records=new Map();this.history=[];this.timer=null;
    this.halted=false;this.haltReason=null;this.disposed=false;this.refreshing=false;this.observationFault=false;
    this.forfeitedParents=new Set();
  }

  configure(options={}) {
    if(this.disposed)throw new Error('Deadline supervisor is disposed');
    const config={...this.config,...options};
    for(const key of ['enabled','forfeitIfStuck','emergencyDefaultChoice'])if(typeof config[key]!=='boolean')throw new TypeError(`${key} must be boolean`);
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

  observationFailed(action){
    this.observationFault=true;this.halt('state-observation-failed',action);this.clearPendingTimer();
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
        this.observationFailed();
        this.trace('observation-error',{reason,message:String(error.message||error)});return this.status();
      }
      this.observationFault=false;
      const current=new Set(actions.map(action=>action.token));
      for(const [token,record] of this.records)if(!current.has(token)){
        this.trace('request-retired',{...this.identity(record.action),previousState:record.state,reason,submissionConfirmed:false});
        this.records.delete(token);
      }
      for(const action of actions){
        let record=this.records.get(action.token);
        if(!record){
          const receivedAt=finite(action.receivedAt)?action.receivedAt:this.now();
          record={action:copy(action),receivedAt,cutoffAt:Infinity,planningDeadlineAt:receivedAt+this.config.planningMs,unknownCutoffAt:receivedAt+Math.min(this.config.planningMs,this.config.unknownClockMs),hardDeadlineAt:null,turnDeadlineAt:null,bankDeadlineAt:null,emergencyAt:null,clockSource:null,observedClockSource:null,clockObservedAt:null,timerDisabledAt:null,clockFreshForRequest:false,deadlineBasis:'local-unknown-budget',state:'waiting-for-plan',staged:null,stagedSource:null,defaultAttempted:false,attempted:false,sendOutcome:null,containmentAt:null,contained:false,recovering:false,recoveryStartedAt:null,recoveryReason:null,recoveryAttentionAt:null,emergencyHandled:false};
          this.records.set(action.token,record);
          this.trace('request-observed',{...this.identity(action),receivedAt});
        }
        record.action=copy(action);
        this.updateDeadline(record);
        // Showdown normally does not acknowledge a live /choose. Its server
        // emits sentchoice when reconnecting, not routinely after choose(). A
        // returned local send is therefore allowed to wait for the opponent
        // indefinitely; missing acknowledgment is not evidence of a failure.
        if(action.actionable===false){
          record.attempted=true;record.staged=null;
          const uncertain=action.submissionStatus==='uncertain';
          if(uncertain)record.sendOutcome='uncertain';
          else record.sendOutcome??='returned';
          if(!['forfeit-attempted','forfeit-send-returned','forfeit-uncertain','attention-required'].includes(record.state))record.state=record.sendOutcome==='uncertain'?'send-uncertain':'sent-awaiting-server';
          if(record.sendOutcome==='uncertain'){
            if(!record.contained)record.containmentAt??=this.now()+5000;
            if(!this.halted)this.halt('send-uncertain',action);
          }else record.containmentAt=null;
        }
      }
      this.schedule();
      return this.status();
    }finally{this.refreshing=false;}
  }

  updateDeadline(record) {
    const now=this.now(),clock=record.action.clock||{};
    const previousSource=record.clockSource;
    const previousHardDeadline=record.hardDeadlineAt,previousEmergency=record.emergencyAt;
    // Production clock evidence has this source and observation timestamp.
    // A local budget or stale/different-request observation is never promoted
    // into an automatic-forfeit deadline merely because it has numeric fields.
    const freshForRequest=finite(clock.observedAt)&&clock.observedAt>=record.receivedAt&&clock.observedAt<=now&&(clock.rqid===undefined||clock.rqid===record.action.rqid)&&(clock.revision===undefined||clock.revision===record.action.revision);
    const revoked=clock.source==='server-timer-disabled'&&freshForRequest&&(record.timerDisabledAt===null||clock.observedAt>record.timerDisabledAt)&&(record.clockObservedAt===null||clock.observedAt>=record.clockObservedAt);
    if(revoked){
      record.timerDisabledAt=clock.observedAt;record.turnDeadlineAt=null;record.bankDeadlineAt=null;record.hardDeadlineAt=null;record.emergencyAt=null;
      record.clockFreshForRequest=false;record.clockObservedAt=null;record.observedClockSource='server-timer-disabled';record.emergencyHandled=false;
      if(record.recovering&&record.recoveryAttentionAt===null)record.recoveryAttentionAt=now+5000;
    }
    const fresh=clock.source==='server-timer-observation'&&freshForRequest&&(record.timerDisabledAt===null||clock.observedAt>record.timerDisabledAt);
    const turn=[],bank=[];
    if(fresh){
      if(finite(clock.deadlineAt))turn.push(clock.deadlineAt);
      if(finite(clock.remainingMs))turn.push(now+Math.max(0,clock.remainingMs));
      if(finite(clock.bankDeadlineAt))bank.push(clock.bankDeadlineAt);
      if(finite(clock.bankRemainingMs))bank.push(now+Math.max(0,clock.bankRemainingMs));
      if(turn.length)record.turnDeadlineAt=Math.min(record.turnDeadlineAt??Infinity,...turn);
      if(bank.length)record.bankDeadlineAt=Math.min(record.bankDeadlineAt??Infinity,...bank);
      if(turn.length||bank.length){record.clockObservedAt=clock.observedAt;record.observedClockSource=clock.source;record.clockFreshForRequest=true;}
    }
    const deadlines=[record.turnDeadlineAt,record.bankDeadlineAt].filter(finite);
    record.hardDeadlineAt=deadlines.length?Math.min(...deadlines):null;
    const source=record.hardDeadlineAt===null?'local-unknown-clock-budget':'observed-server-clock';
    record.observedClockSource??='unavailable';
    record.planningDeadlineAt=Math.min(record.planningDeadlineAt,record.receivedAt+this.config.planningMs);
    record.unknownCutoffAt=Math.min(record.unknownCutoffAt,record.receivedAt+Math.min(this.config.planningMs,this.config.unknownClockMs));
    record.emergencyAt=record.hardDeadlineAt===null?null:Math.max(record.receivedAt,record.hardDeadlineAt-this.config.safetyMarginMs);
    record.deadlineBasis=record.hardDeadlineAt===null?'local-unknown-budget':record.bankDeadlineAt!==null&&record.bankDeadlineAt===record.hardDeadlineAt?'verified-server-bank':'verified-server-turn';
    const budget=source==='local-unknown-clock-budget'?record.unknownCutoffAt:record.planningDeadlineAt;
    const cutoff=Math.max(record.receivedAt,Math.min(budget,record.emergencyAt??Infinity));
    // The first verified clock replaces a provisional unknown-clock budget.
    // Once a real turn/bank deadline is known, later longer observations never
    // extend it. Neither a takeover nor a repeated read resets request age.
    const updated=previousSource==='local-unknown-clock-budget'&&source==='observed-server-clock'?cutoff:Math.min(record.cutoffAt,cutoff);
    if(record.emergencyAt!==null)record.recoveryAttentionAt=null;
    if(updated!==record.cutoffAt||source!==previousSource||record.hardDeadlineAt!==previousHardDeadline||record.emergencyAt!==previousEmergency){
      record.cutoffAt=updated;record.clockSource=source;
      this.trace('deadline-armed',{...this.identity(record.action),...this.deadlineFacts(record),exactServerDeadline:false});
    }
    if(revoked)this.trace('timer-disabled',{...this.identity(record.action),...this.deadlineFacts(record),forfeited:false});
  }

  deadlineFacts(record){
    return {planningDeadlineAt:record.planningDeadlineAt,cutoffAt:record.cutoffAt,emergencyAt:record.emergencyAt,hardDeadlineAt:record.hardDeadlineAt,turnDeadlineAt:record.turnDeadlineAt,bankDeadlineAt:record.bankDeadlineAt,unknownCutoffAt:record.unknownCutoffAt,clockSource:record.clockSource,observedClockSource:record.observedClockSource,clockObservedAt:record.clockObservedAt,timerDisabledAt:record.timerDisabledAt,clockFreshForRequest:record.clockFreshForRequest,deadlineBasis:record.deadlineBasis,recoveryStartedAt:record.recoveryStartedAt,emergencyEligible:record.emergencyAt!==null&&record.emergencyAt<=this.now()};
  }

  stage(token,actions) {
    if(this.disposed||!this.config.enabled)throw new Error('Deadline supervisor is not enabled');
    // halted blocks future searches in AgentSession, not protection for the
    // current owned set after a new request reconciles an uncertain send.
    this.refresh('stage');
    if(this.observationFault)throw new Error('Battle state is unavailable; refresh before staging a fallback');
    const record=this.records.get(token);
    if(!record)throw new Error('Fallback token is stale or unavailable');
    if(record.attempted)throw new Error('A fallback was already attempted for this request');
    if(this.forfeitedParents.has(record.action.parentId))throw new Error('This parent already has a reserved forfeit');
    const action=this.readActions().find(value=>value.token===token);
    if(!action)throw new Error('Fallback request changed before staging');
    if(action.actionable===false)throw new Error('Fallback request already has a reserved submission');
    const canonical=this.validate(action,copy(actions));
    if(canonical&&typeof canonical.then==='function')throw new TypeError('validate must be synchronous');
    if(!Array.isArray(canonical)||!canonical.length)throw new TypeError('validate must return a complete canonical action array');
    record.staged=copy(canonical);record.stagedSource='fallback';record.state='fallback-staged';
    this.trace('fallback-staged',{...this.identity(action),...this.deadlineFacts(record),recovering:record.recovering});
    // A short clock may already have expired while the caller prepared its plan.
    this.schedule();
    return this.status();
  }

  invalidateStaged(reason='controller-changed') {
    this.authorityEpoch++;
    for(const record of this.records.values())if(record.staged&&!record.attempted){
      record.staged=null;record.stagedSource=null;record.defaultAttempted=false;record.state='waiting-for-plan';
      this.trace('fallback-invalidated',{...this.identity(record.action),reason,cutoffAt:record.cutoffAt});
    }
    return this.status();
  }

  clearPendingTimer() {
    if(this.timer!==null){this.clearTimer(this.timer);this.timer=null;}
  }

  schedule() {
    this.clearPendingTimer();
    if(this.disposed||!this.config.enabled||this.observationFault)return;
    const pending=[...this.records.values()].map(record=>{
      if(record.containmentAt!==null)return record.containmentAt;
      if(record.attempted||this.forfeitedParents.has(record.action.parentId))return null;
      if(!record.recovering)return record.cutoffAt;
      if(record.staged)return this.now();
      if(!record.emergencyHandled&&record.emergencyAt!==null)return record.emergencyAt;
      return record.recoveryAttentionAt;
    }).filter(finite);
    if(!pending.length)return;
    const due=Math.min(...pending);
    this.timer=this.setTimer(()=>{this.timer=null;this.onTimer();},Math.max(0,due-this.now()));
    this.timer?.unref?.();
  }

  onTimer() {
    if(this.disposed||!this.config.enabled||this.observationFault)return;
    this.refresh('deadline-check');
    if(this.observationFault)return;
    // refresh cancels manual submissions, old requests, results and disconnects
    // before any choice or forfeit authority is consulted.
    for(const record of [...this.records.values()]){
      if(this.observationFault)break;
      if(record.containmentAt!==null&&record.containmentAt<=this.now()){
        record.containmentAt=null;
        this.attention(record,'uncertain-send-not-reconciled');
      }else if(!record.attempted){
        if(record.recovering){
          if(record.staged)this.handleCutoff(record);
          else if(!record.emergencyHandled&&record.emergencyAt!==null&&record.emergencyAt<=this.now())this.contain(record,record.recoveryReason||'planning-timeout-without-fallback');
          else if(record.recoveryAttentionAt!==null&&record.recoveryAttentionAt<=this.now()){
            record.recoveryAttentionAt=null;record.state='attention-required';
            this.trace('recovery-attention-required',{...this.identity(record.action),...this.deadlineFacts(record),reason:record.recoveryReason,controlFailure:true,forfeited:false});
          }
        }else if(record.cutoffAt<=this.now())this.handleCutoff(record);
      }
    }
    this.schedule();
  }

  handleCutoff(record) {
    const authorityEpoch=this.authorityEpoch;
    let action;
    try{action=this.readActions().find(value=>value.token===record.action.token);}catch{
      this.observationFailed(record.action);return;
    }
    if(!action){this.refresh('request-changed-at-cutoff');return;}
    if(action.actionable===false||record.sendOutcome){this.refresh('submission-already-attempted');return;}
    record.action=copy(action);this.updateDeadline(record);
    if(!record.recovering&&record.cutoffAt>this.now())return;
    if(!record.staged){
      if(!this.prepareEmergencyDefault(record,action)){
        this.beginRecovery(record,'planning-timeout-without-fallback');return;
      }
    }
    let canonical;
    try{
      canonical=this.validate(action,copy(record.staged));
      if(canonical&&typeof canonical.then==='function')throw new Error('validate must be synchronous');
      if(!Array.isArray(canonical)||!canonical.length)throw new Error('Invalid canonical fallback');
    }catch(error){
      record.state='fallback-invalid';this.trace('fallback-invalid',{...this.identity(action),message:String(error.message||error)});
      record.staged=null;record.stagedSource=null;
      if(this.prepareEmergencyDefault(record,action)){this.handleCutoff(record);return;}
      this.beginRecovery(record,'fallback-no-longer-legal');return;
    }
    // Validation may invoke session hooks. Recheck before entering the single
    // sender, whose own reservation/deduplication handles a reentrant manual send.
    let fresh;
    try{fresh=this.readActions().find(value=>value.token===action.token);}catch{
      this.observationFailed(record.action);return;
    }
    if(authorityEpoch!==this.authorityEpoch){record.staged=null;record.stagedSource=null;record.defaultAttempted=false;this.refresh('takeover-won-race');return;}
    if(!fresh||fresh.actionable===false){this.refresh('manual-send-won-race');return;}
    const source=record.stagedSource||'fallback';
    record.attempted=true;record.state='submitting';record.recoveryAttentionAt=null;
    this.trace('fallback-send-attempted',{...this.identity(fresh),...this.deadlineFacts(record),source,...(source==='emergency-default'?{controlFailure:true}:{})});
    try{
      const result=this.submit(fresh,canonical,source);
      if(result&&typeof result.then==='function')throw new Error('submit must be synchronous');
      record.sendOutcome='returned';record.state='sent-awaiting-server';record.staged=null;record.containmentAt=null;
      this.trace('fallback-send-returned',{...this.identity(fresh),source,serverAcceptanceConfirmed:false});
    }catch(error){
      record.sendOutcome='uncertain';record.containmentAt??=this.now()+5000;
      record.state='send-uncertain';this.trace('fallback-send-uncertain',{...this.identity(fresh),message:String(error.message||error),retried:false});
      this.halt('fallback-send-uncertain',fresh);
    }
    // Local send return is not acceptance, but acknowledgment silence is also
    // not rejection. Never retry or forfeit merely because it remains silent.
    this.refresh('after-fallback-send');
  }

  prepareEmergencyDefault(record,action){
    if(!this.config.emergencyDefaultChoice||record.defaultAttempted)return false;
    record.defaultAttempted=true;
    try{
      const choices=this.selectDefault(copy(action));
      if(choices&&typeof choices.then==='function')throw new Error('selectDefault must be synchronous');
      if(!Array.isArray(choices)||!choices.length)throw new Error('No complete emergency choice');
      record.staged=copy(choices);record.stagedSource='emergency-default';
      this.halt('emergency-default-used',action);
      this.trace('emergency-default-selected',{...this.identity(action),source:'emergency-default',controlFailure:true});
      return true;
    }catch(error){
      this.trace('emergency-default-unavailable',{...this.identity(action),source:'emergency-default',controlFailure:true,reason:'no-legal-default'});
      return false;
    }
  }

  attention(record,reason) {
    let action;
    try{action=this.readActions().find(value=>value.token===record.action.token);}catch{
      this.observationFailed(record.action);return;
    }
    if(!action){this.refresh('attention-request-retired');return;}
    record.contained=true;record.state='attention-required';this.halt(reason,action);
    this.trace('submission-attention-required',{...this.identity(action),reason,serverAcceptanceConfirmed:false,forfeited:false,retried:false});
  }

  beginRecovery(record,reason){
    let action;
    try{action=this.readActions().find(value=>value.token===record.action.token);}catch{
      this.observationFailed(record.action);return;
    }
    if(!action){this.refresh('request-changed-before-recovery');return;}
    if(action.actionable===false||record.sendOutcome){this.refresh('submission-already-attempted');return;}
    record.action=copy(action);this.updateDeadline(record);
    if(!record.recovering&&record.cutoffAt>this.now())return;
    record.recovering=true;record.recoveryStartedAt??=this.now();record.recoveryReason=reason;
    record.staged=null;record.state='recovery-awaiting-plan';
    record.recoveryAttentionAt=record.emergencyAt===null?this.now()+5000:null;
    this.halt(reason,record.action);
    this.trace('planning-recovery',{...this.identity(record.action),...this.deadlineFacts(record),reason,controlFailure:true,forfeited:false});
    if(record.emergencyAt!==null&&record.emergencyAt<=this.now())this.contain(record,reason);
  }

  contain(record,reason) {
    let action;
    try{action=this.readActions().find(value=>value.token===record.action.token);}catch{
      this.observationFailed(record.action);return;
    }
    if(!action){this.refresh('containment-request-retired');return;}
    // A send reservation (including a throwing write) is not proof that our
    // action remains required. Only a genuinely unsubmitted actionable request
    // may use the authorized automatic forfeit path.
    if(action.actionable===false||record.sendOutcome){this.refresh('submission-already-attempted');return;}
    // Missing a local planning target is recoverable. Only verified turn/bank
    // evidence for this still-actionable request can authorize this emergency.
    if(record.emergencyAt===null||record.emergencyAt>this.now())return;
    record.emergencyHandled=true;
    record.contained=true;
    this.halt(reason,action);record.state='attention-required';
    if(!this.config.forfeitIfStuck){this.trace('containment-not-authorized',{...this.identity(action),reason});return;}
    if(!action.parentId){this.trace('containment-owner-unavailable',{...this.identity(action),reason});return;}
    if(this.forfeitedParents.has(action.parentId))return;
    // Reserve before sending; unknown forfeits must never become retry loops.
    this.forfeitedParents.add(action.parentId);record.state='forfeit-attempted';
    this.trace('forfeit-attempted',{...this.identity(action),...this.deadlineFacts(record),reason,controlFailure:true});
    try{
      const result=this.forfeit(action,reason);
      if(result&&typeof result.then==='function')throw new Error('forfeit must be synchronous');
      record.state='forfeit-send-returned';this.trace('forfeit-send-returned',{...this.identity(action),controlFailure:true,officialResultConfirmed:false});
    }catch(error){
      record.state='forfeit-uncertain';this.trace('forfeit-uncertain',{...this.identity(action),message:String(error.message||error),controlFailure:true,retried:false});
    }
  }

  status() {
    return {enabled:this.config.enabled,forfeitIfStuck:this.config.forfeitIfStuck,emergencyDefaultChoice:this.config.emergencyDefaultChoice,planningMs:this.config.planningMs,safetyMarginMs:this.config.safetyMarginMs,unknownClockMs:this.config.unknownClockMs,halted:this.halted,haltReason:this.haltReason,observationFault:this.observationFault,disposed:this.disposed,pending:[...this.records.values()].map(record=>({...this.identity(record.action),...this.deadlineFacts(record),receivedAt:record.receivedAt,state:record.state,hasFallback:!!record.staged,fallbackSource:record.stagedSource,attempted:record.attempted,containmentAt:record.containmentAt,recovering:record.recovering,recoveryAttentionAt:record.recoveryAttentionAt,emergencyHandled:record.emergencyHandled})),recentEvents:copy(this.history)};
  }

  dispose() {
    this.clearPendingTimer();this.records.clear();this.disposed=true;
  }
}
