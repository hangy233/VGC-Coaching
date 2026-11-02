// Mechanical observation assembly only. The owner feeds the complete ordered
// receive stream; no action, target, opposing pair, spread or seed is selected.
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {types} from 'node:util';
import {createBattleState,reduceBattleLine,reduceBattleRequest,battleStateSnapshot,validateOwnReservePpSnapshot} from '../showdown/battle-state.mjs';
import {observedBindingSchema,observedLifecycleSchema,observedPpSchema} from './schemas.mjs';
import {compileSpreadObservations} from './spread-observations.mjs';
import {cantActionAttribution} from '../showdown/protocol-action.mjs';

const {Teams,TeamValidator,Dex}=createRequire(import.meta.url)('pokemon-showdown');
const dex=Dex.mod('champions'),FORMAT='gen9championsvgc2026regmc';
const receipts=new WeakMap(),stages=['atk','def','spa','spd','spe','accuracy','evasion'];
const id=value=>String(value??'').toLowerCase().replace(/[^a-z0-9]/g,'');
const effectId=value=>id(String(value??'').replace(/^move: /u,''));
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const check=(ok,message)=>{if(!ok)throw new Error('Choice state: '+message);};
const reference=text=>/^(p[12])([ab])?:\s*(.*)$/.exec(String(text??''));
const base=species=>id(dex.species.get(species).baseSpecies);
const zero=()=>Object.fromEntries(stages.map(stat=>[stat,0]));
const LIFE=()=>({activeTurns:0,activeMoveActions:0,protectCounter:0,choiceLock:false,lastMove:false});
const nativeKnown=(value,origin,sequence)=>({known:true,value,origin,sequence});
const nativeUnknown=(reason,sequence)=>({known:false,reason,sequence});
const nativeInitial=()=>({timesAttacked:nativeKnown(0,'native-Champions-constructor',0),lastMoveTargetLoc:nativeUnknown('Native target location is undefined before a provable targeted move.',0),currentResult:nativeUnknown('Native current-turn result is undefined before an action.',0),moveLastTurnResult:nativeUnknown('Native previous-turn result is undefined before an action.',0)});
function nativeClear(entry,sequence,resetHitCounter){if(!entry.nativeHistory)return;if(resetHitCounter)entry.nativeHistory.timesAttacked=nativeKnown(0,'audited-Champions-clearVolatile-reset',sequence);entry.nativeHistory.currentResult=nativeUnknown('Native clearVolatile resets current-turn result to undefined.',sequence);entry.nativeHistory.moveLastTurnResult=nativeUnknown('Native clearVolatile resets previous-turn result to undefined.',sequence);}

// Never run model/caller accessors while cloning a source or options object.
function snapshot(value){
  let nodes=0,bytes=0;const seen=new Set();
  function visit(v,depth){
    check(depth<=50&&++nodes<=200000,'source traversal limit');
    if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)||typeof v==='string'){
      bytes+=Buffer.byteLength(JSON.stringify(v));check(bytes<=8*1024*1024,'source byte limit');return v;
    }
    check(v&&typeof v==='object'&&!types.isProxy(v),'ordinary finite JSON required');
    check(!seen.has(v),'cyclic source');const array=Array.isArray(v),proto=Object.getPrototypeOf(v);
    check(array||proto===Object.prototype||proto===null,'plain source required');
    const keys=Reflect.ownKeys(v).filter(key=>!(array&&key==='length'));
    check(!array||keys.length===v.length,'dense source array required');seen.add(v);const result=array?[]:{};
    for(const [index,key]of keys.entries()){
      check(typeof key==='string'&&(!array||key===String(index)),'ordinary source keys required');
      const d=Object.getOwnPropertyDescriptor(v,key);check(d.enumerable&&Object.hasOwn(d,'value'),'data-only source required');
      // Native in-process optional properties serialize as absent on IPC.
      // Never turn an absent value into a supplied fact or an array placeholder.
      if(!array&&d.value===undefined)continue;
      bytes+=Buffer.byteLength(key)+4;check(bytes<=8*1024*1024,'source byte limit');
      Object.defineProperty(result,key,{value:visit(d.value,depth+1),enumerable:true,writable:true,configurable:true});
    }
    seen.delete(v);return result;
  }
  return visit(value,0);
}
function ownSets(teamText,teamId){
  const sets=Teams.import(teamText);check(sets?.length===6,'exact locked six required');
  check(!new TeamValidator(FORMAT).validateTeam(sets)?.length,'invalid locked team');
  check(createHash('sha256').update(Teams.pack(sets)).digest('hex')===teamId,'locked team hash differs');return sets;
}
const sameMoves=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===4&&b.length===4&&a.every((m,i)=>id(m)===id(b[i]));
const setFor=(sets,species)=>{const rows=sets.filter(s=>base(s.species)===base(species));return rows.length===1?rows[0]:null;};
function sheetMechanics(rows){
  check(Array.isArray(rows)&&rows.length===6,'complete published six required');
  return rows.map(s=>({species:base(s.species),ability:id(s.ability),item:id(s.item),moves:s.moves?.map(id)})).sort((a,b)=>a.species.localeCompare(b.species));
}
// Native initial PP semantics, not a claim that any current member is fresh.
// Eligibility below separately requires full history and no intervening use.
function initialPp(moves){return moves.map(name=>{
  const move=dex.moves.get(name);check(move.exists,'unknown registered move');
  return dex.data.Scripts.calculatePP.call({gen:9},move,move.noPPBoosts||move.id==='trumpcard'?0:3);
});}
const clearExit=(entry,sequence,resetHitCounter=true)=>{entry.life.lastMove=false;entry.life.protectCounter=0;entry.life.choiceLock=false;entry.protected=false;entry.encore=null;entry.confusion=null;entry.confusionAttempt=false;
  entry.unburden={known:true,value:false,origin:'audited-native-exit-or-faint-reset',sequence};nativeClear(entry,sequence,resetHitCounter);};
// These pinned item callbacks consume themselves through pokemon.useItem in
// their matching terrain. Arbitrary enditem events can instead bypass both
// Unburden hooks, so empty held-item state never supplies this activation.
const TERRAIN_SEEDS={grassyseed:'grassyterrain',electricseed:'electricterrain',mistyseed:'mistyterrain',psychicseed:'psychicterrain'};
const AMBIGUOUS_MOVES=new Set('sleeptalk metronome copycat mirrormove mefirst naturepower assist instruct mimic sketch transform revivalblessing batonpass spite eeriespell grudge recycle lunardance healingwish'.split(' '));
const UNSAFE_ABILITIES=new Set(['pressure','dancer','neutralizinggas','klutz','magicbounce','magicguard'].map(id));
const PRESENTATION=new Set(['','t:','c','chat','j','l','n','html','uhtml','uhtmlchange','controlshtml','fieldhtml','init','title','request','sentchoice','inactive','inactiveoff','player','teamsize','gen','gametype','tier','rule','poke','clearpoke','teampreview','seed','rated','timestamp','message','-message','debug','hint','-hint','showteam']);
const ORDINARY=new Set(['start','turn','upkeep','switch','drag','move','cant','faint','win','tie','detailschange','-formechange','-mega','-damage','-heal','-sethp','-status','-curestatus','-cureteam','-boost','-unboost','-setboost','-clearboost','-clearallboost','-clearpositiveboost','-clearnegativeboost','-invertboost','-copyboost','-swapboost','-ability','-endability','-item','-enditem','-activate','-weather','-fieldstart','-fieldend','-sidestart','-sideend','-start','-end','-singleturn','-singlemove','-immune','-fail','-miss','-crit','-hitcount','-supereffective','-resisted','-notarget','-anim','-center']);

/** Native owner only. Feed every room line and private request through one
 * contiguous per-tracker receive sequence, before any capped history projection.
 * Missing start/epoch/gap invalidates history-derived facts permanently. */
export function createChoiceStateHistory(options){
  const config=snapshot(options);check(typeof config.sessionId==='string'&&config.sessionId&&typeof config.room==='string'&&config.room,'exact session and room required');
  check(Number.isSafeInteger(config.epoch)&&config.epoch>=0,'connection epoch required');
  const sets=ownSets(config.teamText,config.teamId),state=createBattleState(),entries=new Map(),problems=[];
  let sequence=0,validity=0,start=false,continuous=true,derivedSafe=true,upkeep=null,lastRequest=null,lastRequestSequence=0,lastMaterialSequence=0,chain=sha({kind:'choice-state-history-v1',sessionId:config.sessionId,room:config.room,teamId:config.teamId,epoch:config.epoch}),sheet=config.opposingSheet??null;
  const faintEvents={p1:0,p2:0},faintSequence={p1:0,p2:0},faintCountsKnown={p1:true,p2:true};let globalLastMove=nativeKnown(false,'native-battle-constructor',0);
  const addProblem=(code,detail)=>{if(!problems.some(p=>p.code===code&&p.detail===detail))problems.push({code,detail});};
  const invalidate=reason=>{validity++;continuous=false;addProblem('incomplete-history',String(reason).slice(0,300));};
  const entry=p=>{
    if(!p)return null;
    if(!entries.has(p.id))entries.set(p.id,{life:LIFE(),known:derivedSafe,nativeHistory:nativeInitial(),pp:null,ppKnown:false,ppUnsupported:false,ppOrigin:null,uses:{},entered:false,protected:false,substitute:false,substituteSequence:null,encore:null,confusion:null,confusionAttempt:false,actedTurn:null,moveThisTurn:null,item:null,itemKnown:false,itemTouched:false,ability:null,suppressed:false,abilityKnown:false,abilityTouched:false,unburdenAbilityTouched:false,unburden:{known:false,value:false,origin:'entry-not-observed',sequence:null},boosts:zero(),boostsKnown:true,side:p.id.split('-')[0],lastSequence:sequence});
    return entries.get(p.id);
  };
  const actor=text=>{const ref=reference(text);if(!ref)return null;const side=state.sides[ref[1]];if(!side)return null;
    if(ref[2])return side.pokemon.find(p=>p.id===side.active[ref[2]])??null;
    const rows=side.pokemon.filter(p=>p.nickname===ref[3]);return rows.length===1?rows[0]:null;};
  const unsafe=(code,detail)=>{derivedSafe=false;addProblem(code,detail);for(const e of entries.values()){e.known=false;e.ppKnown=false;e.abilityKnown=false;}};
  // The journal is a bounded mechanical source for the separate spread
  // observation compiler. It never calculates damage/Speed or chooses a move.
  const frames=[],turnRecords=new Map();let pendingFrame=null,framesDropped=0,turnsDropped=0,eventsDropped=0;
  function turnRecord(turn=state.turn){
    if(!turnRecords.has(turn))turnRecords.set(turn,{turn,events:[],complete:false,truncated:false});
    return turnRecords.get(turn);
  }
  function auditedAtFrame(){
    return start&&continuous&&derivedSafe&&!Object.values(state.sides).some(side=>side.pokemon.some(p=>{
      const item=entry(p),registered=setFor(side.id===state.ownSide?sets:sheet??[],p.species);
      return item.entered&&[item.ability,registered?.ability].some(a=>id(a)!=='pressure'&&UNSAFE_ABILITIES.has(id(a)));
    }));
  }
  function beforeFrame(){
    const current=battleStateSnapshot(state),record=turnRecord();
    const actors=current.sides.flatMap(side=>side.pokemon.filter(p=>side.id!==state.ownSide||p.selection==='selected'&&Number.isInteger(p.requestIndex)).map(p=>{
      const item=entry(p),own=side.id===state.ownSide,registered=setFor(own?sets:sheet??[],p.species),species=dex.species.get(p.species);
      const ability=item.abilityKnown?item.ability:!item.abilityTouched&&registered?.ability?species.isMega&&Object.values(species.abilities).length===1?Object.values(species.abilities)[0]:registered.ability:null;
      const held=item.itemKnown?item.item:!item.itemTouched&&typeof registered?.item==='string'?registered.item:null;
      const volatiles=snapshot(p.volatiles??{});if(item.substitute&&!volatiles.substitute)volatiles.substitute={name:'Substitute',startedTurn:null};
      return {id:p.id,side:side.id,own,species:p.species,activeSlot:p.activeSlot,hp:snapshot(p.hp),status:p.status,
        boosts:stages.every(s=>Number.isInteger(p.boosts?.[s]))?snapshot(p.boosts):item.boostsKnown?snapshot(item.boosts):null,
        ability,abilityKnown:typeof ability==='string'&&!!ability,abilitySuppressed:typeof ability==='string'&&!!ability?item.suppressed:null,
        item:held,itemKnown:typeof held==='string',substitute:item.substitute||Object.hasOwn(volatiles,'substitute'),volatiles,
        ...(own&&registered?{ownSet:snapshot(registered)}:{})};
    }));
    return {ownSide:state.ownSide,field:snapshot(current.field),sides:current.sides.map(side=>({id:side.id,active:snapshot(side.active),conditions:snapshot(side.conditions)})),actors,
      turnEvents:snapshot(record.events),turnEventsTruncated:record.truncated};
  }
  function finishFrame(boundary){
    if(!pendingFrame)return;
    const record=turnRecord(pendingFrame.turn);
    pendingFrame.complete=true;pendingFrame.boundary=boundary;
    pendingFrame.source.auditedHistory=pendingFrame.source.auditedHistory&&auditedAtFrame()&&!record.truncated;
    finishNativeFrame(pendingFrame,record.truncated);
    pendingFrame.sha256=sha(pendingFrame);frames.push(pendingFrame);pendingFrame=null;
    while(frames.length>64){frames.shift();framesDropped++;}
  }
  function finishNativeFrame(frame,truncated){
    const move=dex.moves.get(frame.moveName),header=frame.events.find(event=>event.type==='move'&&event.sequence===frame.sequence),user=frame.before.actors.find(p=>p.id===frame.actorId),userEntry=entries.get(frame.actorId);
    const called=!header||header.tags.some(tag=>tag.startsWith('[from]'))||AMBIGUOUS_MOVES.has(move.id),ambiguous=truncated||!move.exists||!user||called;
    // A plain completed useMove leaves its active native move for the outer
    // clearActiveMove call, including an attack blocked by Protect. BeforeMove
    // denials have no Move header and cannot replace this global value.
    globalLastMove=ambiguous?nativeUnknown('Called, truncated or ambiguous native move resolution.',frame.sequence):nativeKnown(move.id,'audited-completed-ordinary-native-move',frame.sequence);
    if(!user)return;
    const direct=frame.events.filter(event=>event.type==='-damage'&&!event.tags.some(tag=>tag.startsWith('[from]'))&&event.pokemonId!==user.id);
    const hasFunction=(value,seen=new Set())=>{if(!value||typeof value!=='object'||seen.has(value))return false;seen.add(value);return Object.values(value).some(v=>typeof v==='function'||v&&typeof v==='object'&&hasFunction(v,seen));};
    const ordinaryDamage=!ambiguous&&['Physical','Special'].includes(move.category)&&!move.smartTarget&&!move.multiaccuracy&&!hasFunction(move);
    const live=frame.before.actors.filter(p=>p.activeSlot&&p.hp?.current>0),spread=['allAdjacent','allAdjacentFoes'].includes(move.target);
    const candidates=spread?live.filter(p=>p.id!==user.id&&(move.target==='allAdjacent'||p.side!==user.side)):frame.targetIds.map(value=>frame.before.actors.find(p=>p.id===value)).filter(Boolean);
    const affected=new Set([...candidates.map(p=>p.id),...direct.map(e=>e.pokemonId)]);
    if(['Physical','Special'].includes(move.category))for(const actorId of affected){if(actorId===user.id)continue;const recipient=entries.get(actorId);if(!recipient)continue;const hits=direct.filter(e=>e.pokemonId===actorId),subHits=frame.events.filter(e=>e.pokemonId===actorId&&effectId(e.data[1])==='substitute'&&(e.type==='-end'||e.type==='-activate'&&e.tags.includes('[damage]'))),zeroProof=frame.events.some(e=>e.pokemonId===actorId&&(e.type==='-miss'||e.type==='-immune'||e.type==='-activate'&&['protect','detect','kingsshield','spikyshield','banefulbunker','silktrap','burningbulwark','obstruct'].includes(effectId(e.data[1]))));
      let count=null;
      if(ordinaryDamage&&hits.length&&!move.multihit)count=hits.length===1?1:null;
      else if(ordinaryDamage&&move.multihit){const totals=frame.events.filter(e=>e.type==='-hitcount'&&e.pokemonId===actorId),n=Number(totals[0]?.data[1]);if(totals.length===1&&Number.isInteger(n)&&n>=1&&hits.length+subHits.length===n&&!frame.events.some(e=>['-immune','-miss','-fail'].includes(e.type))){if(hits.length&&hits.at(-1).sequence>(subHits.at(-1)?.sequence??0))count=n;else if(!hits.length&&subHits.length===n)count=0;}}
      else if(!ambiguous&&!move.multihit&&!move.beforeMoveCallback&&!move.smartTarget&&!move.multiaccuracy&&!hits.length&&subHits.length===1)count=0;
      else if(!hits.length&&zeroProof)count=0;
      if(count===null)recipient.nativeHistory.timesAttacked=nativeUnknown('Public native move outcome does not prove the exact final numeric hit count.',frame.sequence);
      else if(recipient.nativeHistory.timesAttacked.known&&count)recipient.nativeHistory.timesAttacked=nativeKnown(recipient.nativeHistory.timesAttacked.value+count,'audited-ordinary-native-direct-hit-count',frame.sequence);
    }
    if(userEntry){const current=Object.values(state.sides).flatMap(s=>s.pokemon).find(p=>p.id===user.id);
      if(current?.activeSlot&&!current.fainted){let result;
        if(!ambiguous&&direct.length)result=true;
        else if(!ambiguous&&frame.events.some(e=>['-start','-singleturn','-singlemove','-sidestart','-fieldstart','-boost','-unboost','-setboost','-status','-heal'].includes(e.type)&&!e.tags.some(tag=>tag.startsWith('[from]'))))result=true;
        else if(!ambiguous&&!spread&&['Physical','Special'].includes(move.category)&&frame.events.some(e=>e.type==='-miss'))result=false;
        userEntry.nativeHistory.currentResult=result===undefined?nativeUnknown('Public events do not prove this native move result.',frame.sequence):nativeKnown(result,'audited-public-native-move-result',frame.sequence);
      }
      // moveUsed records the original target location, before redirection. Do
      // not read self/spread/random/called/locked/retargeted display targets as
      // an authored location. An uncertain field can recover on a later proof.
      const target=frame.before.actors.find(p=>p.id===frame.targetIds[0]),allAbilitiesKnown=live.every(p=>p.abilityKnown&&p.abilitySuppressed===false&&!entries.get(p.id)?.abilityTouched),redirect=frame.events.some(e=>e.type==='-activate'&&/followme|ragepowder|spotlight|lightningrod|stormdrain/u.test(id(e.data[1])))||live.some(p=>Object.keys(p.volatiles??{}).length);
      const targetable=['normal','any','adjacentAlly','adjacentFoe','adjacentAllyOrSelf'].includes(move.target),opponentLive=live.filter(p=>p.side!==user.side).length===2;
      if(!ambiguous&&targetable&&target?.activeSlot&&target.hp?.current>0&&opponentLive&&allAbilitiesKnown&&!redirect&&!['Electric','Water'].includes(move.type)&&!move.onModifyTarget&&!move.onModifyMove&&!(frame.before.turnEvents??[]).some(e=>e.type==='faint'))userEntry.nativeHistory.lastMoveTargetLoc=nativeKnown((target.side===user.side?-1:1)*(target.activeSlot==='a'?1:2),'audited-unredirected-public-single-target-location',frame.sequence);
      else userEntry.nativeHistory.lastMoveTargetLoc=nativeUnknown('Public displayed target does not prove the original native target location.',frame.sequence);
    }
  }
  function beginFrame(parts,p){
    finishFrame('next-move');
    const target=actor(parts[2]);
    pendingFrame={id:'move-'+sequence,sequence,turn:state.turn,actorId:p?.id??null,moveName:parts[1]??null,targetIds:target?[target.id]:[],
      before:beforeFrame(),events:[],complete:false,source:{teamId:config.teamId,room:config.room,epoch:config.epoch,turn:state.turn,sequence,historySha256:chain,fullHistory:start&&continuous,auditedHistory:auditedAtFrame()}};
  }
  function appendJournalEvent(type,parts,p,beforeHp){
    if(!ORDINARY.has(type)&&!type.startsWith('-'))return;
    const after=actor(parts[0]),hpChanged=['-damage','-heal','-sethp','faint'].includes(type);
    const event={type,sequence,turn:state.turn,pokemonId:p?.id??after?.id??null,data:[...parts],tags:parts.filter(value=>value.startsWith('[')),
      ...(hpChanged?{beforeHp:snapshot(beforeHp??null),afterHp:snapshot(after?.hp??null)}:{})};
    const record=turnRecord();
    if(record.events.length<128)record.events.push(event);else{record.truncated=true;eventsDropped++;}
    if(pendingFrame){if(pendingFrame.events.length<128)pendingFrame.events.push(snapshot(event));else{record.truncated=true;eventsDropped++;}}
  }
  function journalSnapshot(){
    const turns=[...turnRecords.values()].filter(row=>row.turn>=Math.max(0,state.turn-7));
    return snapshot({schemaVersion:1,kind:'mechanical-choice-state-journal-v1',frames:frames.filter(frame=>frame.turn>=Math.max(0,state.turn-7)),turns,
      coverage:{maxTurns:8,maxFrames:64,maxEventsPerTurn:128,framesDropped,turnsDropped,eventsDropped,pendingFrame:pendingFrame!==null,completeHistory:start&&continuous,auditedHistory:auditedAtFrame()}});
  }
  function receive(kind,value,meta){
    const m=snapshot(meta);check(m.connected===true,'connected native feed required');
    check(m.observedAt===undefined||Number.isSafeInteger(m.observedAt)&&m.observedAt>=0,'native observation timestamp required');
    if(m.epoch!==config.epoch)invalidate('Connection epoch changed');
    if(m.sequence!==sequence+1)invalidate('Missing, duplicated or reordered receive sequence');
    check(Number.isSafeInteger(m.sequence)&&m.sequence>=1,'positive receive sequence required');
    sequence=m.sequence;chain=sha([chain,kind,sequence,value]);return m;
  }
  function observeLine(value,meta){
    const line=snapshot(value);check(typeof line==='string'&&Buffer.byteLength(line)<=100000,'bounded protocol line required');const m=receive('line',line,meta);
    if(!line.startsWith('|')){invalidate('Nonprotocol battle line');return;}
    const [,type,...parts]=line.split('|'),p=actor(parts[0]),e=entry(p);
    const beforeHp=p?.hp?snapshot(p.hp):null;
    if(type==='move')beginFrame(parts,p);
    if(['switch','drag'].includes(type))finishFrame('switch-boundary');
    if(['turn','upkeep','win','tie'].includes(type))finishFrame(type);
    const transfersSubstitute=['switch','drag'].includes(type)&&parts.slice(3).some(v=>['frommoveshedtail','fromshedtail'].includes(id(v)))&&e?.substitute===true;
    if(ORDINARY.has(type))lastMaterialSequence=sequence;
    if(type==='start'){if(start||state.turn!==0)invalidate('Repeated or late start');start=true;}
    if(type==='turn'){
      const n=Number(parts[0]);if(!start||n!==state.turn+1||state.turn>0&&upkeep!==state.turn)invalidate('Missing, repeated or discontinuous turn/upkeep');
      if(state.turn>0&&upkeep===state.turn)turnRecord(state.turn).complete=true;
      for(const side of Object.values(state.sides))for(const mon of side.pokemon){const item=entry(mon);if(mon.activeSlot&&!mon.fainted)item.life.activeTurns++;
        if(mon.activeSlot)item.nativeHistory.moveLastTurnResult=snapshot(item.nativeHistory.currentResult);
        item.nativeHistory.currentResult=nativeUnknown('No public current-turn action result yet.',sequence);
        if(item.encore&&mon.activeSlot&&!mon.fainted&&--item.encore.remainingTurns<=0)unsafe('unsupported-encore-history','Encore duration expired without its native end event');
        if(!item.protected)item.life.protectCounter=0;item.protected=false;item.actedTurn=null;item.moveThisTurn=null;item.confusionAttempt=false;}
    }
    if(type==='upkeep'){if(upkeep===state.turn)invalidate('Repeated upkeep');upkeep=state.turn;}
    if(['switch','drag'].includes(type)){
      if(e)clearExit(e,sequence,p.fainted!==true);
      if(e)e.substitute=false;
      if(parts.length>3&&parts.slice(3).some(v=>v!=='[silent]'&&!['frommoveshedtail','fromshedtail'].includes(id(v))))unsafe('unsupported-entry','Entry with unaudited copied/history state');
    }
    if(type==='replace'||type==='swap')unsafe('unsupported-identity','Identity replacement/swap requires separate audit');
    if(['replace','swap'].includes(type)){for(const item of entries.values()){item.nativeHistory.timesAttacked=nativeUnknown('Identity replacement/swap makes this public counter ambiguous.',sequence);item.nativeHistory.lastMoveTargetLoc=nativeUnknown('Identity replacement/swap makes target history ambiguous.',sequence);}globalLastMove=nativeUnknown('Identity replacement/swap requires a separate native move audit.',sequence);}
    if(type==='-transform'&&e){e.nativeHistory.timesAttacked=nativeUnknown('Native Transform copies its target hit counter; unaudited copied history is withheld.',sequence);e.nativeHistory.lastMoveTargetLoc=nativeUnknown('Transformed/called target history is unaudited.',sequence);}
    if(type==='move'&&e){
      e.confusionAttempt=false;
      if(parts.some(s=>s.startsWith('[from]'))||e.actedTurn===state.turn||AMBIGUOUS_MOVES.has(id(parts[1])))unsafe('unsupported-move-history','Called/repeated/PP-changing or copied-state move');
      e.life.activeMoveActions++;e.life.lastMove=dex.moves.get(parts[1]).name;e.actedTurn=state.turn;e.moveThisTurn=id(parts[1]);
      e.uses[id(parts[1])]=(e.uses[id(parts[1])]??0)+1;
      if(e.ppKnown){const registered=setFor(p.id.startsWith(state.ownSide+'-')?sets:sheet??[],p.species),slot=registered?.moves.findIndex(m=>id(m)===id(parts[1]));
        if(!Number.isInteger(slot)||slot<0||e.pp[slot]<=0)e.ppKnown=false;else{e.pp[slot]--;e.ppOrigin='audited-native-move-PP-history';}}
      if(e.itemKnown&&dex.items.get(e.item).isChoice)e.life.choiceLock=id(parts[1]);
    }
    if(type==='cant'){
      const attribution=cantActionAttribution(parts);
      if(attribution.kind==='blocked-user'){
        // The pinned native holder-first ability event follows the denied
        // user's [still] move announcement. That announcement already owns its
        // attempt/PP/lastMove; the holder may have only switched in this turn.
        const denied=actor(attribution.actor),attempt=denied?entry(denied):null;
        if(!p?.activeSlot||!denied?.activeSlot||attempt?.actedTurn!==state.turn||attempt.moveThisTurn!==id(attribution.move))unsafe('unsupported-denial','Holder-first ability denial lacks its exact already-counted move attempt');
      }else if(e){
        if(attribution.kind!=='ordinary'||e.actedTurn===state.turn||!['slp','par','frz','flinch','nopp','recharge','truant'].includes(id(parts[1])))unsafe('unsupported-denial','Unaudited move-denial lifecycle');
        e.life.activeMoveActions++;e.actedTurn=state.turn;e.confusionAttempt=false;
        const denial=id(parts[1]);e.nativeHistory.currentResult=['slp','par','frz','flinch','nopp','truant'].includes(denial)?nativeKnown(false,'audited-native-BeforeMove-or-PP-denial',sequence):denial==='recharge'?nativeKnown(null,'audited-native-recharge-result',sequence):nativeUnknown('Unaudited native denial result.',sequence);
      }else unsafe('unsupported-denial','Move-denial actor is unavailable');
    }
    if(type==='-singleturn'&&e&&['protect','detect','endure','kingsshield','spikyshield','banefulbunker','silktrap','burningbulwark','obstruct'].includes(id(parts[1]))){
      e.life.protectCounter=Math.min(729,e.life.protectCounter?e.life.protectCounter*3:3);e.protected=true;
    }
    if(type==='-fail'&&e&&['protect','detect','endure','kingsshield','spikyshield','banefulbunker','silktrap','burningbulwark','obstruct'].includes(e.moveThisTurn))e.life.protectCounter=0;
    if(type==='-item'&&e){
      // A replacement item can hide a TakeItem hook (e.g. Trick). Preserve an
      // already proven volatile, but never preserve a false flag through an
      // unaudited replacement of a held/unknown item.
      if(!(e.unburden.known&&e.unburden.value)&&(!e.itemKnown||id(e.item)))e.unburden={known:false,value:false,origin:'unclassified-item-replacement-hook',sequence};
      e.item=parts[1];e.itemKnown=true;e.itemTouched=true;e.life.choiceLock=false;
    }
    if(type==='-enditem'&&e){
      const item=id(parts[1]),seedUse=Object.hasOwn(TERRAIN_SEEDS,item)&&parts.length===2&&id(state.field.terrain?.name)===TERRAIN_SEEDS[item]&&p?.activeSlot&&!p.fainted&&(!e.itemKnown||id(e.item)===item);
      if(!(e.unburden.known&&e.unburden.value)){
        if(seedUse&&!e.suppressed&&!e.unburdenAbilityTouched){
          e.unburden={known:e.abilityKnown,value:e.abilityKnown&&id(e.ability)==='unburden',pendingSeedUse:!e.abilityKnown,origin:'audited-native-terrain-Seed-useItem',sequence};
        }else e.unburden={known:false,value:false,origin:'unclassified-item-loss-hook',sequence};
      }
      e.item='';e.itemKnown=true;e.itemTouched=true;e.life.choiceLock=false;
    }
    if(type==='-ability'&&e){const registered=setFor(p.id.startsWith(state.ownSide+'-')?sets:sheet??[],p.species),before=e.abilityKnown?e.ability:registered?.ability;if(!before||id(before)!==id(parts[1])){e.nativeHistory.timesAttacked=nativeUnknown('Copied/changed ability source may alter hit bookkeeping; unaudited history is withheld.',sequence);e.nativeHistory.lastMoveTargetLoc=nativeUnknown('Copied/changed ability may alter original target selection.',sequence);}e.unburdenAbilityTouched=true;e.unburden={known:false,value:false,origin:'ability-change-or-reveal-requires-source-audit',sequence};e.ability=parts[1];e.abilityKnown=true;e.abilityTouched=true;e.suppressed=false;if(UNSAFE_ABILITIES.has(id(parts[1])))unsafe('unsupported-ability-history','Ability can alter PP, suppression or move-call history');}
    if(type==='-endability'&&e){e.nativeHistory.timesAttacked=nativeUnknown('Suppression/copy history requires an independent native hit-counter audit.',sequence);e.nativeHistory.lastMoveTargetLoc=nativeUnknown('Suppression/copy may alter original targeting history.',sequence);e.unburdenAbilityTouched=true;e.unburden={known:true,value:false,origin:'audited-native-ability-end-reset',sequence};e.suppressed=true;e.abilityKnown=true;e.abilityTouched=true;}
    if(type==='-activate'&&e&&id(parts[1])==='itemleppaberry'){e.ppKnown=false;e.ppUnsupported=true;addProblem('unsupported-PP-history','Public PP restoration awaits an exact private request');}
    // Shed Tail copies only the visible Substitute. Current substitution still
    // blocks strict reconstruction, but a later observed end clears that effect
    // without erasing otherwise audited PP and lifecycle history.
    if(type==='-start'&&!['healblock','substitute','encore','confusion'].includes(id(parts[1]?.replace(/^move: /,''))))unsafe('unsupported-volatile-history','Unaudited volatile state');
    if(type==='-start'&&e&&id(parts[1])==='confusion'){
      // Native Start draws time in [2,5] ([3,5] for Axe Kick). The public
      // event proves an interval, never the sampled private native counter.
      if(e.confusion)unsafe('unsupported-confusion-history','Repeated confusion start without its native end event');
      const axe=pendingFrame?.turn===state.turn&&id(pendingFrame.moveName)==='axekick'&&pendingFrame.targetIds.includes(p.id)&&parts.length===2;
      e.confusion={min:axe?3:2,max:5,sequence};e.confusionAttempt=false;
    }
    if(type==='-activate'&&e&&id(parts[1])==='confusion'){
      // BeforeMove decrements first and only emits Activate if time stays >0.
      // Flinch, turns, Protect announcements and other guesses do not count.
      if(!e.confusion||e.confusion.max<=1||e.actedTurn===state.turn||e.confusionAttempt)unsafe('unsupported-confusion-history','Confusion activation lacks an unambiguous live action counter');
      else {e.confusion={min:Math.max(1,e.confusion.min-1),max:e.confusion.max-1,sequence};e.confusionAttempt=true;}
    }
    if(type==='-damage'&&e&&parts.some(tag=>tag==='[from] confusion')){
      // Native runMove counts this attempted action before BeforeMove; self-hit
      // returns before deductPP and lastMove. It has no Move or Cant event.
      if(!e.confusionAttempt||e.actedTurn===state.turn){unsafe('unsupported-confusion-history','Confusion self-hit lacks its exact preceding activation');e.nativeHistory.currentResult=nativeUnknown('Confusion self-hit lacks an unambiguous attempted action.',sequence);}
      else {e.life.activeMoveActions++;e.actedTurn=state.turn;e.confusionAttempt=false;e.nativeHistory.currentResult=nativeKnown(false,'audited-native-confusion-self-hit-result',sequence);}
    }
    if(type==='-end'&&e&&id(parts[1])==='confusion'){e.confusion=null;e.confusionAttempt=false;}
    if(type==='-start'&&e&&id(parts[1]?.replace(/^move: /,''))==='encore'){
      const registered=setFor(p.id.startsWith(state.ownSide+'-')?sets:sheet??[],p.species),move=e.life.lastMove;
      const slot=registered?.moves.findIndex(m=>id(m)===id(move));
      if(e.encore||!move||!Number.isInteger(slot)||slot<0||!e.ppKnown||e.pp[slot]<=0)unsafe('unsupported-encore-history','Encore target move/PP is unavailable or inconsistent');
      else e.encore={move,remainingTurns:e.actedTurn===state.turn?4:3};
    }
    if(type==='-end'&&e&&id(parts[1]?.replace(/^move: /,''))==='encore')e.encore=null;
    if(type==='-start'&&e&&id(parts[1])==='substitute'){e.substitute=true;e.substituteSequence=sequence;}
    if(type==='-end'&&e&&id(parts[1])==='substitute'){e.substitute=false;e.substituteSequence=null;}
    if(['-fieldstart','-fieldend'].includes(type)&&['magicroom','wonderroom'].includes(id(parts[0]?.replace(/^move: /,''))))unsafe('unsupported-field-history','Item/stat suppression field is not audited');
    if(type==='error')invalidate('Server protocol error');
    if(!PRESENTATION.has(type)&&!ORDINARY.has(type))unsafe('unsupported-protocol-history','Unaudited structural event '+type);
    reduceBattleLine(state,line,{epoch:config.epoch,connected:true,now:m.observedAt??sequence});
    for(const prior of [...turnRecords.keys()])if(prior<Math.max(0,state.turn-7)){turnRecords.delete(prior);turnsDropped++;}
    if(['switch','drag'].includes(type)){
      const incoming=actor(parts[0]),item=entry(incoming);if(item){item.life=LIFE();item.entered=true;item.protected=false;item.actedTurn=null;item.boosts=zero();item.boostsKnown=true;item.suppressed=false;
        item.unburdenAbilityTouched=item.abilityTouched===true;item.unburden={known:true,value:false,origin:'audited-native-entry-reset',sequence};
        item.substitute=transfersSubstitute;item.substituteSequence=transfersSubstitute?sequence:null;
        const registered=setFor(incoming.id.startsWith(state.ownSide+'-')?sets:sheet??[],incoming.species);
        if(id(registered?.ability)==='unburden'&&item.abilityTouched){item.abilityKnown=false;item.unburden={known:false,value:false,origin:'entry-after-ability-change-requires-reset-audit',sequence};}
        if(registered&&typeof registered.ability==='string'&&!item.abilityKnown&&!item.abilityTouched){item.ability=registered.ability;item.abilityKnown=true;}if(registered&&!item.itemKnown){item.item=registered.item??'';item.itemKnown=true;}
        if(registered&&!item.pp&&!item.ppUnsupported){const used=Object.keys(item.uses);
          if(used.every(move=>registered.moves.some(value=>id(value)===move))){item.pp=initialPp(registered.moves).map((pp,index)=>pp-(item.uses[id(registered.moves[index])]??0));item.ppKnown=item.pp.every(pp=>pp>=0);item.ppOrigin=used.length?'audited-native-move-PP-history':'native-initial-PP-complete-history';}
        }
      }
    }
    if(type==='faint'&&e){clearExit(e,sequence);e.substitute=false;e.substituteSequence=null;}
    if(type==='faint'){
      const side=reference(parts[0])?.[1];if(side){if(e?.nativeFainted)faintCountsKnown[side]=false;faintEvents[side]++;faintSequence[side]=sequence;if(e)e.nativeFainted=true;}
    }
    if(['-heal','-sethp'].includes(type)&&e&&actor(parts[0])?.hp?.current>0)e.nativeFainted=false;
    if(['detailschange','-formechange','-mega'].includes(type)&&p){
      const current=state.sides[p.id.split('-')[0]]?.pokemon.find(v=>v.id===p.id),species=dex.species.get(current?.species);
      if(species.isMega&&Object.values(species.abilities).length===1){e.ability=Object.values(species.abilities)[0];e.abilityKnown=true;}
      else if(type==='-mega'){e.abilityKnown=false;}
      if(type==='-mega')e.nativeHistory.currentResult=nativeKnown(true,'audited-Champions-Mega-action-result',sequence);
    }
    for(const side of Object.values(state.sides))for(const mon of side.pokemon){const item=entry(mon);if(stages.every(s=>Number.isInteger(mon.boosts[s]))){item.boosts={...mon.boosts};item.boostsKnown=true;}}
    appendJournalEvent(type,parts,p,beforeHp);
  }
  function observeRequest(value,meta){
    const request=snapshot(value),m=receive('request',request,meta);
    finishFrame('request');
    check(request&&typeof request==='object','private request required');
    if(lastRequest&&(!Number.isSafeInteger(request.rqid)||request.rqid<=lastRequest.rqid))invalidate('Repeated/reordered private request');
    reduceBattleRequest(state,request,{epoch:config.epoch,connected:true,now:m.observedAt??sequence});lastRequest=request;lastRequestSequence=sequence;
    const side=state.sides[state.ownSide];if(!side)return;
    let activeIndex=0;
    for(const p of side.pokemon){
      const item=entry(p),native=request.side?.pokemon?.[p.requestIndex-1];if(!native)continue;
      if(typeof native.item==='string'){item.item=native.item;item.itemKnown=true;}
      if(typeof native.ability==='string'&&!item.suppressed){item.ability=native.ability;item.abilityKnown=true;}
      const registered=setFor(sets,p.species);
      if(!item.pp&&!item.entered&&!p.activeSlot&&start&&registered){item.pp=initialPp(registered.moves);item.ppKnown=derivedSafe;item.ppOrigin='native-initial-PP-complete-history';}
      if(native.active){const moves=request.active?.[activeIndex++]?.moves,pp=moves?.map(m=>m.pp);
        if(!request.teamPreview&&sameMoves(moves?.map(m=>m.id??m.move),native.moves)&&observedPpSchema.safeParse(pp).success){item.pp=[...pp];item.ppKnown=true;item.ppUnsupported=false;item.ppOrigin='fresh-private-active-request';}
      }
    }
  }
  function capture(value){
    const data=snapshot(value),expected=observedBindingSchema.parse(data.expected),observed=data.observed;
    check(observed?.sessionId===config.sessionId&&expected.room===config.room&&expected.teamId===config.teamId&&(!observed.teamSha256||observed.teamSha256===config.teamId),'source session/room/team differs');
    check(Number.isSafeInteger(observed.revision)&&observed.revision>=0&&(observed.epoch===undefined||observed.epoch===config.epoch),'source revision/epoch differs');
    const matches=observed.actions?.filter(a=>a.room===expected.room&&a.rqid===expected.rqid&&a.token===expected.token),boards=observed.boards?.filter(b=>b.room===expected.room&&b.request?.rqid===expected.rqid);
    check(matches?.length===1&&boards?.length===1,'exact source action/board not unique');
    const action=matches[0],board=boards[0];
    check(action.kind==='turn'&&action.actionable!==false&&!['sent','uncertain','accepted','execution-observed'].includes(action.submissionStatus)&&!observed.controlPolicy?.pending?.some(p=>p.token===expected.token&&p.attempted),'source is submitted, reserved or not a normal turn');
    check(!board.request.wait&&!board.request.forceSwitch&&!action.legalActions?.forceSwitch&&!action.legalActions?.teamPreview&&action.legalActions?.active?.length===2,'complete normal turn required');
    check(lastRequest?.rqid===expected.rqid&&!lastRequest.wait&&!lastRequest.forceSwitch&&!lastRequest.teamPreview&&board.turn===state.turn&&board.ownSide===state.ownSide,'history/request turn differs');
    check(lastRequestSequence>lastMaterialSequence,'material events followed the last private request');
    const legal=action.legalActions,party=lastRequest.side?.pokemon;
    check(legal?.pokemon?.length===party?.length&&party.length===4,'exact private selected four required');
    const entryKeys=['ident','details','condition','active','ability','item'];
    check(party.every((p,i)=>entryKeys.every(k=>p[k]===legal.pokemon[i][k])&&sameMoves(p.moves,legal.pokemon[i].moves)),'private party source changed');
    check(lastRequest.active.every((slot,i)=>sameMoves(slot.moves.map(m=>m.id??m.move),legal.active[i].moves.map(m=>m.id??m.move))&&JSON.stringify(slot.moves.map(m=>m.pp))===JSON.stringify(legal.active[i].moves.map(m=>m.pp))),'private active move/PP source changed');
    const tracked=battleStateSnapshot(state);
    check(JSON.stringify(board.field)===JSON.stringify(tracked.field),'observed field differs from current native history');
    for(const side of board.sides??[])for(const p of side.pokemon??[]){
      const rows=tracked.sides.find(s=>s.id===side.id)?.pokemon.filter(t=>side.id===board.ownSide?t.requestIndex===p.requestIndex:t.nickname===p.nickname&&base(t.species)===base(p.species))??[];
      check(rows.length===1,'observed actor mapping differs or is ambiguous');const current=rows[0];
      check(p.species===current.species&&p.nickname===current.nickname&&p.requestIndex===current.requestIndex&&JSON.stringify(p.hp)===JSON.stringify(current.hp)&&p.status===current.status&&p.fainted===current.fainted&&p.activeSlot===current.activeSlot&&stages.every(s=>p.boosts[s]===current.boosts[s])&&JSON.stringify(p.volatiles)===JSON.stringify(current.volatiles),'observed actor state differs from native history');
    }
    const published=observed.opponentSheets?.[board.ownSide==='p1'?'p2':'p1'],suppliedSheet=data.opposingSheet??published??sheet;
    if(suppliedSheet){
      const mechanics=sha(sheetMechanics(suppliedSheet));
      if(published)check(mechanics===sha(sheetMechanics(published)),'supplied sheet mechanics differ from bound published sheet');
      if(sheet)check(mechanics===sha(sheetMechanics(sheet)),'published sheet mechanics changed during this game');
      sheet=suppliedSheet;
    }
    const source={observed,expected,opposingSheet:sheet,teamText:config.teamText};
    const binding={sessionId:config.sessionId,teamId:config.teamId,room:config.room,epoch:config.epoch,rqid:expected.rqid,revision:observed.revision??null,token:expected.token,sequence,historySha256:chain,sourceSha256:sha(source)};
    const token=Object.freeze({kind:'owned-choice-state-snapshot-v1',binding:Object.freeze({...binding})});
    const capturedValidity=validity;
    receipts.set(token,{binding,source,board,legal,tracked,entries:snapshot(Object.fromEntries(entries)),nativeHistory:snapshot({faintEvents,faintSequence,faintCountsKnown,globalLastMove}),journal:journalSnapshot(),complete:start&&continuous,derivedSafe,problems:snapshot(problems),sets:snapshot(sets),isCurrent:()=>sequence===binding.sequence&&chain===binding.historySha256&&validity===capturedValidity});return token;
  }
  return Object.freeze({observeLine,observeRequest,invalidate,capture,journalSnapshot});
}

/** Called inside the same native owner process as capture. Returned data can
 * cross trusted IPC; model arguments must never supply or replace this result.
 * The strict observed builder remains the final reconstruction authority. */
export function assembleChoiceState(token){
  const receipt=receipts.get(token);check(receipt,'unbranded or serialized snapshot');
  check(receipt.isCurrent(),'snapshot is no longer the current native receive boundary');
  const {binding,board,legal,tracked,complete,sets}=receipt,entries=snapshot(receipt.entries),problems=snapshot(receipt.problems);
  const declaredUnsafe=tracked.sides.some(side=>side.pokemon.some(p=>{
    const e=entries[p.id],registered=setFor(side.id===board.ownSide?sets:receipt.source.opposingSheet??[],p.species);
    return e?.entered&&[registered?.ability,e.ability].some(a=>id(a)!=='pressure'&&UNSAFE_ABILITIES.has(id(a)));
  }));
  const derivedSafe=receipt.derivedSafe&&!declaredUnsafe;
  if(declaredUnsafe)problems.push({code:'unsupported-ability-history',detail:'An entered declared ability can alter suppression or called-move history'});
  const unsafePp=[...sets,...receipt.source.opposingSheet??[]].some(s=>id(s.ability)==='pressure');
  const unknowns=[],provenance=[],actors=[],compilerActors=[],reserveEligibility=[],observedOverrides=[],hypotheses={mode:'current',label:'Mechanically assembled known state; missing and hidden fields remain explicit.',own:{},opposing:{},reserves:[],sideMegaUsed:{}};
  const nativeHistory={schemaVersion:1,kind:'source-bound-native-history-v1',binding:Object.fromEntries(['sourceSha256','historySha256','sequence','teamId','room','rqid'].map(key=>[key,binding[key]])),completeHistory:complete,sides:{},pokemon:{},battle:{},unknowns:[],provenance:[],coverage:{knownFields:0,unknownFields:0}};
  const nativeFact=(target,key,record,path)=>{if(complete&&record?.known){target[key]=snapshot(record.value);nativeHistory.provenance.push({path,origin:record.origin,sequence:record.sequence});provenance.push({path:['nativeHistory',...path.split('.')],origin:record.origin,confidence:'source-bound',sequence:record.sequence});nativeHistory.coverage.knownFields++;}else{nativeHistory.unknowns.push({path,reason:!complete?'Complete start-to-current native history is unavailable.':record?.reason??'Native field is not publicly provable.',sequence:record?.sequence??binding.sequence});nativeHistory.coverage.unknownFields++;}};
  nativeFact(nativeHistory.battle,'lastMove',receipt.nativeHistory.globalLastMove,'battle.lastMove');
  let unsupportedCurrentState=false;
  const known=(path,origin)=>provenance.push({path,origin,confidence:'source-bound',sequence:binding.sequence});
  const missing=(path,reason)=>unknowns.push({path,reason});
  for(const side of board.sides??[]){
    nativeHistory.sides[side.id]={};nativeFact(nativeHistory.sides[side.id],'totalFainted',receipt.nativeHistory.faintCountsKnown[side.id]?nativeKnown(Math.min(100,receipt.nativeHistory.faintEvents[side.id]),'audited-every-native-faint-event-Champions-cap-100',receipt.nativeHistory.faintSequence[side.id]):nativeUnknown('Repeated/ambiguous native faint sequence.',binding.sequence),'sides.'+side.id+'.totalFainted');
    if(complete){hypotheses.sideMegaUsed[side.id]=tracked.sides.find(s=>s.id===side.id)?.pokemon.some(p=>p.mega===true)===true;known(['sideMegaUsed',side.id],'complete-native-history-Mega-events');}
    else missing(['sideMegaUsed',side.id],'Complete start-to-current history unavailable');
    for(const p of side.pokemon??[]){
      const own=side.id===board.ownSide,rows=tracked.sides.find(s=>s.id===side.id)?.pokemon.filter(t=>own?t.requestIndex===p.requestIndex:t.nickname===p.nickname&&base(t.species)===base(p.species))??[];
      const native=rows.length===1?rows[0]:null,e=native?entries[native.id]:null,registered=setFor(own?sets:receipt.source.opposingSheet??[],p.species);
      nativeHistory.pokemon[p.id]={};for(const key of ['timesAttacked','lastMoveTargetLoc','moveLastTurnResult'])nativeFact(nativeHistory.pokemon[p.id],key,e?.nativeHistory?.[key],'pokemon.'+p.id+'.'+key);
      if(complete&&derivedSafe&&e&&registered){
        if(!e.abilityKnown&&!e.abilityTouched&&typeof registered.ability==='string'){
          const species=dex.species.get(p.species);e.ability=species.isMega&&Object.values(species.abilities).length===1?Object.values(species.abilities)[0]:registered.ability;e.abilityKnown=true;
        }
        if(!e.itemKnown&&!e.itemTouched&&typeof registered.item==='string'){e.item=registered.item;e.itemKnown=true;}
        if(!e.pp&&!e.ppUnsupported&&!unsafePp){
          const values=initialPp(registered.moves),used=Object.keys(e.uses);
          if(used.every(move=>registered.moves.some(m=>id(m)===move))){e.pp=values.map((pp,i)=>pp-(e.uses[id(registered.moves[i])]??0));e.ppKnown=e.pp.every(pp=>pp>=0);e.ppOrigin=used.length?'audited-native-move-PP-history':'native-initial-PP-complete-history';}
        }
        if(!e.itemTouched&&e.itemKnown&&dex.items.get(e.item).isChoice&&e.life.lastMove)e.life.choiceLock=id(e.life.lastMove);
      }
      const facts={id:p.id,own,species:p.species,hp:snapshot(p.hp),status:p.status??'',item:p.itemKnown?p.item??'':null,ability:p.ability??null,boosts:snapshot(p.boosts),fainted:p.fainted===true};
      if(own&&registered){facts.registeredSet=snapshot(registered);known(['actors',p.id,'registeredSet'],'verified-locked-six');}
      const fragment={label:'Known state from exact private request and audited complete native history.'};
      if(complete&&derivedSafe&&e?.known&&observedLifecycleSchema.safeParse(e.life).success){fragment.lifecycle=snapshot(e.life);known([own?'own':'opposing',p.id,'lifecycle'],'audited-native-public-lifecycle');}
      else missing([own?'own':'opposing',p.id,'lifecycle'],'Incomplete or unsupported native history');
      if(stages.every(s=>Number.isInteger(p.boosts?.[s]))){fragment.boosts=snapshot(p.boosts);known([own?'own':'opposing',p.id,'boosts'],'bound-observed-boosts');}
      else if(complete&&derivedSafe&&e?.boostsKnown){fragment.boosts=snapshot(e.boosts);known([own?'own':'opposing',p.id,'boosts'],'native-initial-and-observed-boost-history');}
      if(complete&&derivedSafe&&e?.abilityKnown){facts.ability=e.ability;facts.abilitySuppressed=e.suppressed;if(!own){fragment.ability=e.ability;if(!e.suppressed)fragment.abilitySuppressed=false;}known(['actors',p.id,'ability'],'declared-initial-and-native-ability-history');}
      if(complete&&derivedSafe&&e?.itemKnown){facts.item=e.item;if(!own)fragment.item=e.item;known(['actors',p.id,'item'],'declared-initial-and-native-item-history');}
      if(id(facts.ability)==='unburden'||id(registered?.ability)==='unburden'){
        if(e?.unburdenAbilityTouched)unsupportedCurrentState=true;
        if(complete&&derivedSafe&&e&&id(registered?.ability)==='unburden'&&!e.unburdenAbilityTouched&&!e.suppressed){
          if(!e.entered&&!p.activeSlot)e.unburden={known:true,value:false,origin:'audited-native-never-entered-Unburden-inactive',sequence:binding.sequence};
          if(e.unburden.pendingSeedUse)e.unburden={...e.unburden,known:true,value:true,origin:'audited-native-terrain-Seed-useItem-and-fixed-declared-ability'};
          if(e.unburden.known&&(!e.unburden.value||p.activeSlot&&!p.fainted)){
            if(fragment.lifecycle)fragment.lifecycle.unburdenVolatile=e.unburden.value;
            facts.unburdenVolatile=e.unburden.value;known([own?'own':'opposing',p.id,'lifecycle','unburdenVolatile'],e.unburden.origin);
            observedOverrides.push({sideId:side.id,pokemonId:p.id,field:'unburdenVolatile',value:e.unburden.value,origin:'audited-native-Unburden-volatile-history',sequence:e.unburden.sequence});
          }else missing([own?'own':'opposing',p.id,'lifecycle','unburdenVolatile'],'Unburden item-use/removal hook or reset history is unaudited');
        }else missing([own?'own':'opposing',p.id,'lifecycle','unburdenVolatile'],'Complete unchanged unsuppressed native Unburden history is unavailable');
      }
      let pp=null,origin=null,retainedRefused=false;
      if(own){const activeIndex=side.active.findIndex(s=>s.pokemon===p.id),requestEntry=legal.pokemon[p.requestIndex-1];
        if(activeIndex>=0){pp=legal.active[activeIndex]?.moves?.map(m=>m.pp);origin='fresh-private-active-request';}
        else try{const retained=validateOwnReservePpSnapshot({pokemon:p,requestEntry,observation:board.ownPpObservation,rqid:binding.rqid});if(retained){pp=retained.pp;origin='shared-validated-retained-private-request';}}catch{retainedRefused=true;missing(['own',p.id,'pp'],'Claimed retained private PP failed the unchanged shared guard');}
      }
      if(!pp&&!retainedRefused&&complete&&derivedSafe&&!unsafePp&&e?.ppKnown&&!e.ppUnsupported){pp=e.pp;origin=e.ppOrigin??'audited-native-move-PP-history';}
      if(observedPpSchema.safeParse(pp).success){fragment.pp=[...pp];known([own?'own':'opposing',p.id,'pp'],origin);}
      else missing([own?'own':'opposing',p.id,'pp'],'No exact private or audited complete-history PP evidence');
      if(complete&&e?.substitute){
        unsupportedCurrentState=true;
        missing([own?'own':'opposing',p.id,'volatiles'],'Explicit native Substitute remains active; current reconstruction does not support its hidden HP');
        if(!Object.hasOwn(p.volatiles??{},'substitute'))observedOverrides.push({sideId:side.id,pokemonId:p.id,field:'substitute',value:{name:'Substitute',startedTurn:null},origin:'audited-native-ShedTail-transfer',sequence:e.substituteSequence});
      }
      else {
        fragment.volatiles={};const keys=Object.keys(p.volatiles??{});
        if(!keys.length)known([own?'own':'opposing',p.id,'volatiles'],'bound-observed-empty-volatile-state');
        if(keys.includes('encore')&&complete&&derivedSafe&&e?.encore&&e.encore.remainingTurns>=1&&e.encore.remainingTurns<=3){fragment.volatiles.encore=snapshot(e.encore);known([own?'own':'opposing',p.id,'volatiles','encore'],'audited-native-Encore-move-and-duration');}
        if(keys.includes('confusion')){
          const range=e?.confusion,existing=p.volatiles.confusion?.remainingActions;
          const valid=r=>Number.isInteger(r?.min)&&Number.isInteger(r?.max)&&r.min>=1&&r.max<=5&&r.min<=r.max;
          if(complete&&derivedSafe&&p.activeSlot&&!p.fainted&&valid(range)&&(!existing||valid(existing)&&existing.min>=range.min&&existing.max<=range.max)){
            const bounded=existing??{min:range.min,max:range.max};facts.confusionRemainingActions=snapshot(bounded);
            known(['actors',p.id,'confusionRemainingActions'],'audited-native-confusion-action-range');
            if(!existing)observedOverrides.push({sideId:side.id,pokemonId:p.id,field:'confusionRemainingActions',value:snapshot(bounded),origin:'audited-native-confusion-action-range',sequence:range.sequence});
            if(bounded.min===bounded.max)fragment.volatiles.confusion={remainingActions:bounded.min};
            else missing([own?'own':'opposing',p.id,'volatiles','confusion','remainingActions'],'Hidden native confusion action counter requires an explicit bounded hypothesis');
          }else {unsupportedCurrentState=true;missing([own?'own':'opposing',p.id,'volatiles','confusion'],'Complete unambiguous native confusion action history is unavailable or conflicts with observation');}
        }
        if(keys.some(key=>key==='healblock'||key==='encore'&&!fragment.volatiles.encore||!['healblock','encore','confusion'].includes(key)))missing([own?'own':'opposing',p.id,'volatiles'],'Volatile duration/source still requires supported exact evidence');
      }
      if(Object.keys(p.volatiles??{}).some(key=>!['healblock','confusion'].includes(key)&&(key!=='encore'||!fragment.volatiles?.encore)))unsupportedCurrentState=true;
      if(!own){fragment.status=p.status??'';if(p.fainted===true)fragment.hp=0;else missing(['opposing',p.id,'hp'],'Public HP display is not exact opposing HP');missing(['opposing',p.id,'statPoints'],'Hidden opposing investments remain a separately labeled candidate');}
      hypotheses[own?'own':'opposing'][p.id]=fragment;actors.push(facts);compilerActors.push({...facts,historyId:native.id});
    }
    if(side.id!==board.ownSide&&side.unrevealedSelected>0)missing(['reserves'],'Unrevealed opposing selection is not chosen by the facts assembler');
    for(const [key,c]of Object.entries(side.conditions??{})){
      if(key==='toxicspikes'&&complete&&derivedSafe&&Number.isInteger(c?.layers)&&c.layers>=1&&c.layers<=2){
        hypotheses.sideConditions??={};hypotheses.sideConditions[side.id]??={};hypotheses.sideConditions[side.id][key]={layers:c.layers};known(['sideConditions',side.id,key],'audited-native-hazard-layer-history');
      }else if(c?.remainingTurns?.min===c?.remainingTurns?.max&&Number.isInteger(c?.remainingTurns?.min)&&c.remainingTurns.min>=1&&['reflect','lightscreen','auroraveil','tailwind'].includes(key)){
        hypotheses.sideConditions??={};hypotheses.sideConditions[side.id]??={};hypotheses.sideConditions[side.id][key]={remainingTurns:c.remainingTurns.min};known(['sideConditions',side.id,key],'exact-bound-observed-duration');
      }else missing(['sideConditions',side.id,key],'Current side-condition duration is unsupported, a range or unavailable');
    }
  }
  const field={};for(const [key,c]of [['weather',board.field?.weather],['terrain',board.field?.terrain],['trickRoom',board.field?.conditions?.trickroom]])if(c){
    if(c.remainingTurns?.min===c.remainingTurns?.max&&Number.isInteger(c.remainingTurns?.min)&&c.remainingTurns.min>=1){field[key]=key==='trickRoom'?{remainingTurns:c.remainingTurns.min}:{id:id(c.name)==='snowscape'?'snow':id(c.name),remainingTurns:c.remainingTurns.min};known(['field',key],'exact-bound-observed-duration');}
    else missing(['field',key],'Current duration is a range or unavailable');
  }
  if(Object.keys(field).length)hypotheses.field=field;
  if(complete&&derivedSafe&&Array.isArray(receipt.source.opposingSheet)){
    const foe=tracked.sides.find(side=>side.id!==board.ownSide),entered=new Set((foe?.pokemon??[]).filter(p=>entries[p.id]?.entered).map(p=>base(p.species)));
    for(const registered of receipt.source.opposingSheet){
      if(entered.has(base(registered.species))||typeof registered.ability!=='string'||!registered.ability||typeof registered.item!=='string'||!Array.isArray(registered.moves)||registered.moves.length!==4)continue;
      reserveEligibility.push({species:registered.species,eligible:true,conditionalOn:'selected-unrevealed-and-never-entered',notSelectionEvidence:true,
        hp:'full',status:'',boosts:zero(),pp:initialPp(registered.moves),lifecycle:{...LIFE(),...(id(registered.ability)==='unburden'?{unburdenVolatile:false}:{})},volatiles:{},ability:registered.ability,item:registered.item,abilitySuppressed:false,
        origin:'audited-complete-native-history-never-entered',sequence:binding.sequence});
    }
  }
  const spread=compileSpreadObservations({journal:receipt.journal,binding,currentActors:compilerActors,ownTeam:sets});
  const originalObserved=receipt.source.observed,overlaid=applyOverrides(originalObserved,observedOverrides,binding.room,binding.rqid);
  return {schemaVersion:1,kind:'mechanical-choice-state-v1',binding:{...snapshot(binding),observedSha256:sha(originalObserved),assembledObservedSha256:sha(overlaid)},facts:{actors,field:snapshot(board.field),reserveEligibility,spreadObservations:spread.spreadObservations,nativeHistory},hypotheses,provenance,unknowns,observedOverrides,
    spreadEvidence:{binding:spread.binding,coverage:spread.coverage,ignoredConstraints:spread.ignoredConstraints.slice(0,64),ignoredOmitted:Math.max(0,spread.ignoredConstraints.length-64),provenance:spread.provenance.slice(0,64),provenanceOmitted:Math.max(0,spread.provenance.length-64),limitations:spread.limitations},
    coverage:{completeHistory:complete,auditedHistory:complete&&derivedSafe,historyProblems:problems,unsupportedCurrentState,tacticalChoicesSelected:false,hiddenInvestmentsSelected:false,reconstructionReady:false,calculationsRun:0,calculationScope:'damage-Speed-and-turn-checks-only'},limitations:['Known-state fragments are not a complete strict reconstruction or a tactical result.','The native owner must capture and assemble atomically and retain original deadline and submission reservations.','Unsupported or incomplete history withholds derived fields; hidden investments/selected reserves remain assumptions outside this assembler.','Reserve eligibility is conditional freshness if selected, never evidence of actual opposing selection. PP uses the pinned Champions native initial rule.','Spread observations are mechanical templates only; actual numerical filtering still requires MCP.']};
}

function applyOverrides(observed,overrides,room,rqid){
  const result=snapshot(observed),boards=result.boards?.filter(b=>b.room===room&&b.request?.rqid===rqid);check(boards?.length===1,'override board binding differs');
  for(const row of overrides){
    check(row.field==='substitute'&&row.origin==='audited-native-ShedTail-transfer'||row.field==='unburdenVolatile'&&row.origin==='audited-native-Unburden-volatile-history'&&typeof row.value==='boolean'||row.field==='confusionRemainingActions'&&row.origin==='audited-native-confusion-action-range'&&Number.isInteger(row.value?.min)&&Number.isInteger(row.value?.max)&&row.value.min>=1&&row.value.max<=5&&row.value.min<=row.value.max,'unsupported source override');
    const actors=boards[0].sides?.filter(s=>s.id===row.sideId).flatMap(s=>s.pokemon.filter(p=>p.id===row.pokemonId));check(actors?.length===1,'override actor binding differs');
    const actor=actors[0];
    if(row.field==='unburdenVolatile'){check(!Object.hasOwn(actor,'unburdenVolatile'),'override would replace an observed fact');actor.unburdenVolatile=row.value;}
    else if(row.field==='confusionRemainingActions'){check(actor.volatiles?.confusion&&!Object.hasOwn(actor.volatiles.confusion,'remainingActions'),'override would replace or invent observed confusion');actor.volatiles.confusion.remainingActions=snapshot(row.value);}
    else {check(!Object.hasOwn(actor.volatiles??{},'substitute'),'override would replace an observed fact');actor.volatiles={...actor.volatiles,substitute:snapshot(row.value)};}
  }
  return result;
}

/** Apply only a trusted IPC assembly's exact hash-bound mechanical additions.
 * The model must never be allowed to author this assembly or its overrides. */
export function applyChoiceStateOverrides({observed,assembly}){
  const data=snapshot({observed,assembly});check(data.assembly.kind==='mechanical-choice-state-v1'&&sha(data.observed)===data.assembly.binding.observedSha256,'source/assembly hash differs');
  const result=applyOverrides(data.observed,data.assembly.observedOverrides,data.assembly.binding.room,data.assembly.binding.rqid);
  check(sha(result)===data.assembly.binding.assembledObservedSha256,'assembled source hash differs');return result;
}
