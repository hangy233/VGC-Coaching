import test from 'node:test';
import assert from 'node:assert/strict';
import {preparePreviousGameSummary,retainPreviousGameSummary} from './game-summary.mjs';
import {updateStrategicMemory} from './decision-context.mjs';

const TEAM='a'.repeat(64),PARENT='game-bestof3-gen9championsvgc2026regmcbo3-8000',GAME='battle-gen9championsvgc2026regmcbo3-8001',NEXT='battle-gen9championsvgc2026regmcbo3-8002';
const options=state=>({state,gameId:GAME,parentId:PARENT,teamId:TEAM,account:'FixturePlayer'});
function fixture(){
  const result={type:'win',winner:'Opponent'};
  const board={turn:8,ownSide:'p1',ended:true,result,field:{weather:{name:'RainDance',remainingTurns:{min:1,max:3}},terrain:null,conditions:{trickroom:{name:'Trick Room',remainingTurns:null}}},
    request:{rqid:12,token:'NEVER_INCLUDE_REQUEST'},sides:[
      {id:'p1',teamSize:4,active:[{slot:'a',pokemon:'p1-0'}],pokemon:[
        {id:'p1-0',species:'Archaludon',selection:'selected',activeSlot:'a',hp:{current:0,max:100,precision:'server-own-exact',raw:'NEVER_RAW'},status:null,fainted:true,boosts:{spa:1,spe:0},item:'Choice Scarf',itemKnown:true,moves:['Dragon Pulse','Aura Sphere']},
        {id:'p1-1',species:'Golisopod',selection:'selected',activeSlot:null,hp:{current:17,max:50,precision:'server-own-exact'},status:'brn',fainted:false,boosts:{atk:-1},item:null,itemKnown:true,moves:['Leech Life']},
        {id:'p1-2',species:'Politoed',selection:'not-in-current-request',hp:{current:200,max:200},moves:['Weather Ball']}],conditions:{tailwind:{name:'Tailwind'}}},
      {id:'p2',active:[{slot:'a',pokemon:'p2-0'}],pokemon:[{id:'p2-0',species:'Charizard',activeSlot:'a',hp:{current:25,max:100,precision:'server-display'},status:null,fainted:false,boosts:{spa:-2},item:null,itemKnown:false,moves:['Overheat']}]}]};
  return {username:'FixturePlayer',teamSha256:TEAM,controllerLease:'NEVER_LEASE',rooms:[{id:PARENT,teamId:TEAM,children:[GAME]},{id:GAME,parentId:PARENT,teamId:TEAM,ended:true,result,state:board,recentEvents:['|turn|8','|move|p2a: Charizard|Overheat|p1a: Archaludon','|faint|p1a: Archaludon','|win|Opponent']}],boards:[]};
}

test('same-scope official final snapshot preserves only observed facts and actual final events',()=>{
  const summary=preparePreviousGameSummary(options(fixture()));
  assert.equal(summary.source.status,'verified-final');assert.equal(summary.source.officialResultVerified,true);assert.equal(summary.source.snapshotFinalVerified,true);
  assert.equal(summary.source.finalEventObserved,true);assert.equal(summary.result.outcome,'loss');assert.equal(summary.observed.turn,8);
  assert.deepEqual(summary.observed.field.weather.remainingTurns,{min:1,max:3});assert.equal(summary.observed.field.trickRoom.remainingTurns,null);
  const own=summary.observed.sides[0].pokemon;assert.equal(own.length,2);assert.deepEqual(own[1].hp,{current:17,max:50,precision:'server-own-exact'});
  assert.deepEqual(own[1].boosts,{atk:-1});assert.equal(summary.observed.sides[1].pokemon[0].itemKnown,false);
  const serialized=JSON.stringify(summary);assert(!serialized.includes('Politoed'));assert(!serialized.includes('NEVER_'));assert(!serialized.includes('controllerLease'));
  assert(Buffer.byteLength(serialized)<=4096);assert(retainPreviousGameSummary(summary,{teamId:TEAM,parentId:PARENT,currentGameId:NEXT}));
});

test('an ended room does not silently turn a cached last-observed board into final state',()=>{
  const state=fixture(),board=state.rooms[1].state;delete state.rooms[1].state;delete board.ended;delete board.result;
  state.boards=[{...board,room:GAME,parentId:PARENT}];
  const summary=preparePreviousGameSummary(options(state));
  assert.equal(summary.source.officialResultVerified,true);assert.equal(summary.source.snapshotFinalVerified,false);assert.equal(summary.source.status,'last-observed');
  delete state.boards;const missing=preparePreviousGameSummary(options(state));assert.equal(missing.observed,null);assert.equal(missing.source.status,'snapshot-unavailable');assert.equal(missing.result.outcome,'loss');
});

test('unknown team proof, absent end event or unverified result stays explicitly unknown',()=>{
  const state=fixture();delete state.teamSha256;for(const room of state.rooms)delete room.teamId;
  const summary=preparePreviousGameSummary(options(state));assert.equal(summary.source.officialResultVerified,false);assert.equal(summary.result,null);assert.equal(summary.source.status,'last-observed');
  const unfinished=fixture();unfinished.rooms[1].ended=false;assert.equal(preparePreviousGameSummary(options(unfinished)).result,null);
  const noFinalEvent=fixture();noFinalEvent.rooms[1].recentEvents=['|turn|8'];assert.equal(preparePreviousGameSummary(options(noFinalEvent)).source.finalEventObserved,false);
});

test('wrong team parent child account or ambiguous canonical source cannot cross the handoff',()=>{
  for(const mutate of [s=>{s.teamSha256='b'.repeat(64);},s=>{s.rooms[1].parentId=PARENT+'9';},s=>{s.username='SomeoneElse';},
    s=>{s.rooms.push({...s.rooms[1],id:GAME+'-privatepw'});},s=>{s.boards=[{room:GAME,parentId:PARENT+'9'}];}]){
    const state=fixture();mutate(state);assert.equal(preparePreviousGameSummary(options(state)),null,mutate.toString());
  }
  const missingChild=fixture();missingChild.rooms[1].id=NEXT;
  const unavailable=preparePreviousGameSummary(options(missingChild));assert.equal(unavailable.observed,null);assert.equal(unavailable.result,null);assert.deepEqual(unavailable.events,[]);
  const privateState=fixture();privateState.rooms[1].id=GAME+'-privatepw';privateState.rooms[1].parentId=PARENT+'-privatepw';
  const safe=preparePreviousGameSummary({...options(privateState),gameId:GAME+'-privatepw',parentId:PARENT+'-privatepw'});
  assert.equal(safe.gameId,GAME);assert.equal(safe.parentId,PARENT);assert(!JSON.stringify(safe).includes('privatepw'));
});

test('whole optional observations are omitted under 4KB without truncating serialized current facts',()=>{
  const state=fixture(),board=state.rooms[1].state;
  for(const [index,side]of board.sides.entries())side.pokemon=Array.from({length:6},(_,n)=>({id:`p${index+1}-${n}`,species:'SpeciesWithAnObservedName',selection:'selected',activeSlot:n<2?'ab'[n]:null,
    hp:{current:20,max:50,precision:'server-display'},status:'tox',boosts:{atk:1,def:2,spa:3,spd:4,spe:5,accuracy:0,evasion:0},item:'Observed Item',itemKnown:true,moves:Array(4).fill('Observed Move With A Long Actual Name')}));
  state.rooms[1].recentEvents=[...Array.from({length:30},(_,n)=>`|move|p1a: Actor|Observed Move ${n} ${'x'.repeat(100)}|p2a: Opponent`),'|request|SECRET_REQUEST','|move|password=NEVER|Attack','|win|Opponent'];
  const summary=preparePreviousGameSummary(options(state));assert(Buffer.byteLength(JSON.stringify(summary))<=4096);assert(summary.events.length<=12);
  assert(summary.omitted.events>0);assert(summary.omitted.knownPokemon>=4);assert(!JSON.stringify(summary).includes('NEVER'));assert(!JSON.stringify(summary).includes('SECRET_REQUEST'));
  for(const side of summary.observed?.sides??[])for(const p of side.pokemon){assert.equal(p.hp.current,20);assert.equal(p.hp.max,50);assert.equal(p.species,'SpeciesWithAnObservedName');}
});

test('previous-game observations survive same-set turns separately from claims and reset across scope',()=>{
  const summary=preparePreviousGameSummary(options(fixture()));
  let memory=updateStrategicMemory({},undefined,{teamId:TEAM,parentId:PARENT,gameId:GAME,lastGameAdaptations:['Agent claim: change the lead.'],positionPlan:{payoff:'Old claim'}});
  memory=updateStrategicMemory(memory,undefined,{teamId:TEAM,parentId:PARENT,gameId:NEXT,previousGameSummary:summary});
  assert.equal(memory.facts.previousGameSummary.gameId,GAME);assert.equal(memory.claims.currentPlan.objective,'');assert.equal(memory.claims.positionPlan,undefined);assert.equal(memory.claims.lastGameAdaptations.length,1);
  const anotherTurn=updateStrategicMemory(memory,undefined,{teamId:TEAM,parentId:PARENT,gameId:NEXT,events:['|turn|2']});assert.deepEqual(anotherTurn.facts.previousGameSummary,summary);
  for(const changed of [{teamId:'b'.repeat(64),parentId:PARENT,gameId:NEXT},{teamId:TEAM,parentId:PARENT+'9',gameId:NEXT}])assert.equal(updateStrategicMemory(memory,undefined,changed).facts.previousGameSummary,undefined);
  assert.equal(updateStrategicMemory(memory,undefined,{teamId:TEAM,parentId:PARENT,gameId:NEXT,previousGameSummary:null}).facts.previousGameSummary,undefined);
  assert.equal(retainPreviousGameSummary({...summary,rawRequest:{secret:'never'}},{teamId:TEAM,parentId:PARENT,currentGameId:NEXT}),null);
  assert.equal(retainPreviousGameSummary(summary,{teamId:TEAM,parentId:PARENT,currentGameId:GAME}),null);
  assert.equal(retainPreviousGameSummary({...summary,gameId:GAME+'-privatepw'},{teamId:TEAM,parentId:PARENT,currentGameId:NEXT}),null);
});
