// Actual local native histories; no model, SDK, login or network battle.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {compileSpreadObservations as compile,verifySpreadAttackerHpIrrelevance} from './spread-observations.mjs';
import {spreadCandidateObservationSchema,generateSpreadCandidates} from './spread-candidates.mjs';
import {createNativeSpreadHistory as nativeHistory,spreadFixtureRoom as room,spreadFixtureSession as sessionId} from './spread-observations.fixture.mjs';
const copy=value=>JSON.parse(JSON.stringify(value)),sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rows=report=>Object.values(report.spreadObservations).flat();
const rehash=frame=>{const {sha256,...body}=frame;frame.sha256=sha(body);};

test('actual owned native history compiles ordinary order and exact own HP bookkeeping without hidden HP or numerical calls',()=>{
  const f=nativeHistory();try{
    const before=copy(f.input),report=compile(f.input),all=rows(report),damage=all.filter(o=>o.kind==='damage'),orders=all.filter(o=>o.kind==='move-order');
    assert(orders.length>0,JSON.stringify(report.ignoredConstraints));assert(damage.length>0,JSON.stringify(report.ignoredConstraints));
    assert(all.every(o=>spreadCandidateObservationSchema.safeParse(o).success));assert(all.every(o=>o.sourceSha256===f.assembly.binding.sourceSha256));
    for(const o of damage){assert.equal(o.verification.attackerHpIrrelevant,true);assert.equal(o.input.attackerOptions.curHP,undefined);assert.equal(o.input.attackerOptions.nature,undefined);assert.equal(o.input.attackerOptions.evs,undefined);assert(Number.isInteger(o.input.defenderOptions.curHP));
      const proof=report.provenance.find(p=>p.observationId===o.id),frame=f.journal.frames.find(frame=>frame.sha256===proof.frameSha256[0]),hit=frame.events.find(e=>e.type==='-damage');assert.equal(o.amount,hit.beforeHp.current-hit.afterHp.current);}
    assert.equal(report.coverage.calculationsRun,0);assert.deepEqual(f.input,before);assert.equal(report.candidates,undefined);
  }finally{f.battle.destroy();}
});

test('frame integrity, capture continuity and scope changes withhold observations rather than inventing history',()=>{
  const f=nativeHistory();try{
    for(const mutate of [input=>input.journal.coverage.completeHistory=false,input=>input.journal.coverage.auditedHistory=false,input=>input.binding.teamId='b'.repeat(64),input=>input.binding.epoch++,input=>input.journal.frames.forEach(frame=>frame.sha256='b'.repeat(64))]){
      const input=copy(f.input);mutate(input);const report=compile(input);assert.equal(rows(report).length,0);assert(report.ignoredConstraints.length>0);
    }
  }finally{f.battle.destroy();}
});

test('native-frame countercases reject crit, multihit, residual/called damage and rounded or capped own HP',()=>{
  const f=nativeHistory();try{
    const baseline=compile(f.input),observation=rows(baseline).find(o=>o.kind==='damage'),proof=baseline.provenance.find(p=>p.observationId===observation.id);
    for(const mutate of [
      frame=>frame.events.push({type:'-crit',sequence:frame.sequence+1,pokemonId:frame.targetIds[0],data:[],tags:[]}),
      frame=>frame.events.push({type:'-hitcount',sequence:frame.sequence+1,pokemonId:frame.targetIds[0],data:[],tags:[]}),
      frame=>frame.events.find(e=>e.type==='-damage').tags.push('[from] psn'),
      frame=>frame.events.find(e=>e.type==='move').tags.push('[from] move: Sleep Talk'),
      frame=>frame.events.find(e=>e.type==='-damage').afterHp.precision='server-display',
      frame=>frame.events.find(e=>e.type==='-damage').afterHp.current=0,
      frame=>{const target=frame.before.actors.find(p=>p.id===frame.targetIds[0]);target.substitute=true;target.volatiles.substitute={name:'Substitute'};},
    ]){const input=copy(f.input),frame=input.journal.frames.find(frame=>frame.sha256===proof.frameSha256[0]);mutate(frame);rehash(frame);const report=compile(input);assert(!rows(report).some(o=>o.id===observation.id));}
  }finally{f.battle.destroy();}
});

test('unknown weather/modifiers, forced order, changed snapshots, form and own investment ambiguity never become filters',()=>{
  const f=nativeHistory();try{
    for(const mutate of [
      input=>input.journal.frames.forEach(frame=>{frame.before.field.weather={name:'Unknown weather'};rehash(frame);}),
      input=>input.journal.frames.forEach(frame=>{frame.before.actors.forEach(p=>p.abilityKnown=false);rehash(frame);}),
      input=>input.journal.turns.forEach(turn=>turn.events.push({type:'-activate',sequence:999,turn:turn.turn,data:['p1a: own','item: Quick Claw'],tags:[]})),
      input=>input.journal.turns.forEach(turn=>turn.events.push({type:'-enditem',sequence:999,turn:turn.turn,data:['p1a: own','Custap Berry','[eat]'],tags:['[eat]']})),
      input=>input.journal.frames.forEach(frame=>{frame.before.actors.forEach(p=>{if(p.own&&p.ownSet)delete p.ownSet.nature;});rehash(frame);}),
      input=>input.currentActors.forEach(p=>{if(!p.own)p.species='Unobserved current form';}),
    ]){const input=copy(f.input);mutate(input);assert.equal(rows(compile(input)).length,0);}
  }finally{f.battle.destroy();}
});

test('HP-independent template proof rejects dependent move/ability/item countercases without guessing current HP',()=>{
  const f=nativeHistory();try{
    const observed=rows(compile(f.input)).find(o=>o.kind==='damage');assert(verifySpreadAttackerHpIrrelevance(observed.input).supported);
    for(const mutate of [args=>args.move='Water Spout',args=>args.attackerOptions.ability='Blaze',args=>args.attackerOptions.item='Liechi Berry']){const input=copy(observed.input);mutate(input);assert.equal(verifySpreadAttackerHpIrrelevance(input).supported,false);assert.equal(input.attackerOptions.curHP,undefined);}
  }finally{f.battle.destroy();}
});

test('compiler templates reach injected numeric generator without inserting opposing HP; fake calls prove no actual MCP qualification',async()=>{
  const f=nativeHistory();try{
    const compiled=compile(f.input),observation=rows(compiled).find(o=>o.kind==='damage'),log=[];
    const report=await generateSpreadCandidates({source:{teamId:f.input.binding.teamId,sessionId,parentId:'synthetic-parent',gameId:room,sourceSha256:f.input.binding.sourceSha256},publishedSet:{species:observation.currentForme,nature:'Modest',ability:'Armor Tail',item:'Sitrus Berry',moves:['Psychic','Helping Hand','Trick Room','Protect']},currentForme:observation.currentForme,conditions:{frameSource:compiled.binding.journalSha256},relevantMoves:[{name:'Psychic',category:'Special'}],observations:[observation],poolLimit:2,maxCalls:2},
      {deadlineAt:Date.now()+5000,call:async(tool,args)=>{log.push({tool,args});return {structuredContent:{gen:0,contractVersion:'champions-damage-v2',damage:[observation.amount]}};}});
    assert.equal(log.length,2);assert(log.every(entry=>entry.tool==='calculate_damage'&&entry.args.attackerOptions.curHP===undefined));assert.equal(report.ignoredConstraints.length,0);assert(report.records.every(r=>/not an observed HP fact/.test(r.hpSemantics)));assert.equal(report.provenance.actualSdkReceiptVerified,false);
  }finally{f.battle.destroy();}
});

test('bounded compiler rejects getters, proxies and ambiguous actor mapping without executing callbacks',()=>{
  let accessed=0;const input={};Object.defineProperty(input,'journal',{enumerable:true,get(){accessed++;throw new Error('must not run');}});assert.throws(()=>compile(input),/data properties/);
  const proxy=new Proxy({}, {ownKeys(){accessed++;throw new Error('must not run');}});assert.throws(()=>compile(proxy),/finite journal/);assert.equal(accessed,0);
  const f=nativeHistory();try{const input=copy(f.input);input.currentActors[1].historyId=input.currentActors[0].historyId;assert.throws(()=>compile(input),/unique current/);}finally{f.battle.destroy();}
});
