import test from 'node:test';
import assert from 'node:assert/strict';
import {planningFixture} from './fixtures.mjs';
import {buildTurnFacts} from './board.mjs';
import {boardDigest,requestDigest,digest} from './identity.mjs';
import {buildRecipientEffects,validateSelectedRecipientEffects} from './recipient-effects.mjs';
import {createDecisionBriefFromSnapshot} from './service.mjs';
import {projectRecipientEffects} from './decision-view.mjs';

export function recipientFixture(){
  const input=planningFixture(),own=input.board.sides[0].pokemon,foes=input.board.sides[1].pokemon;
  Object.assign(own[1],{species:'Farigiraf',ability:'Armor Tail'});
  input.ownTeam[1]={species:'Farigiraf',ability:'Armor Tail',item:'Safety Goggles',moves:['Psychic Noise','Protect']};
  input.legalActions.active[0].moves=[{move:'Sucker Punch',target:'normal',pp:10},{move:'Protect',target:'self',pp:10}];
  input.legalActions.active[1].moves=[{move:'Psychic Noise',target:'normal',pp:10},{move:'Protect',target:'self',pp:10}];
  Object.assign(foes[0],{species:'Farigiraf',ability:'Armor Tail'});Object.assign(foes[1],{species:'Incineroar',ability:'Intimidate'});
  input.opponentSheet=[{species:'Farigiraf',ability:'Armor Tail',item:'Safety Goggles',moves:['Psychic Noise','Protect']},
    {species:'Incineroar',ability:'Intimidate',item:'Sitrus Berry',moves:['Flare Blitz','Protect']},{species:'Rotom-Wash',ability:'Levitate',item:'Sitrus Berry',moves:['Hydro Pump','Protect']}];
  input.objective={};
  const source={kind:'bound-observed-turn',sessionId:'recipient-fixture',teamId:'a'.repeat(64),room:'battle-gen9championsvgc2026regmcbo3-999',rqid:2,token:'b'.repeat(64)};
  const bind=()=>{const boardHash=boardDigest(input.board,input.legalActions);return {...source,boardHash,requestDigest:requestDigest({...source,boardHash}),opposingSheetSha256:digest(input.opponentSheet)};};
  const pair=[{type:'move',slot:2},{type:'move',slot:1,target:2}],facts=()=>buildTurnFacts(input);
  const read=()=>({actorId:own[1].id,moveSlot:1,targetSlot:2,currentTargetId:foes[1].id,expected:{kind:'switch',recipientId:'registered:p2:3'},source:Object.fromEntries(['boardHash','requestDigest','opposingSheetSha256'].map(name=>[name,bind()[name]])),acknowledgeCurrentImmunity:true});
  return {input,source:bind,facts,pair,read};
}
test('H01 immunity remains visible after two earlier candidate blocks',()=>{
  const f=recipientFixture(),source=f.source(),report=createDecisionBriefFromSnapshot({...f.input,source});
  assert.equal(report.coverage.candidates.knownBlockedOptions[2].move,'Psychic Noise');
  const card=projectRecipientEffects(report);assert.equal(card.blocked.length,1);assert.equal(card.blocked[0].targetSpecies,'Incineroar');
  assert.throws(()=>validateSelectedRecipientEffects(f.facts(),f.pair,undefined,{source}),/Incineroar is currently type-immune to Psychic/);
  assert.equal(card.blocked[0].targetId,f.input.board.sides[1].pokemon[1].id);
  // Bounded observed identity history can exceed the six published sets. It
  // must not make a real immunity cell disappear from the essential card.
  report.recipientEffects.readRecipients=Array.from({length:12},(_,i)=>({id:`historical-${i}`,species:'Rotom-Wash'}));
  assert.equal(projectRecipientEffects(report).blocked[0].targetSpecies,'Incineroar');
});
test('ordinary recipient and explicit source-bound switch read preserve exact authored choices',()=>{
  const f=recipientFixture(),before=structuredClone(f.pair),safe=[f.pair[0],{type:'move',slot:1,target:1}];
  assert.equal(validateSelectedRecipientEffects(f.facts(),safe,undefined,{source:f.source()}).blocked.length,0);
  const result=validateSelectedRecipientEffects(f.facts(),f.pair,[f.read()],{source:f.source()});
  assert.equal(result.futureEffectsVerified,false);assert.deepEqual(f.pair,before);assert.equal(result.reads[0].expected.recipientId,'registered:p2:3');
});
test('both actors and every supplied read reject stale/source/action/current-target mismatches',()=>{
  const f=recipientFixture();
  for(const change of [read=>{read.source.boardHash='f'.repeat(64);},read=>{read.source.requestDigest='f'.repeat(64);},read=>{read.source.opposingSheetSha256='f'.repeat(64);},read=>{read.actorId='other';},read=>{read.moveSlot=2;},read=>{read.targetSlot=1;},read=>{read.currentTargetId='other';},read=>{read.expected.recipientId='invented';}]){
    const read=f.read();change(read);assert.throws(()=>validateSelectedRecipientEffects(f.facts(),f.pair,[read],{source:f.source()}));
  }
  assert.throws(()=>validateSelectedRecipientEffects(f.facts(),f.pair,[f.read(),f.read()],{source:f.source()}),/Duplicate/);
  assert.throws(()=>validateSelectedRecipientEffects(f.facts(),f.pair,[f.read()],{source:{...f.source(),opposingSheetSha256:undefined}}),/source changed/);
  f.input.legalActions.active[0].moves[0]={move:'Psychic',target:'normal',pp:10};f.input.board.sides[0].pokemon[0].ability='Intimidate';
  assert.throws(()=>validateSelectedRecipientEffects(f.facts(),[{type:'move',slot:1,target:2},f.pair[1]],[f.read()],{source:f.source()}),/type-immune/);
});
test('dynamic typing, own selected Mega, current redirection and spread/ally scope do not create false hard blocks',()=>{
  const changes=[
    f=>{f.input.board.sides[1].pokemon[1].volatiles.typechange={name:'typechange'};},
    f=>{f.input.board.sides[1].pokemon[1].volatiles.typeadd={name:'typeadd'};},
    f=>{f.input.board.sides[1].pokemon[1].volatiles.roost={name:'roost'};},
    f=>{f.input.board.sides[0].pokemon[1].volatiles.electrify={name:'electrify'};},
    f=>{f.input.field={};f.input.board.field.conditions.iondeluge={};},
    f=>{f.input.legalActions.active[1].moves[0]={move:'Weather Ball',target:'normal',pp:10};},
    f=>{f.pair[1].mega=true;},
    f=>{f.input.board.sides[1].pokemon[0].volatiles.followme={};},
    f=>{f.input.board.sides[1].pokemon[1].item='Ring Target';f.input.board.sides[1].pokemon[1].itemKnown=true;},
    f=>{f.input.legalActions.active[0].moves[0]={move:'Electrify',target:'any',pp:10};f.pair[0]={type:'move',slot:1,target:-2};},
    f=>{f.input.legalActions.active[1].moves[0]={move:'Expanding Force',target:'allAdjacentFoes',pp:10};},
    f=>{f.pair[1].target=-1;},
  ];
  for(const [index,change]of changes.entries()){const f=recipientFixture();change(f);assert.doesNotThrow(()=>validateSelectedRecipientEffects(f.facts(),f.pair,undefined,{source:f.source()}),`countercase ${index}`);}
});
test('a form read names the published possible form without crediting its future effect',()=>{
  const f=recipientFixture();f.input.legalActions.active[1].moves[0]={move:'High Horsepower',target:'normal',pp:10};
  Object.assign(f.input.board.sides[1].pokemon[1],{species:'Gyarados',item:'Gyaradosite',itemKnown:true});
  f.input.opponentSheet[1]={species:'Gyarados',ability:'Intimidate',item:'Gyaradosite',moves:['Waterfall','Protect']};
  const read=f.read();read.expected={kind:'form',species:'Gyarados-Mega'};
  assert.throws(()=>validateSelectedRecipientEffects(f.facts(),f.pair,undefined,{source:f.source()}),/type-immune to Ground/);
  assert.equal(validateSelectedRecipientEffects(f.facts(),f.pair,[read],{source:f.source()}).futureEffectsVerified,false);
  read.expected.species='Charizard-Mega-Y';assert.throws(()=>validateSelectedRecipientEffects(f.facts(),f.pair,[read],{source:f.source()}),/published possible Mega form/);
  read.expected.species='Gyarados-Mega';f.input.board.sides[1].pokemon[1].species='Tornadus';
  Object.assign(read.source,Object.fromEntries(['boardHash','requestDigest','opposingSheetSha256'].map(name=>[name,f.source()[name]])));
  assert.throws(()=>validateSelectedRecipientEffects(f.facts(),f.pair,[read],{source:f.source()}),/published possible Mega form/);
});
test('type converters, immunity bypasses and observed grounding use current native mechanics',()=>{
  const f=recipientFixture();
  f.input.board.sides[0].pokemon[1].ability='Liquid Voice';assert.equal(buildRecipientEffects(f.facts()).blocked.length,0);
  f.input.board.sides[0].pokemon[1].ability='Armor Tail';f.input.board.sides[1].pokemon[1].volatiles.miracleeye={};assert.equal(buildRecipientEffects(f.facts()).blocked.length,0);
  delete f.input.board.sides[1].pokemon[1].volatiles.miracleeye;
  f.input.legalActions.active[1].moves[0]={move:'Tackle',target:'normal',pp:10};f.input.board.sides[1].pokemon[1].species='Gengar';f.input.board.sides[0].pokemon[1].ability='Pixilate';
  assert.equal(buildRecipientEffects(f.facts()).blocked.length,0);
  f.input.board.sides[0].pokemon[1].ability='Scrappy';f.input.legalActions.active[1].moves[0]={move:'Tackle',target:'normal',pp:10};assert.equal(buildRecipientEffects(f.facts()).blocked.length,0);
  f.input.board.sides[0].pokemon[1].ability='Mold Breaker';assert.equal(buildRecipientEffects(f.facts()).blocked.length,1);
  f.input.board.sides[1].pokemon[1].volatiles.foresight={};assert.equal(buildRecipientEffects(f.facts()).blocked.length,0);delete f.input.board.sides[1].pokemon[1].volatiles.foresight;
  f.input.board.sides[0].pokemon[1].ability='Armor Tail';f.input.legalActions.active[1].moves[0]={move:'High Horsepower',target:'normal',pp:10};f.input.board.sides[1].pokemon[1].species='Tornadus';
  assert.equal(buildRecipientEffects(f.facts()).blocked.length,1);f.input.board.field.conditions.gravity={};assert.equal(buildRecipientEffects(f.facts()).blocked.length,0);
});
test('a source-bound future redirection read is explicit and must name an eligible published redirector',()=>{
  const f=recipientFixture();f.input.opponentSheet[0].moves.push('Follow Me');const read=f.read();
  read.expected={kind:'redirection',recipientId:f.input.board.sides[1].pokemon[0].id,move:'Follow Me'};
  assert.doesNotThrow(()=>validateSelectedRecipientEffects(f.facts(),f.pair,[read],{source:f.source()}));
  read.expected.move='Rage Powder';assert.throws(()=>validateSelectedRecipientEffects(f.facts(),f.pair,[read],{source:f.source()}),/redirection read/);
  read.expected.move='Follow Me';f.input.board.sides[0].pokemon[1].ability='Stalwart';
  // Source and read are current, but the selected actor ignores redirection.
  Object.assign(read.source,Object.fromEntries(['boardHash','requestDigest','opposingSheetSha256'].map(name=>[name,f.source()[name]])));
  assert.throws(()=>validateSelectedRecipientEffects(f.facts(),f.pair,[read],{source:f.source()}),/redirection read/);
});

test('explicit ineffective-action costs preserve exact partner linkage and never establish successful effects',()=>{
  const f=recipientFixture(),read=f.read(),ack={actorId:read.actorId,moveSlot:read.moveSlot,targetSlot:read.targetSlot,currentTargetId:read.currentTargetId,source:read.source,
    acknowledgeNoCurrentEffect:true,independentActorId:f.input.board.sides[0].pokemon[0].id,purpose:'Partner Protect is an authored stall; this Psychic Noise has no current effect.'},before=structuredClone(f.pair);
  const audit=validateSelectedRecipientEffects(f.facts(),f.pair,undefined,{source:f.source(),ineffectiveActions:[ack]});
  assert.deepEqual(f.pair,before);assert.equal(audit.ineffectiveActions[0].status,'acknowledged-no-current-effect');assert.deepEqual(audit.ineffectiveActions[0].independentAction,f.pair[0]);
  for(const name of ['independentEffectVerified','usefulnessVerified','forcednessVerified'])assert.equal(audit.ineffectiveActions[0][name],false);
  for(const change of [a=>{a.source.boardHash='d'.repeat(64);},a=>{a.actorId='other';},a=>{a.moveSlot=2;},a=>{a.currentTargetId='other';},a=>{a.independentActorId=ack.actorId;},a=>{a.independentActorId='invented';}]){
    const altered=structuredClone(ack);change(altered);assert.throws(()=>validateSelectedRecipientEffects(f.facts(),f.pair,undefined,{source:f.source(),ineffectiveActions:[altered]}));
  }
  assert.throws(()=>validateSelectedRecipientEffects(f.facts(),f.pair,undefined,{source:f.source(),ineffectiveActions:[ack,ack]}),/Duplicate/);
  assert.throws(()=>validateSelectedRecipientEffects(f.facts(),f.pair,[read],{source:f.source(),ineffectiveActions:[ack]}),/conflicting/);
  assert.throws(()=>validateSelectedRecipientEffects(f.facts(),[f.pair[0],{type:'move',slot:1,target:1}],undefined,{source:f.source(),ineffectiveActions:[ack]}),/differs/);
});
test('all-ineffective acknowledgements are explicit costs, including purposeful stalling, with no independent success credit',()=>{
  const f=recipientFixture();f.input.legalActions.active[0].moves[0]={move:'Psychic',target:'normal',pp:10};f.input.board.sides[0].pokemon[0].ability='Intimidate';
  const pair=[{type:'move',slot:1,target:2},f.pair[1]],source=f.source(),own=f.input.board.sides[0].pokemon;
  const acks=own.slice(0,2).map((actor,index)=>({actorId:actor.id,moveSlot:1,targetSlot:2,currentTargetId:f.input.board.sides[1].pokemon[1].id,source:Object.fromEntries(['boardHash','requestDigest','opposingSheetSha256'].map(name=>[name,source[name]])),acknowledgeNoCurrentEffect:true,
    independentActorId:own[1-index].id,purpose:'Both attacks fail currently; this is an authored necessary stall, not pressure.'}));
  const audit=validateSelectedRecipientEffects(f.facts(),pair,undefined,{source,ineffectiveActions:acks});
  assert.equal(audit.ineffectiveActions.length,2);assert(audit.ineffectiveActions.every(row=>row.status==='acknowledged-no-current-effect'&&row.independentEffectVerified===false&&row.usefulnessVerified===false));
});
test('no-effect acknowledgement sheet binding follows exact actual presence while future-recipient reads still require a sheet',()=>{
  const f=recipientFixture(),read=f.read(),ack={actorId:read.actorId,moveSlot:read.moveSlot,targetSlot:read.targetSlot,currentTargetId:read.currentTargetId,source:{...read.source},acknowledgeNoCurrentEffect:true,
    independentActorId:f.input.board.sides[0].pokemon[0].id,purpose:'Accept the current failed hit while preserving the named partner stall.'};
  const noSheet={...f.source()};delete noSheet.opposingSheetSha256;
  assert.throws(()=>validateSelectedRecipientEffects(f.facts(),f.pair,undefined,{source:noSheet,ineffectiveActions:[ack]}),/source changed/);
  const omitted=structuredClone(ack);delete omitted.source.opposingSheetSha256;
  assert.equal(validateSelectedRecipientEffects(f.facts(),f.pair,undefined,{source:noSheet,ineffectiveActions:[omitted]}).ineffectiveActions[0].status,'acknowledged-no-current-effect');
  assert.throws(()=>validateSelectedRecipientEffects(f.facts(),f.pair,undefined,{source:f.source(),ineffectiveActions:[omitted]}),/source changed/);
  assert.throws(()=>validateSelectedRecipientEffects(f.facts(),f.pair,[read],{source:noSheet}),/source changed/);
  const wrong=structuredClone(ack);wrong.source.opposingSheetSha256='f'.repeat(64);
  assert.throws(()=>validateSelectedRecipientEffects(f.facts(),f.pair,undefined,{source:f.source(),ineffectiveActions:[wrong]}),/source changed/);
});
