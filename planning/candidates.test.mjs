import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTurnFacts} from './board.mjs';
import {buildCandidates,competingFakeOutWarnings,stagedPairFakeOutWarnings,stagedPairDependencyWarnings} from './candidates.mjs';
import {validateChoice} from '../showdown/choice-validation.mjs';
import {planningFixture} from './fixtures.mjs';

const build = input => buildCandidates(buildTurnFacts(input));
const request = legal => ({...legal,side:{pokemon:legal.pokemon}});
const isMove = (candidate,index,slot) => candidate.actions[index]?.type === 'move' && candidate.actions[index].slot === slot;

function competingFixture(){
  const input=planningFixture();
  Object.assign(input.board.sides[1].pokemon[0],{species:'Raichu',ability:'Lightning Rod'});
  input.opponentSheet[0]={species:'Raichu',ability:'Lightning Rod',item:'Raichunite X',moves:['Fake Out','Protect']};
  return input;
}

test('competing Fake Out is a zero-number paired-delivery caution, including unknown first-turn eligibility',()=>{
  const input=competingFixture(),before=structuredClone(input),warnings=competingFakeOutWarnings(buildTurnFacts(input));
  assert.deepEqual(warnings,[{code:'COMPETING_FAKE_OUT',actorId:'p1-cat',firstTurnEligibility:'unknown',opposing:[{actorId:'p2-chomp',firstTurnEligibility:'unknown'}]}]);
  assert.deepEqual(input,before);
  input.board.sides[0].pokemon[0].lifecycle={activeMoveActions:0};input.board.sides[1].pokemon[0].lifecycle={activeTurns:1};
  assert.equal(competingFakeOutWarnings(buildTurnFacts(input))[0].firstTurnEligibility,'eligible');
  assert.equal(competingFakeOutWarnings(buildTurnFacts(input))[0].opposing[0].firstTurnEligibility,'unknown');
});

test('proven Fake Out ineligibility and known active priority protection suppress the current competing-control caution',()=>{
  for(const change of [
    input=>{input.board.sides[1].pokemon[0].lifecycle={activeMoveActions:1};},
    input=>{input.board.sides[0].pokemon[0].lifecycle={fakeOutEligible:false};},
    input=>{input.board.sides[0].pokemon[1].ability='Armor Tail';},
    input=>{input.board.sides[0].pokemon[0].ability='Inner Focus';},
  ]){const input=competingFixture();change(input);assert.deepEqual(competingFakeOutWarnings(buildTurnFacts(input)),[]);}
  for(const change of [
    input=>{input.board.sides[0].pokemon[2].ability='Armor Tail';},
    input=>{Object.assign(input.board.sides[0].pokemon[1],{ability:'Armor Tail',abilitySuppressed:true});},
    input=>{Object.assign(input.board.sides[0].pokemon[1],{ability:'Armor Tail',fainted:true});},
  ]){const input=competingFixture();change(input);assert.equal(competingFakeOutWarnings(buildTurnFacts(input)).length,1);}
});

function stagedPressureFixture(){
  const input=competingFixture(),own=input.board.sides[0].pokemon;
  Object.assign(own[0],{species:'Golisopod-Mega',ability:'Tough Claws'});
  Object.assign(own[1],{species:'Rillaboom',ability:'Grassy Surge'});
  input.legalActions.active[0].moves=[{move:'Protect',target:'self',pp:10}];
  input.legalActions.active[1].moves=[{move:'High Horsepower',target:'normal',pp:10}];
  input.board.sides[1].pokemon[0].lifecycle={activeMoveActions:0};
  return input;
}
const stagedPressurePair=[{type:'move',slot:1},{type:'move',slot:1,target:1}];

test('selected sole attack beside Protect exposes eligible or unknown opposing Fake Out without choosing a strategy',()=>{
  const input=stagedPressureFixture(),before=structuredClone(input),pair=structuredClone(stagedPressurePair),ctx=buildTurnFacts(input);
  assert.deepEqual(stagedPairFakeOutWarnings(ctx,pair),[{code:'STAGED_SOLE_ATTACK_FAKE_OUT',actorId:'p1-dragon',move:'High Horsepower',protectingActorId:'p1-cat',opposing:[{actorId:'p2-chomp',firstTurnEligibility:'eligible'}]}]);
  assert.deepEqual(input,before);assert.deepEqual(pair,stagedPressurePair);
  input.board.sides[1].pokemon[0].lifecycle={activeTurns:1};
  assert.equal(stagedPairFakeOutWarnings(buildTurnFacts(input),pair)[0].opposing[0].firstTurnEligibility,'unknown');
});

test('selected attack Fake Out warning respects current blockers, immunity and known ineligibility, never a reserve blocker',()=>{
  for(const change of [
    input=>{input.board.sides[0].pokemon[0].ability='Armor Tail';},
    input=>{input.board.sides[0].pokemon[1].ability='Inner Focus';},
    input=>{input.board.sides[0].pokemon[1].ability='Shield Dust';},
    input=>{input.board.sides[0].pokemon[1].species='Dragapult';},
    input=>{input.board.sides[1].pokemon[0].lifecycle={activeMoveActions:1};},
    input=>{input.board.field.terrain={name:'Psychic Terrain'};input.board.sides[0].pokemon[1].itemKnown=true;input.board.sides[0].pokemon[1].item='Miracle Seed';},
  ]){const input=stagedPressureFixture();change(input);assert.deepEqual(stagedPairFakeOutWarnings(buildTurnFacts(input),stagedPressurePair),[]);}
  for(const change of [
    input=>{input.board.sides[0].pokemon[2].ability='Armor Tail';},
    input=>{Object.assign(input.board.sides[0].pokemon[0],{ability:'Armor Tail',abilitySuppressed:true});},
  ]){const input=stagedPressureFixture();change(input);assert.equal(stagedPairFakeOutWarnings(buildTurnFacts(input),stagedPressurePair).length,1);}
});

test('selected-pair warning stays narrow for both attacks, other progress, forced choices and priority moves',()=>{
  for(const change of [
    input=>{input.legalActions.active[0].moves=[{move:'Liquidation',target:'normal',pp:10}];return [{type:'move',slot:1,target:2},stagedPressurePair[1]];},
    input=>{input.legalActions.active[0].moves=[{move:'Trick Room',target:'all',pp:10}];},
    input=>{input.legalActions.forceSwitch=[false,true];},
    input=>{input.legalActions.active[1].moves=[{move:'Quick Attack',target:'normal',pp:10}];},
    input=>{return [stagedPressurePair[0],{type:'move',slot:1,target:-1}];},
  ]){const input=stagedPressureFixture(),pair=change(input)??stagedPressurePair;assert.deepEqual(stagedPairFakeOutWarnings(buildTurnFacts(input),pair),[]);}
  const invalid=stagedPressureFixture();assert.throws(()=>stagedPairFakeOutWarnings(buildTurnFacts(invalid),[{type:'move',slot:9},stagedPressurePair[1]]),/unavailable/i);
});

function ordinaryExposureFixture(){
  const input=planningFixture();
  Object.assign(input.board.sides[0].pokemon[0],{species:'Golisopod',ability:'Emergency Exit'});
  Object.assign(input.board.sides[0].pokemon[1],{species:'Farigiraf',ability:'Armor Tail'});
  input.ownTeam[0]={species:'Golisopod',ability:'Emergency Exit',item:'Golisopodite',moves:['Leech Life','Protect']};
  input.ownTeam[1]={species:'Farigiraf',ability:'Armor Tail',item:'Safety Goggles',moves:['Psychic','Protect','Trick Room']};
  input.legalActions.active[0]={canMegaEvo:true,moves:[{move:'Leech Life',target:'normal',pp:10},{move:'Protect',target:'self',pp:10}]};
  input.legalActions.active[1]={moves:[{move:'Protect',target:'self',pp:10},{move:'Trick Room',target:'all',pp:10},{move:'Psychic',target:'normal',pp:10}]};
  Object.assign(input.board.sides[1].pokemon[0],{species:'Farigiraf',ability:'Armor Tail'});
  Object.assign(input.board.sides[1].pokemon[1],{species:'Incineroar',ability:'Intimidate'});
  input.opponentSheet=[{species:'Farigiraf',ability:'Armor Tail',item:'Safety Goggles',moves:['Helping Hand','Psychic','Trick Room','Protect']},
    {species:'Incineroar',ability:'Intimidate',item:'Sitrus Berry',moves:['Fake Out','Flare Blitz','Knock Off','Parting Shot']}];
  return input;
}
const ordinaryExposurePair=[{type:'move',slot:1,target:1,mega:true},{type:'move',slot:1}];

test('sole selected Mega attack beside Protect retains named ordinary attacks and Helping Hand without numerical claims',()=>{
  const input=ordinaryExposureFixture(),before=structuredClone(input),pair=structuredClone(ordinaryExposurePair),ctx=buildTurnFacts(input);
  assert.deepEqual(stagedPairFakeOutWarnings(ctx,pair),[],'active Armor Tail already covers the legacy priority-only dependency');
  const rows=stagedPairDependencyWarnings(ctx,pair,{preserveIds:['p1-dragon']});
  assert.equal(rows.length,1);assert.equal(rows[0].actorId,'p1-cat');assert.deepEqual(rows[0].roles,['sole-progress']);
  assert.equal(rows[0].selectedMove,'Leech Life');assert.equal(rows[0].partnerAction,'protect');
  assert(rows[0].opposing.some(row=>row.actorId==='p2-wash'&&row.damageMoves.includes('Flare Blitz')));
  assert.deepEqual(rows[0].pairedSupport,[{actorId:'p2-chomp',move:'Helping Hand',partnerActorId:'p2-wash'}]);
  assert.deepEqual(rows[0].goals,{requiredActionsBy:['p1-cat']});
  assert(!JSON.stringify(rows).includes('damageRange'));assert(!JSON.stringify(rows).includes('will target'));
  assert.deepEqual(input,before);assert.deepEqual(pair,ordinaryExposurePair);
});

test('two attacks offer explicit per-actor delivery questions without declaring them necessary or requiring research',()=>{
  const input=ordinaryExposureFixture(),both=[ordinaryExposurePair[0],{type:'move',slot:3,target:2}];
  const before=structuredClone(input),rows=stagedPairDependencyWarnings(buildTurnFacts(input),both);
  assert.deepEqual(rows.map(row=>({actorId:row.actorId,roles:row.roles,goals:row.goals})),[
    {actorId:'p1-cat',roles:['paired-progress'],goals:{requiredActionsBy:['p1-cat']}},
    {actorId:'p1-dragon',roles:['paired-progress'],goals:{requiredActionsBy:['p1-dragon']}}]);
  assert(rows.every(row=>row.partnerAction==='move'&&row.opposing.length>0&&row.requiredCalculation===undefined));
  assert.deepEqual(validateChoice(request(input.legalActions),both).actions,both,'independently useful chip keeps the direct complete-pair path');
  assert.deepEqual(input,before);
});

test('self-protected declared actors, forced turns and passive opposing sheets create no action exposure question',()=>{
  const input=ordinaryExposureFixture();
  const protectedPair=[{type:'move',slot:2},{type:'move',slot:1}];
  assert.deepEqual(stagedPairDependencyWarnings(buildTurnFacts(input),protectedPair,{requiredActors:['p1-cat'],preserveIds:['p1-cat','p1-dragon']}),[]);
  input.legalActions.forceSwitch=[false,true];assert.deepEqual(stagedPairDependencyWarnings(buildTurnFacts(input),ordinaryExposurePair),[]);
  const passive=ordinaryExposureFixture();passive.opponentSheet.forEach(set=>{set.moves=['Protect','Helping Hand'];});
  assert.deepEqual(stagedPairDependencyWarnings(buildTurnFacts(passive),ordinaryExposurePair),[]);
});

test('declared required and preserved actors and setup get actor-specific action or survival goals',()=>{
  const input=ordinaryExposureFixture(),pair=[ordinaryExposurePair[0],{type:'move',slot:3,target:2}],ctx=buildTurnFacts(input);
  const required=stagedPairDependencyWarnings(ctx,pair,{requiredActors:['p1-cat'],preserveIds:['p1-dragon']});
  assert.deepEqual(required.map(row=>({id:row.actorId,roles:row.roles,goals:row.goals})),[
    {id:'p1-cat',roles:['required-actor'],goals:{requiredActionsBy:['p1-cat']}},
    {id:'p1-dragon',roles:['preserved-actor'],goals:{survive:['p1-dragon']}}]);
  const setup=stagedPairDependencyWarnings(ctx,[{type:'move',slot:2},{type:'move',slot:2}]);
  assert.equal(setup.length,1);assert.equal(setup[0].actorId,'p1-dragon');assert.deepEqual(setup[0].roles,['setup-actor']);
  assert.deepEqual(setup[0].goals,{requiredActionsBy:['p1-dragon']});
});

test('switch entry has a departing-action plus actual recipient survival goal and never credits an unselected reserve',()=>{
  const input=ordinaryExposureFixture(),pair=[{type:'switch',slot:3},{type:'move',slot:1}],ctx=buildTurnFacts(input);
  const rows=stagedPairDependencyWarnings(ctx,pair,{preserveIds:['p1-cat','p1-boom']});
  assert.equal(rows.length,1);assert.equal(rows[0].actorId,'p1-boom');assert.deepEqual(rows[0].roles,['switch-recipient','preserved-actor']);
  assert.deepEqual(rows[0].goals,{requiredActionsBy:['p1-cat'],survive:['p1-boom']});
  assert(!rows.some(row=>row.actorId==='p1-cat'),'the departing preserved actor is not still exposed on the board');
  input.board.sides[0].pokemon[2].selection='not-in-current-request';
  assert.deepEqual(stagedPairDependencyWarnings(buildTurnFacts(input),pair),[]);
});

test('current known attack immunity and inactive sheets are respected but a selected Mega transition remains unresolved',()=>{
  const input=ordinaryExposureFixture();input.opponentSheet[0].moves=['Psychic'];input.opponentSheet[1].moves=['Protect'];
  Object.assign(input.board.sides[0].pokemon[0],{species:'Incineroar',ability:'Intimidate'});
  const current=[{type:'move',slot:1,target:1},{type:'move',slot:1}];
  assert.deepEqual(stagedPairDependencyWarnings(buildTurnFacts(input),current),[],'current Dark typing blocks the sole named Psychic');
  assert.equal(stagedPairDependencyWarnings(buildTurnFacts(input),ordinaryExposurePair).length,1,'do not transplant current immunity through a selected Mega');
  input.board.sides[1].pokemon[0].fainted=true;
  assert.deepEqual(stagedPairDependencyWarnings(buildTurnFacts(input),ordinaryExposurePair),[]);
  assert.throws(()=>stagedPairDependencyWarnings(buildTurnFacts(ordinaryExposureFixture()),[{type:'move',slot:9},ordinaryExposurePair[1]]),/unavailable/i);
});

test('ordinary chip or a necessary intentional trade remains a legal selectable pair after a factual exposure warning',()=>{
  const input=ordinaryExposureFixture();input.legalActions.active[0].moves[0]={move:'Struggle Bug',target:'allAdjacentFoes',pp:10};
  const pair=[{type:'move',slot:1},{type:'move',slot:1}],before=structuredClone(pair),ctx=buildTurnFacts(input);
  const rows=stagedPairDependencyWarnings(ctx,pair);
  assert.equal(rows[0].selectedMove,'Struggle Bug');assert.deepEqual(rows[0].roles,['sole-progress']);
  assert(rows.every(row=>row.blocked===undefined&&row.requiredCalculation===undefined),'the detector does not enforce research or choose a strategy');
  assert.deepEqual(validateChoice(request(input.legalActions),pair).actions,before,'an authored chip/trade keeps the full-pair escape');
  assert.deepEqual(pair,before);
});

test('advisory candidates are distinct legal complete pairs, keep both foes exposed, and never mutate source',() => {
  const input = planningFixture(), before = structuredClone(input), result = build(input);
  assert.equal(result.candidates.length,4);assert.equal(new Set(result.candidates.map(value => JSON.stringify(value.actions))).size,4);
  assert.deepEqual(result.candidates.map(value => value.purpose),['attack-pressure','denial-plus-progress','protect-plus-progress','switch-plus-progress']);
  for (const candidate of result.candidates) {
    assert.deepEqual(validateChoice(request(input.legalActions),candidate.actions).actions,candidate.actions);
    assert.equal(candidate.heuristic,true);assert.equal(candidate.actions.length,2);
    assert(candidate.warnings.some(warning => warning.includes('exposed to both foes')));
  }
  assert(result.candidates.find(candidate => candidate.purpose === 'denial-plus-progress').warnings.some(warning => warning.includes('first-turn eligibility is unknown')));
  assert(result.candidates.find(candidate => candidate.purpose === 'switch-plus-progress').warnings.some(warning => warning.includes('not established safe')));
  assert(result.coverage.requiredActorExposure.some(warning => warning.code === 'TWO_FOE_DELIVERY_UNCHECKED'));
  assert.deepEqual(input,before);
});

test('chosen move target signs are correct and self/side moves omit target',() => {
  const input = planningFixture();input.legalActions.active[0].moves = [{move:'Helping Hand',target:'adjacentAlly',pp:10}];
  input.legalActions.active[1].moves = [{move:'Dark Pulse',target:'normal',pp:10}];
  const result = build(input);
  assert(result.candidates.some(candidate => candidate.actions[0].target === -2));
  for (const candidate of result.candidates) {
    if (candidate.actions[1].type === 'move') assert.equal(candidate.actions[1].target > 0,true);
    validateChoice(request(input.legalActions),candidate.actions);
  }
  const protects = build(planningFixture()).candidates.find(candidate => candidate.purpose === 'protect-plus-progress');
  assert(protects.actions.some(action => action.type === 'move' && !Object.hasOwn(action,'target')));
});

test('trapped actors cannot switch and an unselected reserve is never proposed',() => {
  const input = planningFixture();input.legalActions.active[0].trapped = true;input.legalActions.active[1].trapped = true;
  assert(!build(input).candidates.some(candidate => candidate.actions.some(action => action.type === 'switch')));
  const unselected = planningFixture();unselected.board.sides[0].pokemon[2].selection = 'not-in-current-request';
  assert(!build(unselected).candidates.some(candidate => candidate.actions.some(action => action.type === 'switch')));
});

test('forced switches enumerate distinct legal recipients, shortage passes, and no arbitrary preview order',() => {
  const input = planningFixture();input.legalActions.forceSwitch = [true,true];delete input.legalActions.active;
  for (let index = 0;index < 2;index++) {
    input.legalActions.pokemon[index].condition = '0 fnt';input.board.sides[0].pokemon[index].fainted = true;input.board.sides[0].pokemon[index].hp.current = 0;
  }
  const result = build(input);assert.equal(result.candidates.length,2);
  for (const candidate of result.candidates) {
    validateChoice(request(input.legalActions),candidate.actions);
    const switches = candidate.actions.filter(action => action.type === 'switch');
    assert.equal(switches.length,1);assert.equal(switches[0].slot,3);assert(candidate.actions.some(action => action.type === 'pass'));
  }
  assert.throws(() => validateChoice(request(input.legalActions),[{type:'switch',slot:3},{type:'switch',slot:3}]),/forced replacements|Invalid switch/);
  input.legalActions.teamPreview = true;
  const preview = build(input);assert.equal(preview.candidates.length,0);assert(preview.warnings.some(warning => warning.includes('authored selected-four')));
});

test('two simultaneous forced replacements cannot choose the same reserve',() => {
  const input = planningFixture();input.legalActions.forceSwitch = [true,true];delete input.legalActions.active;
  const fourth = {...structuredClone(input.board.sides[0].pokemon[2]),id:'p1-giraffe',species:'Farigiraf',nickname:'Farigiraf',requestIndex:4};
  input.board.sides[0].pokemon.push(fourth);input.board.sides[0].selectedTeamSize = 4;
  input.legalActions.pokemon.push({ident:'p1: Farigiraf',details:'Farigiraf, L50',condition:'100/100',active:false});
  for (let index = 0;index < 2;index++) {input.legalActions.pokemon[index].condition = '0 fnt';input.board.sides[0].pokemon[index].fainted = true;}
  const result = build(input);assert.equal(result.candidates.length,2);
  for (const candidate of result.candidates) {
    assert.deepEqual(candidate.actions.map(action => action.slot).sort(),[3,4]);
    validateChoice(request(input.legalActions),candidate.actions);
  }
});

test('Fake Out rejects known false lifecycle, Ghost immunity, Armor Tail and grounded Psychic Terrain',() => {
  for (const change of [
    input => {input.board.sides[0].pokemon[0].lifecycle = {firstTurn:false};},
    input => {input.board.sides[1].pokemon.forEach(mon => {mon.species = 'Gengar';mon.ability = 'Cursed Body';});},
    input => {input.board.sides[1].pokemon[0].ability = 'Armor Tail';},
    input => {input.board.field.terrain = {name:'PsychicTerrain'};input.board.sides[1].pokemon.forEach(mon => {mon.ability = 'Pressure';mon.itemKnown = true;mon.item = null;});},
  ]) {
    const input = planningFixture();change(input);
    // Psychic Terrain leaves airborne Rotom eligible, so explicitly ground it.
    if (input.board.field.terrain) input.board.sides[1].pokemon[1].volatiles.ingrain = {};
    const result = build(input);
    assert(!result.candidates.some(candidate => isMove(candidate,0,1)));
    assert(result.coverage.knownBlockedOptions.some(option => option.move === 'Fake Out'));
  }
});

test('known type and ability immunities, choice locks, zero PP and denial do not receive useful credit',() => {
  const input = planningFixture();input.legalActions.active[0].moves = [{move:'Earthquake',target:'allAdjacent',pp:10}];
  input.board.sides[1].pokemon[0].species = 'Corviknight';input.board.sides[1].pokemon[0].ability = 'Pressure';
  const result = build(input);assert(!result.candidates.some(candidate => isMove(candidate,0,1)));
  assert(result.coverage.knownBlockedOptions.some(option => /immune|blocks/.test(option.reason)));
  const locked = planningFixture();locked.legalActions.active[0].lockedMove = 'Protect';locked.legalActions.active[1].moves[0].pp = 0;
  const lockResult = build(locked);
  assert(lockResult.candidates.every(candidate => candidate.actions[0].type !== 'move' || candidate.actions[0].slot === 3));
  assert(lockResult.candidates.every(candidate => !isMove(candidate,1,1)));
  const sound = planningFixture();sound.legalActions.active[0].moves = [{move:'Psychic Noise',target:'normal',pp:10}];
  sound.board.sides[0].pokemon[0].volatiles.throatchop = {};
  assert(!build(sound).candidates.some(candidate => isMove(candidate,0,1)));
});

test('registered Armor Tail does not protect active foes; current base forms and Mega eligibility remain distinct',() => {
  const input = planningFixture();input.legalActions.active[0].canMegaEvo = 'Incineroar-Mega';
  const result = build(input);
  assert(result.candidates.some(candidate => isMove(candidate,0,1)),'Unselected registered Armor Tail is not active protection');
  assert(result.candidates.every(candidate => candidate.actions.every(action => !action.mega)));
  assert(result.warnings.some(warning => warning.includes('post-Mega')&&warning.includes('unresolved')));
});

test('native ability redirection into its known immunity is blocked while plausible redirection is warned',() => {
  const input = planningFixture();input.legalActions.active[0].moves = [{move:'Thunderbolt',target:'normal',pp:10}];
  input.board.sides[1].pokemon[0].ability = 'Lightning Rod';
  const result = build(input);assert(!result.candidates.some(candidate => isMove(candidate,0,1)));
  assert(result.coverage.knownBlockedOptions.some(option => /redirects/.test(option.reason)));
  const possible = planningFixture();possible.opponentSheet[1].moves.push('Follow Me');
  assert(build(possible).candidates.some(candidate => candidate.warnings.some(warning => warning.includes('Plausible redirection'))));
});

test('native lifecycle counters distinguish first-action Fake Out from active-turn count and enforce choice lock',() => {
  const input = planningFixture();input.board.sides[0].pokemon[0].lifecycle = {activeTurns:1,activeMoveActions:0,choiceLock:false};
  let result = build(input);assert(result.candidates.some(candidate => isMove(candidate,0,1)));
  assert(!result.candidates.find(candidate => isMove(candidate,0,1)).warnings.some(warning => warning.includes('first-turn eligibility is unknown')));
  input.board.sides[0].pokemon[0].lifecycle.activeMoveActions = 1;
  result = build(input);assert(!result.candidates.some(candidate => isMove(candidate,0,1)));
  input.board.sides[0].pokemon[0].lifecycle.choiceLock = 'Flare Blitz';
  result = build(input);assert(result.candidates.every(candidate => candidate.actions[0].type !== 'move' || candidate.actions[0].slot === 2));
});

test('eligible status terrain and extreme weather blockers retain a suppression countercase',() => {
  const input = planningFixture();input.legalActions.active[0].moves = [{move:'Spore',target:'normal',pp:10}];
  input.board.field.terrain = {name:'ElectricTerrain'};
  for (const foe of input.board.sides[1].pokemon) {foe.ability = 'Pressure';foe.item = null;foe.itemKnown = true;foe.volatiles.ingrain = {};}
  let result = build(input);assert(!result.candidates.some(candidate => isMove(candidate,0,1)));
  assert(result.coverage.knownBlockedOptions.some(option => option.reason.includes('terrain prevents')));
  input.board.field.terrain = null;input.board.field.weather = {name:'DesolateLand'};
  input.legalActions.active[0].moves = [{move:'Hydro Pump',target:'normal',pp:10}];
  result = build(input);assert(!result.candidates.some(candidate => isMove(candidate,0,1)));
  input.board.sides[0].pokemon[1].ability = 'Cloud Nine';
  result = build(input);assert(result.candidates.some(candidate => isMove(candidate,0,1)));
});

test('complete-pair objective alignment changes relevant denial routes rather than taking the first move',()=>{
  const input=planningFixture();input.legalActions.active.forEach(active=>{active.trapped=true;});
  input.legalActions.active[0].moves=[{move:'Taunt',target:'normal',pp:10},{move:'Haze',target:'all',pp:10}];
  input.legalActions.active[1].moves=[{move:'Dark Pulse',target:'normal',pp:10}];
  input.opponentSheet[0].moves=['Earthquake'];input.opponentSheet[1].moves=['Tailwind'];
  input.board.sides[1].pokemon[0].boosts.atk=2;
  input.objective={targets:['p2-chomp'],requiredActors:['p1-cat']};
  const boosted=build(input).candidates.find(row=>row.purpose==='denial-plus-progress');
  assert.equal(boosted.actions[0].slot,2,'the boosted obstacle supplies an actual Haze relevance fact');
  assert.equal(boosted.actions[1].target,1);
  assert.deepEqual(boosted.qualitativeAlignment.declaredTargetsPressured,['p2-chomp']);
  assert.deepEqual(boosted.qualitativeAlignment.pressure[0].denialRelevantTo,['p2-chomp']);
  input.objective.targets=['p2-wash'];
  const status=build(input).candidates.find(row=>row.purpose==='denial-plus-progress');
  assert.deepEqual(status.actions[0],{type:'move',slot:1,target:2});assert.equal(status.actions[1].target,2);
  assert.deepEqual(status.qualitativeAlignment.pressure[0].denialRelevantTo,['p2-wash']);
  assert.equal(status.qualitativeAlignment.deliveryVerified,false);
  input.board.sides[1].pokemon[0].boosts.atk=0;input.objective.targets=['p2-chomp'];
  const unboosted=build(input);
  assert(unboosted.candidates.every(row=>row.qualitativeAlignment.pressure.filter(value=>value.move==='Haze').every(value=>value.targetIds.length===0)),
    'Haze with no observed boosts does not acquire target pressure from its field-wide target');
});

test('empty objectives cover current capabilities and both eligible recipients independent of native move order',()=>{
  const input=planningFixture();input.objective={};input.legalActions.active.forEach(active=>{active.trapped=true;});
  input.legalActions.active[0].moves=[{move:'Ice Beam',target:'normal',pp:10},{move:'Icy Wind',target:'allAdjacentFoes',pp:10}];
  input.legalActions.active[1].moves=[{move:'Dark Pulse',target:'normal',pp:10}];
  const before=structuredClone(input),first=buildCandidates(buildTurnFacts(input),{maxCandidates:1}).candidates[0];
  assert.equal(first.actions[0].slot,2);assert(first.qualitativeAlignment.capabilities.includes('speed-control'));
  assert.deepEqual(first.qualitativeAlignment.pressure[0].targetIds,['p2-chomp','p2-wash']);
  assert.deepEqual(first.qualitativeAlignment.unmet,{targets:[],requiredActors:[],preserve:[]});
  assert.deepEqual(input,before);
  input.legalActions.active[0].moves.reverse();
  const reordered=buildCandidates(buildTurnFacts(input),{maxCandidates:1}).candidates[0];
  assert.equal(reordered.actions[0].slot,1);assert.deepEqual(reordered.qualitativeAlignment,first.qualitativeAlignment);
  assert(build(input).coverage.selection.limitations.some(value=>value.includes('do not establish')));
});

test('declared preservation ranks a complete protection route while retaining required actor progress',()=>{
  const input=planningFixture();input.legalActions.active.forEach(active=>{active.trapped=true;});
  input.objective={targets:['p2-wash'],preserve:['p1-dragon'],requiredActors:['p1-cat']};
  const result=build(input),candidate=result.candidates[0];
  assert.equal(candidate.purpose,'protect-plus-progress');assert.deepEqual(candidate.actions[1],{type:'move',slot:3});
  assert.equal(candidate.actions[0].target,2);
  assert.deepEqual(candidate.qualitativeAlignment.declaredActorsProtectedOrWithdrawn,['p1-dragon']);
  assert.deepEqual(candidate.qualitativeAlignment.declaredActorsActing,['p1-cat']);
  assert.deepEqual(candidate.qualitativeAlignment.unmet,{targets:[],requiredActors:[],preserve:[]});
  assert(candidate.warnings.some(value=>value.includes('exposed to both foes')));
});

test('a required actor self-protecting cannot stand in for its only useful pressure or paired support',()=>{
  const input=planningFixture();input.legalActions.active.forEach(active=>{active.trapped=true;});
  input.legalActions.active[0].moves=[{move:'Protect',target:'self',pp:10},{move:'Flare Blitz',target:'normal',pp:10}];
  input.legalActions.active[1].moves=[{move:'Helping Hand',target:'adjacentAlly',pp:10},{move:'Protect',target:'self',pp:10}];
  input.objective={targets:['p2-wash'],requiredActors:['p1-cat'],preserve:['p1-cat']};
  const result=build(input);
  assert(result.candidates.length>0);
  for(const candidate of result.candidates){
    assert.equal(candidate.actions[0].slot,2,'self-protection would remove the sole damage route and invalidate Helping Hand progress');
    assert.deepEqual(candidate.qualitativeAlignment.declaredActorsActing,['p1-cat']);
    assert.deepEqual(candidate.qualitativeAlignment.unmet.preserve,['p1-cat']);
    assert.equal(candidate.qualitativeAlignment.deliveryVerified,false);
    validateChoice(request(input.legalActions),candidate.actions);
  }
  const supported=result.candidates.find(candidate=>candidate.purpose==='control-plus-progress');
  assert(supported);assert.deepEqual(supported.qualitativeAlignment.supportForRequired,['p1-cat']);
  input.legalActions.active[0].moves[1].disabled=true;
  assert.equal(build(input).candidates.length,0,'protection plus unsupported Helping Hand is not invented as progress');
});

test('unknown activation and known recipient blocks remain distinct in objective candidate metadata',()=>{
  const input=planningFixture();input.objective={targets:['p2-wash'],requiredActors:['p1-cat']};
  input.legalActions.active.forEach(active=>{active.trapped=true;});
  input.legalActions.active[0].moves=[{move:'Fake Out',target:'normal',pp:10}];
  input.legalActions.active[1].moves=[{move:'Dark Pulse',target:'normal',pp:10}];
  const unknown=build(input).candidates.find(candidate=>candidate.purpose==='denial-plus-progress');
  assert.equal(unknown.qualitativeAlignment.pressure[0].activationUnverified,true);
  assert.deepEqual(unknown.qualitativeAlignment.pressure[0].targetIds,[]);
  assert(unknown.qualitativeAlignment.pressure[0].possibleRecipientIds.length>0);
  assert(unknown.warnings.some(value=>value.includes('eligibility is unknown')));
  input.board.sides[0].pokemon[0].lifecycle={firstTurn:true};
  const eligible=build(input).candidates.find(candidate=>candidate.qualitativeAlignment.pressure[0].targetIds.includes('p2-wash'));
  assert.equal(eligible.qualitativeAlignment.pressure[0].activationUnverified,false);
  assert.deepEqual(eligible.qualitativeAlignment.pressure[0].targetIds,['p2-wash']);
  input.board.sides[1].pokemon[1].species='Gengar';input.board.sides[1].pokemon[1].ability='Cursed Body';
  const blocked=build(input);
  assert(blocked.coverage.knownBlockedOptions.some(row=>row.move==='Fake Out'&&row.targetId==='p2-wash'));
  assert(blocked.candidates.every(candidate=>candidate.qualitativeAlignment.pressure.filter(row=>row.move==='Fake Out').every(row=>!row.possibleRecipientIds.includes('p2-wash'))));
});

test('required setup retains relevant paired denial as a delivery question without requiring a damage move',()=>{
  const input=planningFixture();input.objective={requiredActors:['p1-cat']};input.legalActions.active.forEach(active=>{active.trapped=true;});
  input.legalActions.active[0].moves=[{move:'Swords Dance',target:'self',pp:10}];
  input.legalActions.active[1].moves=[{move:'Haze',target:'all',pp:10},{move:'Taunt',target:'normal',pp:10}];
  input.opponentSheet[0].moves=['Earthquake'];input.opponentSheet[1].moves=['Will-O-Wisp'];
  const candidate=build(input).candidates[0];
  assert.equal(candidate.purpose,'denial-plus-progress');
  assert.deepEqual(candidate.actions,[{type:'move',slot:1},{type:'move',slot:2,target:2}]);
  assert.deepEqual(candidate.qualitativeAlignment.supportForRequired,['p1-cat']);
  assert.deepEqual(candidate.qualitativeAlignment.pressure[0].denialRelevantTo,['p2-wash']);
  assert.equal(candidate.qualitativeAlignment.deliveryVerified,false);
  assert(candidate.warnings.some(value=>value.includes('exposed to both foes')));
});

function complementaryDamageFixture(){
  const input=planningFixture();input.objective={};
  Object.assign(input.board.sides[0].pokemon[0],{species:'Gardevoir',ability:'Trace',item:'Gardevoirite',itemKnown:true});
  Object.assign(input.board.sides[0].pokemon[1],{species:'Farigiraf',ability:'Armor Tail',item:'Grassy Seed',itemKnown:true});
  Object.assign(input.board.sides[1].pokemon[0],{species:'Farigiraf',ability:'Armor Tail',item:'Grassy Seed',itemKnown:true});
  Object.assign(input.board.sides[1].pokemon[1],{species:'Umbreon',ability:'Synchronize',item:null,itemKnown:true});
  input.ownTeam[0]={species:'Gardevoir',ability:'Trace',item:'Gardevoirite',moves:['Quick Attack','Flash Cannon','Draining Kiss','Protect']};
  input.ownTeam[1]={species:'Farigiraf',ability:'Armor Tail',item:'Grassy Seed',moves:['Psychic Noise','Helping Hand','Trick Room','Protect']};
  input.opponentSheet=[{species:'Farigiraf',ability:'Armor Tail',item:'Grassy Seed',moves:['Psychic','Helping Hand','Trick Room']},
    {species:'Umbreon',ability:'Synchronize',item:'',moves:['Dark Pulse','Taunt','Protect']}];
  const move=(name,target='normal')=>({move:name,target,pp:10});
  input.legalActions.active=[{canMegaEvo:true,moves:[move('Quick Attack'),move('Flash Cannon'),move('Draining Kiss'),move('Protect','self')]},
    {moves:[move('Psychic Noise'),move('Helping Hand','adjacentAlly'),move('Trick Room','all'),move('Protect','self')]}];
  return input;
}

test('damaging denial capabilities retain both attack and denial purpose coverage',()=>{
  const input=planningFixture();input.objective={};input.legalActions.active.forEach(active=>{active.trapped=true;});
  input.legalActions.active[0].moves=[{move:'Clear Smog',target:'normal',pp:10}];
  input.legalActions.active[1].moves=[{move:'Psychic Noise',target:'normal',pp:10}];
  const result=buildCandidates(buildTurnFacts(input),{maxCandidates:6});
  for(const purpose of ['attack-pressure','denial-plus-progress']){
    const candidate=result.candidates.find(row=>row.purpose===purpose);assert(candidate,purpose);
    assert.equal(candidate.actions.length,2);validateChoice(request(input.legalActions),candidate.actions);
    assert(candidate.qualitativeAlignment.pressure.every(row=>row.damage===true));
    assert.equal(candidate.qualitativeAlignment.deliveryVerified,false);
  }
  input.legalActions.active[0].moves=[{move:'Taunt',target:'normal',pp:10}];
  input.legalActions.active[1].moves=[{move:'Will-O-Wisp',target:'normal',pp:10}];
  const statuses=buildCandidates(buildTurnFacts(input),{maxCandidates:6});
  assert(!statuses.candidates.some(row=>row.purpose==='attack-pressure'),'two status denials do not acquire a damage route');
  assert(statuses.coverage.missingPurposes.includes('attack-pressure'));
});

test('a scarce form variation retains focused complementary damage before a novel partner support move',()=>{
  const input=complementaryDamageFixture(),before=structuredClone(input),result=buildCandidates(buildTurnFacts(input),{maxCandidates:6});
  assert.equal(result.candidates.length,6);assert.deepEqual(input,before);
  for(const purpose of ['attack-pressure','denial-plus-progress','protect-plus-progress','switch-plus-progress','control-plus-progress'])
    assert(result.candidates.some(row=>row.purpose===purpose),purpose);
  const variation=result.candidates.find(row=>row.purpose==='optional-mega-variation');assert(variation);
  assert.deepEqual(variation.actions,[{type:'move',slot:3,target:1,mega:true},{type:'move',slot:1,target:1}]);
  assert(variation.qualitativeAlignment.capabilities.includes('recovery'),'retains a distinct move capability without claiming useful healing');
  assert(variation.warnings.some(value=>value.includes('post-Mega')&&value.includes('unresolved')));
  assert.equal(variation.qualitativeAlignment.deliveryVerified,false);
  assert(!result.coverage.missingPurposes.includes('attack-pressure'));
  for(const candidate of result.candidates)validateChoice(request(input.legalActions),candidate.actions);
  input.legalActions.active[0].moves.reverse();
  const reordered=buildCandidates(buildTurnFacts(input),{maxCandidates:6}),form=reordered.candidates.find(row=>row.purpose==='optional-mega-variation');
  assert.equal(input.legalActions.active[0].moves[form.actions[0].slot-1].move,'Draining Kiss');
  assert.equal(form.actions[0].target,1);assert.equal(form.actions[1].target,1);
});

test('complete damage-pattern novelty cannot bypass unavailable moves, forms or current recipients',()=>{
  const input=complementaryDamageFixture();input.legalActions.active[0].moves[2].disabled=true;
  let result=buildCandidates(buildTurnFacts(input),{maxCandidates:6});
  assert(result.candidates.every(row=>!isMove(row,0,3)),'disabled complementary damage is excluded, including Mega variants');
  input.legalActions.active[0].moves[2].disabled=false;input.legalActions.active[0].canMegaEvo=false;
  result=buildCandidates(buildTurnFacts(input),{maxCandidates:6});
  assert(result.candidates.every(row=>row.actions.every(action=>!action.mega)));
  assert(result.candidates.every(row=>row.actions[1].type!=='move'||row.actions[1].slot!==1||row.actions[1].target!==2),
    'an empty diversity slot cannot award a current Psychic recipient through Dark immunity');
  assert(result.coverage.knownBlockedOptions.some(row=>row.move==='Psychic Noise'&&row.targetId==='p2-wash'));
  input.board.sides[0].megaUsed=true;input.legalActions.active[0].canMegaEvo=true;
  assert(buildCandidates(buildTurnFacts(input),{maxCandidates:6}).candidates.every(row=>row.actions.every(action=>!action.mega)));
});

test('Mold Breaker cannot bypass an intact Air Balloon; Gravity is a separate grounding countercase',() => {
  const input=planningFixture();input.board.sides[0].pokemon[0].ability='Mold Breaker';
  input.legalActions.active[0].moves=[{move:'Earthquake',target:'allAdjacent',pp:10}];
  for(const foe of input.board.sides[1].pokemon){foe.species='Mew';foe.ability='Synchronize';foe.item='Air Balloon';foe.itemKnown=true;}
  const blocked=build(input);assert(!blocked.candidates.some(candidate=>isMove(candidate,0,1)));
  assert(blocked.coverage.knownBlockedOptions.some(option=>option.reason==='Air Balloon blocks Ground damage'));
  input.board.field.conditions.gravity={};
  assert(build(input).candidates.some(candidate=>isMove(candidate,0,1)));
});

test('Helping Hand plus partner Protect or switch is not invented as useful progress',() => {
  const input = planningFixture();input.legalActions.active[0].moves = [{move:'Helping Hand',target:'adjacentAlly',pp:10}];
  input.legalActions.active[1].moves = [{move:'Protect',target:'self',pp:10}];
  const result = build(input);
  assert(!result.candidates.some(candidate => isMove(candidate,0,1)));
  assert(result.warnings.some(warning => warning.includes('No useful complete pair')));
});

test('Weather Ball uses the current user Mega Sol and native suppression precedence for immunity checks',() => {
  const input = planningFixture();input.legalActions.active[0].moves = [{move:'Weather Ball',target:'normal',pp:10}];
  for (const foe of input.board.sides[1].pokemon) {foe.species = 'Arcanine';foe.ability = 'Flash Fire';}
  input.board.sides[0].pokemon[0].ability = 'Mega Sol';
  let result = build(input);assert(!result.candidates.some(candidate => isMove(candidate,0,1)),'Mega Sol makes Weather Ball Fire into Flash Fire even without field sun');
  input.board.sides[0].pokemon[1].ability = 'Cloud Nine';
  result = build(input);assert(!result.candidates.some(candidate => isMove(candidate,0,1)),'Native Mega Sol precedes external weather suppression');
  input.board.sides[0].pokemon[0].abilitySuppressed = true;
  result = build(input);assert(result.candidates.some(candidate => isMove(candidate,0,1)),'Suppressed Mega Sol does not change Normal Weather Ball');
  input.board.sides[0].pokemon[0].ability = 'Pressure';input.board.sides[0].pokemon[0].abilitySuppressed = false;input.board.field.weather = {name:'SunnyDay'};
  result = build(input);assert(result.candidates.some(candidate => isMove(candidate,0,1)),'Cloud Nine suppresses ordinary field sun for Weather Ball');
  input.board.sides[0].pokemon[1].ability = 'Levitate';
  result = build(input);assert(!result.candidates.some(candidate => isMove(candidate,0,1)),'Unsuppressed sun makes ordinary Weather Ball Fire');
  input.board.sides[0].pokemon[0].item = 'Utility Umbrella';input.board.sides[0].pokemon[0].itemKnown = true;
  result = build(input);assert(result.candidates.some(candidate => isMove(candidate,0,1)),'Active Utility Umbrella removes ordinary sun for the user');
});

test('grounding and Thousand Arrows bypass airborne immunity but do not bypass Earth Eater absorption',() => {
  const input = planningFixture();input.legalActions.active[0].moves = [{move:'High Horsepower',target:'normal',pp:10}];
  for (const foe of input.board.sides[1].pokemon) {foe.species = 'Orthworm';foe.ability = 'Earth Eater';}
  let result = build(input);assert(!result.candidates.some(candidate => isMove(candidate,0,1)));
  input.board.field.conditions.gravity = {name:'Gravity'};
  result = build(input);assert(!result.candidates.some(candidate => isMove(candidate,0,1)));
  input.legalActions.active[0].moves[0].move = 'Thousand Arrows';
  result = build(input);assert(!result.candidates.some(candidate => isMove(candidate,0,1)));
  input.board.sides[0].pokemon[0].ability = 'Mold Breaker';
  result = build(input);assert(result.candidates.some(candidate => isMove(candidate,0,1)));
});
