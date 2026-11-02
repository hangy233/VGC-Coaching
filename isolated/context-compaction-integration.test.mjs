import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {buildDecisionContextSource,buildDecisionContext,ISOLATED_POLICY_SOURCE} from './decision-context.mjs';
import {compactContextPayload,restoreContextPayload} from './context-compaction.mjs';
import {loadMaintainedMatchupGuidance} from './matchup-guidance.mjs';
import {MAX_CONTEXT_BYTES} from './context-limits.mjs';
import {validateChoice} from '../showdown/choice-validation.mjs';

// Public, synthetic observations exercise the whole source -> projection ->
// budget -> native validation boundary, independently of ignored battle archives.
const ROOM='battle-gen9championsvgc2026regmcbo3-181';
const PARENT='game-bestof3-gen9championsvgc2026regmcbo3-180';
const names=['Garchomp','Tyranitar','Rillaboom','Politoed','Farigiraf','Sylveon'];
const abilities=['Rough Skin','Sand Stream','Grassy Surge','Drizzle','Armor Tail','Pixilate'];
const moveSets=[['Dragon Claw','Earthquake','Stomping Tantrum','Protect'],['Rock Slide','Crunch','Low Kick','Protect'],
  ['Wood Hammer','Grassy Glide','Fake Out','Protect'],['Weather Ball','Helping Hand','Encore','Protect'],
  ['Psychic','Helping Hand','Trick Room','Protect'],['Hyper Voice','Calm Mind','Moonblast','Protect']];
const ownTeamText=names.map((name,index)=>`${name}${index===0?' @ Garchompite':index===1?' @ Tyranitarite':''}\nAbility: ${abilities[index]}\nLevel: 50\n${index===0?'Jolly':'Adamant'} Nature\n${moveSets[index].map(move=>`- ${move}`).join('\n')}`).join('\n\n');
const opponentSheet=[
  {species:'Corviknight',ability:'Mirror Armor',item:'Choice Scarf',moves:['Brave Bird','Iron Head','Tailwind','Protect']},
  {species:'Gengar',ability:'Cursed Body',item:'Gengarite',moves:['Shadow Ball','Sludge Bomb','Encore','Protect']},
  {species:'Incineroar',ability:'Intimidate',item:'Sitrus Berry',moves:['Fake Out','Knock Off','Flare Blitz','Parting Shot']},
  {species:'Rotom-Wash',ability:'Levitate',item:'Sitrus Berry',moves:['Hydro Pump','Thunderbolt','Will-O-Wisp','Protect']},
  {species:'Sinistcha',ability:'Hospitality',item:'Rocky Helmet',moves:['Matcha Gotcha','Life Dew','Trick Room','Rage Powder']},
  {species:'Excadrill',ability:'Sand Rush',item:'Focus Sash',moves:['Earthquake','Iron Head','High Horsepower','Protect']},
];
const byteLength=value=>Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value));
const matchupGuidance=loadMaintainedMatchupGuidance(ISOLATED_POLICY_SOURCE);
const protectedSkillBytes=byteLength(matchupGuidance);
const promptBudget=(context,turnBytes)=>protectedSkillBytes+byteLength(context.instructions)+byteLength(context.schema)+turnBytes;
const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}return value;};

function fixture(repetitions=0) {
  const actor=(id,species,index)=>({id:`${id}-${index}`,nickname:species,species,activeSlot:index<2?index+1:null,
    requestIndex:id==='p2'?index+1:null,identityConfidence:'confirmed',selection:'selected',
    hp:{current:100,max:100,precision:id==='p2'?'server-own-exact':'server-display'},fainted:false,
    boosts:{atk:id==='p1'&&index===0?-1:0,spe:0},status:null,
    ability:id==='p2'?abilities[index]:opponentSheet[index].ability,item:null,itemKnown:id==='p1'&&index===0,
    itemHistory:id==='p1'&&index===0?[{item:'Choice Scarf',event:'lost',turn:2}]:[],mega:{evolved:false},moves:[],volatiles:{}});
  const side=(id,list)=>({id,selectedTeamSize:4,selectionKnowledge:id==='p2'?'current-own-request':'observed-opponents-only',
    unrevealedSelected:id==='p1'?2:0,active:list.slice(0,2).map((_,index)=>({slot:index+1,pokemon:`${id}-${index}`})),
    reserves:list.slice(2).map((_,index)=>`${id}-${index+2}`),pokemon:list.map((name,index)=>actor(id,name,index)),
    conditions:id==='p2'?{tailwind:{turns:1,minimumRemaining:0,maximumRemaining:1}}:{}});
  const legalActions={pokemon:names.slice(0,4).map((name,index)=>({ident:`p2: ${name}`,details:`${name}, L50`,condition:'100/100',active:index<2})),
    active:[{canMegaEvo:true,moves:[{move:'Dragon Claw',target:'normal',pp:10},{move:'Earthquake',target:'allAdjacent',pp:10},{move:'Stomping Tantrum',target:'normal',pp:10},{move:'Protect',target:'self',pp:10}]},
      {canMegaEvo:true,moves:[{move:'Rock Slide',target:'allAdjacentFoes',pp:10},{move:'Crunch',target:'normal',pp:10},{move:'Low Kick',target:'normal',pp:10},{move:'Protect',target:'self',pp:10}]}]};
  const board={room:ROOM,parentId:PARENT,turn:3,ownSide:'p2',request:{rqid:7},observedAt:1000,updatedAt:1000,
    field:{weather:null,terrain:{id:'grassyterrain',minimumRemaining:1,maximumRemaining:3},conditions:{trickroom:null}},
    sides:[side('p1',['Corviknight','Gengar']),side('p2',names.slice(0,4))],opponentSheets:{p1:opponentSheet},warnings:[],
    recentEvents:{lines:['|start','|turn|2','|move|p2a: Garchomp|Dragon Claw|p1b: Gengar',
      '|move|p1b: Gengar|Shadow Ball|p2a: Garchomp','|-enditem|p1a: Corviknight|Choice Scarf','|turn|3'],omitted:0,truncated:false}};
  // Future structured current facts must survive even when an old 96k source
  // builder would have deleted order/resources before producing a fast menu.
  board.sides[1].pokemon[0].volatiles.observedConditionEvidence=Array.from({length:repetitions},(_,index)=>({
    condition:'focusenergy',actorId:'p2-0',source:'public-protocol',active:true,sequence:index,
    duration:{remaining:null,known:false},qualifiers:['current-board-observation','not-a-numerical-inference'],
    explanation:'The current effect is observed. Its unrevealed duration and the opponent investment remain unknown; preserve the original evidence and its qualification. 条件不明・évidence.',
    ...(index%3===0?{}:{futureField:index%3===1?null:{confirmed:false,values:[false,null,'unknown']}}),
  }));
  const state={sessionId:'offline-compaction-session',teamId:'offline-compaction-team',connected:true,authenticated:true,stopped:false,
    actions:[{kind:'turn',room:ROOM,parentId:PARENT,rqid:7,revision:9,token:'offline-compaction-request',actionable:true,legalActions}],
    boards:[board],rooms:[{id:ROOM,parentId:PARENT,ended:false}],controlPolicy:{pending:[]}};
  const strategicMemory={teamId:state.teamId,parentId:PARENT,gameId:ROOM,
    facts:{observedOrderConstraints:[{first:'p2-0',second:'p1-1',tiesPossible:true,currentReuse:false,
      originalConditions:{weather:null,trickRoom:'unknown'},reason:'Original ordering state remains uncertain.'}],
      confirmedReveals:[{actorId:'p1-0',item:'Choice Scarf',event:'lost',turn:2}],recentEvents:['Observed previous turn.']},
    claims:{currentPlan:{objective:'Preserve paired pressure and the later weather answer.',preserveIds:['p2-3'],nextCondition:'Reassess after the reply.'},
      lastGameAdaptations:['Agent claim: an opposing switch remains plausible.']}};
  return {state,ownTeamText,opponentSheet,strategicMemory,matchupGuidance,includeMatchupSkill:true,skillVersion:ISOLATED_POLICY_SOURCE.skillVersion,
    skillSha256:ISOLATED_POLICY_SOURCE.skillSha256,now:()=>1001};
}

function assertActualBudget(built,maxBytes) {
  const total=byteLength(built.input)+byteLength(built.instructions)+byteLength(built.schema);
  assert.equal(built.promptMetadata.totalBytes,total);
  assert.equal(built.promptMetadata.maxBytes,maxBytes);
  assert.equal(built.promptMetadata.hardCapBytes,maxBytes);
  assert(total<=maxBytes,`Actual ${total} byte prompt exceeds selected ${maxBytes} byte limit.`);
  assert.equal(built.promptMetadata.hardCapExceeded,false);
  assert.deepEqual(restoreContextPayload(JSON.parse(built.input)).matchupSkill,matchupGuidance,'Required complete skill contents must survive every budget stage.');
}

function assertSourceBinding(source,built) {
  for(const [key,value]of Object.entries(source.binding))assert.deepEqual(built.binding[key],value,`${key} binding`);
  assert.deepEqual(built.legalOptions,source.legalOptions);
}

function assertDeclaredArchiveOnly(raw,restored,metadata,{fast=false}={}) {
  const expected=structuredClone(raw),actual=structuredClone(restored),omitted=metadata.omittedHistory??[];
  for(const row of omitted){
    assert(['strategicMemory.claims.lastGameAdaptations','strategicMemory.facts.recentEvents'].includes(row.path),`Undeclared protected path ${row.path}`);
    assert.equal(row.order,'oldest-first');assert(Number.isInteger(row.count)&&row.count>0);assert(row.reason);
    const path=row.path.split('.'),key=path.pop(),holder=path.reduce((value,part)=>value[part],expected);
    assert(row.count<=holder[key].length);holder[key]=holder[key].slice(row.count);
  }
  if(!Object.hasOwn(expected,'contextCoverage')&&Object.hasOwn(actual,'contextCoverage')){
    const coverage=actual.contextCoverage.boundedContextCompaction;
    assert(coverage,'Additional coverage must declare bounded context compaction.');
    assert.deepEqual(coverage.omittedHistory,omitted);assert.match(coverage.historyCoverage,/unknown/iu);
    delete actual.contextCoverage;
  }
  if(fast){
    delete expected.legalOptions;delete expected.guidance;
    delete actual.legalOptions;delete actual.guidance;
    delete actual.hostRouteConstraints;delete actual.firstChoiceScope;
  }
  assert.deepEqual(actual,expected,'Every protected current fact must roundtrip from the unbudgeted host source.');
  for(const key of ['recentEvents','resources','observedOrderConstraints'])assert.deepEqual(restored[key],raw[key],key);
  assert.deepEqual(restored.strategicMemory.facts.confirmedReveals,raw.strategicMemory.facts.confirmedReveals);
  assert.deepEqual(restored.strategicMemory.facts.observedOrderConstraints,raw.strategicMemory.facts.observedOrderConstraints);
  assert.deepEqual(restored.strategicMemory.claims.currentPlan,raw.strategicMemory.claims.currentPlan);
}

test('archive-only budget relief declares exact oldest removals while every current fact and ref remains intact',()=>{
  const options=fixture(),uniqueText=(label,length)=>Array.from({length:8},(_,index)=>createHash('sha256').update(`${label}-${index}`).digest('hex')).join('').slice(0,length);
  options.strategicMemory.facts.recentEvents=Array.from({length:8},(_,index)=>uniqueText(`archived-event-${index}`,480));
  options.strategicMemory.claims.lastGameAdaptations=Array.from({length:3},(_,index)=>uniqueText(`old-agent-claim-${index}`,360));
  const source=buildDecisionContextSource({...options,includeMatchupSkill:true}),raw=JSON.parse(source.input),wide=buildDecisionContext(options);
  assert.equal((wide.promptMetadata.omittedHistory??[]).length,0);
  // Choose a cap immediately below this fixture's fully lossless encoding so
  // this checks archive pruning even when the codec learns a better table.
  // The codec chooses no expected facts or legal choices for these assertions.
  const lossless=compactContextPayload(restoreContextPayload(restoreContextPayload(JSON.parse(wide.input))),{
    maxBytes:MAX_CONTEXT_BYTES,targetBytes:0,instructionBytes:byteLength(wide.instructions),schemaBytes:byteLength(wide.schema),
  });
  assert(lossless.fits);assert.equal(lossless.metadata.omittedHistory.length,0);
  const selectedCap=lossless.metadata.finalBytes-200;
  assert(selectedCap>protectedSkillBytes&&selectedCap<MAX_CONTEXT_BYTES);
  const protectedOnly={...options,strategicMemory:structuredClone(options.strategicMemory)};
  protectedOnly.strategicMemory.facts.recentEvents=[];protectedOnly.strategicMemory.claims.lastGameAdaptations=[];
  assertActualBudget(buildDecisionContext({...protectedOnly,maxBytes:selectedCap}),selectedCap);
  const bounded=buildDecisionContext({...options,maxBytes:selectedCap}),restored=restoreContextPayload(JSON.parse(bounded.input));
  assertActualBudget(bounded,selectedCap);assert(bounded.promptMetadata.omittedHistory.length>0,'The test must actually exercise archive removal.');
  assertDeclaredArchiveOnly(raw,restored,bounded.promptMetadata,{fast:false});
  assert.deepEqual(bounded.optionRefs,wide.optionRefs);assert.deepEqual(bounded.binding,wide.binding);
  assertSourceBinding(source,bounded);assert.deepEqual(bounded.legalOptions,wide.legalOptions);
  assert(restored.contextCoverage?.boundedContextCompaction?.omittedHistory.length>0,'The model input must disclose the omitted archive.');
});

test('unique protected evidence still produces typed bounded overflow with no silent current-fact deletion',()=>{
  const options=fixture();
  options.state.boards[0].sides[1].pokemon[0].volatiles.uniqueObservedValue=Array.from({length:36},(_,index)=>
    Array.from({length:28},(_,block)=>createHash('sha256').update(`unique-current-${index}-${block}`).digest('hex')).join(''));
  const source=buildDecisionContextSource({...options,includeMatchupSkill:true}),raw=JSON.parse(source.input),values=raw.actors.find(actor=>actor.id==='p2-0').volatiles.uniqueObservedValue;
  assert.equal(values.length,36);assert(values.every(value=>value.length===1792));
  assert(byteLength(source.input)-protectedSkillBytes>64000);
  for(const build of [buildDecisionContext,buildDecisionContext]){
    const wide=build(options),limit=promptBudget(wide,32000);
    assertActualBudget(wide,MAX_CONTEXT_BYTES);
    assert.throws(()=>build({...options,maxBytes:limit}),error=>{
    assert.equal(error.code,'ISOLATED_CONTEXT_OVERFLOW');
    assert.equal(error.promptMetadata.maxBytes,limit);assert.equal(error.promptMetadata.hardCapBytes,limit);
    assert(error.promptMetadata.totalBytes>limit);assert.equal(error.promptMetadata.hardCapExceeded,true);
    assert.equal(error.promptMetadata.legalOptionsPreserved,true);assert.equal(error.promptMetadata.criticalFactsPreserved,true);
    assert((error.promptMetadata.omitted??[]).every(path=>['strategicMemory.facts.recentEvents','strategicMemory.claims.lastGameAdaptations'].includes(path)));
    return true;
  });
  }
  assert.deepEqual(JSON.parse(buildDecisionContextSource({...options,includeMatchupSkill:true}).input),raw,'Overflow must not trim or mutate the retained host source.');
});
