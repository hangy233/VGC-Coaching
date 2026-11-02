import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTurnFacts} from './board.mjs';
import {buildCandidates} from './candidates.mjs';
import {planningFixture} from './fixtures.mjs';
import {validateChoice} from '../showdown/choice-validation.mjs';

const build=(input,limit=6)=>buildCandidates(buildTurnFacts(input),{maxCandidates:limit});
const canonical=(input,actions)=>validateChoice({...input.legalActions,side:{pokemon:input.legalActions.pokemon}},actions).actions;
const attack=(move,target='normal')=>({move,target,pp:10});

test('six candidates retain available purposes before optional complete move/form diversity',()=>{
  const input=planningFixture();input.legalActions.active[0].canMegaEvo=true;
  const before=structuredClone(input),three=build(input,3),six=build(input,6);
  assert.deepEqual(input,before);assert.deepEqual(build(input,3),three);assert.deepEqual(build(input,6),six);
  assert(six.candidates.length<=6);assert.equal(new Set(six.candidates.map(row=>JSON.stringify(row.actions))).size,six.candidates.length);
  for(const row of three.candidates)assert(six.candidates.some(candidate=>candidate.purpose===row.purpose));
  for(const purpose of ['attack-pressure','denial-plus-progress','protect-plus-progress','switch-plus-progress','control-plus-progress'])assert(six.candidates.some(row=>row.purpose===purpose),purpose);
  assert(six.candidates.some(row=>row.actions.some(action=>action.mega)));
  for(const row of six.candidates){assert.deepEqual(canonical(input,row.actions),row.actions);assert(row.actions.filter(action=>action.mega).length<=1);if(row.actions.some(action=>action.mega))assert(row.warnings.some(value=>/Optional own Mega.*post-Mega.*unresolved/.test(value)));}
  assert.equal(build(input,99).candidates.length,6);assert.equal(six.coverage.variants.postMegaEffectsVerified,false);
});

test('different supported move and target pairs do not collapse to the first legal option',()=>{
  const input=planningFixture();input.objective={};
  input.legalActions.active[0].moves=[attack('Dark Pulse'),attack('Flamethrower')];input.legalActions.active[0].canMegaEvo=true;
  input.legalActions.active[1].moves=[attack('Psychic'),attack('Protect','self')];
  const result=build(input);
  assert(result.candidates.some(row=>row.actions[0].slot===2&&row.actions[0].mega&&row.actions[0].target===1&&row.actions[1].slot===1&&row.actions[1].target===1));
  assert(result.candidates.some(row=>row.actions[0].target===2||row.actions[1].target===2));
  assert(result.candidates.every(row=>row.actions.length===2));
});

test('typed objective ordering uses current identities and preserves a named resource without a safety verdict',()=>{
  const input=planningFixture();input.objective={targets:['p2-wash'],preserve:['p1-dragon'],requiredActors:['p1-cat'],description:'This prose does not select another move or reserve.'};
  const result=build(input),first=result.candidates[0];
  assert.equal(first.purpose,'protect-plus-progress');assert.deepEqual(first.actions[1],{type:'move',slot:3});assert.equal(first.actions[0].target,2);
  assert(first.warnings.some(value=>/delivery/.test(value)));
  const unknown=structuredClone(input);unknown.objective={targets:['unknown-target','registered:p2:3'],preserve:['unknown-own'],requiredActors:['unknown-own']};
  const neutral=structuredClone(input);neutral.objective={};assert.deepEqual(build(unknown),build(neutral));
  assert(!JSON.stringify(result).includes('safe entry established'));
});

test('Mega unavailable, already-used and disabled/locked actions remain excluded; no pair uses both Megas',()=>{
  for(const alter of [()=>{},input=>{input.legalActions.active[0].canMegaEvo=true;input.board.sides[0].megaUsed=true;}]){
    const input=planningFixture();alter(input);assert(build(input).candidates.every(row=>row.actions.every(action=>!action.mega)));
  }
  const input=planningFixture();for(const active of input.legalActions.active)active.canMegaEvo=true;
  input.legalActions.active[0].moves[1].disabled=true;input.legalActions.active[1].moves[1].pp=0;
  input.board.sides[0].pokemon[0].lifecycle={choiceLockedMove:'fakeout'};
  const result=build(input);
  for(const row of result.candidates){assert(row.actions.filter(action=>action.mega).length<=1);if(row.actions[0].type==='move')assert.equal(row.actions[0].slot,1);if(row.actions[1].type==='move')assert.notEqual(row.actions[1].slot,2);canonical(input,row.actions);}
});

test('current type/ability blocks remain categorical for base form but unresolved for a selected own Mega',()=>{
  const input=planningFixture();input.objective={};
  input.legalActions.active[0].moves=[attack('Tackle')];input.legalActions.active[0].canMegaEvo=true;
  input.legalActions.active[1].moves=[attack('Protect','self')];
  for(const raw of input.board.sides[1].pokemon)Object.assign(raw,{species:'Gengar',ability:'Cursed Body'});
  input.opponentSheet=[{species:'Gengar',ability:'Cursed Body',item:'',moves:['Shadow Ball']}];
  const result=build(input);
  assert(result.coverage.knownBlockedOptions.some(row=>/type-immune/.test(row.reason)));
  assert(result.candidates.length>0);assert(result.candidates.every(row=>row.actions[0].mega===true));
  assert(result.candidates.every(row=>row.warnings.some(value=>/Current-form eligibility is unresolved/.test(value))));
  delete input.legalActions.active[0].canMegaEvo;assert.equal(build(input).candidates.length,0);
});

test('a selected Mega does not transplant current field eligibility to the partner or select registered reserves',()=>{
  const input=planningFixture();input.objective={};
  input.legalActions.active[0].moves=[attack('Dark Pulse')];input.legalActions.active[0].canMegaEvo=true;
  input.legalActions.active[1].moves=[attack('Flamethrower')];input.board.field.weather='Primordial Sea';
  const result=build(input);assert(result.candidates.some(row=>row.actions[0].mega&&row.actions[1].slot===1));
  assert(result.candidates.filter(row=>row.actions[0].mega&&row.actions[1].type==='move').every(row=>row.warnings.some(value=>/Current-form eligibility is unresolved.*extreme weather/.test(value))));
  input.board.sides[0].selectionKnowledge='unknown';input.board.sides[0].pokemon[2].selection='unknown';input.legalActions.pokemon[2].active=false;
  assert(build(input).candidates.every(row=>row.actions.every(action=>action.type!=='switch')));
  assert(result.candidates.every(row=>row.actions.filter(action=>action.target>0).every(action=>[1,2].includes(action.target))));
});
