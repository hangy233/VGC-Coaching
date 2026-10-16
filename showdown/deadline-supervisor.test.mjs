import test from 'node:test';
import assert from 'node:assert/strict';
import {DeadlineSupervisor} from './deadline-supervisor.mjs';

function fixture(options={}) {
  let now=1000,sequence=0;
  const timers=new Map(),sent=[],forfeits=[],traces=[];
  let actions=[{kind:'turn',token:'turn-1',room:'battle-1',parentId:'set-1',rqid:31,revision:1,receivedAt:1000,clock:{deadlineAt:61000,remainingMs:60000}}];
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

test('silence immediately after a new request causes one authorized forfeit and halts searches',()=>{
  const f=fixture();f.supervisor.configure(enable);f.advance(20000);
  assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,1);
  assert.equal(f.forfeits[0].action.parentId,'set-1');assert.match(f.forfeits[0].reason,/without-fallback/);
  assert.equal(f.supervisor.status().halted,true);assert(f.traces.some(event=>event.state==='forfeit-attempted'&&event.controlFailure));
  f.advance(100000);assert.equal(f.forfeits.length,1);
  f.actions=[{kind:'turn',token:'next-set',room:'battle-2',parentId:'set-2',receivedAt:f.now}];f.supervisor.refresh();
  f.advance(30000);assert.equal(f.forfeits.length,1);
  f.supervisor.configure(enable);f.advance(0);assert.equal(f.forfeits.length,2);
});

test('forfeit is never inferred from enabling the watchdog',()=>{
  const f=fixture();f.supervisor.configure({enabled:true});f.advance(20000);
  assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().halted,true);
  assert(f.traces.some(event=>event.state==='containment-not-authorized'));
});

test('short observed clock and bank shorten the local planning budget',()=>{
  const f=fixture();f.actions[0].clock={deadlineAt:13000,remainingMs:12000,bankRemainingMs:9000};
  f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);
  assert.equal(f.supervisor.status().pending[0].cutoffAt,5000);
  f.advance(3999);assert.equal(f.sent.length,0);f.advance(1);assert.equal(f.sent.length,1);
});

test('an already urgent request is sent as soon as its staged plan can run',()=>{
  const f=fixture();f.actions[0].clock={remainingMs:1900};
  f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.advance(0);
  assert.equal(f.sent.length,1);assert.equal(f.forfeits.length,0);
});

test('unknown server clock is explicitly a bounded local budget',()=>{
  const f=fixture();f.actions[0].clock={source:'unavailable',deadlineAt:null,remainingMs:null};
  f.supervisor.configure({...enable,unknownClockMs:12000});
  const pending=f.supervisor.status().pending[0];
  assert.equal(pending.clockSource,'local-unknown-clock-budget');assert.equal(pending.hardDeadlineAt,null);
  assert.equal(pending.cutoffAt,13000);f.advance(12000);assert.equal(f.forfeits.length,1);
});

test('fresh shorter observations are applied, and later longer clocks do not extend a cutoff',()=>{
  const f=fixture();f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.advance(1000);
  f.actions[0].clock={deadlineAt:12000,remainingMs:10000};f.supervisor.refresh('timer');
  assert.equal(f.supervisor.status().pending[0].cutoffAt,7000);
  f.actions[0].clock={deadlineAt:99000,remainingMs:97000};f.supervisor.refresh('timer');
  assert.equal(f.supervisor.status().pending[0].cutoffAt,7000);
  f.advance(5000);assert.equal(f.sent.length,1);
});

test('stale staged token never crosses a request change',()=>{
  const f=fixture();f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.advance(5000);
  f.actions=[{...f.actions[0],token:'turn-2',rqid:33,receivedAt:f.now,clock:{remainingMs:60000}}];f.supervisor.refresh('request');
  assert.throws(()=>f.supervisor.stage('turn-1',pair),/stale/);
  f.advance(15000);assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,0);
  f.advance(5000);assert.equal(f.forfeits.length,1);assert.equal(f.forfeits[0].action.rqid,33);
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
  f.advance(1000);assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,1);
});

test('complete fallback must be legal both when staged and at deadline',()=>{
  let legal=true;
  const f=fixture({validate:(_action,choices)=>{if(!legal)throw new Error('Replacement no longer legal');if(choices.length!==2)throw new Error('Incomplete pair');return choices;}});
  f.supervisor.configure(enable);assert.throws(()=>f.supervisor.stage('turn-1',pair.slice(0,1)),/Incomplete/);
  f.supervisor.stage('turn-1',pair);legal=false;f.advance(20000);
  assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,1);assert.equal(f.supervisor.status().halted,true);
});

test('unknown send is never retried and fresh actionable state gets bounded containment',()=>{
  let attempts=0;
  const f=fixture({submit:()=>{attempts++;throw new Error('Socket send unknown');}});
  f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.advance(20000);
  assert.equal(attempts,1);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().halted,true);
  f.advance(4999);assert.equal(f.forfeits.length,0);f.advance(1);assert.equal(f.forfeits.length,1);f.advance(100000);assert.equal(attempts,1);assert.equal(f.forfeits.length,1);
});

test('an uncertain send followed by request advancement is never forfeited',()=>{
  let attempts=0,f;
  f=fixture({submit:()=>{attempts++;throw new Error('Unknown send');}});
  f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.advance(20000);
  f.actions=[];f.supervisor.refresh('server-advanced');f.advance(10000);
  assert.equal(attempts,1);assert.equal(f.forfeits.length,0);assert.equal(f.supervisor.status().halted,true);
});

test('local send return without reservation or advancement cannot suppress containment',()=>{
  let attempts=0;
  const f=fixture({submit:()=>{attempts++;}});
  f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.advance(25000);
  assert.equal(attempts,1);assert.equal(f.forfeits.length,1);assert.equal(f.supervisor.status().halted,true);
});

test('reserved manual send remains watched without permitting another choice',()=>{
  const f=fixture();f.supervisor.configure(enable);f.advance(5000);
  f.actions[0].actionable=false;f.actions[0].submissionStatus='sent';f.supervisor.refresh('manual-send-reserved');
  assert.throws(()=>f.supervisor.stage('turn-1',pair),/already attempted/);
  f.advance(5000);assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,1);
  assert.equal(f.forfeits[0].reason,'submission-not-confirmed');
});

test('fallback whose send reservation hides choices still gets containment without acknowledgment',()=>{
  let f,attempts=0;
  f=fixture({submit:()=>{attempts++;f.actions[0].actionable=false;f.actions[0].submissionStatus='sent';}});
  f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.advance(20000);
  assert.equal(attempts,1);assert.equal(f.forfeits.length,0);
  f.advance(5000);assert.equal(f.forfeits.length,1);assert.equal(attempts,1);
});

test('uncertain manual send is contained even though its sender reserved the action',()=>{
  const f=fixture();f.supervisor.configure(enable);f.advance(1000);
  f.actions[0].actionable=false;f.actions[0].submissionStatus='uncertain';f.supervisor.refresh('socket-throw');
  assert.equal(f.supervisor.status().halted,true);f.advance(5000);
  assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,1);
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

test('pending send acknowledgment grace shortens for fresh turn or bank evidence',()=>{
  const f=fixture();f.supervisor.configure(enable);f.advance(1000);
  f.actions[0].actionable=false;f.actions[0].submissionStatus='sent';f.supervisor.refresh('send');
  assert.equal(f.supervisor.status().pending[0].containmentAt,7000);
  f.advance(1000);f.actions[0].clock={deadlineAt:6000,bankDeadlineAt:5500};f.supervisor.refresh('short-bank');
  assert.equal(f.supervisor.status().pending[0].containmentAt,4500);
  f.actions[0].clock={deadlineAt:99999};f.supervisor.refresh('longer-clock');
  assert.equal(f.supervisor.status().pending[0].containmentAt,4500);
  f.advance(1499);assert.equal(f.forfeits.length,0);f.advance(1);assert.equal(f.forfeits.length,1);
});

test('repeated pending reads never extend the acknowledgment grace',()=>{
  const f=fixture();f.supervisor.configure(enable);f.advance(1000);
  f.actions[0].actionable=false;f.actions[0].submissionStatus='sent';f.supervisor.refresh('send');
  f.advance(3000);f.supervisor.refresh('status-read');assert.equal(f.supervisor.status().pending[0].containmentAt,7000);
  f.advance(2000);assert.equal(f.forfeits.length,1);
});

test('unknown forfeit is reserved once even across explicit reset',()=>{
  let attempts=0;
  const f=fixture({forfeit:()=>{attempts++;throw new Error('Socket send unknown');}});
  f.supervisor.configure(enable);f.advance(20000);f.supervisor.configure(enable);f.advance(20000);
  assert.equal(attempts,1);assert(f.traces.some(event=>event.state==='forfeit-uncertain'&&event.retried===false));
});

test('missing parent authority halts without forfeiting an arbitrary room',()=>{
  const f=fixture();delete f.actions[0].parentId;f.supervisor.configure(enable);f.advance(20000);
  assert.equal(f.forfeits.length,0);assert(f.traces.some(event=>event.state==='containment-owner-unavailable'));
});

test('new switch request after the last reported failure never inherits the turn plan',()=>{
  const f=fixture();f.actions[0].rqid=31;f.actions[0].clock={remainingMs:1900};
  f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);
  f.actions=[{...f.actions[0],token:'switch-33',kind:'switch',rqid:33,revision:2,clock:{remainingMs:10000}}];
  f.supervisor.refresh('forced-replacement');f.advance(5000);
  assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,1);assert.equal(f.forfeits[0].action.rqid,33);
});

test('dispose clears timers and a diagnostic hook failure cannot interfere',()=>{
  const f=fixture({onTrace:()=>{throw new Error('Logger unavailable');}});
  f.supervisor.configure(enable);f.supervisor.stage('turn-1',pair);f.supervisor.dispose();f.advance(100000);
  assert.equal(f.sent.length,0);assert.equal(f.forfeits.length,0);assert.equal(f.timers.size,0);
  assert.throws(()=>f.supervisor.configure(enable),/disposed/);
});
