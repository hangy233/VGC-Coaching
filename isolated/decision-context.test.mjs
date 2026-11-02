import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDecisionContext,buildDecisionContextSource,rebudgetDecisionContext, validateIsolatedDecision, updateStrategicMemory,ISOLATED_POLICY_SOURCE,verifyIsolatedPolicySource} from './decision-context.mjs';
import {loadMaintainedMatchupGuidance} from './matchup-guidance.mjs';
import {MAX_CONTEXT_BYTES} from './context-limits.mjs';
import {restoreContextPayload} from './context-compaction.mjs';

const ownTeamText = `Golisopod @ Assault Vest
Ability: Emergency Exit
Level: 50
Adamant Nature
EVs: 10 HP / 32 Atk / 24 SpD
- First Impression
- Leech Life
- Liquidation
- Knock Off

Hydreigon @ Choice Scarf
Ability: Levitate
Level: 50
Timid Nature
- Draco Meteor
- Dark Pulse
- Heat Wave
- Snarl

Rillaboom @ Miracle Seed
Ability: Grassy Surge
- Fake Out
- Grassy Glide
- Wood Hammer
- Protect

Politoed @ Sitrus Berry
Ability: Drizzle
- Weather Ball
- Helping Hand
- Encore
- Protect

Farigiraf @ Safety Goggles
Ability: Armor Tail
- Psychic
- Helping Hand
- Trick Room
- Protect

Sylveon @ Throat Spray
Ability: Pixilate
- Hyper Voice
- Tera Blast
- Calm Mind
- Protect`;
const names = ['Golisopod','Hydreigon','Rillaboom','Politoed','Farigiraf','Sylveon'];
const party = () => names.slice(0,4).map((name,index) => ({ident:`p2: ${name}`,details:`${name}, L50`,condition:'100/100',active:index < 2}));
const moves = () => [
  {move:'Leech Life',id:'leechlife',target:'normal',pp:10},
  {move:'Knock Off',id:'knockoff',target:'normal',pp:10},
  {move:'Liquidation',id:'liquidation',target:'normal',pp:10},
  {move:'Protect',id:'protect',target:'self',pp:10},
];
const room = 'battle-gen9championsvgc2026regmcbo3-52';
const opponentSheet = [
  {species:'Corviknight',ability:'Mirror Armor',item:'Choice Scarf',moves:['Brave Bird','Iron Head','Tailwind','Protect']},
  {species:'Tyranitar',ability:'Sand Stream',item:'Tyranitarite',moves:['Rock Slide','Knock Off','Low Kick','Protect']},
  {species:'Incineroar',ability:'Intimidate',item:'Sitrus Berry',moves:['Fake Out','Knock Off','Flare Blitz','Parting Shot']},
  {species:'Rotom-Wash',ability:'Levitate',item:'Sitrus Berry',moves:['Hydro Pump','Thunderbolt','Will-O-Wisp','Protect']},
  {species:'Sinistcha',ability:'Hospitality',item:'Rocky Helmet',moves:['Matcha Gotcha','Life Dew','Trick Room','Rage Powder']},
  {species:'Excadrill',ability:'Sand Rush',item:'Focus Sash',moves:['Earthquake','Iron Head','High Horsepower','Protect']},
];
function fixture({preview = false, replacement = false} = {}) {
  const pokemon = preview ? names.map((name,index) => ({ident:`p2: ${name}`,details:`${name}, L50`,condition:'100/100',active:index < 2})) : party();
  const legalActions = {teamPreview:preview,maxChosenTeamSize:preview ? 4 : undefined,pokemon,
    active:replacement || preview ? null : [{canMegaEvo:true,moves:moves()},{moves:[{move:'Dark Pulse',id:'darkpulse',target:'normal',pp:10},{move:'Helping Hand',id:'helpinghand',target:'adjacentAlly',pp:10},{move:'Protect',id:'protect',target:'self',pp:10}]}],
    forceSwitch:replacement ? [true,false] : null};
  if (replacement) pokemon[0].condition = '0 fnt';
  const raw = (name,index,side = 'p2') => ({id:`${side}-${index}`,nickname:name,species:name,activeSlot:index < 2 ? index + 1 : null,requestIndex:side === 'p2' ? index + 1 : null,
    identityConfidence:'confirmed',selection:'selected',hp:{current:100,max:100,precision:side === 'p2' ? 'server-own-exact' : 'server-display'},fainted:replacement && side === 'p2' && index === 0,
    boosts:{atk:side === 'p1' && index === 0 ? -1 : 0},status:null,ability:side === 'p2' ? 'Emergency Exit' : index === 0 ? 'Mirror Armor' : 'Sand Stream',item:null,itemKnown:side === 'p1' && index === 0,
    itemHistory:side === 'p1' && index === 0 ? [{item:'Choice Scarf',event:'lost',turn:2}] : [],mega:{evolved:false},moves:[],volatiles:{}});
  const side = (id,list) => ({id,selectedTeamSize:preview ? null : 4,selectionKnowledge:id === 'p2' ? preview ? 'preview-only' : 'current-own-request' : 'observed-opponents-only',unrevealedSelected:preview ? null : id === 'p2' ? 0 : 2,
    active:list.slice(0,2).map((_,index) => ({slot:index + 1,pokemon:`${id}-${index}`})),reserves:list.slice(2).map((_,index) => `${id}-${index + 2}`),pokemon:list.map((name,index) => raw(name,index,id)),conditions:{}});
  const board = {room,parentId:'game-bestof3-51',turn:3,ownSide:'p2',observedAt:3000,updatedAt:3000,field:{weather:null,terrain:null,conditions:{}},request:{rqid:7},
    sides:[side('p1',['Corviknight','Tyranitar']),side('p2',preview ? names : names.slice(0,4))],recentEvents:{lines:['|turn|2','|-enditem|p1a: Corviknight|Choice Scarf','|-weather|none','|turn|3'],omitted:0,truncated:false,scope:'latest-two-observed-turns'},warnings:[]};
  const action = {kind:preview ? 'preview' : replacement ? 'switch' : 'turn',room,parentId:'game-bestof3-51',rqid:7,revision:9,token:'PRIVATE-REQUEST-TOKEN',receivedAt:2900,legalActions};
  return {sessionId:'session-fixture',teamId:'team-fixture',connected:true,authenticated:true,actions:[action],boards:[board],rooms:[{id:room,parentId:'game-bestof3-51',ended:false}],controlPolicy:{pending:[]}};
}
const args = state => ({state,ownTeamText,opponentSheet,skillVersion:ISOLATED_POLICY_SOURCE.skillVersion,skillSha256:ISOLATED_POLICY_SOURCE.skillSha256,now:() => 3001});

test('turn source delivers native move priorities and own reported Speed without calculating effective order',()=>{
  const state=fixture(),legal=state.actions[0].legalActions;
  legal.pokemon[0].stats={atk:150,def:100,spa:80,spd:100,spe:97};
  state.boards[0].field.conditions.trickroom={remainingTurns:{min:2,max:2}};
  state.boards[0].sides.find(side=>side.id==='p2').conditions.tailwind={remainingTurns:{min:1,max:1}};
  state.boards[0].sides.find(side=>side.id==='p2').pokemon[0].status='par';
  const before=structuredClone(state),payload=JSON.parse(buildDecisionContextSource(args(state)).input),order=payload.moveOrder;
  assert.deepEqual(state,before,'Presentation must not rewrite source facts or stats');
  const own=order.actors.find(actor=>actor.actorId==='p2-0');
  assert.equal(own.reportedSpeed.value,97);
  assert.equal(own.reportedSpeed.source,'current-own-server-request');
  assert.equal(own.reportedSpeed.atTurn,3);
  assert.match(own.reportedSpeed.meaning,/have not been applied/u);
  assert(order.actors.find(actor=>actor.actorId==='p2-1').movePriorities.some(([move,priority])=>move==='Helping Hand'&&priority===5));
  assert(order.actors.find(actor=>actor.actorId==='p2-1').movePriorities.some(([move,priority])=>move==='Protect'&&priority===4));
  assert(order.actors.filter(actor=>actor.actorId.startsWith('p1-')).every(actor=>!actor.reportedSpeed),'Opposing Speed must not be invented from a sheet');
  assert.equal(order.observedRelationsRef,'observedOrderConstraints');
  assert.equal(Object.hasOwn(order,'effectiveSpeed'),false);
  assert.equal(Object.hasOwn(order,'ranking'),false);
  assert.match(order.uncertainty,/Priority-changing effects are not applied/u);
});

test('move-order facts omit unavailable own stats, exclude disabled moves and do not promote preview actors',()=>{
  const state=fixture();state.actions[0].legalActions.active[1].moves[0].disabled=true;
  const order=JSON.parse(buildDecisionContextSource(args(state)).input).moveOrder;
  assert(order.actors.every(actor=>!actor.reportedSpeed));
  assert(!order.actors.find(actor=>actor.actorId==='p2-1').movePriorities.some(([move])=>move==='Dark Pulse'));
  assert.deepEqual(JSON.parse(buildDecisionContextSource(args(fixture({preview:true}))).input).moveOrder.actors,[]);
});

test('move facts distinguish base targets from current own menu without rewriting conditional targets',()=>{
  const state=fixture(),menu=state.actions[0].legalActions.active[0];
  menu.moves=[
    {move:'Snarl',target:'allAdjacentFoes',pp:10},
    {move:'Draco Meteor',target:'normal',pp:10},
    {move:'Curse',target:'self',pp:10},
    {move:'Expanding Force',target:'normal',pp:10},
  ];
  state.boards[0].field.terrain='psychicterrain';
  state.boards[0].sides[0].pokemon[0].moves=['Snarl','Draco Meteor'];
  const before=structuredClone(state),order=JSON.parse(buildDecisionContextSource(args(state)).input).moveOrder;
  assert.deepEqual(state,before,'Target metadata must not rewrite legal menus or battle state');
  assert.deepEqual(order.targetColumns,['move','nativeBaseTarget','currentOwnMenuTarget']);
  const own=order.actors.find(actor=>actor.actorId==='p2-0');
  assert.deepEqual(own.moveTargets,[['Snarl','allAdjacentFoes','allAdjacentFoes'],['Draco Meteor','normal','normal'],['Curse','normal','self'],['Expanding Force','normal','normal']]);
  const opposing=order.actors.find(actor=>actor.actorId==='p1-0');
  assert(opposing.moveTargets.some(([name,base,current])=>name==='Snarl'&&base==='allAdjacentFoes'&&current===null));
  assert.match(order.targetMeaning,/not an opposing clickable menu/u);
  assert.match(order.targetMeaning,/form or field effects can change recipients/u);
  menu.moves[2].target='normal';
  assert.deepEqual(JSON.parse(buildDecisionContextSource(args(state)).input).moveOrder.actors.find(actor=>actor.actorId==='p2-0').moveTargets[2],['Curse','normal','normal']);
});

const decision = () => ({actions:[{type:'move',slot:2,target:1,mega:false},{type:'move',slot:1,target:2,mega:false}],
  planUpdate:{objective:'Remove the current attacker before exposing the cleaner.',preserveIds:['p2-1'],nextCondition:'Reassess after weather or item changes.'},reason:'Pressure both foes while retaining the later reset.',});



test('p2 current facts retain item loss, expired weather, stat drops and unknown registered reserves', () => {
  const built = buildDecisionContext(args(fixture())), input = restoreContextPayload(JSON.parse(built.input));
  assert.equal(input.board.ownSide,'p2'); assert.equal(input.board.field.weather,null);
  const foe = input.actors.find(actor => actor.id === 'p1-0');
  assert.equal(foe.item,null); assert.equal(foe.itemKnown,true); assert.equal(foe.boosts.atk,-1);
  assert.equal(foe.itemHistory[0].item,'Choice Scarf');
  assert.equal(foe.nature,null); assert.equal(foe.statPoints,null);
  const unseen = input.actors.filter(actor => actor.id.startsWith('registered:'));
  assert.equal(unseen.length,4); assert(unseen.every(actor => actor.selected === 'unknown' && actor.hp === null));
  assert.equal(input.board.sides.find(side => side.id === 'p1').unrevealedSelected,2);
  assert.equal(built.binding.token,'PRIVATE-REQUEST-TOKEN'); assert(!built.input.includes('PRIVATE-REQUEST-TOKEN'));
  for (const hostId of ['session-fixture','team-fixture',room]) assert(!built.input.includes(hostId));
  assert.equal(built.promptMetadata.historyIncluded,false); assert(built.promptMetadata.totalBytes <= MAX_CONTEXT_BYTES);
});

test('legal menu contains every move, all targets, optional Mega and all named switch recipients', () => {
  const built = buildDecisionContext(args(fixture()));
  const first = built.legalOptions.slots[0].options;
  for (const slot of [1,2,3]) for (const target of [-2,1,2]) for (const mega of [false,true]) assert(first.some(action => action.slot === slot && action.target === target && action.mega === mega));
  assert(first.some(action => action.slot === 4 && action.type === 'move' && action.target === undefined));
  assert.equal(first.filter(action => action.type === 'switch').length,2);
  assert(first.length > 4, 'advisory candidate shortlist must not constrain strategy');
  assert(!first.some(action => action.slot === 1 && action.target === -1));
  assert.equal(validateIsolatedDecision(decision(),{state:fixture(),binding:built.binding,ownTeamText}).choice,'move 2 1, move 1 2');
});

test('switch menus preserve per-slot trapping flags and uncertainty without banning maybeTrapped choices', () => {
  const state=fixture(),before=structuredClone(state);
  state.actions[0].legalActions.active[0].trapped=true;
  state.actions[0].legalActions.active[1].maybeTrapped=true;
  const built=buildDecisionContext(args(state)),payload=restoreContextPayload(JSON.parse(built.input));
  assert.deepEqual(payload.legalOptions.slots.map(slot=>slot.requestFlags),[
    {trapped:{present:true,value:true},maybeTrapped:{present:false,value:null}},
    {trapped:{present:false,value:null},maybeTrapped:{present:true,value:true}},
  ]);
  assert(!built.legalOptions.slots[0].options.some(action=>action.type==='switch'));
  assert.equal(built.legalOptions.slots[1].options.filter(action=>action.type==='switch').length,2);
  assert.match(payload.legalOptions.constraints.at(-1),/maybeTrapped.*provisional.*hidden trapping/);
  assert.deepEqual(built.schema,buildDecisionContext(args(before)).schema,'Request facts do not alter the authoring contract');
  for(const value of [false,null,undefined]){
    const next=fixture();if(value!==undefined)Object.assign(next.actions[0].legalActions.active[1],{trapped:value,maybeTrapped:value});
    const menu=restoreContextPayload(JSON.parse(buildDecisionContext(args(next)).input)).legalOptions;
    assert.deepEqual(menu.slots[1].requestFlags.maybeTrapped,{present:value!==undefined,value:value??null});
    assert.deepEqual(menu.slots[1].requestFlags.trapped,{present:value!==undefined,value:value??null});
    assert.equal(menu.slots[1].options.filter(action=>action.type==='switch').length,2);
  }
  const forced=buildDecisionContext(args(fixture({replacement:true})));
  assert(forced.legalOptions.replacementPairs.length>0,'Request uncertainty does not remove forced replacements');
  assert.deepEqual(forced.legalOptions.slots[0].requestFlags,{trapped:{present:false,value:null},maybeTrapped:{present:false,value:null}});
});

test('JSON shape is distinct from native legality, and metadata fields cannot smuggle commands', () => {
  const state = fixture(), built = buildDecisionContext(args(state));
  const invalid = decision(); invalid.actions[0].target = -1;
  assert.throws(() => validateIsolatedDecision(invalid,{state,binding:built.binding,ownTeamText}), /self/);
  const extra = decision(); extra.actions[0].command = 'battle_start';
  assert.throws(() => validateIsolatedDecision(extra,{state,binding:built.binding,ownTeamText}), /shape/);
  const unknown = decision(); unknown.room = 'other';
  assert.throws(() => validateIsolatedDecision(unknown,{state,binding:built.binding,ownTeamText}), /unknown/);
  const long = decision(); long.reason = 'x'.repeat(501);
  assert.throws(() => validateIsolatedDecision(long,{state,binding:built.binding,ownTeamText}), /bounded string/);
  const ambiguous = decision(); ambiguous.actions[0].mega = true; ambiguous.actions[1].mega = true;
  assert.throws(() => validateIsolatedDecision(ambiguous,{state,binding:built.binding,ownTeamText}), /Mega unavailable/);
});

test('fresh validation rejects changed session/team/room/request/token/board and reserved writes', () => {
  const original = fixture(), built = buildDecisionContext(args(original));
  for (const mutate of [
    state => {state.sessionId = 'new-session';}, state => {state.teamId = 'new-team';},
    state => {state.actions[0].rqid++;}, state => {state.actions[0].revision++;}, state => {state.actions[0].token = 'new-token';},
    state => {state.boards[0].sides[0].pokemon[0].hp.current = 90;},
    state => {state.actions[0].room = 'different';state.boards[0].room = 'different';state.rooms[0].id = 'different';},
    state => {state.actions[0].legalActions.active[0].moves[1].disabled = true;},
    state => {state.actions[0].submissionStatus = 'sent';}, state => {state.actions[0].actionable = false;},
    state => {state.controlPolicy.pending = [{token:state.actions[0].token,attempted:true}];},
  ]) {
    const state = structuredClone(original); mutate(state);
    assert.throws(() => validateIsolatedDecision(decision(),{state,binding:built.binding,ownTeamText}), /Stale|stale|reserved|sent/);
  }
});

test('preview requires four unique party indexes; replacements use current stable identities and both slots', () => {
  const preview = fixture({preview:true}), builtPreview = buildDecisionContext(args(preview)), pick = decision();
  pick.actions = [{type:'team',order:[1,5,3,4]}];
  assert.equal(builtPreview.legalOptions.party.length,6);
  assert.equal(validateIsolatedDecision(pick,{state:preview,binding:builtPreview.binding,ownTeamText}).choice,'team 1534');
  pick.actions[0].order = [1,1,3,4];
  assert.throws(() => validateIsolatedDecision(pick,{state:preview,binding:builtPreview.binding,ownTeamText}), /team-preview order/);
  const replacement = fixture({replacement:true}), built = buildDecisionContext(args(replacement));
  const legalPair = built.legalOptions.replacementPairs[0];
  assert.equal(legalPair[0].type,'switch'); assert.equal(legalPair[1].type,'pass');
  const replace = {...decision(),actions:legalPair};
  assert.match(validateIsolatedDecision(replace,{state:replacement,binding:built.binding,ownTeamText}).choice,/^switch [34], pass$/);
  replace.actions[0].pokemonId = 'stale-id';
  assert.throws(() => validateIsolatedDecision(replace,{state:replacement,binding:built.binding,ownTeamText}), /missing or ambiguous/);
});

test('bounded context excludes control secrets, private URLs, arbitrary history, and refuses critical overflow', () => {
  const state = fixture(); state.controller = {lease:'LEASE-SECRET'}; state.readReceipt = 'RECEIPT-SECRET'; state.codingLogs = 'CODING-SECRET';
  state.boards[0].recentEvents.lines.push('|move|p1a: https://private.example/watch|Brave Bird');
  const memory = {teamId:'team-fixture',parentId:'game-bestof3-51',gameId:room,conversation:'HISTORY-SECRET',claims:{currentPlan:{objective:'password=PASSWORD-SECRET',preserveIds:[],nextCondition:'readReceipt=RECEIPT-SECRET'}},facts:{confirmedReveals:[{event:'Knock Off observed',controlLease:'LEASE-SECRET',privateWatchUrl:'https://private.example/watch'}]}};
  const built = buildDecisionContext({...args(state),strategicMemory:memory});
  for (const secret of ['LEASE-SECRET','RECEIPT-SECRET','CODING-SECRET','HISTORY-SECRET','PASSWORD-SECRET','private.example','PRIVATE-REQUEST-TOKEN']) assert(!built.input.includes(secret), secret);
  assert.equal(Buffer.byteLength(built.input) + Buffer.byteLength(built.instructions) + Buffer.byteLength(JSON.stringify(built.schema)),built.promptMetadata.totalBytes);
  assert.throws(() => buildDecisionContext({...args(state),maxBytes:4000}), error => error.code === 'ISOLATED_CONTEXT_OVERFLOW' && error.promptMetadata.totalBytes > error.promptMetadata.maxBytes && error.promptMetadata.legalOptionsPreserved && error.promptMetadata.criticalFactsPreserved);
});

test('memory carries short intent and conditional observations without prior choices or full history', () => {
  const prior = {teamId:'team-fixture',parentId:'set-1',gameId:'game-1',actions:[{type:'move',slot:1}],transcript:'discard',facts:{observedOrderConstraints:[{first:'p1-0',second:'p2-0',tiesPossible:true,originalConditions:{weather:'rain'}}],confirmedReveals:['item lost']},claims:{currentPlan:{objective:'old',preserveIds:['p2-0'],nextCondition:'weather ends'},lastGameAdaptations:['Previous Protect -> split pressure; attack remains possible.']}};
  const memory = updateStrategicMemory(prior,decision(),{teamId:'team-fixture',parentId:'set-1',gameId:'game-2',events:['new game'],confirmedReveals:['Mirror Armor revealed']});
  assert.equal(memory.facts.observedOrderConstraints[0].tiesPossible,true);
  assert.deepEqual(memory.facts.confirmedReveals,['Mirror Armor revealed']);
  assert.equal(memory.claims.currentPlan.objective,decision().planUpdate.objective);
  assert.equal(memory.claims.lastGameAdaptations.length,1);
  assert(!JSON.stringify(memory).includes('transcript')); assert(!JSON.stringify(memory).includes('"actions"'));
  const many = updateStrategicMemory(memory,undefined,{teamId:'team-fixture',parentId:'set-1',gameId:'game-2',lastGameAdaptations:[{observation:'x'.repeat(9000),adjustment:'y'.repeat(9000)}],events:Array(50).fill('x'.repeat(5000)),observedOrderConstraints:Array.from({length:20},(_,index) => ({index,details:'y'.repeat(10000)}))});
  assert(many.facts.recentEvents.length <= 8); assert(many.facts.observedOrderConstraints.length <= 6);
  assert(Buffer.byteLength(JSON.stringify(many)) < 12000);
  assert(many.claims.lastGameAdaptations.every(row => typeof row === 'string' && row.length <= 360));
  const newTeam = updateStrategicMemory(memory,undefined,{teamId:'different',parentId:'set-2',gameId:'game-3'});
  assert.deepEqual(newTeam.facts.observedOrderConstraints,[]); assert.deepEqual(newTeam.claims.lastGameAdaptations,[]);
});

test('private room access suffixes never erase same-game memory or leak into its model context',()=>{
  const parent='game-bestof3-gen9championsvgc2026regmcbo3-101',child='battle-gen9championsvgc2026regmcbo3-102';
  const privateParent=parent+'-setaccessfixturepw',privateChild=child+'-childaccessfixturepw';
  const order={first:'p2-0',second:'p1-0',tiesPossible:true,direction:'unknown',originalConditions:{weather:'rain'},currentReuse:false};
  let memory=updateStrategicMemory({},decision(),{teamId:'team-fixture',parentId:privateParent,gameId:privateChild,
    events:['First observed reply'],observedOrderConstraints:[order],lastGameAdaptations:['Agent claim: preserve the weather reset.']});
  assert.equal(memory.parentId,parent);assert.equal(memory.gameId,child);
  for(let turn=2;turn<=4;turn++)memory=updateStrategicMemory(memory,undefined,{teamId:'team-fixture',parentId:privateParent,gameId:privateChild,events:[`Observed turn ${turn}`]});
  assert.equal(memory.claims.currentPlan.objective,decision().planUpdate.objective);assert.deepEqual(memory.facts.observedOrderConstraints,[order]);
  assert(memory.facts.recentEvents.includes('First observed reply'));assert(memory.facts.recentEvents.includes('Observed turn 4'));
  const state=fixture();state.actions[0].room=privateChild;state.actions[0].parentId=privateParent;state.boards[0].room=privateChild;state.boards[0].parentId=privateParent;state.rooms[0].id=privateChild;state.rooms[0].parentId=privateParent;
  const built=buildDecisionContext({...args(state),strategicMemory:memory});
  assert.equal(JSON.parse(built.input).strategicMemory.claims.currentPlan.objective,decision().planUpdate.objective);
  assert.equal(JSON.parse(built.input).strategicMemory.facts.recentEvents.length,4);
  for(const secret of ['setaccessfixturepw','childaccessfixturepw',privateParent,privateChild,'PRIVATE-REQUEST-TOKEN']){assert(!built.input.includes(secret),secret);assert(!JSON.stringify(memory).includes(secret),secret);}
});

test('private sibling games clear current plans and game events while retaining bounded set observations and adaptation claims',()=>{
  const parent='game-bestof3-gen9championsvgc2026regmcbo3-101-setaccessfixturepw',child='battle-gen9championsvgc2026regmcbo3-102-childaccessfixturepw';
  const prior=updateStrategicMemory({},decision(),{teamId:'team-fixture',parentId:parent,gameId:child,events:['Old child reply'],confirmedReveals:['Old child item'],observedOrderConstraints:[{tiesPossible:true,currentReuse:false}],lastGameAdaptations:['Agent claim: retain reserve pressure.']});
  // Previously stored raw private IDs are canonicalized when comparing too.
  prior.parentId=parent;prior.gameId=child;
  const sibling=updateStrategicMemory(prior,undefined,{teamId:'team-fixture',parentId:parent,gameId:'battle-gen9championsvgc2026regmcbo3-103-nextaccessfixturepw'});
  assert.equal(sibling.claims.currentPlan.objective,'');assert.deepEqual(sibling.facts.recentEvents,[]);assert.deepEqual(sibling.facts.confirmedReveals,[]);
  assert.equal(sibling.facts.observedOrderConstraints.length,1);assert.equal(sibling.claims.lastGameAdaptations.length,1);
  for(const change of [{teamId:'another-team',parentId:parent,gameId:child},{teamId:'team-fixture',parentId:'game-bestof3-gen9championsvgc2026regmcbo3-104-newsetfixturepw',gameId:child}]){
    const reset=updateStrategicMemory(sibling,undefined,change);assert.equal(reset.claims.currentPlan.objective,'');assert.deepEqual(reset.facts.observedOrderConstraints,[]);assert.deepEqual(reset.claims.lastGameAdaptations,[]);
  }
  const unsafe=updateStrategicMemory({},decision(),{teamId:'team-fixture',parentId:'https://private.example/parent?password=never',gameId:'https://private.example/child?apiKey=never'});
  assert(!JSON.stringify(unsafe).includes('private.example'));assert(!JSON.stringify(unsafe).includes('password=never'));assert(!JSON.stringify(unsafe).includes('apiKey=never'));
});








test('approved teamSha256 alias binds exactly and conflicting identity sources are refused', () => {
  const state = fixture(); delete state.teamId; state.teamSha256 = 'team-fixture';
  const built = buildDecisionContext(args(state));
  assert.equal(built.binding.teamId,'team-fixture');
  assert.equal(validateIsolatedDecision(decision(),{state,binding:built.binding,ownTeamText}).choice,'move 2 1, move 1 2');
  state.teamSha256 = 'different-team';
  assert.throws(() => validateIsolatedDecision(decision(),{state,binding:built.binding,ownTeamText}), /teamId binding/);
  state.teamId = 'conflicting-team';
  assert.throws(() => buildDecisionContext(args(state)), /identity sources conflict/);
});

test('an absent sheet stays explicitly incomplete and provides no invented opposing investment', () => {
  const built = buildDecisionContext({...args(fixture()),opponentSheet:[]}), input = JSON.parse(built.input);
  assert.deepEqual(input.opponentSheetStatus,{registeredCount:0,completeRegisteredSix:false,selectionUnknown:true,investmentsUnknownUnlessExplicit:true});
  assert(input.actors.filter(actor => !actor.own).every(actor => actor.statPoints === null && actor.nature === null));
});


test('runner protocol pins actual complete skill source and rejects claimed stale adoption', () => {
  const source=verifyIsolatedPolicySource();assert.equal(source.verified,true);assert.equal(source.files,10);assert.equal(source.actualSha256,ISOLATED_POLICY_SOURCE.skillSha256);
  assert.throws(() => verifyIsolatedPolicySource({skillVersion:'2026-10-26.old',skillSha256:ISOLATED_POLICY_SOURCE.skillSha256}), /review.*refresh/);
  assert.throws(() => buildDecisionContext({...args(fixture()),skillSha256:'c'.repeat(64)}), /review.*refresh/);
  const built=buildDecisionContext(args(fixture()));assert.equal(built.promptMetadata.sourceVerified,true);assert.equal(built.promptMetadata.policySha256,source.policySha256);
});

test('the model receives every exact maintained skill file instead of a duplicated runner strategy',()=>{
  const expected=loadMaintainedMatchupGuidance(ISOLATED_POLICY_SOURCE);
  const built=buildDecisionContext(args(fixture())),payload=restoreContextPayload(JSON.parse(built.input));
  assert.deepEqual(payload.matchupSkill,expected);
  for(const file of expected.files)assert.equal(payload.matchupSkill.files.find(row=>row.path===file.path).content,file.content);
  const main=payload.matchupSkill.files.find(file=>file.path==='SKILL.md');
  assert.match(main.content,/Cycle revision:/);
  assert.match(built.instructions,/matchupSkill.files/);
  assert(!built.instructions.includes('Compare immediate/delayed evolution'),'Strategy lives in the maintained skill only');
  assert(!built.instructions.includes('FIRST/all result pairs'),'The copied tactical policy was removed');
  assert.equal(built.promptMetadata.skillFiles,expected.files.length);
  assert.equal(built.promptMetadata.skillContentBytes,expected.files.reduce((n,file)=>n+Buffer.byteLength(file.content),0));
  const changed=structuredClone(expected);changed.files[0].content+=' altered';
  assert.throws(()=>buildDecisionContext({...args(fixture()),matchupGuidance:changed}),{code:'MATCHUP_GUIDANCE_FILE_HASH'});
  assert.throws(()=>buildDecisionContext({...args(fixture()),maxBytes:32000}),error=>error.code==='ISOLATED_CONTEXT_OVERFLOW'&&error.promptMetadata.skillFiles===expected.files.length);
  const without={...payload};delete without.matchupSkill;
  assert.throws(()=>rebudgetDecisionContext(built,{payload:without}),{code:'MATCHUP_GUIDANCE_METADATA'});
  assert.throws(()=>rebudgetDecisionContext(built,{payload:{...payload,matchupSkill:changed}}),{code:'MATCHUP_GUIDANCE_FILE_HASH'});
  const host=buildDecisionContextSource(args(fixture()));
  assert.equal(host.promptMetadata.sourceOnly,true);assert.equal(host.promptMetadata.modelReady,false);
  assert.equal(JSON.parse(host.input).matchupSkill,undefined);
  assert.equal(host.promptMetadata.skillDelivery,'host-only-source');
});
