import test from 'node:test';
import assert from 'node:assert/strict';
import {createOperator} from './operator-client.mjs';

const TEAM='a'.repeat(64), TOKEN='c'.repeat(64), NEXT='d'.repeat(64), LEASE='b'.repeat(64);
const ROOM='battle-gen9championsvgc2026regmcbo3-42', PARENT='game-bestof3-gen9championsvgc2026regmcbo3-42';
const pair=()=>[{type:'move',slot:1,target:1},{type:'move',slot:2,target:2}];
const reply=result=>({content:[{type:'text',text:JSON.stringify({ok:true,result})}]});

function fixture({stageError=false,stageWait}={}) {
  let time=1000, state, stageCount=0, chooseCount=0, schemaCount=0;
  const calls=[];
  const idle={sessionId:'planning-fixture',teamSha256:TEAM,username:'Fixture',connected:true,authenticated:true,
    stopped:false,actions:[],rooms:[],search:{searching:[],games:null}};
  const setRequest=(token=TOKEN,rqid=2)=>{
    state={...structuredClone(idle),revision:rqid,observedAt:time,searchPending:true,
      rooms:[{id:PARENT,ended:false},{id:ROOM,ended:false}],search:{searching:[],games:{[ROOM]:true}},
      actions:[{kind:'turn',room:ROOM,parentId:PARENT,rqid,token,actionable:true,legalActions:{active:[{moves:[{slot:1}]},{moves:[{slot:2}]}]}}],
      controlPolicy:{enabled:true,pending:[{room:ROOM,rqid,token,hasFallback:false,fallbackSource:null,attempted:false,cutoffAt:20000}]},
      boards:[{room:ROOM,ownSide:'p1',turn:rqid,sides:[],field:{}}]};
  };
  setRequest();
  const client={async callTool(req,_schema,options){
    calls.push({name:req.name,args:structuredClone(req.arguments),options});
    if(req.name==='battle_status')return reply(idle);
    if(req.name==='battle_control_claim')return reply({controllerLease:LEASE});
    if(req.name==='battle_turn_status')return reply(state);
    if(req.name==='battle_stage_fallback'){
      stageCount++;
      if(stageError)throw Error('Fixture stage transport unavailable after dispatch');
      if(stageWait)await stageWait();
      const a=state.actions[0];
      if(!a.actionable||a.token!==req.arguments.token)return {isError:true,content:[{type:'text',text:JSON.stringify({ok:false,error:'Request is already reserved',recovery:{outcome:'not-sent',state}})}]};
      Object.assign(state.controlPolicy.pending[0],{hasFallback:true,fallbackSource:'fallback'});
      return reply(state.controlPolicy);
    }
    if(req.name==='battle_choose'){chooseCount++;setRequest(NEXT,4);return reply({status:'sent-not-acknowledged'});}
    return reply({fixtureResult:true});
  },async listTools(_params,options){schemaCount++;calls.push({name:'schema',options});return {tools:[]};}};
  const operator=createOperator({client,responseFile:'unused-planning-fixture.json',publish:async()=>{},now:()=>time});
  return {operator,calls,get state(){return state;},setRequest,setTime:value=>{time=value;},
    counts:()=>({stageCount,chooseCount,schemaCount}),command:(id,op='stage-next',actions=pair())=>({id,op,room:ROOM,rqid:2,token:TOKEN,...(actions===undefined?{}:{actions})})};
}
async function own(f){
  await f.operator.dispatch({id:'arm',op:'arm',confirmed:true,expectedSessionId:'planning-fixture',expectedTeamId:TEAM});
  await f.operator.dispatch({id:'claim',op:'call',name:'battle_control_claim',args:{confirmed:true,commandId:'claim',controllerId:'Fixture'}});
  await f.operator.dispatch({id:'board',op:'turn'});
}

test('owner is given the fresh unprotected board instead of starting optional calculations, history or schemas',async()=>{
  const f=fixture();await own(f);
  for(const [id,name]of [['damage','calculate_damage'],['speed','calculate_speed'],['notes','battle_decision_notes']]){
    const r=await f.operator.dispatch({id,op:'call',name});
    assert.equal(r.result.blocked,true);assert.equal(r.result.reason,'first-plan-required');
    assert.equal(r.result.state.result.actions[0].token,TOKEN);
    assert.equal(f.calls.some(c=>c.name===name),false);
  }
  const schema=await f.operator.dispatch({id:'schemas',op:'schema'});
  assert.equal(schema.result.blocked,true);assert.equal(f.counts().schemaCount,0);
});

test('stage-only protects the authored pair, allows bounded calculations, then commits the stored pair without inventing actions',async()=>{
  const f=fixture();await own(f);const authored=pair();
  const staged=await f.operator.dispatch(f.command('first-plan','stage-next',authored));
  assert.equal(staged.result.protection.staged,true);
  assert.deepEqual(f.counts(),{stageCount:1,chooseCount:0,schemaCount:0});
  authored[0].target=2;
  const calc=await f.operator.dispatch({id:'damage',op:'call',name:'calculate_damage'});
  assert.equal(calc.result.result.fixtureResult,true);
  assert.equal(f.calls.find(c=>c.name==='calculate_damage').options.timeout,5000);
  // searchPending can lag during a real active battle; it is not queue-only.
  assert.equal(f.state.searchPending,true);
  const sent=await f.operator.dispatch({id:'commit',op:'commit-next',room:ROOM,rqid:2,token:TOKEN});
  assert.equal(sent.result.sent.result.status,'sent-not-acknowledged');
  assert.equal(f.counts().chooseCount,1);
  assert.deepEqual(f.calls.find(c=>c.name==='battle_choose').args.actions,pair());
  assert.equal(sent.result.next.state.result.actions[0].token,NEXT);
});

test('fresh request changes revoke permission for research even though the cached preceding request had a staged pair',async()=>{
  const f=fixture();await own(f);await f.operator.dispatch(f.command('first-plan'));
  f.setRequest(NEXT,4);
  const r=await f.operator.dispatch({id:'must-not-calc',op:'call',name:'calculate_damage'});
  assert.equal(r.result.reason,'first-plan-required');
  assert.equal(r.result.state.result.actions[0].token,NEXT);
  assert.equal(f.calls.some(c=>c.name==='calculate_damage'),false);
});

test('an API caller cannot mutate a staged command while its RPC is pending',async()=>{
  let release;let waiting;
  const paused=new Promise(done=>{waiting=done;});
  const f=fixture({stageWait:()=>new Promise(done=>{release=done;waiting();})});await own(f);
  const command=f.command('stable-authored');
  const pending=f.operator.dispatch(command);await paused;
  command.actions[0].target=2;release();await pending;
  // Disable the pause for the commit's revalidation stage.
  const committing=f.operator.dispatch({id:'stable-commit',op:'commit-next',room:ROOM,rqid:2,token:TOKEN});
  await new Promise(done=>setImmediate(done));release();await committing;
  assert.deepEqual(f.calls.find(c=>c.name==='battle_choose').args.actions,pair());
});

test('long report and retention work stays between sets even with a valid staged live fallback',async()=>{
  const f=fixture();await own(f);await f.operator.dispatch(f.command('first-plan'));
  for(const [id,name]of [['report','team_metrics_agent_report'],['retention','team_metrics_finalize_bo3'],['guidance','battle_skill_read']]){
    const r=await f.operator.dispatch({id,op:'call',name});
    assert.equal(r.result.reason,'between-sets-required');assert.equal(f.calls.some(c=>c.name===name),false);
  }
});

test('the local cutoff stops optional research before consuming the final commit buffer',async()=>{
  const f=fixture();await own(f);await f.operator.dispatch(f.command('first-plan'));f.setTime(16000);
  const r=await f.operator.dispatch({id:'late-calc',op:'call',name:'calculate_speed'});
  assert.equal(r.result.reason,'commit-staged-plan-first');
  assert.equal(f.calls.some(c=>c.name==='calculate_speed'),false);
});

test('live schemas and research after a sent choice keep the short budget while waiting for the opponent',async()=>{
  const f=fixture();await own(f);await f.operator.dispatch(f.command('first-plan'));
  await f.operator.dispatch({id:'staged-schema',op:'schema'});
  assert.equal(f.calls.find(c=>c.name==='schema').options.timeout,5000);
  f.state.actions[0].actionable=false;f.state.actions[0].submissionStatus='sent';
  f.state.controlPolicy.pending=[];
  const calc=await f.operator.dispatch({id:'reserved-calc',op:'call',name:'calculate_damage'});
  assert.equal(calc.result.result.fixtureResult,true);
  assert.equal(f.calls.find(c=>c.name==='calculate_damage').options.timeout,5000);
  await f.operator.dispatch({id:'reserved-schema',op:'schema'});
  assert.equal(f.calls.filter(c=>c.name==='schema').at(-1).options.timeout,5000);
});

test('a stage transport timeout retains uncertainty and cannot become a second stage or an ordinary send',async()=>{
  const f=fixture({stageError:true});await own(f);
  const r=await f.operator.dispatch(f.command('stage-unknown'));
  assert.equal(r.result.recovery.outcome,'mutation-uncertain');
  const repeated=await f.operator.dispatch(f.command('different-id'));
  assert.match(repeated.error,/reservation/);
  assert.deepEqual(f.counts(),{stageCount:1,chooseCount:0,schemaCount:0});
});

test('a watchdog reservation appearing after stage cannot cause commit to send the pair again',async()=>{
  const f=fixture();await own(f);await f.operator.dispatch(f.command('first-plan'));
  f.state.actions[0].actionable=false;f.state.actions[0].submissionStatus='sent';f.state.controlPolicy.pending[0].attempted=true;
  const r=await f.operator.dispatch({id:'commit-late',op:'commit-next',room:ROOM,rqid:2,token:TOKEN});
  assert.equal(r.result.recovery.outcome,'not-sent');assert.equal(f.counts().chooseCount,0);
});

test('read-only auditors can inspect tools while another operator has an unprotected turn',async()=>{
  const f=fixture();const r=await f.operator.dispatch({id:'audit',op:'call',name:'calculate_damage'});
  assert.equal(r.result.result.fixtureResult,true);assert.deepEqual(f.calls.map(c=>c.name),['calculate_damage']);
});
