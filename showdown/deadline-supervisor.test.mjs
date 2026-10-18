import test from 'node:test';
import assert from 'node:assert/strict';
import {DeadlineSupervisor} from './deadline-supervisor.mjs';
import {ShowdownClient} from './client.mjs';

const serverClock=(values,observedAt=1000)=>({source:'server-timer-observation',observedAt,...values});

function fixture(options={}) {
  let now=1000,sequence=0;
  const timers=new Map(),sent=[],forfeits=[],traces=[];
  let actions=[{kind:'turn',token:'turn-1',room:'battle-1',parentId:'set-1',rqid:31,revision:1,receivedAt:1000,clock:serverClock({deadlineAt:61000,remainingMs:60000})}];
  const supervisor=new DeadlineSupervisor({
    now:()=>now,
    setTimer:(callback,delay)=>{const id=++sequence;timers.set(id,{callback,at:now+delay});return id;},
    clearTimer:id=>timers.delete(id),
    getActions:()=>actions,
    validate:(_action,pair)=>{if(!Array.isArray(pair)||pair.length!==2||pair.some(value=>value.invalid))throw new Error('Incomplete or illegal paired choice');return structuredClone(pair);},
    submit:(action,pair,source)=>{sent.push({action,pair,source});actions=actions.filter(value=>value.token!==action.token);},
    forfeit:(action,reason)=>{forfeits.push({action,reason});actions=[];},
    onTrace:event=>traces.push(event),
    ...options,
  });
  return {supervisor,sent,forfeits,traces,timers,get actions(){return actions;},set actions(value){actions=value;},get now(){return now;},advance(ms){
    const end=now+ms;let ticks=0;
    while(true){
      const due=[...timers.entries()].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!due)break;if(++ticks>100)throw new Error('Timer loop');
      now=due[1].at;timers.delete(due[0]);due[1].callback();
    }
    now=end;
  }};
}

const pair=[{type:'move',slot:1},{type:'move',slot:1}];
const enable={enabled:true,forfeitIfStuck:true};

test('opt-in emergency default fills an unstaged request and preserves send uncertainty',()=>{
  let selections=0;
  const f=fixture({selectDefault:()=>{selections++;return pair;}});
  f.supervisor.configure({...enable,emergencyDefaultChoice:true});f.advance(19999);
  assert.equal(selections,0);f.advance(1);
  assert.equal(selections,1);assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].source,'emergency-default');
  assert.equal(f.supervisor.status().halted,true);
  assert(f.traces.some(event=>event.state==='emergency-default-selected'&&event.controlFailure));
  f.advance(120000);assert.equal(f.sent.length,1);assert.equal(f.forfeits.length,0);
});

test('emergency generation is disabled by default and never replaces a staged pair',()=>{
  let selections=0;const f=fixture({selectDefault:()=>{selections++;return pair;}});
  f.supervisor.configure(enable);f.advance(20000);assert.equal(selections,0);assert.equal(f.sent.length,0);
  const g=fixture({selectDefault:()=>{selections++;return pair;}});
  g.supervisor.configure({...enable,emergencyDefaultChoice:true});g.supervisor.stage('turn-1',pair);g.advance(20000);
  assert.equal(selections,0);assert.equal(g.sent[0].source,'fallback');assert.equal(g.supervisor.status().halted,false);
});

test('invalid or unavailable emergency pair uses existing recovery without a retry loop',()=>{
  for(const selected of [null,[{invalid:true},{invalid:true}],Promise.resolve(pair)]){
    let selections=0;const f=fixture({selectDefault:()=>{selections++;return selected;}});
    f.supervisor.configure({...enable,emergencyDefaultChoice:true});f.advance(20000);
    assert.equal(selections,1);assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,0);
    assert.equal(f.supervisor.status().pending[0].recovering,true);
    f.advance(35000);assert.equal(selections,1);assert.equal(f.forfeits.length,1);
  }
});

test('manual send or request advance during emergency generation wins the race',()=>{
  const f=fixture({selectDefault:()=>{f.actions=[];return pair;}});
  f.supervisor.configure({...enable,emergencyDefaultChoice:true});f.advance(20000);
  assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,0);
  const g=fixture({selectDefault:()=>{g.actions=g.actions.map(action=>({...action,actionable:false,submissionStatus:'sent'}));return pair;}});
  g.supervisor.configure({...enable,emergencyDefaultChoice:true});g.advance(120000);
  assert.equal(g.sent.length,0);assert.equal(g.forfeits.length,0);
});

test('an emergency throwing write reserves its send and never retries or forfeits',()=>{
  const f=fixture({selectDefault:()=>pair,submit:()=>{throw new Error('uncertain');}});
  f.supervisor.configure({...enable,emergencyDefaultChoice:true});f.advance(120000);
  assert.equal(f.forfeits.length,0);
  assert.equal(f.traces.filter(event=>event.state==='fallback-send-attempted').length,1);
  assert(f.traces.some(event=>event.state==='fallback-send-uncertain'));
});

test('disabled by default and configuration does not send anything',()=>{
  const f=fixture();f.supervisor.refresh();f.advance(100000);
  assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,0);assert.equal(f.timers.size,0);
  assert.throws(()=>f.supervisor.stage('turn-1',pair),/not enabled/);
  assert.throws(()=>f.supervisor.configure({planningMs:0}),/planningMs/);
  assert.equal(f.supervisor.configure(enable).enabled,true);
  assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,0);f.supervisor.dispose();
});

test('slow agent: complete staged fallback is sent at planning cutoff exactly once',()=>{
  const f=fixture();f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);
  f.advance(19999);assert.equal(f.sent.length,0);
  f.advance(1);assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0].pair,pair);assert.equal(f.sent[0].source,'fallback');
  f.advance(100000);assert.equal(f.sent.length,1);assert.equal(f.forfeits.length,0);
  assert.equal(f.supervisor.status().halted,false);
  assert(f.traces.some(event=>event.state==='fallback-send-returned'&&event.serverAcceptanceConfirmed===false));
});

test('planning miss halts searches for recovery, and only the verified emergency can forfeit',()=>{
  const f=fixture();f.supervisor.configure(enable);f.advance(20000);
  assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().pending[0].recovering,true);
  assert.equal(f.supervisor.status().halted,true);f.advance(34999);assert.equal(f.forfeits.length,0);f.advance(1);assert.equal(f.forfeits.length,1);
  assert.equal(f.forfeits[0].action.parentId,'set-1');assert.match(f.forfeits[0].reason,/without-fallback/);
  assert.equal(f.supervisor.status().halted,true);assert(f.traces.some(event=>event.state==='forfeit-attempted'&&event.controlFailure));
  f.advance(100000);assert.equal(f.forfeits.length,1);
  // AgentSession uses halted to block another search. It does not disable
  // protection for newly actionable requests in the currently owned set.
  f.supervisor.configure(enable);assert.equal(f.supervisor.status().halted,false);
});

test('forfeit is never inferred from enabling the watchdog',()=>{
  const f=fixture();f.supervisor.configure({enabled:true});f.advance(20000);
  assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().halted,true);
  assert(f.traces.some(event=>event.state==='planning-recovery'));f.advance(35000);assert(f.traces.some(event=>event.state==='containment-not-authorized'));
});

test('short observed clock and bank shorten the local planning budget',()=>{
  const f=fixture();f.actions[0].clock=serverClock({deadlineAt:13000,remainingMs:12000,bankRemainingMs:9000});
  f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);
  assert.equal(f.supervisor.status().pending[0].cutoffAt,5000);
  f.advance(3999);assert.equal(f.sent.length,0);f.advance(1);assert.equal(f.sent.length,1);
});

test('an already urgent request is sent as soon as its staged plan can run',()=>{
  const f=fixture();f.actions[0].clock=serverClock({remainingMs:1900});
  f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.advance(0);
  assert.equal(f.sent.length,1);assert.equal(f.forfeits.length,0);
});

test('unknown server clock is explicitly a bounded local budget',()=>{
  const f=fixture();f.actions[0].clock={source:'unavailable',deadlineAt:null,remainingMs:null};
  f.supervisor.configure({...enable,unknownClockMs:12000});
  const pending=f.supervisor.status().pending[0];
  assert.equal(pending.clockSource,'local-unknown-clock-budget');assert.equal(pending.hardDeadlineAt,null);
  assert.equal(pending.cutoffAt,13000);f.advance(12000);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().pending[0].state,'recovery-awaiting-plan');
  f.advance(5000);assert.equal(f.supervisor.status().pending[0].state,'attention-required');f.advance(100000);assert.equal(f.forfeits.length,0);
});

test('known 90-second preview can recover at 40 seconds after missing its 30-second planning target',()=>{
  const f=fixture();f.actions[0].kind='preview';f.actions[0].clock=serverClock({deadlineAt:91000,remainingMs:90000,bankRemainingMs:300000});
  f.supervisor.configure({...enable,planningMs:30000});f.advance(30000);
  const recovery=f.supervisor.status().pending[0];assert.equal(recovery.state,'recovery-awaiting-plan');assert.equal(recovery.emergencyAt,86000);assert.equal(f.supervisor.status().halted,true);assert.equal(f.forfeits.length,0);
  f.advance(10000);f.supervisor.stage('turn-1',pair);f.advance(0);
  assert.equal(f.sent.length,1);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().halted,true);assert(f.traces.some(event=>event.state==='planning-recovery'&&event.controlFailure));
  f.advance(100000);assert.equal(f.forfeits.length,0);assert.equal(f.sent.length,1);
});

test('known 55-second turn forfeits only at its real emergency margin, with auditable clock facts',()=>{
  const f=fixture();f.actions[0].clock=serverClock({deadlineAt:56000,remainingMs:55000,bankDeadlineAt:301000,bankRemainingMs:300000});f.supervisor.configure(enable);
  f.advance(20000);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().pending[0].emergencyAt,51000);
  f.advance(29999);assert.equal(f.forfeits.length,0);f.advance(1);assert.equal(f.forfeits.length,1);
  const evidence=f.traces.find(event=>event.state==='forfeit-attempted');assert.equal(evidence.clockSource,'observed-server-clock');assert.equal(evidence.observedClockSource,'server-timer-observation');assert.equal(evidence.clockObservedAt,1000);assert.equal(evidence.clockFreshForRequest,true);assert.equal(evidence.planningDeadlineAt,21000);assert.equal(evidence.turnDeadlineAt,56000);assert.equal(evidence.bankDeadlineAt,301000);assert.equal(evidence.emergencyAt,51000);assert.equal(evidence.emergencyEligible,true);assert.equal(evidence.deadlineBasis,'verified-server-turn');
});

test('first verified clock replaces the provisional unknown cutoff instead of latching twenty seconds',()=>{
  const f=fixture();f.actions[0].clock={source:'unavailable'};f.supervisor.configure({...enable,planningMs:30000,unknownClockMs:20000});
  assert.equal(f.supervisor.status().pending[0].cutoffAt,21000);f.advance(4000);
  f.actions[0].clock=serverClock({deadlineAt:95000,remainingMs:90000,rqid:31,revision:1},f.now);f.supervisor.refresh('first-real-preview-clock');
  const adopted=f.supervisor.status().pending[0];assert.equal(adopted.cutoffAt,31000);assert.equal(adopted.hardDeadlineAt,95000);assert.equal(adopted.emergencyAt,90000);assert.equal(adopted.clockSource,'observed-server-clock');
  f.advance(16000);assert.equal(f.supervisor.status().halted,false);assert.equal(f.forfeits.length,0);f.advance(10000);assert.equal(f.supervisor.status().pending[0].recovering,true);assert.equal(f.forfeits.length,0);
  f.advance(10000);f.supervisor.stage('turn-1',pair);f.advance(0);assert.equal(f.sent.length,1);assert.equal(f.forfeits.length,0);
});

test('a verified clock arriving after a planning miss supplies a future emergency without premature forfeit',()=>{
  const f=fixture();f.actions[0].clock={source:'unavailable'};f.supervisor.configure({...enable,planningMs:30000,unknownClockMs:20000});f.advance(20000);
  assert.equal(f.supervisor.status().pending[0].recovering,true);assert.equal(f.supervisor.status().pending[0].hardDeadlineAt,null);f.advance(4000);
  f.actions[0].clock=serverClock({remainingMs:60000},f.now);f.supervisor.refresh('late-first-real-clock');
  const pending=f.supervisor.status().pending[0];assert.equal(pending.hardDeadlineAt,85000);assert.equal(pending.emergencyAt,80000);assert.equal(pending.recoveryAttentionAt,null);
  f.advance(10000);assert.equal(f.forfeits.length,0);f.supervisor.stage('turn-1',pair);f.advance(0);assert.equal(f.sent.length,1);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().halted,true);
});

test('a shorter verified bank bounds recovery and later longer observations cannot extend it',()=>{
  const f=fixture();f.actions[0].clock=serverClock({remainingMs:90000,bankRemainingMs:300000});f.supervisor.configure({...enable,planningMs:30000});f.advance(30000);
  f.actions[0].clock=serverClock({remainingMs:60000,bankRemainingMs:8000},f.now);f.supervisor.refresh('short-bank-during-recovery');
  assert.equal(f.supervisor.status().pending[0].emergencyAt,34000);f.advance(1000);
  f.actions[0].clock=serverClock({remainingMs:90000,bankRemainingMs:300000},f.now);f.supervisor.refresh('later-longer-clock');assert.equal(f.supervisor.status().pending[0].emergencyAt,34000);
  f.advance(1999);assert.equal(f.forfeits.length,0);f.advance(1);assert.equal(f.forfeits.length,1);const evidence=f.traces.find(event=>event.state==='forfeit-attempted');assert.equal(evidence.deadlineBasis,'verified-server-bank');assert.equal(evidence.bankDeadlineAt,39000);assert(f.traces.some(event=>event.state==='deadline-armed'&&event.emergencyAt===34000));
});

test('explicit fresh timer-off revokes a recovery emergency instead of forfeiting at a cancelled deadline',()=>{
  const f=fixture();f.supervisor.configure(enable);f.advance(30000);assert.equal(f.supervisor.status().pending[0].emergencyAt,56000);
  f.actions[0].clock={source:'server-timer-disabled',observedAt:f.now,rqid:31,revision:1,deadlineAt:null,remainingMs:null,bankDeadlineAt:null,bankRemainingMs:null};f.supervisor.refresh('inactiveoff');
  const pending=f.supervisor.status().pending[0];assert.equal(pending.hardDeadlineAt,null);assert.equal(pending.emergencyAt,null);assert.equal(pending.timerDisabledAt,31000);assert.equal(pending.clockFreshForRequest,false);assert.equal(pending.observedClockSource,'server-timer-disabled');assert.equal(pending.recoveryAttentionAt,36000);
  f.advance(100000);assert.equal(f.forfeits.length,0);assert(f.traces.some(event=>event.state==='timer-disabled'&&event.timerDisabledAt===31000&&event.emergencyAt===null));
  f.supervisor.stage('turn-1',pair);f.advance(0);assert.equal(f.sent.length,1);assert.equal(f.forfeits.length,0);
});

test('generic unavailable does not revoke a previously verified real deadline',()=>{
  const f=fixture();f.supervisor.configure(enable);f.advance(30000);f.actions[0].clock={source:'unavailable',deadlineAt:null,remainingMs:null,bankDeadlineAt:null,bankRemainingMs:null};f.supervisor.refresh('missing-clock');
  assert.equal(f.supervisor.status().pending[0].emergencyAt,56000);f.advance(25000);assert.equal(f.forfeits.length,1);
});

for(const revoked of [
  {source:'server-timer-disabled',observedAt:999},
  {source:'server-timer-disabled',observedAt:3000},
  {source:'server-timer-disabled',observedAt:2000,rqid:99},
  {source:'server-timer-disabled',observedAt:2000,revision:9},
])test(`stale or different-request timer-off cannot revoke a real deadline: ${JSON.stringify(revoked)}`,()=>{
  const f=fixture();f.supervisor.configure(enable);f.advance(1000);f.actions[0].clock=revoked;f.supervisor.refresh('untrusted-inactiveoff');assert.equal(f.supervisor.status().pending[0].emergencyAt,56000);assert.equal(f.supervisor.status().pending[0].timerDisabledAt,null);
});

test('stale pre-off observations cannot restore a deadline, but an explicit fresh restart can',()=>{
  const f=fixture();f.supervisor.configure(enable);f.advance(30000);f.actions[0].clock={source:'server-timer-disabled',observedAt:f.now};f.supervisor.refresh('timer-off');
  f.actions[0].clock=serverClock({deadlineAt:61000,remainingMs:30000},30000);f.supervisor.refresh('stale-before-timer-off');assert.equal(f.supervisor.status().pending[0].hardDeadlineAt,null);
  f.advance(1000);f.actions[0].clock=serverClock({remainingMs:90000,bankRemainingMs:300000},f.now);f.supervisor.refresh('explicit-timer-restart');assert.equal(f.supervisor.status().pending[0].hardDeadlineAt,122000);assert.equal(f.supervisor.status().pending[0].emergencyAt,117000);assert.equal(f.supervisor.status().pending[0].timerDisabledAt,31000);
  // A repeated old timer-off observation must not cancel the restarted clock.
  f.actions[0].clock={source:'server-timer-disabled',observedAt:31000};f.supervisor.refresh('old-off-repeat');assert.equal(f.supervisor.status().pending[0].emergencyAt,117000);
  f.advance(84999);assert.equal(f.forfeits.length,0);f.advance(1);assert.equal(f.forfeits.length,1);
});

for(const invalid of [
  {deadlineAt:6000,remainingMs:5000},
  {source:'unavailable',observedAt:1000,deadlineAt:6000},
  serverClock({deadlineAt:6000},999),
  serverClock({deadlineAt:6000,rqid:99}),
  serverClock({deadlineAt:6000,revision:9}),
  serverClock({deadlineAt:6000},50000),
])test(`unverified or stale clock cannot create an emergency: ${JSON.stringify(invalid)}`,()=>{
  const f=fixture();f.actions[0].clock=invalid;f.supervisor.configure(enable);f.advance(30000);
  assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().pending[0].hardDeadlineAt,null);assert.equal(f.supervisor.status().halted,true);
  f.supervisor.stage('turn-1',pair);f.advance(0);assert.equal(f.sent.length,1);assert.equal(f.forfeits.length,0);
});

test('manual successful submission during recovery remains reserved past the emergency without acknowledgment',()=>{
  const f=fixture();f.actions[0].clock=serverClock({remainingMs:55000});f.supervisor.configure(enable);f.advance(30000);
  f.actions[0].actionable=false;f.actions[0].submissionStatus='sent';f.supervisor.refresh('manual-recovery-sent');f.advance(100000);
  assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().pending[0].state,'sent-awaiting-server');assert.equal(f.supervisor.status().halted,true);
});

test('fresh shorter observations are applied, and later longer clocks do not extend a cutoff',()=>{
  const f=fixture();f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.advance(1000);
  f.actions[0].clock=serverClock({deadlineAt:12000,remainingMs:10000},f.now);f.supervisor.refresh('timer');
  assert.equal(f.supervisor.status().pending[0].cutoffAt,7000);
  f.actions[0].clock=serverClock({deadlineAt:99000,remainingMs:97000},f.now);f.supervisor.refresh('timer');
  assert.equal(f.supervisor.status().pending[0].cutoffAt,7000);
  f.advance(5000);assert.equal(f.sent.length,1);
});

test('stale staged token never crosses a request change',()=>{
  const f=fixture();f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.advance(5000);
  f.actions=[{...f.actions[0],token:'turn-2',rqid:33,receivedAt:f.now,clock:serverClock({remainingMs:60000},f.now)}];f.supervisor.refresh('request');
  assert.throws(()=>f.supervisor.stage('turn-1',pair),/stale/);
  f.advance(15000);assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,0);
  f.advance(5000);assert.equal(f.forfeits.length,0);f.advance(35000);assert.equal(f.forfeits.length,1);assert.equal(f.forfeits[0].action.rqid,33);
});

for(const reason of ['manual-choice','disconnect','official-result'])test(`${reason} cancels staged watchdog work`,()=>{
  const f=fixture();f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.advance(5000);
  f.actions=[];f.supervisor.refresh(reason);f.advance(100000);
  assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().pending.length,0);
});

test('manual submission racing validation wins without a second send',()=>{
  let f,validations=0;
  f=fixture({validate:(_action,choices)=>{if(++validations===2)f.actions=[];return choices;}});
  f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.advance(20000);
  assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,0);
});

test('controller takeover invalidates plans without extending request cutoff',()=>{
  const f=fixture();f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.advance(19000);
  const cutoff=f.supervisor.status().pending[0].cutoffAt;
  f.supervisor.invalidateStaged('takeover');
  assert.equal(f.supervisor.status().pending[0].cutoffAt,cutoff);assert.equal(f.supervisor.status().pending[0].hasFallback,false);
  f.advance(1000);assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().pending[0].recovering,true);f.advance(35000);assert.equal(f.forfeits.length,1);
});

test('complete fallback must be legal both when staged and at deadline',()=>{
  let legal=true;
  const f=fixture({validate:(_action,choices)=>{if(!legal)throw new Error('Replacement no longer legal');if(choices.length!==2)throw new Error('Incomplete pair');return choices;}});
  f.supervisor.configure(enable);assert.throws(()=>f.supervisor.stage('turn-1',pair.slice(0,1)),/Incomplete/);
  f.supervisor.stage('turn-1',pair);legal=false;f.advance(20000);
  assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().halted,true);assert.equal(f.supervisor.status().pending[0].recovering,true);
  legal=true;f.supervisor.stage('turn-1',pair);f.advance(0);assert.equal(f.sent.length,1);assert.equal(f.forfeits.length,0);
});

test('request advancement during failed fallback validation does not halt or forfeit the new request',()=>{
  let f,validations=0;
  f=fixture({validate:(_action,choices)=>{if(++validations===2){f.actions=[{...f.actions[0],token:'new-request',rqid:33,receivedAt:f.now,clock:serverClock({remainingMs:60000},f.now)}];throw new Error('Old request is no longer legal');}return choices;}});
  f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.advance(20000);
  assert.equal(f.supervisor.status().halted,false);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().pending[0].token,'new-request');
  f.supervisor.stage('new-request',pair);f.advance(20000);assert.equal(f.sent.length,1);assert.equal(f.forfeits.length,0);
});

for(const boundary of ['planning','emergency'])test(`state read failure at ${boundary} suspends timers until a successful external observation`,()=>{
  let fail=false,reads=0,f;
  f=fixture({getActions:()=>{reads++;if(fail)throw new Error('Synthetic state read unavailable');return f.actions;}});f.supervisor.configure(enable);
  if(boundary==='emergency')f.advance(20000);
  const before=reads;fail=true;f.advance(boundary==='planning'?20000:35000);
  assert.equal(reads,before+1);assert.equal(f.supervisor.status().observationFault,true);assert.equal(f.supervisor.status().halted,true);assert.equal(f.timers.size,0);assert.equal(f.forfeits.length,0);f.advance(100000);assert.equal(reads,before+1);assert.equal(f.forfeits.length,0);
  fail=false;f.actions=[{...f.actions[0],token:'restored-fresh-request',rqid:33,receivedAt:f.now,clock:serverClock({remainingMs:60000},f.now)}];f.supervisor.refresh('external-state-restored');
  assert.equal(f.supervisor.status().observationFault,false);f.supervisor.stage('restored-fresh-request',pair);f.advance(20000);assert.equal(f.sent.length,1);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().halted,true);
});

test('staging cannot claim protection after its freshness observation failed',()=>{
  let failOnce=false,f;
  f=fixture({getActions:()=>{if(failOnce){failOnce=false;throw new Error('One failed freshness read');}return f.actions;}});f.supervisor.configure(enable);failOnce=true;
  assert.throws(()=>f.supervisor.stage('turn-1',pair),/state is unavailable/);assert.equal(f.supervisor.status().pending[0].hasFallback,false);assert.equal(f.timers.size,0);
  f.supervisor.stage('turn-1',pair);f.advance(20000);assert.equal(f.sent.length,1);assert.equal(f.forfeits.length,0);
});

test('unknown send is never retried and bounded attention never becomes an automatic forfeit',()=>{
  let attempts=0;
  const f=fixture({submit:()=>{attempts++;throw new Error('Socket send unknown');}});
  f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.advance(20000);
  assert.equal(attempts,1);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().halted,true);
  f.advance(4999);assert.equal(f.supervisor.status().pending[0].state,'send-uncertain');
  f.advance(1);assert.equal(f.supervisor.status().pending[0].state,'attention-required');
  f.advance(100000);assert.equal(attempts,1);assert.equal(f.forfeits.length,0);
});

test('an uncertain send followed by request advancement is never forfeited',()=>{
  let attempts=0,f;
  f=fixture({submit:()=>{attempts++;throw new Error('Unknown send');}});
  f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.advance(20000);
  f.actions=[];f.supervisor.refresh('server-advanced');f.advance(10000);
  assert.equal(attempts,1);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().halted,true);
});

test('a returned send cannot be retried or forfeited even if its adapter leaves the context visible',()=>{
  let attempts=0;
  const f=fixture({submit:()=>{attempts++;}});
  f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.advance(25000);
  assert.equal(attempts,1);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().halted,false);
});

test('reserved manual send waits without acknowledgment and without permitting another choice',()=>{
  const f=fixture();f.supervisor.configure(enable);f.advance(5000);
  f.actions[0].actionable=false;f.actions[0].submissionStatus='sent';f.supervisor.refresh('manual-send-reserved');
  assert.throws(()=>f.supervisor.stage('turn-1',pair),/already attempted/);
  f.advance(100000);assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,0);
  assert.equal(f.supervisor.status().halted,false);assert.equal(f.supervisor.status().pending[0].state,'sent-awaiting-server');
});

test('fallback whose send reservation hides choices can wait for the opponent without acknowledgment',()=>{
  let f,attempts=0;
  f=fixture({submit:()=>{attempts++;f.actions[0].actionable=false;f.actions[0].submissionStatus='sent';}});
  f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.advance(20000);
  assert.equal(attempts,1);assert.equal(f.forfeits.length,0);
  f.advance(100000);assert.equal(f.forfeits.length,0);assert.equal(attempts,1);assert.equal(f.supervisor.status().halted,false);
});

test('uncertain manual send raises bounded attention without forfeiting a possibly delivered choice',()=>{
  const f=fixture();f.supervisor.configure(enable);f.advance(1000);
  f.actions[0].actionable=false;f.actions[0].submissionStatus='uncertain';f.supervisor.refresh('socket-throw');
  assert.equal(f.supervisor.status().halted,true);f.advance(5000);
  assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().pending[0].state,'attention-required');
});

for(const status of ['accepted','execution-observed'])test(`${status} retires a reserved submission without inferring official result`,()=>{
  const f=fixture();f.supervisor.configure(enable);f.actions[0].actionable=false;f.actions[0].submissionStatus='sent';f.supervisor.refresh();
  f.actions[0].submissionStatus=status;f.supervisor.refresh('server-status');f.advance(100000);
  assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().pending.length,0);
});

test('fallback acknowledgment delayed beyond one second is reconciled without a forfeit',()=>{
  let f;
  f=fixture({submit:()=>{f.actions[0].actionable=false;f.actions[0].submissionStatus='sent';}});
  f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.advance(20000);
  f.advance(3000);assert.equal(f.forfeits.length,0);
  f.actions[0].submissionStatus='accepted';f.supervisor.refresh('delayed-ack');f.advance(100000);
  assert.equal(f.forfeits.length,0);
});

test('a pre-send countdown expiring is not proof that a sent choice remains required',()=>{
  const f=fixture();f.supervisor.configure(enable);f.advance(1000);
  f.actions[0].actionable=false;f.actions[0].submissionStatus='sent';f.supervisor.refresh('send');
  assert.equal(f.supervisor.status().pending[0].containmentAt,null);
  f.advance(1000);f.actions[0].clock=serverClock({deadlineAt:6000,bankDeadlineAt:5500},f.now);f.supervisor.refresh('short-bank');
  assert.equal(f.supervisor.status().pending[0].containmentAt,null);
  f.actions[0].clock=serverClock({deadlineAt:99999},f.now);f.supervisor.refresh('longer-clock');
  assert.equal(f.supervisor.status().pending[0].containmentAt,null);
  f.advance(100000);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().halted,false);
});

test('repeated uncertain reads never extend the bounded attention timeout',()=>{
  const f=fixture();f.supervisor.configure(enable);f.advance(1000);
  f.actions[0].actionable=false;f.actions[0].submissionStatus='uncertain';f.supervisor.refresh('send');
  f.advance(3000);f.supervisor.refresh('status-read');assert.equal(f.supervisor.status().pending[0].containmentAt,7000);
  f.advance(2000);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().pending[0].state,'attention-required');
});

for(const kind of ['preview','turn','switch'])test(`${kind}: successful send without routine acknowledgment safely waits beyond 5, 20 and 90 seconds`,()=>{
  const f=fixture();f.actions[0].kind=kind;f.supervisor.configure(enable);f.advance(1000);
  f.actions[0].actionable=false;f.actions[0].submissionStatus='sent';f.supervisor.refresh('successful-send');
  for(const elapsed of [5000,15000,70000]){
    f.advance(elapsed);f.supervisor.refresh('still-waiting-opponent');
    assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().halted,false);
    assert.equal(f.supervisor.status().pending[0].containmentAt,null);
  }
  f.actions=[{...f.actions[0],token:'fresh-request',rqid:34,receivedAt:f.now,actionable:true,submissionStatus:undefined,clock:serverClock({remainingMs:60000},f.now)}];
  f.supervisor.refresh('actual-new-request');f.supervisor.stage('fresh-request',pair);f.advance(20000);
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].action.token,'fresh-request');
});

test('uncertainty halts future searches but a fresh request keeps fallback protection',()=>{
  const f=fixture();f.supervisor.configure(enable);
  f.actions[0].actionable=false;f.actions[0].submissionStatus='uncertain';f.supervisor.refresh('unknown-write');f.advance(5000);
  assert.equal(f.supervisor.status().halted,true);assert.equal(f.forfeits.length,0);
  f.actions=[{...f.actions[0],token:'next-turn',rqid:33,receivedAt:f.now,actionable:true,submissionStatus:undefined,clock:serverClock({remainingMs:60000},f.now)}];
  f.supervisor.refresh('reconciled-by-request');f.supervisor.stage('next-turn',pair);f.advance(20000);
  assert.equal(f.sent.length,1);assert.equal(f.supervisor.status().halted,true);assert.equal(f.forfeits.length,0);
});

test('an explicit server rejection creates a fresh actionable recovery deadline',()=>{
  const f=fixture();f.supervisor.configure(enable);
  f.actions[0].actionable=false;f.actions[0].submissionStatus='sent';f.supervisor.refresh('sent');f.advance(10000);
  f.actions=[{...f.actions[0],token:'rejected-revision-2',revision:2,receivedAt:f.now,actionable:true,submissionStatus:'rejected',clock:serverClock({remainingMs:30000},f.now)}];
  f.supervisor.refresh('explicit-server-rejection');f.supervisor.stage('rejected-revision-2',pair);f.advance(20000);
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].action.revision,2);assert.equal(f.forfeits.length,0);
});

test('real preview wire counterexample: successful /choose has no live sentchoice before opponent selects',()=>{
  const room='battle-gen9championsvgc2026regmcbo3-2699613961',wire=[];
  const client=new ShowdownClient();client.connected=true;client.authenticated=true;client.epoch=1;
  client.ws={send:text=>wire.push(text)};
  const request={rqid:3,teamPreview:true,maxChosenTeamSize:4,side:{id:'p2',name:'Fixture',pokemon:Array.from({length:6},(_,index)=>({ident:`p2: Pokemon ${index+1}`,details:'Politoed, L50',condition:'100/100'}))}};
  client.receive(`>${room}\n|request|${JSON.stringify(request)}\n|inactive|Time left: 90 sec this turn | 300 sec total`);
  const token='preview-exact-failed-request';let f;
  f=fixture({getActions:()=>{
    const state=client.state(room);if(!state.request||state.confirmedChoice)return [];
    const pending=client.sent.has(`choose:${room}:3:${state.revision}`);
    return [{kind:'preview',token,room,parentId:'set-1',rqid:3,revision:state.revision,receivedAt:1000,clock:serverClock({deadlineAt:91000,remainingMs:Math.max(0,91000-f.now)}),...(pending?{actionable:false,submissionStatus:state.lastAction.status}:{})}];
  },validate:(_action,choices)=>client.validateChoice(room,{rqid:3,revision:client.state(room).revision,actions:choices,deadlineAt:Date.now()+10000}).actions});
  f.supervisor.configure(enable);f.advance(12124);
  f.supervisor.stage(token,[{type:'team',order:[1,5,3,6]}]);
  client.authorize('choose',{room,confirmed:true});client.choose(room,{rqid:3,revision:client.state(room).revision,actions:[{type:'team',order:[1,5,3,6]}],deadlineAt:Date.now()+10000});
  f.supervisor.refresh('operator-sent-preview');
  assert.deepEqual(wire,[`${room}|/choose team 1536|3`]);assert.equal(client.state(room).lastAction.status,'sent');
  f.advance(100000);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().halted,false);assert.equal(wire.length,1);
  assert.equal(client.state(room).confirmedChoice,null);
});

test('unknown forfeit is reserved once even across explicit reset',()=>{
  let attempts=0;
  const f=fixture({forfeit:()=>{attempts++;throw new Error('Socket send unknown');}});
  f.supervisor.configure(enable);f.advance(55000);f.supervisor.configure(enable);f.advance(20000);
  assert.equal(attempts,1);assert(f.traces.some(event=>event.state==='forfeit-uncertain'&&event.retried===false));
});

test('missing parent authority halts without forfeiting an arbitrary room',()=>{
  const f=fixture();delete f.actions[0].parentId;f.supervisor.configure(enable);f.advance(55000);
  assert.equal(f.forfeits.length,0);assert(f.traces.some(event=>event.state==='containment-owner-unavailable'));
});

test('new switch request after the last reported failure never inherits the turn plan',()=>{
  const f=fixture();f.actions[0].rqid=31;f.actions[0].clock=serverClock({remainingMs:1900});
  f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);
  f.actions=[{...f.actions[0],token:'switch-33',kind:'switch',rqid:33,revision:2,clock:serverClock({remainingMs:10000})}];
  f.supervisor.refresh('forced-replacement');f.advance(5000);
  assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,1);assert.equal(f.forfeits[0].action.rqid,33);
});

test('dispose clears timers and a diagnostic hook failure cannot interfere',()=>{
  const f=fixture({onTrace:()=>{throw new Error('Logger unavailable');}});
  f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.supervisor.dispose();f.advance(100000);
  assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,0);assert.equal(f.timers.size,0);
  assert.throws(()=>f.supervisor.configure(enable),/disposed/);
});
