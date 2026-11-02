import test from 'node:test';
import assert from 'node:assert/strict';
import {playNext,startNext,waitForNext} from './action-next.mjs';

const room='battle-gen9championsvgc2026regmcbo3-101',parent='game-bestof3-gen9championsvgc2026regmcbo3-100';
const action=(rqid=9,kind='turn')=>({room,parentId:parent,rqid,kind,token:`token-${rqid}`,actionable:true});
const board=(a,extra={})=>({connected:true,authenticated:true,revision:a?.rqid??10,actions:a?[a]:[],boards:[{room,turn:3,requestAgeMs:2}],...extra});
const choice={id:'authored-9',room,rqid:9,token:'token-9',actions:[{type:'move',slot:4},{type:'move',slot:3,target:2}]};
const replacement=board({...action(11,'switch'),legalActions:{forceSwitch:[true,false],replacementPairs:[[{type:'switch',pokemonId:'stable-reserve'},{type:'pass'}]]}});

test('trusted post-send handoff uses the existing first read and releases actual opponent waiting time without another call',async()=>{
  const calls=[],current=board(null,{stopped:false,rooms:[{id:room,parentId:parent,ended:false}],choices:[{room,rqid:9,status:'sent',evidence:[]}]});
  const result=await playNext({q:choice,observed:board(action()),returnAfterSend:true,call:async(name,args)=>{
    calls.push(name);
    if(name==='battle_stage_fallback')return {pending:[{token:choice.token,hasFallback:true,fallbackSource:'fallback',attempted:false}]};
    if(name==='battle_choose')return {status:'sent-not-acknowledged'};
    assert.equal(name,'battle_turn_status');return current;
  }});
  assert.deepEqual(calls,['battle_stage_fallback','battle_choose','battle_turn_status']);
  assert.equal(result.next.reason,'committed-opponent-wait');assert.equal(result.next.serverAcceptance,false);assert.equal(result.next.choiceAuthority,false);
});

test('post-send handoff never mistakes execution, uncertainty, missing identity or ordinary legacy waiting for committed idle',async()=>{
  const original=()=>board(null,{stopped:false,rooms:[{id:room,parentId:parent,ended:false}],choices:[{room,rqid:9,status:'sent',evidence:[]}]});
  for(const mutate of [s=>s.choices[0].status='uncertain',s=>s.choices[0].uncertain=true,s=>s.choices[0].executionObserved=true,s=>s.choices[0].boundary='next-turn',s=>s.choices[0].evidence.push({type:'move'}),s=>delete s.choices[0].evidence,s=>s.choices[0].rqid++,s=>s.choices[0].room+='0',s=>s.choices.push({...s.choices[0]}),s=>s.connected=false,s=>s.rooms[0].ended=true]){
    const current=original();mutate(current);let reads=0;
    const result=await waitForNext({origin:action(),parentId:parent,initial:current,returnOnCommitted:true,call:async name=>{reads++;assert.equal(name,'battle_wait');return board(action(10),{stopped:false});}});
    if(current.connected===false){assert.equal(result.reason,'disconnected-or-stopped');assert.equal(reads,0);}
    else{assert.equal(result.reason,'fresh-action');assert.equal(reads,1);}
  }
  let reads=0;const legacy=await waitForNext({origin:action(),parentId:parent,initial:original(),call:async()=>{reads++;return board(action(10),{stopped:false});}});
  assert.equal(legacy.reason,'fresh-action');assert.equal(reads,1);
});

const betweenChildren=()=>board(null,{boards:[],autoReady:true,rooms:[
  {id:parent,parentId:parent,ended:false,result:null},
  {id:room,parentId:parent,ended:true,result:{type:'win',winner:'opponent'}},
]});

test('known unsent terminal-child race observes the next preview without a model reentry or another mutation',async()=>{
  let time=1000;
  const calls=[],observed=[],gap=betweenChildren();
  const preview=board({...action(2,'preview'),room:'battle-gen9championsvgc2026regmcbo3-102',token:'next-preview'},
    {revision:gap.revision+1});
  const result=await playNext({q:{...choice,postSendWaitMs:55000},observed:board(action()),now:()=>time,
    observe:value=>observed.push(value),call:async(name,args,options)=>{
      calls.push({name,args,timeoutMs:options.timeoutMs});
      if(name==='battle_stage_fallback')return {ok:false,error:'stale after terminal',recovery:{outcome:'not-sent',retry:false,rebind:false,requiresNewDecision:true,state:gap}};
      assert.equal(name,'battle_wait');time+=594;return preview;
    }});
  assert.deepEqual(calls.map(c=>c.name),['battle_stage_fallback','battle_wait']);
  assert.equal(result.recovery.outcome,'not-sent');
  assert.equal(result.recovery.retry,false);assert.equal(result.recovery.rebind,false);
  assert.equal(result.recovery.state,gap);assert.match(result.error,/stale/);
  assert.equal(result.next.reason,'fresh-action');
  assert.equal(result.next.state.actions[0].token,'next-preview');
  assert.equal(result.next.afterKnownNotSentChildTransition,true);
  assert(observed.includes(preview));
  assert(calls[1].timeoutMs<=20000);
});

test('terminal-child observation keeps the original rejection deadline rather than the longer post-send budget',async()=>{
  let time=1000;
  const calls=[],gap=betweenChildren();
  const result=await playNext({q:{...choice,postSendWaitMs:55000},observed:board(action()),now:()=>time,
    call:async(name,args,options)=>{
      calls.push({name,args,timeoutMs:options.timeoutMs});
      if(name==='battle_stage_fallback') {time+=4000;return {ok:false,recovery:{outcome:'not-sent',state:gap}};}
      time+=options.timeoutMs;return gap;
    }});
  assert.equal(result.next.reason,'bounded-wait-ended');
  assert.equal(time,21000);
  assert.equal(calls[1].timeoutMs,16000);
  assert.deepEqual(calls.map(c=>c.name),['battle_stage_fallback','battle_wait']);
});

test('known terminal-child observation returns an official parent ending and idle without choosing again',async()=>{
  const calls=[],gap=betweenChildren();
  const ended={...gap,revision:11,search:{searching:[],games:null},rooms:gap.rooms.map(r=>r.id===parent?{...r,ended:true,result:{type:'win',winner:'opponent'}}:r)};
  const result=await playNext({q:{...choice,postSendWaitMs:55000},observed:board(action()),call:async name=>{
    calls.push(name);return name==='battle_stage_fallback'?{ok:false,recovery:{outcome:'not-sent',state:gap}}:ended;
  }});
  assert.deepEqual(calls,['battle_stage_fallback','battle_wait']);
  assert.equal(result.next.reason,'official-parent-ended-and-idle');
  assert.equal(result.recovery.outcome,'not-sent');
});

test('terminal-transition continuation does not broaden uncertain, reserved, live, unmatched, ready or unopted recovery',async()=>{
  const cases=[
    {name:'no opt in',q:choice,state:betweenChildren(),outcome:'not-sent'},
    {name:'reserved',state:betweenChildren(),outcome:'submission-reserved'},
    {name:'unclassified',state:betweenChildren(),outcome:'rejection-unclassified'},
    {name:'uncertain',state:betweenChildren(),outcome:'mutation-uncertain'},
    {name:'live child',state:{...betweenChildren(),rooms:betweenChildren().rooms.map(r=>({...r,ended:false}))},outcome:'not-sent'},
    {name:'unknown child',state:{...betweenChildren(),rooms:[{id:parent,ended:false}]},outcome:'not-sent'},
    {name:'ended parent',state:{...betweenChildren(),rooms:betweenChildren().rooms.map(r=>({...r,ended:true}))},outcome:'not-sent'},
    {name:'ready decision',state:{...betweenChildren(),actions:[action(12,'ready')]},outcome:'not-sent'},
    {name:'disconnected',state:{...betweenChildren(),connected:false},outcome:'not-sent'},
  ];
  for(const example of cases) {
    const calls=[];
    const result=await playNext({q:example.q??{...choice,postSendWaitMs:55000},observed:board(action()),call:async name=>{
      calls.push(name);return {ok:false,recovery:{outcome:example.outcome,state:example.state}};
    }});
    assert.deepEqual(calls,['battle_stage_fallback'],example.name);
    assert.equal(result.recovery.outcome,example.outcome,example.name);
    assert.equal(result.next.afterKnownNotSentChildTransition,undefined,example.name);
  }
});

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

// Anonymized shape of a retained terminal wait: several owned completed BO3s
// and children remain in the same compact session snapshot between searches.
const historyParent='game-bestof3-gen9championsvgc2026regmcbo3-084';
const historyChild='battle-gen9championsvgc2026regmcbo3-085';
const endedHistory=()=>board(null,{revision:411,autoReady:true,boards:[],awaitingSet:false,searchPending:false,switchingTeam:false,
  controlPolicy:{pending:[]},search:{searching:[],games:null},rooms:[
    {id:historyParent,parentId:historyParent,ended:true,result:{type:'win',winner:'Fixture A'}},
    {id:historyChild,parentId:historyParent,ended:true,result:{type:'win',winner:'Fixture A'}},
    {id:parent,parentId:parent,ended:true,result:{type:'win',winner:'Fixture B'}},
    {id:room,parentId:parent,ended:true,result:{type:'win',winner:'Fixture B'}},
  ]});

test('terminal scope leaves multiple completed owned parents ambiguous instead of selecting historical array order',async()=>{
  for(const reverse of [false,true]) {
    const state=endedHistory();if(reverse)state.rooms.reverse();
    const result=await waitForNext({initial:state,call:async()=>{throw Error('No query needed');}});
    assert.equal(result.reason,'server-idle');assert.equal(result.officialParentEnded,false);assert.equal(result.parentId,undefined);
  }
});

test('terminal scope resolves the exact authored origin through parent, child metadata and readiness room',async()=>{
  for(const origin of [action(),{room,rqid:9,token:'previous-token'},{room:parent,kind:'ready',rqid:0}]) {
    const result=await waitForNext({initial:endedHistory(),origin,call:async()=>{throw Error('No query needed');}});
    assert.equal(result.reason,'official-parent-ended-and-idle');assert.equal(result.parentId,parent);
  }
});

test('terminal scope preserves explicit and single-parent results while an unmatched scope never selects another parent',async()=>{
  const state=endedHistory(),noCall=async()=>{throw Error('No query needed');};
  for(const selected of [historyParent,parent]) {
    const result=await waitForNext({initial:state,parentId:selected,call:noCall});
    assert.equal(result.reason,'official-parent-ended-and-idle');assert.equal(result.parentId,selected);
  }
  const unmatched=await waitForNext({initial:state,parentId:parent+'9',call:noCall});
  assert.equal(unmatched.reason,'server-idle');assert.equal(unmatched.officialParentEnded,false);assert.equal(unmatched.parentId,undefined);
  const single={...state,rooms:state.rooms.filter(value=>value.id===parent||value.parentId===parent)};
  assert.equal((await waitForNext({initial:single,call:noCall})).parentId,parent);
  single.rooms[0]={...single.rooms[0],result:null};
  assert.equal((await waitForNext({initial:single,call:noCall})).officialParentEnded,false);
});

test('terminal scope gives live owned parents priority over ended history during transient server idle',async()=>{
  for(const options of [{},{origin:{room:historyChild,parentId:historyParent,rqid:1}},{parentId:historyParent}]) {
    let time=1000,calls=0;const state=endedHistory();
    Object.assign(state.rooms.find(value=>value.id===parent),{ended:false,result:null});
    const result=await waitForNext({initial:state,...options,budgetMs:10,now:()=>time,call:async name=>{
      assert.equal(name,'battle_wait');calls++;time+=10;return state;
    }});
    assert.equal(result.reason,'bounded-wait-ended');assert.equal(result.parentId,undefined);assert.equal(calls,1);
  }
});

test('terminal scope never chooses an arbitrary parent from multiple live owned sets',async()=>{
  const state=endedHistory();state.rooms=state.rooms.map(value=>({...value,ended:false,result:null}));
  const calls=[];
  const result=await waitForNext({initial:state,call:async name=>{calls.push(name);return state;}});
  assert.deepEqual(calls,['battle_wait']);assert.equal(result.reason,'bounded-wait-ended');assert.equal(result.parentId,undefined);
});

test('terminal scope explicit parent returns only a matching fresh request and preserves canonical private aliases',async()=>{
  for(const mode of ['different-parent','unknown-parent','matching-private-alias']) {
    let time=1000;const calls=[],state=endedHistory(),privateParent=parent+'-fixturepw';
    Object.assign(state.rooms.find(value=>value.id===parent),{ended:false,result:null});
    const current=mode==='matching-private-alias'?{...action(12),parentId:privateParent}:
      mode==='different-parent'?{...action(12),room:historyChild,parentId:historyParent}:
      {...action(12),room:'battle-unmapped-fixture',parentId:undefined};
    if(mode==='matching-private-alias') {
      state.rooms=state.rooms.map(value=>({...value,...(value.id===parent?{id:privateParent}:{}),
        ...(value.parentId===parent?{parentId:privateParent}:{})}));
    } else if(mode==='different-parent')Object.assign(state.rooms.find(value=>value.id===historyParent),{ended:false,result:null});
    state.actions=[current];state.boards=[{room:current.room,parentId:current.parentId,request:{rqid:12}}];
    const result=await waitForNext({initial:state,parentId:parent,budgetMs:10,now:()=>time,call:async name=>{
      calls.push(name);time+=10;return state;
    }});
    assert.equal(result.reason,mode==='matching-private-alias'?'fresh-action':'bounded-wait-ended',mode);
    assert.deepEqual(calls,mode==='matching-private-alias'?[]:['battle_wait'],mode);
  }
});

test('terminal scope remembers a uniquely observed live parent when its official ending arrives',async()=>{
  const state=endedHistory();Object.assign(state.rooms.find(value=>value.id===parent),{ended:false,result:null});
  const ended=endedHistory();ended.revision++;
  const calls=[];
  const result=await waitForNext({initial:state,call:async name=>{calls.push(name);return ended;}});
  assert.deepEqual(calls,['battle_wait']);assert.equal(result.reason,'official-parent-ended-and-idle');assert.equal(result.parentId,parent);
});

test('terminal scope respects prior search exclusions across a known canonical private-room alias',async()=>{
  const state=endedHistory(),privateParent=historyParent+'-fixturepw';
  state.rooms[0]={...state.rooms[0],id:privateParent,parentId:privateParent};
  state.rooms[1]={...state.rooms[1],parentId:privateParent};
  const noCall=async()=>{throw Error('No query needed');};
  const result=await waitForNext({initial:state,priorParentIds:[historyParent],call:noCall});
  assert.equal(result.reason,'official-parent-ended-and-idle');assert.equal(result.parentId,parent);
  const exact=await waitForNext({initial:state,parentId:historyParent,call:noCall});
  assert.equal(exact.reason,'official-parent-ended-and-idle');assert.equal(exact.parentId,privateParent);
  const live=structuredClone(state);Object.assign(live.rooms[0],{ended:false,result:null});
  const excludedLive=await waitForNext({initial:live,priorParentIds:[historyParent],call:noCall});
  assert.equal(excludedLive.parentId,parent);
});

test('terminal scope preserves a fresh current request with old ended parents and an empty server game map',async()=>{
  const state=endedHistory();Object.assign(state.rooms.find(value=>value.id===parent),{ended:false,result:null});
  state.actions=[action(12)];state.boards=[{room,parentId:parent,request:{rqid:12}}];
  const result=await waitForNext({initial:state,origin:action(),call:async()=>{throw Error('Fresh request needs no query');}});
  assert.equal(result.reason,'fresh-action');assert.equal(result.state.actions[0].token,'token-12');
});

test('terminal scope prior-search exclusions suppress stale alias actions without consuming a second search',async()=>{
  const privateParent=historyParent+'-fixturepw',privateChild=historyChild+'-fixturepw',calls=[];
  const before=endedHistory();before.rooms=before.rooms.filter(value=>value.parentId===historyParent);
  const searching=board({room:privateChild,parentId:privateParent,kind:'preview',rqid:2,token:'old-alias-token'},
    {revision:20,boards:[],search:{searching:['fixture'],games:null},rooms:[
      {id:privateParent,parentId:privateParent,ended:false,result:null},
      {id:privateChild,parentId:privateParent,ended:false,result:null},
    ]});
  const preview=board(action(3,'preview'),{revision:21,rooms:[{id:parent,parentId:parent,ended:false}]});
  const result=await startNext({q:{id:'prior-alias-search',confirmed:true},call:async name=>{
    calls.push(name);
    if(name==='battle_status')return before;
    if(name==='battle_start')return {ok:true,result:{status:'sent-not-acknowledged'}};
    if(name==='battle_turn_status')return searching;
    assert.equal(name,'battle_wait');return preview;
  }});
  assert.deepEqual(calls,['battle_status','battle_start','battle_turn_status','battle_wait']);
  assert.equal(result.next.reason,'fresh-action');assert.equal(result.next.state.actions[0].token,'token-3');
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

test('opt-in start-next returns the preview arriving 21.887 s after search input in the same dispatch',async()=>{
  for(const extended of [false,true]) {
    const began=1792734065382;
    let time=began,waits=0;const calls=[];
    const searching=board(null,{revision:241,boards:[],autoReady:true,rooms:[],
      search:{searching:['gen9championsvgc2026regmcbo3'],games:null}});
    const preview=board(action(3,'preview'),{revision:242,boards:[{room,parentId:parent,requestAgeMs:0}],
      rooms:[{id:parent,parentId:parent,ended:false},{id:room,parentId:parent,ended:false}],
      search:{searching:[],games:{[parent]:'fixture set',[room]:'fixture battle'}}});
    const result=await startNext({q:{id:'observed-delayed-search',confirmed:true,...(extended?{postSendWaitMs:55000}:{})},
      now:()=>time,call:async(name,args,options)=>{
        calls.push({name,args,timeoutMs:options.timeoutMs});
        if(name==='battle_status')return {ok:true,result:{...searching,search:{searching:[],games:null}}};
        if(name==='battle_start'){time+=6;return {id:'observed-delayed-search',ok:true,result:{status:'sent-not-acknowledged',searchesSent:2,authorizedSets:6}};}
        if(name==='battle_turn_status')return {ok:true,result:searching};
        assert.equal(name,'battle_wait');
        if(++waits===1){time=began+19904;return {ok:true,result:searching};}
        time=began+21887;return {ok:true,result:preview};
      }});
    assert.equal(result.next.reason,extended?'fresh-action':'bounded-wait-ended');
    assert.equal(waits,extended?2:1);
    if(extended){assert.equal(time-began,21887);assert.equal(result.next.state.result.boards[0].requestAgeMs,0);}
    assert.equal(calls.filter(c=>c.name==='battle_start').length,1);
    assert(calls.every(c=>c.timeoutMs<=20000));
    assert.equal(calls.find(c=>c.name==='battle_start').timeoutMs,5000);
  }
});

test('start-next larger wait returns immediate previews and excludes prior-parent or reserved actions',async()=>{
  for(const mode of ['immediate','prior-parent','prior-child-metadata','prior-parent-room','reserved','sent','unactionable','opponent-board-only']) {
    let time=1000,waits=0;const calls=[];
    const previous='game-bestof3-gen9championsvgc2026regmcbo3-099';
    const searching=board(null,{revision:1,boards:[],search:{searching:['fixture'],games:null},
      rooms:[{id:previous,ended:true,result:{type:'win'}}]});
    const preview=board(action(2,'preview'),{rooms:[...searching.rooms,{id:parent,ended:false},{id:room,parentId:parent,ended:false}]});
    const oldRoom='battle-gen9championsvgc2026regmcbo3-098';
    const distractor=mode==='prior-parent'?{...action(1,'preview'),parentId:previous}:
      mode==='prior-child-metadata'?{...action(1,'preview'),room:oldRoom,parentId:undefined}:
      mode==='prior-parent-room'?{...action(1,'ready'),room:previous,parentId:undefined}:
      {...action(1,'preview'),...(mode==='unactionable'?{actionable:false}:{submissionStatus:mode==='sent'?'sent':'uncertain'})};
    const result=await startNext({q:{id:'normal-search-'+mode,confirmed:true,postSendWaitMs:55000},now:()=>time,
      call:async(name,args,options)=>{
        calls.push({name,args,timeoutMs:options.timeoutMs});
        if(name==='battle_status')return {ok:true,result:searching};
        if(name==='battle_start')return {ok:true,result:{status:'sent-not-acknowledged'}};
        if(name==='battle_turn_status')return mode==='immediate'?preview:{...searching,
          rooms:[...searching.rooms,{id:oldRoom,parentId:previous,ended:true}],
          actions:mode==='opponent-board-only'?[]:[distractor],
          boards:mode==='opponent-board-only'?[{room:'battle-unrelated-observer',ownSide:null}]:[]};
        assert.equal(name,'battle_wait');waits++;time+=100;return preview;
      }});
    assert.equal(result.next.reason,'fresh-action',mode);
    assert.equal(result.next.state.actions[0].token,'token-2',mode);
    assert.equal(waits,mode==='immediate'?0:1,mode);
    assert.equal(calls.filter(c=>c.name==='battle_start').length,1,mode);
  }
});

test('start-next optional read window never extends refused or uncertain search recovery',async()=>{
  for(const mode of ['refused','uncertain','expired-uncertain']) {
    let time=1000;const calls=[];
    const result=await startNext({q:{id:'no-repeat-'+mode,confirmed:true,postSendWaitMs:55000},now:()=>time,
      call:async(name,args,options)=>{
        calls.push({name,args,timeoutMs:options.timeoutMs});
        if(name==='battle_status')return {ok:true,result:{rooms:[]}};
        if(name==='battle_start') {
          if(mode==='refused')return {ok:false,error:'search refused',recovery:{state:board(null)}};
          time+=mode==='expired-uncertain'?20000:19000;throw Error('search outcome unknown');
        }
        assert.equal(name,'battle_turn_status');return board(null);
      }});
    assert.equal(calls.filter(c=>c.name==='battle_start').length,1,mode);
    assert.equal(calls.filter(c=>c.name==='battle_wait').length,0,mode);
    if(mode==='refused')assert.equal(result.next.reason,'search-rejected');
    else {assert.equal(result.recovery.outcome,'mutation-uncertain');assert.equal(result.recovery.retry,false);}
    if(mode==='uncertain')assert.equal(calls.at(-1).timeoutMs,1000);
    if(mode==='expired-uncertain')assert.deepEqual(calls.map(c=>c.name),['battle_status','battle_start']);
  }
});

test('start-next opt-in wait retains one 55 s absolute read cap without hot polling or another search',async()=>{
  for(const mode of ['idle','immediate-unchanged','read-error']) {
    let time=1000,waits=0;const calls=[];
    const searching=board(null,{boards:[],search:{searching:['fixture'],games:null}});
    const result=await startNext({q:{id:'bounded-search-'+mode,confirmed:true,postSendWaitMs:55000},now:()=>time,
      call:async(name,args,options)=>{
        calls.push({name,timeoutMs:options.timeoutMs});
        if(name==='battle_status')return {rooms:[]};
        if(name==='battle_start')return {ok:true,result:{status:'sent-not-acknowledged'}};
        if(name==='battle_turn_status')return searching;
        waits++;
        if(mode==='read-error')throw Error('read unavailable');
        if(mode==='idle')time+=options.timeoutMs;
        return searching;
      }});
    assert.equal(result.next.reason,mode==='read-error'?'read-unavailable':'bounded-wait-ended');
    assert.equal(time-1000,mode==='idle'?55000:0);
    assert.equal(waits,mode==='idle'?3:1);
    assert.equal(calls.filter(c=>c.name==='battle_start').length,1);
    assert(calls.every(c=>c.timeoutMs<=20000));
  }
});

test('start-next rejects invalid optional budgets before any I/O and preserves the original dispatch budget',async()=>{
  for(const postSendWaitMs of [0,19999,55001,Infinity,1.5])await assert.rejects(startNext({
    q:{id:'invalid-search-budget',confirmed:true,postSendWaitMs},call:async()=>{throw Error('No I/O');}}),/postSendWaitMs/);
  let time=1000;const calls=[];
  const result=await startNext({q:{id:'expired-preread',confirmed:true,postSendWaitMs:55000},now:()=>time,
    call:async(name,args,options)=>{calls.push({name,timeoutMs:options.timeoutMs});time+=20000;return {rooms:[]};}});
  assert.deepEqual(calls,[{name:'battle_status',timeoutMs:20000}]);
  assert.equal(result.recovery.outcome,'not-sent');
});
