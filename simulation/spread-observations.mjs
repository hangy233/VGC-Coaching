// Compile owned mechanical history into scalar observation constraints only.
// No action selection, stat formulas, numerical calls or live source reads.
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {types} from 'node:util';
import {digest} from '../planning/identity.mjs';
const {Dex}=createRequire(import.meta.url)('pokemon-showdown');
const dex=Dex.mod('champions'),HASH=/^[a-f0-9]{64}$/u,STATS=['hp','atk','def','spa','spd','spe'],BOOSTS=STATS.slice(1);
const key=value=>String(value??'').toLowerCase().replace(/[^a-z0-9]/gu,'');
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy=value=>structuredClone(value);
const safeAbilities=new Set('stamina armortail drizzle pixilate toughclaws grassysurge lightningrod noguard flamebody intimidate adaptability contrary defiant competitive stormdrain levitate sandrush swiftswim drought raindish speedboost emergencyexit pressure cloudnine airlock'.split(' '));
const safeItems=new Set('choicespecs choiceband choicescarf expertbelt lifeorb assaultvest leftovers sitrusberry miracleseed charcoal mysticwater magnet nevermeltice fairyfeather silkscarf blackglasses dragonfang softsand hardstone silverpowder poisonbarb sharpbeak twistedspoon blackbelt metalcoat rockyhelmet eviolite focussash grassyseed psychicseed electricseed mistyseed'.split(' '));
const orderItems=new Set(['quickclaw','custapberry','laggingtail','fullincense']);
const weather={raindance:'Rain',sunnyday:'Sun',sandstorm:'Sand',snowscape:'Snow',snow:'Snow'};
const terrain={grassyterrain:'Grassy',psychicterrain:'Psychic',electricterrain:'Electric',mistyterrain:'Misty'};

function json(value){
  let nodes=0,bytes=0;const seen=new Set(),limit=8*1024*1024;
  const visit=(v,depth)=>{
    if(depth>50||++nodes>200000)throw new TypeError('Spread journal traversal bound');
    if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)||typeof v==='string'){bytes+=Buffer.byteLength(JSON.stringify(v));if(bytes>limit)throw new TypeError('Spread journal byte bound');return v;}
    if(!v||typeof v!=='object'||types.isProxy(v))throw new TypeError('Ordinary finite journal JSON required');
    const array=Array.isArray(v),proto=Object.getPrototypeOf(v);if(!array&&proto!==Object.prototype&&proto!==null||seen.has(v))throw new TypeError('Acyclic plain journal required');
    const keys=Reflect.ownKeys(v).filter(k=>!(array&&k==='length'));if(array&&(v.length>200000||v.length!==keys.length))throw new TypeError('Dense journal arrays required');
    const result=array?[]:{};seen.add(v);
    for(const [i,k]of keys.entries()){
      if(typeof k!=='string'||Buffer.byteLength(k)>limit)throw new TypeError('Bounded journal keys required');
      const d=Object.getOwnPropertyDescriptor(v,k);if(!d.enumerable||!Object.hasOwn(d,'value')||array&&k!==String(i))throw new TypeError('Journal data properties required');
      if(!array&&d.value===undefined)continue;bytes+=Buffer.byteLength(k)+4;if(bytes>limit)throw new TypeError('Spread journal byte bound');
      Object.defineProperty(result,k,{value:visit(d.value,depth+1),enumerable:true,writable:true,configurable:true});
    }
    seen.delete(v);return result;
  };return visit(value,0);
}
const ordinaryMove=move=>move.exists&&move.category!=='Status'&&move.priority===0&&!move.onModifyPriority&&!move.flags?.charge&&!move.flags?.recharge&&!move.damage&&!move.damageCallback&&!move.basePowerCallback&&!move.multihit;
const safeHeld=item=>typeof item==='string'&&(!item||safeItems.has(key(item))||!!dex.items.get(item).megaStone);

/** Static proof only: omission of attacker HP is harmless for this restricted
 * template. It does not reveal current/max HP or calculate a numerical result. */
export function verifySpreadAttackerHpIrrelevance(input){
  const reasons=[];let args;try{args=json(input);}catch{return {supported:false,reasons:['invalid-HP-irrelevance-template']};}
  const move=dex.moves.get(args.move),p=args.attackerOptions;
  if(!ordinaryMove(move)||!Number.isFinite(move.basePower)||move.basePower<=0||move.onBasePower||move.target!=='normal'||move.recoil||move.drain||move.willCrit)reasons.push('move-is-not-supported-fixed-power-single-hit');
  if(!safeAbilities.has(key(p?.ability)))reasons.push('attacker-ability-is-not-proven-HP-independent');
  if(!safeHeld(p?.item))reasons.push('attacker-item-is-not-proven-HP-independent');
  if(args.moveOptions?.isCrit!==false||args.moveOptions?.hits!==1||args.field?.gameType!=='Doubles'||typeof args.field.weather!=='string'||typeof args.field.terrain!=='string')reasons.push('unknown-or-unsupported-damage-context');
  if(args.gen!==0)reasons.push('native-gen0-required');
  return {supported:reasons.length===0,reasons,scope:'No attacker HP value is supplied or inferred. Native default HP is irrelevant only within this restricted snapshot.'};
}

function actorKnown(actor){
  return actor&&typeof actor.species==='string'&&typeof actor.side==='string'&&typeof actor.own==='boolean'&&actor.abilityKnown===true&&typeof actor.ability==='string'&&typeof actor.abilitySuppressed==='boolean'&&actor.itemKnown===true&&typeof actor.item==='string'&&
    Object.hasOwn(actor,'status')&&['',null,'brn','par','psn'].includes(actor.status)&&BOOSTS.every(s=>Number.isInteger(actor.boosts?.[s]))&&typeof actor.substitute==='boolean'&&actor.volatiles&&typeof actor.volatiles==='object'&&!Array.isArray(actor.volatiles);
}
function active(before){return before.actors.filter(p=>p.activeSlot&&p.hp?.current>0);}
function fieldFor(before){
  if(!['p1','p2'].includes(before.ownSide)||!before.field||!Object.hasOwn(before.field,'weather')||!Object.hasOwn(before.field,'terrain')||!before.field.conditions||!Array.isArray(before.actors)||!Array.isArray(before.sides)||new Set(before.actors.map(p=>p.id)).size!==before.actors.length)return null;
  const actors=active(before);if(actors.length!==4||actors.some(p=>!actorKnown(p)))return null;
  const w=before.field.weather,t=before.field.terrain;
  if(w&&!weather[key(w.name)]||t&&!terrain[key(t.name)]||Object.keys(before.field.conditions).some(c=>!['trickroom','magicroom'].includes(c)))return null;
  if(before.sides.length!==2||new Set(before.sides.map(s=>s.id)).size!==2||before.sides.some(side=>!side.conditions||!Array.isArray(side.active)||side.active.length!==2||side.active.some((slot,index)=>slot.slot!=='ab'[index]||!actors.some(p=>p.id===slot.pokemon&&p.side===side.id&&p.activeSlot===slot.slot&&p.own===(side.id===before.ownSide)))))return null;
  return {weather:w?weather[key(w.name)]:'',terrain:t?terrain[key(t.name)]:'',trickRoom:!!before.field.conditions.trickroom,magicRoom:!!before.field.conditions.magicroom,
    weatherSuppressed:actors.some(p=>['cloudnine','airlock'].includes(key(p.ability))&&!p.abilitySuppressed)};
}
function knownOwn(actor,ownTeam){
  const set=actor?.ownSet;if(!set||!actor.own||!dex.natures.get(set.nature).exists)return null;
  const rows=ownTeam.filter(s=>key(dex.species.get(s.species).baseSpecies)===key(dex.species.get(actor.species).baseSpecies));
  if(rows.length!==1||digest(rows[0])!==digest(set))return null;
  const statPoints=Object.fromEntries(STATS.map(stat=>[stat,set.evs?.[stat]??0]));
  if(STATS.some(s=>!Number.isInteger(statPoints[s])||statPoints[s]<0||statPoints[s]>32)||Object.values(statPoints).reduce((sum,n)=>sum+n,0)!==66)return null;
  return {nature:set.nature,statPoints};
}
const stableActor=p=>({id:p.id,side:p.side,species:p.species,activeSlot:p.activeSlot,status:p.status,boosts:p.boosts,ability:p.ability,abilityKnown:p.abilityKnown,abilitySuppressed:p.abilitySuppressed,item:p.item,itemKnown:p.itemKnown,substitute:p.substitute,volatiles:p.volatiles});
const forcedEvent=e=>['-activate','-start','-singleturn','-item','-enditem','move'].includes(e.type)&&(e.data??[]).some(v=>/afteryou|quash|quickclaw|custapberry|quickdraw/u.test(key(v)));
const calledFrame=frame=>frame.events.some(e=>e.type==='move'&&e.sequence===frame.sequence&&(e.tags??[]).some(tag=>tag.startsWith('[from]')));
function speedPokemon(p,before,own){
  const side=before.sides.find(s=>s.id===p.side);if(!side)return null;
  return {label:p.id,species:p.species,ability:p.ability,item:p.item,status:p.status??'',boosts:Object.fromEntries(BOOSTS.map(s=>[s,p.boosts[s]])),tailwind:!!side.conditions.tailwind,abilitySuppressed:p.abilitySuppressed,itemSuppressed:false,...(own?copy(own):{})};
}

/** Data must come from the owned tracker/capture, not model-authored arguments.
 * Frame hashes and scope are checked, but this pure compiler cannot mint the
 * owner's source receipt. It emits no candidate spread or numerical conclusion. */
export function compileSpreadObservations(value){
  const input=json(value),{journal,binding,currentActors,ownTeam}=input;
  if(journal?.kind!=='mechanical-choice-state-journal-v1'||journal.schemaVersion!==1||!Array.isArray(journal.frames)||journal.frames.length>64||!Array.isArray(journal.turns)||journal.turns.length>8||!HASH.test(binding?.sourceSha256??'')||!HASH.test(binding?.teamId??'')||typeof binding.room!=='string'||!Number.isSafeInteger(binding.epoch)||!Number.isSafeInteger(binding.sequence)||!Array.isArray(currentActors)||currentActors.length>12||!Array.isArray(ownTeam)||ownTeam.length!==6)throw new TypeError('Complete bounded owned spread journal/capture required');
  const spreadObservations={},ignoredConstraints=[],provenance=[],coverage={frames:journal.frames.length,validFrames:0,speedConstraints:0,damageConstraints:0,constraintsDropped:0,ignoredDropped:0,calculationsRun:0,exhaustive:false};
  const ignore=(id,reason)=>{if(ignoredConstraints.length<128)ignoredConstraints.push({id,reason});else coverage.ignoredDropped++;};
  const result=()=>({schemaVersion:1,kind:'compiled-spread-observations-v1',spreadObservations,ignoredConstraints,coverage,provenance,
    binding:{sourceSha256:binding.sourceSha256,historySha256:binding.historySha256,journalSha256:sha(journal)},
    limitations:['Only finalized, source-bound ordinary retained history is supported; ignored observations do not constrain a spread.','HP subtraction is exact server bookkeeping only. No damage or Speed value is calculated here.','The caller must supply an owned verified capture; data hashes do not create an ownership or actual-MCP receipt.','Unknown opposing HP is omitted; any calculator default is explicitly irrelevant to the restricted fixed-power observation, never an observed HP fact.']});
  if(journal.coverage?.completeHistory!==true||journal.coverage?.auditedHistory!==true){ignore('journal','incomplete-or-unsupported-capture-history');return result();}
  const mapped=new Map(),ids=new Set();for(const actor of currentActors){if(typeof actor.id!=='string'||typeof actor.historyId!=='string'||mapped.has(actor.historyId)||ids.has(actor.id))throw new TypeError('Exact unique current/history actor mapping required');mapped.set(actor.historyId,actor);ids.add(actor.id);}
  const emit=(actorId,observation,frames)=>{
    spreadObservations[actorId]??=[];spreadObservations[actorId].push(observation);
    if(spreadObservations[actorId].length>8){spreadObservations[actorId].shift();coverage.constraintsDropped++;}
    provenance.push({observationId:observation.id,actorId,frameSha256:frames.map(f=>f.sha256),historicalHistorySha256:frames.map(f=>f.source.historySha256),sourceSha256:binding.sourceSha256,
      semantics:'Mechanical history constraint only; numerical filtering still requires actual MCP. Unknown opposing investments and HP remain unknown.'});
  };
  const valid=[],badTurns=new Set();
  for(const frame of journal.frames){
    const {sha256:claimed,...body}=frame;
    if(!HASH.test(claimed??'')||sha(body)!==claimed||frame.complete!==true||!Number.isSafeInteger(frame.sequence)||frame.sequence>binding.sequence||frame.source?.teamId!==binding.teamId||frame.source.room!==binding.room||frame.source.epoch!==binding.epoch||frame.source.turn!==frame.turn||frame.source.sequence!==frame.sequence||frame.source.fullHistory!==true||frame.source.auditedHistory!==true||!HASH.test(frame.source.historySha256??'')||!Array.isArray(frame.events)||!Array.isArray(frame.before?.actors)||frame.before.turnEventsTruncated===true){ignore(frame.id??'frame','invalid-incomplete-or-mismatched-owned-frame');badTurns.add(frame.turn);continue;}
    valid.push(frame);coverage.validFrames++;
  }
  const turnById=new Map(journal.turns.map(t=>[t.turn,t]));
  for(const first of valid){
    const a=first.before.actors.find(p=>p.id===first.actorId),move=dex.moves.get(first.moveName),turn=turnById.get(first.turn);
    if(badTurns.has(first.turn)||!a||calledFrame(first)||!ordinaryMove(move)||turn?.complete!==true||turn.truncated===true){ignore(first.id,'unsupported-or-incomplete-turn/move-history');continue;}
    // Every retained turn's move event needs its corresponding finalized frame.
    if((turn.events??[]).filter(e=>e.type==='move').some(e=>!valid.some(f=>f.turn===first.turn&&f.sequence===e.sequence))){ignore(first.id,'retained-turn-move-frame-missing');continue;}
    const field=fieldFor(first.before);if(!field){ignore(first.id,'unknown-field-or-active-modifier-state');continue;}
    if((turn.events??[]).some(forcedEvent)){ignore(first.id,'forced-or-conditional-order-event');continue;}
    for(const second of valid.filter(f=>f.turn===first.turn&&f.sequence>first.sequence)){
      const b=second.before.actors.find(p=>p.id===second.actorId),nextMove=dex.moves.get(second.moveName);
      if(!b||a.own===b.own||!ordinaryMove(nextMove)||nextMove.priority!==move.priority||calledFrame(second))continue;
      const candidate=a.own?b:a,ownActor=a.own?a:b,current=mapped.get(candidate.id),ownKnown=knownOwn(ownActor,ownTeam);
      if(!current||current.own!==false||current.species!==candidate.species||!ownKnown)continue;
      const allKnown=[a,b].every(p=>actorKnown(p)&&safeAbilities.has(key(p.ability))&&!orderItems.has(key(p.item))&&!p.substitute&&!Object.keys(p.volatiles).length);
      const beforeNext=fieldFor(second.before);
      const unchanged=[a.id,b.id].every(id=>{const x=first.before.actors.find(p=>p.id===id),y=second.before.actors.find(p=>p.id===id);return x&&y&&digest(stableActor(x))===digest(stableActor(y));});
      if(!allKnown||!beforeNext||digest(field)!==digest(beforeNext)||digest(first.before.sides)!==digest(second.before.sides)||!unchanged){ignore(first.id+'-'+second.id,'unknown-or-changed-order-snapshot');continue;}
      const knownFirst=knownOwn(a,ownTeam),knownSecond=knownOwn(b,ownTeam),pokemon=[speedPokemon(a,first.before,knownFirst),speedPokemon(b,second.before,knownSecond)];
      if(pokemon.some(p=>!p))continue;
      const observation={id:`order-${first.sequence}-${second.sequence}`,kind:'move-order',sourceSha256:binding.sourceSha256,currentForme:current.species,candidateIndex:a.own?1:0,beforeIndex:0,
        verification:{identityVerified:true,bothExecuted:true,samePriority:true,forcedOrder:false,conditionsKnown:true,abilityItemKnown:true},input:{gen:0,pokemon,field}};
      emit(current.id,observation,[first,second]);coverage.speedConstraints++;
    }
    if(a.own)continue;
    const current=mapped.get(a.id);if(!current||current.own!==false||current.species!==a.species||first.targetIds?.length!==1)continue;
    const target=first.before.actors.find(p=>p.id===first.targetIds[0]),ownKnown=knownOwn(target,ownTeam);
    const hpEvents=first.events.filter(e=>['-damage','-heal','-sethp','faint'].includes(e.type));
    const hit=hpEvents.length===1&&hpEvents[0].type==='-damage'&&hpEvents[0].pokemonId===target?.id?hpEvents[0]:null;
    const forbidden=first.events.some(e=>['-crit','-hitcount','-miss','-fail','-immune','-activate','-start','-end'].includes(e.type)||(e.tags??[]).some(tag=>tag.startsWith('[from]')));
    const prefix=first.before.turnEvents??[];
    if(!target?.own||!ownKnown||!actorKnown(a)||!actorKnown(target)||a.substitute||target.substitute||Object.keys(a.volatiles).length||Object.keys(target.volatiles).length||!hit||forbidden||prefix.some(e=>['move','-singleturn','-start'].includes(e.type)&&['helpinghand','movehelpinghand','instruct','sleeptalk','metronome','copycat'].includes(key(e.data?.[1])))||
      active(first.before).some(p=>!safeAbilities.has(key(p.ability))||p.abilitySuppressed!==false||!safeHeld(p.item))){ignore(first.id,'ambiguous-damage/source/modifier-history');continue;}
    if(first.events.some(e=>e.sequence<hit.sequence&&!['move','-supereffective','-resisted'].includes(e.type))){ignore(first.id,'pre-damage-state-change');continue;}
    const beforeHp=hit.beforeHp,afterHp=hit.afterHp;
    if(beforeHp?.precision!=='server-own-exact'||afterHp?.precision!=='server-own-exact'||!Number.isInteger(beforeHp.current)||!Number.isInteger(afterHp.current)||!Number.isInteger(beforeHp.max)||beforeHp.max!==afterHp.max||afterHp.current<=0||beforeHp.current<=afterHp.current||beforeHp.current>beforeHp.max||digest(beforeHp)!==digest(target.hp)){ignore(first.id,'rounded-unknown-capped-or-inconsistent-own-HP');continue;}
    if(first.before.sides.some(s=>Object.keys(s.conditions).some(c=>!['reflect','lightscreen','auroraveil','tailwind'].includes(c)))){ignore(first.id,'unsupported-damage-side-condition');continue;}
    const seedTerrain={grassyseed:'Grassy',psychicseed:'Psychic',electricseed:'Electric',mistyseed:'Misty'};
    if([a,target].some(p=>seedTerrain[key(p.item)]===field.terrain)){ignore(first.id,'unsupported-current-held-terrain-seed-reapplication');continue;}
    const options=p=>({ability:p.ability,item:p.item,status:p.status??'',boosts:Object.fromEntries(BOOSTS.map(s=>[s,p.boosts[s]]))});
    const side=p=>{const values=first.before.sides.find(s=>s.id===p.side).conditions;return {isReflect:!!values.reflect,isLightScreen:!!values.lightscreen,isAuroraVeil:!!values.auroraveil,isTailwind:!!values.tailwind};};
    const args={gen:0,attacker:a.species,attackerOptions:options(a),defender:target.species,defenderOptions:{...options(target),nature:ownKnown.nature,evs:ownKnown.statPoints,curHP:beforeHp.current},move:move.name,moveOptions:{isCrit:false,hits:1},field:{gameType:'Doubles',weather:field.weatherSuppressed?'':field.weather,terrain:field.terrain,isMagicRoom:field.magicRoom,attackerSide:side(a),defenderSide:side(target)}};
    const independent=verifySpreadAttackerHpIrrelevance(args);if(!independent.supported){ignore(first.id,independent.reasons.join(';'));continue;}
    const observation={id:`damage-${first.sequence}-${hit.sequence}`,kind:'damage',sourceSha256:binding.sourceSha256,currentForme:current.species,candidateRole:'attacker',amount:beforeHp.current-afterHp.current,
      verification:{identityVerified:true,directMoveDamage:true,conditionsKnown:true,allOtherInvestmentsKnown:true,exactHp:true,roundedHp:false,crit:false,multihit:false,uncapped:true,additionalHpChanges:false,attackerHpIrrelevant:true},input:args};
    emit(current.id,observation,[first]);coverage.damageConstraints++;
  }
  return result();
}
