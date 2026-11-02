import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createChoiceStateHistory,assembleChoiceState,applyChoiceStateOverrides} from './choice-state.mjs';
import {createBattleState,reduceBattleLine,reduceBattleRequest,battleStateSnapshot} from '../showdown/battle-state.mjs';
import {compactTurnBoard} from '../showdown/turn-board.mjs';
import {choiceFixtureTeams,choiceFixtureSet as set,choiceFixtureRegistration,choiceFixtureSheet} from './choice-fixture.mjs';
const {Battle}=createRequire(import.meta.url)('pokemon-showdown');
const {extractChannelMessages}=createRequire(import.meta.url)('pokemon-showdown/dist/sim/battle.js');
const copy=v=>JSON.parse(JSON.stringify(v)),sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const room='battle-gen9championsvgc2026regmcbo3-817',sessionId='synthetic-choice-state',token='a'.repeat(64),epoch=1;
function fixture({lateSheet=false,configure,ownOrder='1234',foeOrder='1234',omitStart=false,nativeSeed=[1,2,3,4]}={}){
  const {p1:own,p2:foe}=choiceFixtureTeams();
  configure?.(own,foe);
  const {teamText,teamId}=choiceFixtureRegistration(own),sheet=choiceFixtureSheet(foe);
  const tracker=createChoiceStateHistory({sessionId,room,teamId,epoch,teamText,...(lateSheet?{}:{opposingSheet:sheet})}),state=createBattleState();
  const battle=new Battle({formatid:'gen9championsvgc2026regmc',seed:nativeSeed,p1:{name:'Owner',team:own},p2:{name:'Foe',team:foe}});
  let sequence=0,lastLine=0,rqid=0,request=null;const lines=[];
  const meta=()=>({sequence:++sequence,epoch,connected:true,observedAt:100000+sequence});
  function line(text){const m=meta();tracker.observeLine(omitStart&&text==='|start'?'|message|start prefix absent':text,m);reduceBattleLine(state,text,{...m,now:m.observedAt});lines.push(text);}
  function receive(){
    const native=extractChannelMessages(battle.log.join('\n'),[1])[1];
    for(const text of native.slice(lastLine))line(text);lastLine=native.length;
    if(battle.p1.activeRequest){request=copy({...battle.p1.activeRequest,rqid:++rqid});const m=meta();tracker.observeRequest(request,m);reduceBattleRequest(state,request,{...m,now:m.observedAt});}
  }
  function choose(p1,p2){assert.equal(battle.choose('p1',p1),true,battle.p1.choice.error);assert.equal(battle.choose('p2',p2),true,battle.p2.choice.error);receive();}
  function replace(side,choice){assert.equal(battle.choose(side,choice),true,battle[side].choice.error);receive();}
  function source(){
    const board={...compactTurnBoard(battleStateSnapshot(state),{request,events:lines}),room};
    return {observed:{sessionId,teamSha256:teamId,revision:sequence,connected:true,authenticated:true,actions:[{kind:'turn',room,rqid:request.rqid,token,actionable:true,legalActions:{teamPreview:!!request.teamPreview,forceSwitch:request.forceSwitch??null,active:request.active??[],pokemon:request.side.pokemon}}],boards:[board],opponentSheets:{p2:copy(sheet)}},expected:{room,rqid:request.rqid,token,teamId},opposingSheet:copy(sheet)};
  }
  const assembly=()=>assembleChoiceState(tracker.capture(source()));
  receive();choose('team '+ownOrder,'team '+foeOrder);
  return {battle,tracker,state,source,assembly,choose,replace,line,meta,receive,teamId,teamText,sheet};
}
function nativeLife(p){return {activeTurns:p.activeTurns,activeMoveActions:p.activeMoveActions,protectCounter:p.volatiles.stall?.counter??0,choiceLock:p.volatiles.choicelock?.move??false,lastMove:p.lastMove?.name??false};}
function actor(assembly,name){return assembly.facts.actors.find(p=>p.own&&p.registeredSet.name===name);}

function assertNativeHistory(f){const result=f.assembly(),h=result.facts.nativeHistory;assert.equal(h.kind,'source-bound-native-history-v1');assert.equal(h.completeHistory,true);for(const key of ['sourceSha256','historySha256','sequence','teamId','room','rqid'])assert.equal(h.binding[key],result.binding[key]);
  for(const side of f.source().observed.boards[0].sides){assert.equal(h.sides[side.id].totalFainted,f.battle[side.id].totalFainted);for(const p of side.pokemon){const native=f.battle[side.id].pokemon.find(n=>n.name===p.nickname),facts=h.pokemon[p.id];assert(native,p.id);for(const key of ['timesAttacked','lastMoveTargetLoc','moveLastTurnResult'])if(Object.hasOwn(facts,key))assert.equal(facts[key],native[key],p.nickname+'.'+key);}}
  if(Object.hasOwn(h.battle,'lastMove'))assert.equal(h.battle.lastMove,f.battle.lastMove?.id??false);return result;
}

test('source-bound native history matches actual ordinary hits, original targeted slots, prior results and global last move',()=>{const f=fixture();try{
  let result=assertNativeHistory(f);assert.equal(result.facts.nativeHistory.battle.lastMove,false);assert(result.facts.nativeHistory.unknowns.some(row=>row.path.endsWith('moveLastTurnResult')));
  f.choose('move 3 2, move 2 -1','move 4, move 2 -1');result=assertNativeHistory(f);const h=result.facts.nativeHistory,board=f.source().observed.boards[0],toed=board.sides[0].pokemon.find(p=>p.nickname==='toed'),target=board.sides[1].pokemon.find(p=>p.nickname==='foe-fari');assert.equal(h.pokemon[target.id].timesAttacked,1);assert.equal(h.pokemon[toed.id].lastMoveTargetLoc,2);assert.equal(h.pokemon[toed.id].moveLastTurnResult,true);assert.equal(h.battle.lastMove,'icebeam');assert(h.provenance.some(row=>row.path===`pokemon.${target.id}.timesAttacked`&&row.origin==='audited-ordinary-native-direct-hit-count'));
  f.choose('move 3 1, move 2 -1','move 4, move 2 -1');result=assertNativeHistory(f);const rai=board.sides[1].pokemon.find(p=>p.nickname==='rai');assert.equal(result.facts.nativeHistory.pokemon[rai.id].timesAttacked,0,'Protect does not count as a numeric hit');assert.equal(result.facts.nativeHistory.pokemon[toed.id].moveLastTurnResult,undefined,'generic denial does not invent a native boolean result');assert(result.facts.nativeHistory.unknowns.some(row=>row.path===`pokemon.${toed.id}.moveLastTurnResult`));
}finally{f.battle.destroy();}});

test('unrelated new public volatile does not erase independently proved native faint/hit history',()=>{const f=fixture({configure:a=>{a[1]=set('incin','Incineroar','Intimidate','Grassy Seed',['Fake Out','Taunt','Flare Blitz','Protect'],{hp:32,atk:32,def:2,spa:0,spd:0,spe:0});}});try{
  f.choose('move 4, move 2 2','move 4, move 2 -1');let result=assertNativeHistory(f);assert.equal(result.coverage.auditedHistory,false,'novel Taunt still invalidates the legacy strict-state fragment');const foe=f.source().observed.boards[0].sides[1].pokemon.find(p=>p.nickname==='foe-fari');assert.equal(result.facts.nativeHistory.pokemon[foe.id].timesAttacked,0);assert.equal(result.facts.nativeHistory.sides.p2.totalFainted,0);
  f.choose('move 3 2, move 4','move 4, move 1 1');result=assertNativeHistory(f);assert.equal(result.facts.nativeHistory.pokemon[foe.id].timesAttacked,1,'actual ordinary numeric hit remains independently source-known');
}finally{f.battle.destroy();}});

test('native hit history resets on a genuine Champions switch and source incompleteness withholds every exact history field',()=>{const f=fixture();try{
  f.choose('move 3 2, move 2 -1','move 4, move 2 -1');let result=assertNativeHistory(f),p=f.source().observed.boards[0].sides[1].pokemon.find(p=>p.nickname==='foe-fari');assert.equal(result.facts.nativeHistory.pokemon[p.id].timesAttacked,1);
  f.choose('move 4, move 4','move 4, switch 3');result=assertNativeHistory(f);assert.equal(result.facts.nativeHistory.pokemon[p.id].timesAttacked,0);assert(result.facts.nativeHistory.provenance.some(row=>row.path===`pokemon.${p.id}.timesAttacked`&&row.origin==='audited-Champions-clearVolatile-reset'));
}finally{f.battle.destroy();}const gap=fixture({omitStart:true});try{const h=gap.assembly().facts.nativeHistory;assert.equal(h.completeHistory,false);assert.deepEqual(h.battle,{});assert.deepEqual(h.sides,{p1:{},p2:{}});assert(Object.values(h.pokemon).every(row=>!Object.keys(row).length));assert(h.unknowns.every(row=>row.reason.includes('Complete start-to-current')));}finally{gap.battle.destroy();}});

test('every actual native faint is counted across genuine Revival Blessing and lethal hit counts survive dead replacement',()=>{const f=fixture({configure:a=>{
  a[0]=set('snea','Sneasler','Unburden','Expert Belt',['Close Combat','Rock Slide','Swords Dance','Protect'],{hp:32,atk:32,def:0,spa:0,spd:2,spe:0});a[2]=set('reviver','Pawmot','Volt Absorb','Focus Sash',['Revival Blessing','Close Combat','Fake Out','Protect'],{hp:32,atk:32,def:2,spa:0,spd:0,spe:0});
}});try{
  f.choose('move 3, move 2 -1','move 4, move 1 1');assert.equal(f.battle.p1.pokemon.find(p=>p.name==='snea').fainted,true);f.replace('p1','switch 3, pass');let result=assertNativeHistory(f),p=result.facts.actors.find(p=>p.own&&p.species==='Sneasler');assert.equal(result.facts.nativeHistory.sides.p1.totalFainted,1);assert.equal(result.facts.nativeHistory.pokemon[p.id].timesAttacked,1,'lethal hit increments after faint reset; dead forced exit does not reset it again');
  f.choose('move 1, move 2 -1','move 4, move 4');assert.equal(f.battle.requestState,'switch');f.replace('p1','switch 3, pass');assert.equal(f.battle.p1.pokemon.find(p=>p.name==='snea').fainted,false);result=assertNativeHistory(f);assert.equal(result.facts.nativeHistory.sides.p1.totalFainted,1,'revival does not subtract a historical faint');
  f.choose('switch 3, move 2 -1','move 4, move 4');assertNativeHistory(f);f.choose('move 3, move 2 -1','move 4, move 1 1');assert.equal(f.battle.p1.pokemon.find(p=>p.name==='snea').fainted,true);f.replace('p1','switch 3, pass');result=assertNativeHistory(f);assert.equal(result.facts.nativeHistory.sides.p1.totalFainted,2);assert.equal(result.facts.nativeHistory.pokemon[p.id].timesAttacked,1);assert.equal(result.coverage.auditedHistory,false,'legacy called/history safety does not erase separately known faint totals');
}finally{f.battle.destroy();}});

test('native multihit history counts the full executed hits only when its last hit reaches the body after Substitute',()=>{const f=fixture({ownOrder:'6234',configure:(a,b)=>{a[5]=set('rilla','Rillaboom','Grassy Surge','Miracle Seed',['Bullet Seed','Wood Hammer','Grassy Glide','Protect'],{hp:32,atk:32,def:2,spa:0,spd:0,spe:0});b[1]=set('foe-fari','Farigiraf','Armor Tail','Sitrus Berry',['Psychic','Helping Hand','Substitute','Protect'],{hp:32,atk:0,def:32,spa:2,spd:0,spe:0});}});try{
  f.choose('move 4, move 2 -1','move 4, move 3');let result=assertNativeHistory(f),target=f.source().observed.boards[0].sides[1].pokemon.find(p=>p.nickname==='foe-fari');assert.equal(result.facts.nativeHistory.pokemon[target.id].timesAttacked,0,'own Substitute cost is not an incoming attack');
  const logStart=f.battle.log.length;f.choose('move 1 2, move 4','move 4, move 2 -1');result=assertNativeHistory(f);const log=f.battle.log.slice(logStart),countLine=log.find(line=>line.startsWith('|-hitcount|p2b: foe-fari|')),count=Number(countLine?.split('|')[3]);assert(count>=2);assert(log.some(line=>line.includes('|-end|p2b: foe-fari|Substitute')));assert(log.some(line=>line.startsWith('|-damage|p2b: foe-fari|')));assert.equal(result.facts.nativeHistory.pokemon[target.id].timesAttacked,count,'native final numeric hit adds all executed hits, not only body HP rows');
}finally{f.battle.destroy();}});

test('native multihit entirely absorbed by Substitute proves zero incoming body-hit counter despite its printed hitcount',()=>{const f=fixture({ownOrder:'6234',configure:(a,b)=>{a[5]=set('rilla','Rillaboom','Overgrow','Focus Sash',['Bullet Seed','Wood Hammer','Grassy Glide','Protect'],{hp:32,atk:0,def:32,spa:2,spd:0,spe:0});b[0]=set('foe-incin','Incineroar','Intimidate','Charcoal',['Fake Out','Flare Blitz','Taunt','Protect']);b[1]=set('foe-fari','Farigiraf','Armor Tail','Sitrus Berry',['Psychic','Helping Hand','Substitute','Protect'],{hp:32,atk:0,def:32,spa:2,spd:0,spe:0});}});try{
  f.choose('move 4, move 2 -1','move 4, move 3');const logStart=f.battle.log.length;f.choose('move 1 2, move 4','move 4, move 2 -1');const result=assertNativeHistory(f),target=f.source().observed.boards[0].sides[1].pokemon.find(p=>p.nickname==='foe-fari'),log=f.battle.log.slice(logStart);assert(log.some(line=>line.startsWith('|-hitcount|p2b: foe-fari|')));assert.equal(log.some(line=>line.startsWith('|-damage|p2b: foe-fari|')),false);assert.equal(result.facts.nativeHistory.pokemon[target.id].timesAttacked,0);
}finally{f.battle.destroy();}});

function confusionFixture(options={}){return fixture({...options,configure:(a,b)=>{
  a[1]=set('fari','Farigiraf','Armor Tail','Grassy Seed',['Confuse Ray','Psychic','Helping Hand','Protect']);
  b[1]=set('foe-fari','Farigiraf','Armor Tail','Sitrus Berry',['Confuse Ray','Psychic','Helping Hand','Protect']);
}});}
function confusedActor(result,own){return result.facts.actors.find(p=>p.own===own&&p.species===(own?'Politoed':'Raichu'));}
function confusionRange(f,result,own){const p=confusedActor(result,own),overlaid=applyChoiceStateOverrides({observed:f.source().observed,assembly:result});return overlaid.boards[0].sides.flatMap(s=>s.pokemon).find(a=>a.id===p.id).volatiles.confusion?.remainingActions;}

test('native confusion public starts retain hidden action ranges and self-hits count lifecycle without spending PP, own and foe',()=>{
  const outcomes=new Set();for(const own of [true,false])for(const n of [1,2,3,4]){const f=confusionFixture({nativeSeed:[n,2,3,4]});try{
    f.choose(own?'move 3 1, move 3 -1':'move 4, move 1 1',own?'move 4, move 1 1':'move 1 1, move 3 -1');
    let result=f.assembly(),range=confusionRange(f,result,own),p=confusedActor(result,own);assert.deepEqual(range,{min:2,max:5});assert.equal(result.hypotheses[own?'own':'opposing'][p.id].volatiles.confusion,undefined,'a range does not become an exact source fact');assert.equal(result.coverage.auditedHistory,true);
    const native=(own?f.battle.p1:f.battle.p2).active[0];let count=0;
    while(native.volatiles.confusion&&count++<5){const before=f.battle.log.length,pp=native.moveSlots.map(m=>m.pp),last=native.lastMove?.name??false;
      f.choose('move 4, move 3 -1','move 4, move 3 -1');result=assertNativeHistory(f);p=confusedActor(result,own);const fragment=result.hypotheses[own?'own':'opposing'][p.id];
      assert.deepEqual(fragment.lifecycle,nativeLife(native));assert.deepEqual(fragment.pp,native.moveSlots.map(m=>m.pp));assert.equal(result.coverage.auditedHistory,true);
      const selfHit=f.battle.log.slice(before).some(line=>line.includes('[from] confusion'));outcomes.add(selfHit?'self-hit':'move');if(selfHit){assert.deepEqual(fragment.pp,pp);assert.equal(fragment.lifecycle.lastMove,last);}
      range=confusionRange(f,result,own);if(native.volatiles.confusion){assert(range.min<=native.volatiles.confusion.time&&native.volatiles.confusion.time<=range.max);assert.equal(range.max,5-count);}else assert.equal(range,undefined);
    }
  }finally{f.battle.destroy();}}assert.deepEqual(outcomes,new Set(['self-hit','move']));
});

test('confusion history only consumes native activation events and clears on actual switch or end',()=>{
  const f=confusionFixture();try{f.choose('move 3 1, move 3 -1','move 4, move 1 1');const start=confusionRange(f,f.assembly(),true);assert.deepEqual(start,{min:2,max:5});
    // Native switching has no confusion BeforeMove. The next request must not
    // preserve it on the bench or infer a remaining action from the turn.
    f.choose('switch 3, move 3 -1','move 4, move 3 -1');const result=f.assembly(),p=confusedActor(result,true);assert.equal(confusionRange(f,result,true),undefined);assert.deepEqual(result.hypotheses.own[p.id].volatiles,{});assert.equal(result.coverage.auditedHistory,true);
  }finally{f.battle.destroy();}
});

test('actual native flinch leaves the hidden confusion interval unchanged while counting the denied action and preserving PP',()=>{
  const f=fixture({foeOrder:'2314',configure:(a,b)=>{a[1]=set('garde','Gardevoir','Synchronize','Grassy Seed',['Helping Hand','Mystical Fire','Dazzling Gleam','Protect']);b[1]=set('foe-fari','Farigiraf','Armor Tail','Sitrus Berry',['Confuse Ray','Psychic','Helping Hand','Protect']);}});try{
    f.choose('move 3 2, move 1 -1','move 1 1, move 4');f.choose('move 4, move 1 -1','move 3 -2, switch 3');const before=f.assembly(),p=confusedActor(before,true),range=confusionRange(f,before,true),pp=copy(before.hypotheses.own[p.id].pp),logStart=f.battle.log.length;
    f.choose('move 3 1, move 1 -1','move 3 -2, move 3 1');const after=f.assembly();assert(f.battle.log.slice(logStart).some(line=>line.includes('|cant|p1a: toed|flinch')));assert.deepEqual(confusionRange(f,after,true),range);assert.deepEqual(after.hypotheses.own[p.id].pp,pp);assert.equal(after.hypotheses.own[p.id].lifecycle.activeMoveActions,before.hypotheses.own[p.id].lifecycle.activeMoveActions+1);assert.deepEqual(after.hypotheses.own[p.id].lifecycle,nativeLife(f.battle.p1.active[0]));assert.equal(after.coverage.auditedHistory,true);
  }finally{f.battle.destroy();}
});

test('only an actual source-attributed native Axe Kick start tightens the initial hidden counter interval to three through five',()=>{
  let observed=0;for(const n of [1,2,3,4,5,6,7,8,9,10,11,12]){const f=fixture({nativeSeed:[n,2,3,4],configure:a=>{a[0]=set('medi','Medicham','Pure Power','Expert Belt',['Axe Kick','Zen Headbutt','Ice Punch','Protect'],{hp:32,atk:32,def:2,spa:0,spd:0,spe:0});}});try{
    f.choose('move 1 2, move 4','move 4, move 2 -1');const native=f.battle.p2.active[1];if(native.volatiles.confusion){observed++;const result=f.assembly(),p=result.facts.actors.find(p=>!p.own&&p.species==='Farigiraf'),overlaid=applyChoiceStateOverrides({observed:f.source().observed,assembly:result});assert.deepEqual(overlaid.boards[0].sides[1].pokemon.find(a=>a.id===p.id).volatiles.confusion.remainingActions,{min:3,max:5});assert(native.volatiles.confusion.time>=3&&native.volatiles.confusion.time<=5);assert.equal(result.coverage.auditedHistory,true);}
  }finally{f.battle.destroy();}}assert(observed>0,'a genuine legal native Axe Kick must reach its confusion secondary');
});

test('genuine native confused faint clears the source volatile before replacement and keeps the dead-bench assembly unconfused',()=>{
  const f=fixture({configure:(a,b)=>{a[0]=set('snea','Sneasler','Unburden','Expert Belt',['Close Combat','Rock Slide','Swords Dance','Protect'],{hp:32,atk:32,def:0,spa:0,spd:2,spe:0});b[1]=set('foe-fari','Farigiraf','Armor Tail','Sitrus Berry',['Confuse Ray','Psychic','Helping Hand','Protect']);}});try{
    f.choose('move 1 1, move 2 -1','move 4, move 1 1');const native=f.battle.p1.active[0];assert(native.volatiles.confusion);f.choose('move 3, move 2 -1','move 4, move 2 1');assert.equal(native.fainted,true);assert.equal(native.volatiles.confusion,undefined,'native faint clears its volatile before forced replacement');assert.equal(f.state.sides.p1.pokemon.find(p=>p.nickname==='snea').volatiles.confusion,undefined,'protocol projection must clear the same volatile');
    f.replace('p1','switch 3, pass');const result=f.assembly(),p=result.facts.actors.find(p=>p.own&&p.species==='Sneasler');assert.equal(p.fainted,true);assert.deepEqual(result.hypotheses.own[p.id].volatiles,{});assert.equal(result.observedOverrides.some(row=>row.pokemonId===p.id&&row.field==='confusionRemainingActions'),false);assert.equal(result.coverage.auditedHistory,true);
  }finally{f.battle.destroy();}
});

test('confusion missing/gapped or contradictory activation history withholds its range, and overlays cannot replace observed facts',()=>{
  for(const omitStart of [false,true]){const f=confusionFixture({omitStart});try{f.choose('move 3 1, move 3 -1','move 4, move 1 1');let result=f.assembly(),p=confusedActor(result,true);
    if(omitStart){assert.equal(result.observedOverrides.some(row=>row.field==='confusionRemainingActions'),false);assert.equal(result.coverage.auditedHistory,false);}
    else {const original=f.source().observed,changed=copy(original),row=result.observedOverrides.find(row=>row.field==='confusionRemainingActions');assert(row);changed.boards[0].sides.flatMap(s=>s.pokemon).find(a=>a.id===p.id).volatiles.confusion.remainingActions={min:3,max:3};const tampered=copy(result);tampered.binding.observedSha256=sha(changed);assert.throws(()=>applyChoiceStateOverrides({observed:changed,assembly:tampered}),/replace or invent observed confusion/u);
      f.line('|-activate|p1a: toed|confusion');f.line('|-activate|p1a: toed|confusion');f.receive();result=f.assembly();assert.equal(result.coverage.auditedHistory,false);assert.equal(result.observedOverrides.some(row=>row.field==='confusionRemainingActions'),false);
    }
  }finally{f.battle.destroy();}}
});

function unburdenFixture({item='Grassy Seed',terrain=true,own=false,...options}={}){
  return fixture({...options,configure:(a,b)=>{
    b[0]=set('snea','Sneasler','Unburden',item,['Close Combat','Dire Claw','Rock Slide','Protect'],{hp:2,atk:32,def:0,spa:0,spd:0,spe:32});
    if(terrain)b[1]=set('grass','Rillaboom','Grassy Surge','Miracle Seed',['Wood Hammer','Grassy Glide','High Horsepower','Protect'],{hp:32,atk:32,def:2,spa:0,spd:0,spe:0});
    if(own)a[1]=set('own-snea','Sneasler','Unburden','Grassy Seed',['Close Combat','Dire Claw','Rock Slide','Protect'],{hp:2,atk:32,def:0,spa:0,spd:0,spe:32});
  }});
}
function unburdenActor(result,own=false){return result.facts.actors.find(p=>p.species==='Sneasler'&&p.own===own);}
function unburdenFlag(result,own=false){const p=unburdenActor(result,own);return result.hypotheses[own?'own':'opposing'][p.id].lifecycle?.unburdenVolatile;}

test('native Unburden Seed activation is source-bound for own/foe and late sheets, never inferred from starting itemlessness',()=>{
  for(const options of [{own:true},{lateSheet:true},{item:''},{terrain:false}]){
    const f=unburdenFixture(options);try{
      const result=f.assembly(),native=f.battle.p2.pokemon.find(p=>p.name==='snea');assert.equal(unburdenFlag(result),!!native.volatiles.unburden,JSON.stringify(options));
      if(options.own)assert.equal(unburdenFlag(result,true),!!f.battle.p1.pokemon.find(p=>p.name==='own-snea').volatiles.unburden);
      const p=unburdenActor(result),source=f.source(),overlaid=applyChoiceStateOverrides({observed:source.observed,assembly:result});
      assert.equal(overlaid.boards[0].sides[1].pokemon.find(actor=>actor.id===p.id).unburdenVolatile,!!native.volatiles.unburden);
      assert(result.provenance.some(row=>row.path.join('.')===`opposing.${p.id}.lifecycle.unburdenVolatile`));
      assert.equal(Object.hasOwn(source.observed.boards[0].sides[1].pokemon.find(actor=>actor.id===p.id),'unburdenVolatile'),false);
    }finally{f.battle.destroy();}
  }
});

test('audited Unburden exit/reentry and genuine native faint reset the flag without changing PP or other known history',()=>{
  const f=unburdenFixture();try{
    assert.equal(unburdenFlag(f.assembly()),true);f.choose('move 4, move 4','switch 3, move 4');assert.equal(unburdenFlag(f.assembly()),false);
    f.choose('move 4, move 4','switch 3, move 4');assert.equal(f.battle.p2.active[0].item,'');assert.equal(unburdenFlag(f.assembly()),false);
  }finally{f.battle.destroy();}
  const ko=unburdenFixture();try{
    let attempts=0;while(!ko.battle.p2.pokemon.find(p=>p.name==='snea').fainted&&attempts++<4)ko.choose('move 4, move 1 1','move 1 1, move 4');
    const native=ko.battle.p2.pokemon.find(p=>p.name==='snea');assert.equal(native.fainted,true);assert.equal(!!native.volatiles.unburden,false,'Native ability-end clears activation at faint.');
    assert.equal(ko.battle.requestState,'switch');ko.replace('p2','switch 3, pass');const result=ko.assembly(),p=unburdenActor(result);assert.equal(p.fainted,true);assert.equal(unburdenFlag(result),false);
    assert.deepEqual(result.hypotheses.opposing[p.id].pp,native.moveSlots.map(move=>move.pp));
  }finally{ko.battle.destroy();}
});

test('Unburden volatile presence survives item reacquisition while unknown loss hooks, copied/suppressed ability and missing history stay unavailable',()=>{
  const retained=unburdenFixture();try{retained.line('|-item|p2a: snea|Sitrus Berry|[from] move: Trick');retained.receive();const result=retained.assembly(),p=unburdenActor(result);assert.equal(result.hypotheses.opposing[p.id].item,'Sitrus Berry');assert.equal(unburdenFlag(result),true);}finally{retained.battle.destroy();}
  for(const kind of ['external-loss','item-replacement','copied','suppressed','gap','start']){
    const f=unburdenFixture({...(['external-loss','item-replacement'].includes(kind)?{terrain:false}:{}),...(kind==='start'?{omitStart:true}:{})});try{
      if(kind==='external-loss')f.line('|-enditem|p2a: snea|Grassy Seed|[from] move: Knock Off');
      else if(kind==='item-replacement')f.line('|-item|p2a: snea|Sitrus Berry|[from] move: Trick');
      else if(kind==='copied')f.line('|-ability|p2a: snea|Unburden|[from] move: Skill Swap');
      else if(kind==='suppressed')f.line('|-endability|p2a: snea|Unburden|[from] move: Gastro Acid');
      else if(kind==='gap')f.tracker.observeLine('|message|gap',{...f.meta(),sequence:999});
      f.receive();const result=f.assembly();assert.equal(unburdenFlag(result),undefined,kind);assert(result.unknowns.some(row=>row.path.at(-1)==='unburdenVolatile'),kind);
      assert.equal(result.observedOverrides.some(row=>row.field==='unburdenVolatile'),false,kind);
    }finally{f.battle.destroy();}
  }
});

test('native Unburden overlays are exact-hash-bound and cannot replace an existing known value',()=>{
  const f=unburdenFixture();try{const result=f.assembly(),source=f.source(),p=unburdenActor(result),changed=copy(result);changed.observedOverrides.find(row=>row.field==='unburdenVolatile').value=false;
    assert.throws(()=>applyChoiceStateOverrides({observed:source.observed,assembly:changed}),/assembled source hash differs/u);
    const observed=copy(source.observed);observed.boards[0].sides[1].pokemon.find(actor=>actor.id===p.id).unburdenVolatile=false;const rebased=copy(result);rebased.binding.observedSha256=sha(observed);
    assert.throws(()=>applyChoiceStateOverrides({observed,assembly:rebased}),/replace an observed fact/u);
  }finally{f.battle.destroy();}
});

test('late published sheets preserve already audited opposing PP uses on reentry and keep untouched entry fresh',()=>{
  for(const used of [false,true]){
    const f=fixture({lateSheet:true});try{
      if(used)f.choose('move 4, move 4','move 1 1, move 4');
      const initial=f.assembly(),p=initial.facts.actors.find(p=>!p.own&&p.species==='Raichu');
      assert.deepEqual(initial.hypotheses.opposing[p.id].pp,f.battle.p2.pokemon.find(p=>p.name==='rai').moveSlots.map(m=>m.pp));
      f.choose('move 4, move 4','switch 3, move 4');f.choose('move 4, move 4','switch 3, move 4');
      const result=f.assembly();assert.deepEqual(result.hypotheses.opposing[p.id].pp,f.battle.p2.pokemon.find(p=>p.name==='rai').moveSlots.map(m=>m.pp));
      assert.equal(result.provenance.find(row=>row.path.join('.')===`opposing.${p.id}.pp`).origin,used?'audited-native-move-PP-history':'native-initial-PP-complete-history');
    }finally{f.battle.destroy();}
  }
});

test('late-sheet entry never replaces ambiguous PP restoration or Pressure history with maximum PP',()=>{
  const restored=fixture({lateSheet:true});try{restored.assembly();restored.line('|-activate|p2a: rai|item: Leppa Berry');restored.receive();restored.choose('move 4, move 4','switch 3, move 4');restored.choose('move 4, move 4','switch 3, move 4');const result=restored.assembly(),p=result.facts.actors.find(p=>!p.own&&p.species==='Raichu');assert.equal(result.hypotheses.opposing[p.id].pp,undefined);}finally{restored.battle.destroy();}
  const pressure=fixture({lateSheet:true,configure:(_a,b)=>b[0]=set('pressure','Corviknight','Pressure','Metal Coat',['Brave Bird','Iron Head','Tailwind','Protect'])});try{pressure.assembly();pressure.choose('move 4, move 4','switch 3, move 4');pressure.choose('move 4, move 4','switch 3, move 4');const result=pressure.assembly();assert(result.facts.actors.filter(p=>!p.own).every(p=>result.hypotheses.opposing[p.id].pp===undefined));}finally{pressure.battle.destroy();}
});

test('alternate native ability copied onto declared Unburden cannot survive reentry as a guessed current ability',()=>{
  const f=fixture({configure:(_a,b)=>{b[0]=set('cat','Liepard','Unburden','Grassy Seed',['Knock Off','Fake Out','U-turn','Protect']);b[1]=set('grass','Rillaboom','Grassy Surge','Miracle Seed',['Wood Hammer','Grassy Glide','High Horsepower','Protect']);}});try{
    f.line('|-ability|p2a: cat|Prankster|[from] move: Skill Swap');f.receive();
    f.choose('move 4, move 4','switch 3, move 4');f.choose('move 4, move 4','switch 3, move 4');
    const result=f.assembly(),p=result.facts.actors.find(p=>!p.own&&p.species==='Liepard');assert.equal(result.coverage.unsupportedCurrentState,true);assert.equal(result.hypotheses.opposing[p.id].ability,undefined);assert.equal(result.hypotheses.opposing[p.id].lifecycle?.unburdenVolatile,undefined);
  }finally{f.battle.destroy();}
});

test('permanent Toxic Spikes use audited layers and null durations never crash source assembly',()=>{
  const f=fixture();try{
    f.line('|-sidestart|p1: Owner|Toxic Spikes');f.receive();
    assert.deepEqual(f.assembly().hypotheses.sideConditions.p1.toxicspikes,{layers:1});
    f.line('|-sidestart|p1: Owner|Toxic Spikes');f.receive();
    assert.deepEqual(f.assembly().hypotheses.sideConditions.p1.toxicspikes,{layers:2});
    f.line('|-sideend|p1: Owner|Toxic Spikes');f.receive();
    assert.equal(f.assembly().hypotheses.sideConditions?.p1?.toxicspikes,undefined);
    f.line('|-sidestart|p1: Owner|Spikes');f.receive();
    const unknown=f.assembly();
    assert(unknown.unknowns.some(row=>row.path.join('.')==='sideConditions.p1.spikes'));
    f.line('|-weather|RainDance');f.receive();
    assert(f.assembly().unknowns.some(row=>row.path.join('.')==='field.weather'));
  }finally{f.battle.destroy();}
});
function assertOwnNative(f){
  const result=f.assembly();assert.equal(result.coverage.completeHistory,true);
  for(const p of f.battle.p1.pokemon){
    const observed=actor(result,p.name);assert.ok(observed,p.name);const fragment=result.hypotheses.own[observed.id];
    assert.deepEqual(fragment.lifecycle,nativeLife(p),p.name+' lifecycle');
    assert.deepEqual(fragment.pp,p.moveSlots.map(m=>m.pp),p.name+' exact PP');
    assert.deepEqual(fragment.boosts,p.boosts,p.name+' boosts');
  }
  return result;
}

test('mechanical source assembly derives untouched reserve initial state and matches native ordinary turn history',()=>{
  const f=fixture();try{
    const initial=assertOwnNative(f),gol=actor(initial,'gol');
    assert.ok(initial.provenance.some(p=>p.path.join('.')===`own.${gol.id}.pp`&&p.origin==='native-initial-PP-complete-history'));
    f.choose('move 3 2, move 2 -1','move 4, move 4');assertOwnNative(f);
    assert.equal(initial.coverage.tacticalChoicesSelected,false);assert.equal(initial.coverage.hiddenInvestmentsSelected,false);
    assert.ok(initial.unknowns.some(u=>u.path.at(-1)==='statPoints'));assert.equal(initial.coverage.reconstructionReady,false);
  }finally{f.battle.destroy();}
});

test('mechanical lifecycle matches native chained and failed Protect without resetting bench counters',()=>{
  const f=fixture();try{
    f.choose('move 4, move 4','move 4, move 4');assertOwnNative(f);
    f.choose('move 4, move 4','move 4, move 4');assertOwnNative(f);
    f.choose('switch 3, move 1 2','move 4, move 4');
    const benched=assertOwnNative(f),toed=actor(benched,'toed');
    assert.ok(benched.hypotheses.own[toed.id].lifecycle.activeTurns>0);
    assert.equal(benched.hypotheses.own[toed.id].lifecycle.lastMove,false);
    f.choose('switch 3, move 4','move 4, move 4');assertOwnNative(f);
  }finally{f.battle.destroy();}
});

test('mechanical Choice lock and Mega form follow native current item and form events',()=>{
  const f=fixture();try{
    f.choose('switch 4, move 4','move 4, move 4');assertOwnNative(f);
    f.choose('move 1 2, move 4','move 4, move 4');const locked=assertOwnNative(f),arch=actor(locked,'arch');
    assert.equal(locked.hypotheses.own[arch.id].lifecycle.choiceLock,'dragonpulse');
    f.choose('switch 3, move 4','move 4, move 4');
    f.choose('move 2 2 mega, move 4','move 4, move 4');const mega=assertOwnNative(f),gol=actor(mega,'gol');
    assert.equal(gol.species,'Golisopod-Mega');assert.equal(gol.ability.toLowerCase().replace(/ /g,''),'toughclaws');
    assert.equal(mega.hypotheses.sideMegaUsed.p1,true);
  }finally{f.battle.destroy();}
});

test('late published sheets add only declared mechanics and never opposing investments or selected reserves',()=>{
  const f=fixture({lateSheet:true});try{
    f.choose('move 4, move 4','move 4, move 4');const result=assertOwnNative(f);
    for(const p of result.facts.actors.filter(p=>!p.own)){
      assert.ok(result.hypotheses.opposing[p.id].ability);assert.ok(result.hypotheses.opposing[p.id].pp);
      assert.equal(result.hypotheses.opposing[p.id].statPoints,undefined);assert.equal(result.hypotheses.opposing[p.id].hp,undefined);
    }
    assert.deepEqual(result.hypotheses.reserves,[]);assert.ok(result.unknowns.some(u=>u.path[0]==='reserves'));
  }finally{f.battle.destroy();}
});

test('conditional unseen reserve freshness matches actual native benches without choosing their selection',()=>{
  const f=fixture();try{
    const result=f.assembly(),eligibility=result.facts.reserveEligibility;
    assert.equal(eligibility.length,4,'two actual benches and two unselected registered candidates remain conditional');
    for(const p of f.battle.p2.pokemon.filter(p=>!p.isActive)){
      const row=eligibility.find(r=>r.species===p.species.name);assert.ok(row,p.name);
      assert.equal(row.conditionalOn,'selected-unrevealed-and-never-entered');assert.equal(row.notSelectionEvidence,true);
      assert.deepEqual(row.pp,p.moveSlots.map(m=>m.pp));assert.deepEqual(row.lifecycle,nativeLife(p));
      assert.deepEqual(row.boosts,p.boosts);assert.equal(p.hp,p.maxhp);assert.equal(row.hp,'full');
      assert.deepEqual(row.volatiles,{});assert.equal(row.status,p.status);
    }
    f.choose('move 4, move 4','switch 3, move 4');
    const entered=f.assembly();assert.equal(entered.facts.reserveEligibility.some(r=>r.species==='Politoed'),false);
    f.tracker.invalidate('History lost');assert.deepEqual(f.assembly().facts.reserveEligibility,[]);
  }finally{f.battle.destroy();}
});

test('public denial, pre-action KO and replacement preserve native move counters and retained fainted PP',()=>{
  const denied=fixture({ownOrder:'1432'});try{
    denied.choose('move 1 2, move 2 2','move 3 1, move 4');
    const result=assertOwnNative(denied),toed=actor(result,'toed');
    assert.equal(result.hypotheses.own[toed.id].lifecycle.activeMoveActions,1);
    assert.equal(result.hypotheses.own[toed.id].lifecycle.lastMove,false);
  }finally{denied.battle.destroy();}
  const ko=fixture({ownOrder:'3124'});try{
    ko.choose('move 2 2, move 4','move 1 1 mega, move 4');
    assert.equal(ko.battle.p1.pokemon.find(p=>p.name==='gol').fainted,true);
    ko.replace('p1','switch 3, pass');const result=assertOwnNative(ko),gol=actor(result,'gol');
    assert.equal(result.hypotheses.own[gol.id].lifecycle.activeMoveActions,0);
    assert.equal(result.hypotheses.own[gol.id].lifecycle.lastMove,false);
  }finally{ko.battle.destroy();}
});

test('native holder-first Armor Tail denial keeps switched holder lifecycle and denied Encore PP exactly once',()=>{
  const f=fixture({ownOrder:'6123',configure(_own,foe){foe[0]=set('whim','Whimsicott','Prankster','Focus Sash',['Encore','Tailwind','Moonblast','Protect'],{hp:32,atk:0,def:0,spa:2,spd:0,spe:32});}});
  try{
    f.choose('move 4, move 4','move 4, move 4');assertOwnNative(f);
    f.choose('move 3 1, switch 3','move 1 2, move 1 1');
    const assembly=assertOwnNative(f),board=f.source().observed.boards[0];
    assert(board.recentEvents.lines.some(line=>line==='|cant|p1b: fari|ability: Armor Tail|Encore|[of] p2a: whim'));
    assert.equal(assembly.coverage.auditedHistory,true);assert.equal(assembly.coverage.historyProblems.some(p=>p.code==='unsupported-denial'),false);assert(assembly.facts.reserveEligibility.length>0);
    const holder=f.battle.p1.pokemon.find(p=>p.name==='fari'),holderId=actor(assembly,'fari').id;
    assert.equal(holder.activeMoveActions,0);assert.equal(assembly.hypotheses.own[holderId].lifecycle.activeMoveActions,0);assert.equal(assembly.hypotheses.own[holderId].lifecycle.lastMove,false);
    for(const p of f.battle.p2.pokemon.filter(p=>p.isActive)){
      const id=board.sides[1].pokemon.find(q=>q.nickname===p.name).id,h=assembly.hypotheses.opposing[id];
      assert.deepEqual(h.lifecycle,nativeLife(p),p.name);assert.deepEqual(h.pp,p.moveSlots.map(m=>m.pp),p.name);
    }
    assert.equal(f.battle.p2.pokemon.find(p=>p.name==='whim').lastMove.name,'Encore');
  }finally{f.battle.destroy();}
});

test('malformed holder-first attribution stays unaudited rather than inventing a denied attempt',()=>{
  const f=fixture();try{
    f.line('|cant|p1b: fari|ability: Armor Tail|Encore|[of] p2a: rai');f.receive();
    const assembly=f.assembly();assert.equal(assembly.coverage.auditedHistory,false);assert.equal(assembly.facts.reserveEligibility.length,0);assert(assembly.coverage.historyProblems.some(p=>p.code==='unsupported-denial'));
  }finally{f.battle.destroy();}
});

test('native Encore history retains its locked move and remaining duration through expiry',()=>{
  const f=fixture({ownOrder:'1634',configure(_own,foe){foe[0]=set('whim','Whimsicott','Prankster','Focus Sash',['Encore','Tailwind','Moonblast','Protect'],{hp:32,atk:0,def:0,spa:2,spd:0,spe:32});}});
  try{
    f.choose('move 3 2, move 4','move 4, move 4');assertOwnNative(f);
    f.choose('move 1 2, move 4','move 1 1, move 4');
    const locked=f.battle.p1.pokemon.find(p=>p.name==='toed');assert(locked.volatiles.encore);
    for(let remaining=2;remaining>=1;remaining--){
      const result=assertOwnNative(f),p=actor(result,'toed');
      assert.equal(result.coverage.auditedHistory,true);assert.equal(result.coverage.unsupportedCurrentState,false);
      assert.deepEqual(result.hypotheses.own[p.id].volatiles.encore,{move:locked.lastMove.name,remainingTurns:locked.volatiles.encore.duration});
      assert.equal(locked.volatiles.encore.duration,remaining);
      f.choose('move 3 2, move 4','move 4, move 4');
    }
    const ended=assertOwnNative(f),p=actor(ended,'toed');assert.equal(locked.volatiles.encore,undefined);assert.deepEqual(ended.hypotheses.own[p.id].volatiles,{});
  }finally{f.battle.destroy();}
});

test('native Encore after the target already acted retains the extra native duration',()=>{
  const f=fixture({ownOrder:'1634',configure(_own,foe){foe[0]=set('whim','Whimsicott','Infiltrator','Lagging Tail',['Encore','Tailwind','Moonblast','Protect'],{hp:32,atk:0,def:0,spa:2,spd:0,spe:32});}});
  try{
    f.choose('move 3 2, move 4','move 4, move 4');
    f.choose('move 3 2, move 4','move 1 1, move 4');
    const locked=f.battle.p1.pokemon.find(p=>p.name==='toed'),result=assertOwnNative(f),p=actor(result,'toed');
    assert(locked.volatiles.encore);assert.equal(locked.volatiles.encore.duration,3);
    assert.deepEqual(result.hypotheses.own[p.id].volatiles.encore,{move:'Ice Beam',remainingTurns:3});
    f.choose('switch 3, move 4','move 4, move 4');const exited=assertOwnNative(f);assert.deepEqual(exited.hypotheses.own[p.id].volatiles,{});
  }finally{f.battle.destroy();}
});

test('native Choice-item removal clears the current lock without discarding other known history',()=>{
  const f=fixture({ownOrder:'4123',configure(_own,foe){foe[0]=set('incin','Incineroar','Intimidate','Sitrus Berry',['Knock Off','Darkest Lariat','Parting Shot','Protect'],{hp:32,atk:32,def:0,spa:0,spd:2,spe:0});}});
  try{
    f.choose('move 1 2, move 4','move 1 1, move 4');const result=assertOwnNative(f),arch=actor(result,'arch');
    assert.equal(arch.item,'');assert.equal(result.hypotheses.own[arch.id].lifecycle.choiceLock,false);
  }finally{f.battle.destroy();}
});

test('native Shed Tail keeps known public state while Substitute is active and after its observed removal',()=>{
  const f=fixture({configure(_own,foe){foe[0]=set('worm','Orthworm','Earth Eater','Sitrus Berry',['Shed Tail','Body Press','Heavy Slam','Protect'],{hp:32,atk:0,def:32,spa:0,spd:2,spe:0});}});
  try{
    f.choose('move 4, move 4','move 1, move 4');assert.equal(f.battle.requestState,'switch');
    f.replace('p2','switch 3, pass');const covered=assertOwnNative(f);
    const source=f.source(),incoming=source.observed.boards[0].sides[1].pokemon.find(p=>p.nickname==='foe-toed');
    assert.ok(f.battle.p2.pokemon.find(p=>p.name==='foe-toed').volatiles.substitute,'independent native state has the copied Substitute');
    assert.equal(incoming.volatiles.substitute,undefined,'existing public reducer alone loses this silent copied effect');
    const overlaid=applyChoiceStateOverrides({observed:source.observed,assembly:covered}),sub=overlaid.boards[0].sides[1].pokemon.find(p=>p.id===incoming.id);
    assert.ok(sub.volatiles.substitute);assert.equal(covered.coverage.unsupportedCurrentState,true);assert.ok(covered.unknowns.some(u=>u.path.join('.')===`opposing.${sub.id}.volatiles`));
    assert.ok(covered.hypotheses.opposing[sub.id].lifecycle);assert.ok(covered.hypotheses.opposing[sub.id].pp);
    f.choose('move 3 1, move 1 1','move 3 2, move 2 -1');const uncovered=assertOwnNative(f);
    const current=f.source().observed.boards[0].sides[1].pokemon.find(p=>p.id===sub.id);
    assert.equal(current.volatiles.substitute,undefined);
    assert.deepEqual(uncovered.hypotheses.opposing[sub.id].volatiles,{});
    assert.deepEqual(uncovered.observedOverrides,[]);assert.equal(uncovered.coverage.unsupportedCurrentState,false);
    assert.equal(uncovered.coverage.historyProblems.some(p=>p.code==='unsupported-move-history'),false);
    for(const p of f.battle.p2.pokemon){
      const publicActor=f.source().observed.boards[0].sides[1].pokemon.find(o=>o.nickname===p.name);if(!publicActor)continue;
      const h=uncovered.hypotheses.opposing[publicActor.id];
      assert.deepEqual(h.lifecycle,nativeLife(p),p.name+' lifecycle');assert.deepEqual(h.pp,p.moveSlots.map(m=>m.pp),p.name+' PP');
    }
  }finally{f.battle.destroy();}
});

test('capture is immutable, privately branded and rejects stale/private-source/identity/reservation drift',()=>{
  const f=fixture();try{
    const source=f.source(),before=structuredClone(source),digest=sha(source),receipt=f.tracker.capture(source),one=assembleChoiceState(receipt);
    assert.deepEqual(source,before);assert.equal(sha(source),digest);
    one.hypotheses.own={};assert.notDeepEqual(assembleChoiceState(receipt).hypotheses.own,{});
    assert.throws(()=>assembleChoiceState(copy(receipt)),/unbranded/);
    for(const mutate of [s=>s.observed.sessionId='foreign',s=>s.expected.teamId='f'.repeat(64),s=>s.expected.rqid++,s=>s.observed.actions[0].submissionStatus='uncertain',s=>s.observed.actions[0].legalActions.pokemon[0].condition='1/197',s=>s.observed.actions[0].legalActions.active[0].moves[0].pp--,s=>s.observed.boards[0].request.forceSwitch=[true,false],s=>s.opposingSheet[0].moves[0]='Protect',s=>s.observed.boards[0].sides[0].pokemon[0].nickname='foreign']){
      const changed=copy(source);mutate(changed);assert.throws(()=>f.tracker.capture(changed));
    }
    f.line('|message|new receive boundary');assert.throws(()=>assembleChoiceState(receipt),/no longer the current/);
  }finally{f.battle.destroy();}
});

test('lost/unsupported history withholds derived counters and PP while retaining fresh private active PP',()=>{
  for(const kind of ['gap','epoch','called','volatile']){
    const f=fixture();try{
      if(kind==='gap')f.tracker.observeLine('|message|gap',{...f.meta(),sequence:999});
      else if(kind==='epoch')f.tracker.observeLine('|message|epoch',{...f.meta(),epoch:2});
      else if(kind==='called')f.line('|move|p1a: toed|Ice Beam|p2a: rai|[from] move: Sleep Talk');
      else f.line('|-start|p1a: toed|Encore');
      if(['called','volatile'].includes(kind))f.choose('move 4, move 4','move 4, move 4');
      const result=f.assembly(),toed=actor(result,'toed'),gol=actor(result,'gol');
      assert.equal(result.hypotheses.own[toed.id].lifecycle,undefined,kind);
      assert.deepEqual(result.hypotheses.own[toed.id].pp,f.battle.p1.active[0].moveSlots.map(m=>m.pp));
      assert.equal(result.hypotheses.own[gol.id].pp,undefined,kind+' cannot invent reserve PP');
      assert.ok(result.coverage.historyProblems.length>0);
    }finally{f.battle.destroy();}
  }
});

test('data-only option/source guards do not invoke getters or accept fake history',()=>{
  let invoked=0;assert.throws(()=>createChoiceStateHistory(Object.defineProperty({},'sessionId',{enumerable:true,get(){invoked++;return sessionId;}})),/data-only/);assert.equal(invoked,0);
  assert.throws(()=>assembleChoiceState({kind:'owned-choice-state-snapshot-v1',binding:{}}),/unbranded/);
});

test('missing start prefix leaves never-used reserve PP and lifecycle unknown without overriding fresh active PP',()=>{
  const f=fixture({omitStart:true});try{
    const result=f.assembly(),toed=actor(result,'toed'),gol=actor(result,'gol');
    assert.equal(result.coverage.completeHistory,false);
    assert.deepEqual(result.hypotheses.own[toed.id].pp,f.battle.p1.active[0].moveSlots.map(m=>m.pp));
    assert.equal(result.hypotheses.own[gol.id].pp,undefined);assert.equal(result.hypotheses.own[gol.id].lifecycle,undefined);
  }finally{f.battle.destroy();}
});

test('exact hash-bound overlays reject changed input/output and do not replace observed facts',()=>{
  const f=fixture();try{
    const source=f.source(),assembly=f.assembly(),before=structuredClone(source.observed),hash=sha(source.observed);
    assert.deepEqual(applyChoiceStateOverrides({observed:source.observed,assembly}),copy(source.observed));
    assert.deepEqual(source.observed,before);assert.equal(sha(source.observed),hash);
    const changed=copy(source.observed);changed.revision++;
    assert.throws(()=>applyChoiceStateOverrides({observed:changed,assembly}),/source\/assembly hash differs/);
    const altered=copy(assembly);altered.binding.assembledObservedSha256='0'.repeat(64);
    assert.throws(()=>applyChoiceStateOverrides({observed:source.observed,assembly:altered}),/assembled source hash differs/);
    const receipt=f.tracker.capture(source);f.tracker.invalidate('Explicit native disconnect');
    assert.throws(()=>assembleChoiceState(receipt),/no longer the current/);
  }finally{f.battle.destroy();}
});

test('bounded move journal copies actual native pre-action state and immediate exact own HP changes',t=>{
  const f=fixture({ownOrder:'1432'});try{
    f.choose('move 3 2, move 1 2','move 2 1 mega, move 4');
    const journal=f.tracker.journalSnapshot(),frame=journal.frames.find(row=>row.moveName==='Focus Blast');assert.ok(frame);
    assert.equal(frame.events[0].type,'move');assert.deepEqual(frame.events[0].tags,[]);
    const attacker=frame.before.actors.find(a=>a.id===frame.actorId),target=frame.before.actors.find(a=>frame.targetIds.includes(a.id));
    assert.equal(attacker.species,'Raichu-Mega-Y');assert.equal(attacker.abilityKnown,true);assert.equal(attacker.itemKnown,true);
    assert.equal(target.own,true);assert.equal(target.ownSet.species,'Politoed');assert.equal(target.hp.precision,'server-own-exact');
    assert.equal(frame.before.field.weather.name,'RainDance');
    const hit=frame.events.find(event=>event.type==='-damage'&&event.pokemonId===target.id);assert.ok(hit);
    assert.equal(hit.beforeHp.precision,'server-own-exact');assert.equal(hit.afterHp.precision,'server-own-exact');
    assert.equal(hit.beforeHp.current,target.hp.current);assert.ok(hit.afterHp.current<hit.beforeHp.current);
    assert.equal(frame.complete,true);assert.equal(journal.turns.find(row=>row.turn===frame.turn).complete,true);
    for(const row of journal.frames){const {sha256,...body}=row;assert.equal(sha256,sha(body));assert.equal(row.source.fullHistory,true);assert.equal(row.source.auditedHistory,true);}
    const assembly=f.assembly();assert.equal(assembly.journal,undefined);assert.equal(assembly.facts.journal,undefined,'raw bounded frames stay inside native owner');
    const observations=Object.values(assembly.facts.spreadObservations).flat();
    assert.ok(observations.some(row=>row.kind==='move-order'));assert.ok(observations.some(row=>row.kind==='damage'));
    assert.equal(assembly.spreadEvidence.coverage.calculationsRun,0);
    t.diagnostic(JSON.stringify({kind:'owned-native-journal-to-compiler',speedConstraints:assembly.spreadEvidence.coverage.speedConstraints,damageConstraints:assembly.spreadEvidence.coverage.damageConstraints,actualMcpCalls:0,rawJournalEmitted:false}));
    journal.frames[0].events=[];assert.notDeepEqual(f.tracker.journalSnapshot().frames[0].events,[]);
  }finally{f.battle.destroy();}
});

test('native journal stays bounded to eight turns and sixty-four move frames without changing source facts',()=>{
  const f=fixture();try{
    for(let i=0;i<8;i++)f.choose('move 4, move 4','move 4, move 4');
    f.choose('switch 3, switch 4','switch 3, switch 4');
    for(let i=0;i<8;i++)f.choose('move 4, move 1 2','move 4, move 4');
    f.choose('move 2 1 mega, move 1 2','move 3 1, move 1');
    assert.deepEqual(f.battle.p1.activeRequest.forceSwitch,[false,true]);
    f.replace('p1','pass, switch 3');
    const journal=f.tracker.journalSnapshot();assert.ok(journal.frames.length<=64);assert.ok(journal.turns.length<=8);
    assert.ok(journal.coverage.framesDropped>0);assert.ok(journal.coverage.turnsDropped>0);
    assert.ok(journal.frames.every(frame=>frame.turn>=f.battle.turn-7));
    assert.equal(f.battle.requestState,'move');
    assertOwnNative(f);
  }finally{f.battle.destroy();}
});

test('journal retains called, critical, multihit, residual and forced-order markers without inventing damage',()=>{
  const f=fixture();try{
    f.line('|-activate|p2a: rai|item: Quick Claw');
    f.line('|move|p2a: rai|Focus Blast|p1a: toed|[from] move: Sleep Talk');
    f.line('|-crit|p1a: toed');f.line('|-hitcount|p1a: toed|2');
    f.line('|-damage|p1a: toed|190/197|[from] Sandstorm');
    f.line('|upkeep');f.line('|turn|2');
    const journal=f.tracker.journalSnapshot(),frame=journal.frames.at(-1);
    assert.ok(frame.before.turnEvents.some(event=>event.type==='-activate'&&event.data.includes('item: Quick Claw')));
    assert.ok(frame.events[0].tags.includes('[from] move: Sleep Talk'));
    assert.ok(frame.events.some(event=>event.type==='-crit'));assert.ok(frame.events.some(event=>event.type==='-hitcount'));
    assert.ok(frame.events.some(event=>event.type==='-damage'&&event.tags.includes('[from] Sandstorm')));
    assert.equal(frame.source.auditedHistory,false,'synthetic called-action ambiguity cannot become a qualified filter');
  }finally{f.battle.destroy();}
});
