import test from 'node:test';
import assert from 'node:assert/strict';
import {playNext,startNext,waitForNext} from './action-next.mjs';

const room='battle-gen9championsvgc2026regmcbo3-101',parent='game-bestof3-gen9championsvgc2026regmcbo3-100';
const action=(rqid=9,kind='turn')=>({room,parentId:parent,rqid,kind,token:`token-${rqid}`,actionable:true});
const board=(a,extra={})=>({connected:true,authenticated:true,revision:a?.rqid??10,actions:a?[a]:[],boards:[{room,turn:3,requestAgeMs:2}],...extra});
const choice={id:'authored-9',room,rqid:9,token:'token-9',actions:[{type:'move',slot:4},{type:'move',slot:3,target:2}]};
const replacement=board({...action(11,'switch'),legalActions:{forceSwitch:[true,false],replacementPairs:[[{type:'switch',pokemonId:'stable-reserve'},{type:'pass'}]]}});

test('exact missed-turn to forced-replacement recovery needs no extra tool round trip or stale resend',async()=>{
  const calls=[],observed=[];
  const result=await playNext({q:choice,observed:board(action()),observe:value=>observed.push(value),call:async(name,args)=>{
    calls.push({name,args});
    return {ok:false,error:'Fallback token is stale or unavailable',recovery:{operation:'stage-fallback',outcome:'submission-reserved',retry:false,rebind:false,requiresNewDecision:true,state:replacement}};
  }});
  assert.deepEqual(calls.map(c=>c.name),['battle_stage_fallback']);
  assert.equal(result.next.state.actions[0].rqid,11);
  assert.equal(result.next.state.actions[0].kind,'switch');
  assert.equal(result.recovery.retry,false);assert.equal(result.recovery.rebind,false);
  assert.equal(observed[0],replacement);
});

test('ordinary pair is staged before any observation, then sent immediately and new request returned',async()=>{
  const calls=[];
  const result=await playNext({q:choice,observed:board(action()),call:async(name,args)=>{
    calls.push({name,args});
    if(name==='battle_stage_fallback')return {ok:true,result:{pending:[]}};
    if(name==='battle_choose')return {ok:true,result:{status:'sent-not-acknowledged'}};
    if(name==='battle_turn_status')return {ok:true,result:replacement};
    throw Error('No wait needed');
  }});
  assert.deepEqual(calls.map(c=>c.name),['battle_stage_fallback','battle_choose','battle_turn_status']);
  assert.deepEqual(calls[0].args.actions,choice.actions);assert.deepEqual(calls[1].args.actions,choice.actions);
  assert.equal(calls[0].args.token,'token-9');assert.equal(result.next.reason,'fresh-action');
  assert.equal(result.timing.modelDeliveredAt,null);
});

test('request changing between stage and choose returns new state without rebinding actions',async()=>{
  const calls=[];
  const result=await playNext({q:choice,observed:board(action()),call:async(name,args)=>{
    calls.push({name,args});
    if(name==='battle_stage_fallback')return {ok:true,result:{pending:[]}};
    return {ok:false,error:'stale',recovery:{outcome:'not-sent',state:replacement,retry:false,rebind:false}};
  }});
  assert.equal(calls.length,2);assert(calls.every(c=>c.args.token==='token-9'));
  assert.equal(result.next.state.actions[0].token,'token-11');assert.equal(result.recovery.retry,false);
});

test('watchdog winning a staged reservation prevents a second ordinary choice',async()=>{
  const calls=[];
  const result=await playNext({q:choice,observed:board(action()),call:async(name)=>{
    calls.push(name);
    if(name==='battle_stage_fallback')return {result:{pending:[{token:'token-9',attempted:true,source:'staged-fallback'}]}};
    return replacement;
  }});
  assert.deepEqual(calls,['battle_stage_fallback','battle_turn_status']);
  assert.match(result.ordinarySendSkipped,/preserve reservation/);
});

test('unknown socket/SDK failure after choose never causes another stage, choose or forfeit',async()=>{
  const calls=[],reserved=board(null,{choices:[{room,rqid:9,status:'uncertain'}]});
  const result=await playNext({q:choice,observed:board(action()),call:async(name)=>{
    calls.push(name);
    if(name==='battle_stage_fallback')return {result:{pending:[]}};
    if(name==='battle_choose')throw Error('synthetic transport failure after reserved write');
    return reserved;
  }});
  assert.deepEqual(calls,['battle_stage_fallback','battle_choose','battle_turn_status']);
  assert.equal(result.recovery.outcome,'mutation-uncertain');assert.equal(result.recovery.retry,false);
  assert.equal(result.next.state.choices[0].status,'uncertain');
});

test('bounded hung staging remains uncertain and does not make an ordinary send',async()=>{
  const calls=[],began=Date.now();
  const result=await playNext({q:choice,observed:board(action()),mutationTimeoutMs:20,budgetMs:100,call:async(name)=>{
    calls.push(name);if(name==='battle_stage_fallback')return new Promise(()=>{});return replacement;
  }});
  assert(Date.now()-began<1000);assert.deepEqual(calls,['battle_stage_fallback','battle_turn_status']);
  assert.equal(result.next.reason,'mutation-uncertain');
});

test('old bare rejection gets exactly one bounded compact read, no replay',async()=>{
  const calls=[];
  const result=await playNext({q:choice,observed:board(action()),call:async name=>{
    calls.push(name);return name==='battle_stage_fallback'?{ok:false,error:'old client rejection'}:replacement;
  }});
  assert.deepEqual(calls,['battle_stage_fallback','battle_turn_status']);assert.equal(result.next.state.actions[0].rqid,11);
  assert.equal(result.recovery.outcome,'rejection-unclassified');
});

test('legacy choose error with unavailable resync never establishes not-sent',async()=>{
  const calls=[];
  const result=await playNext({q:choice,observed:board(action()),call:async name=>{
    calls.push(name);
    if(name==='battle_stage_fallback')return {pending:[]};
    if(name==='battle_choose')return {ok:false,error:'legacy flattened write failure'};
    throw Error('resync unavailable');
  }});
  assert.deepEqual(calls,['battle_stage_fallback','battle_choose','battle_turn_status']);
  assert.equal(result.recovery.outcome,'rejection-unclassified');
  assert.equal(result.recovery.state,null);assert.equal(result.recovery.retry,false);
});

test('cached reserved or mismatched action is never rebound by a preliminary status read',async()=>{
  const calls=[];
  const result=await playNext({q:choice,observed:board({...action(),submissionStatus:'uncertain'}),call:async name=>{calls.push(name);return replacement;}});
  assert.deepEqual(calls,['battle_turn_status']);assert.equal(result.next.reason,'action-rejected');
  assert.equal(result.recovery.rebind,false);
});

test('compact wait returns replacement immediately without converting through full status',async()=>{
  const calls=[];
  const result=await waitForNext({initial:board(null),origin:action(),call:async(name,args)=>{
    calls.push({name,args});return replacement;
  }});
  assert.equal(result.reason,'fresh-action');assert.equal(calls.length,1);assert.equal(calls[0].name,'battle_wait');
  assert.equal(calls[0].args.format,'compact');
});

test('hung read-only wait obeys one absolute budget and does not issue any mutation',async()=>{
  const calls=[],began=Date.now();
  const result=await waitForNext({initial:board(null),budgetMs:30,call:async name=>{calls.push(name);return new Promise(()=>{});}});
  assert(Date.now()-began<1000);assert.equal(result.reason,'read-unavailable');assert.deepEqual(calls,['battle_wait']);
});

test('transport budget is not restarted after stage, ordinary send or status rendering',async()=>{
  let time=1000;const calls=[];
  await playNext({q:choice,observed:board(action()),now:()=>time,budgetMs:5000,call:async(name,args,options)=>{
    calls.push({name,args,timeoutMs:options.timeoutMs});time+=1000;
    if(name==='battle_stage_fallback')return {pending:[]};
    if(name==='battle_choose')return {status:'sent-not-acknowledged'};
    return board(null);
  }});
  assert.equal(calls[3].name,'battle_wait');assert.equal(calls[3].args.timeoutMs,1900);assert.equal(calls[3].timeoutMs,2000);
});

test('short remaining wait budget permits a zero server wait while retaining the original transport deadline',async()=>{
  const calls=[],state=board(null);
  const result=await waitForNext({initial:state,now:()=>1000,budgetMs:50,call:async(name,args,options)=>{
    calls.push({name,args,timeoutMs:options.timeoutMs});return state;
  }});
  assert.equal(result.reason,'bounded-wait-ended');assert.equal(calls.length,1);
  assert.equal(calls[0].name,'battle_wait');assert.equal(calls[0].args.timeoutMs,0);assert.equal(calls[0].timeoutMs,50);
});

test('unchanged wait revision exits rather than hot-polling',async()=>{
  let calls=0;const state=board(null);
  const result=await waitForNext({initial:state,call:async()=>{calls++;return state;}});
  assert.equal(calls,1);assert.equal(result.reason,'bounded-wait-ended');
});

test('opt-in post-send wait catches a request after the old boundary without another model read or mutation',async()=>{
  for(const extended of [false,true]){
    let time=1000,waits=0;const calls=[];
    const result=await playNext({q:{...choice,...(extended?{postSendWaitMs:55000}:{})},observed:board(action()),now:()=>time,call:async(name,args,options)=>{
      calls.push({name,timeout:options.timeoutMs});
      if(name==='battle_stage_fallback'||name==='battle_choose'){time++;return {pending:[]};}
      if(name==='battle_turn_status')return board(null);
      if(++waits===1){time+=19900;return board(null);}
      time+=4000;return replacement;
    }});
    assert.equal(result.next.reason,extended?'fresh-action':'bounded-wait-ended');
    assert.equal(waits,extended?2:1);
    assert.deepEqual(calls.filter(x=>/stage|choose/.test(x.name)).map(x=>x.name),['battle_stage_fallback','battle_choose']);
    assert(calls.slice(0,2).every(x=>x.timeout<=5000));
    assert(calls.slice(2).every(x=>x.timeout<=20000));
  }
});

test('post-send option returns fresh requests and terminal results immediately, with an absolute cap and no idle spin',async()=>{
  for(const mode of ['fresh','terminal','idle','immediate-unchanged','reserved']){
    let time=1000,waits=0;const calls=[];
    const result=await playNext({q:{...choice,postSendWaitMs:55000},observed:board(action()),now:()=>time,call:async(name,args,options)=>{
      calls.push(name);
      if(name==='battle_stage_fallback'||name==='battle_choose'){time++;return {pending:mode==='reserved'?[{token:choice.token,attempted:true}]:[]};}
      if(name==='battle_turn_status'){
        if(mode==='fresh'||mode==='reserved')return replacement;
        if(mode==='terminal')return board(null,{rooms:[{id:parent,ended:true,result:{type:'win'}}],search:{searching:[],games:null}});
        return board(null);
      }
      waits++;
      if(mode==='idle')time+=options.timeoutMs;
      return board(null);
    }});
    assert(time-1000<=55000);
    if(mode==='fresh'||mode==='reserved'){assert.equal(result.next.reason,'fresh-action');assert.equal(waits,0);}
    if(mode==='terminal'){assert.equal(result.next.reason,'official-parent-ended-and-idle');assert.equal(waits,0);}
    if(mode==='idle'){assert.equal(result.next.reason,'bounded-wait-ended');assert.equal(time-1000,55000);assert.equal(waits,3);}
    if(mode==='immediate-unchanged'){assert.equal(waits,1);assert.equal(result.next.reason,'bounded-wait-ended');}
    assert.equal(calls.filter(x=>x==='battle_choose').length,mode==='reserved'?0:1);
  }
});

test('post-send window cannot extend uncertain or rejected mutations and rejects invalid values before I/O',async()=>{
  for(const mode of ['uncertain','rejected']){
    let time=1000;const calls=[];
    const result=await playNext({q:{...choice,postSendWaitMs:55000},observed:board(action()),now:()=>time,budgetMs:100,call:async name=>{
      calls.push(name);
      if(name==='battle_stage_fallback')return {pending:[]};
      if(name==='battle_choose'){time+=100;if(mode==='uncertain')throw Error('uncertain');return {ok:false,error:'rejected'};}
      throw Error('No extended read permitted');
    }});
    assert.deepEqual(calls,['battle_stage_fallback','battle_choose']);
    assert.equal(result.recovery.retry,false);
  }
  for(const postSendWaitMs of [0,19999,55001,Infinity,1.5])await assert.rejects(playNext({q:{...choice,postSendWaitMs},observed:board(action()),call:async()=>{throw Error('No I/O');}}),/postSendWaitMs/);
});

test('a legacy full snapshot gets only one compact conversion attempt',async()=>{
  const {boards,...full}=replacement;const calls=[];
  const result=await waitForNext({initial:full,call:async name=>{calls.push(name);return full;}});
  assert.deepEqual(calls,['battle_turn_status']);assert.equal(result.reason,'compact-view-unavailable');
});

test('exhausted staging budget prevents choose and any recovery read',async()=>{
  let time=1000;const calls=[];
  const result=await playNext({q:choice,observed:board(action()),now:()=>time,budgetMs:10,call:async name=>{
    calls.push(name);time+=10;return {pending:[]};
  }});
  assert.deepEqual(calls,['battle_stage_fallback']);assert.equal(result.recovery.outcome,'staged-only');
  assert.equal(result.recovery.state,null);
});

test('a failure at the original deadline cannot start a separate recovery budget',async()=>{
  let time=1000;const calls=[];
  const result=await playNext({q:choice,observed:board(action()),now:()=>time,budgetMs:10,call:async name=>{
    calls.push(name);time+=10;throw Error('uncertain');
  }});
  assert.deepEqual(calls,['battle_stage_fallback']);assert.equal(result.recovery.outcome,'mutation-uncertain');
  assert.equal(result.recovery.state,null);
});

test('recovery read uses only the original remaining budget',async()=>{
  let time=1000;const calls=[];
  await playNext({q:choice,observed:board(action()),now:()=>time,budgetMs:10,call:async(name,args,options)=>{
    calls.push({name,timeoutMs:options.timeoutMs});
    if(name==='battle_stage_fallback'){time+=7;return {ok:false,error:'legacy rejection'};}
    return replacement;
  }});
  assert.equal(calls[1].name,'battle_turn_status');assert.equal(calls[1].timeoutMs,3);
});

test('slow search pre-read cannot dispatch a search after its original budget',async()=>{
  let time=1000;const calls=[];
  const result=await startNext({q:{id:'budget-search',confirmed:true},now:()=>time,budgetMs:10,call:async name=>{
    calls.push(name);time+=10;return {rooms:[]};
  }});
  assert.deepEqual(calls,['battle_status']);assert.equal(result.recovery.outcome,'not-sent');
});

test('official parent plus server idle remains visible in compact output',async()=>{
  const state=board(null,{rooms:[{id:parent,ended:true,result:{type:'win',winner:'Fixture'}}],search:{searching:[],games:null}});
  const result=await waitForNext({initial:state,parentId:parent,call:async()=>{throw Error('No query required');}});
  assert.equal(result.reason,'official-parent-ended-and-idle');assert.equal(result.parentId,parent);
});

test('search send uncertainty does not authorize a retry',async()=>{
  const calls=[];
  const result=await startNext({q:{id:'explicit-search',confirmed:true},call:async name=>{
    calls.push(name);if(name==='battle_status')return {rooms:[]};if(name==='battle_start')throw Error('uncertain');return board(null);
  }});
  assert.deepEqual(calls,['battle_status','battle_start','battle_turn_status']);assert.equal(result.recovery.retry,false);
});

test('invalid authored command fails before contacting the server',async()=>{
  await assert.rejects(playNext({q:{...choice,id:'contains:invalid'},observed:board(action()),call:async()=>{throw Error('No call');}}),/command ID/);
});
