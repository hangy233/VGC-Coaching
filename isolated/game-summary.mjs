// A bounded observation handoff between games, never current state or a plan.
const LIMIT=4096;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const bytes=v=>Buffer.byteLength(JSON.stringify(v));
const own=(v,k)=>Object.hasOwn(v,k);
const canonical=(v,kind)=>{
  const pattern=kind==='parent'?/^(game-bestof3-gen9championsvgc2026regmcbo3-\d+)(?:-[a-z0-9]+pw)?$/iu:/^(battle-gen9championsvgc2026regmcbo3-\d+)(?:-[a-z0-9]+pw)?$/iu;
  return typeof v==='string'?pattern.exec(v)?.[1].toLowerCase()??null:null;
};
const accountId=v=>typeof v==='string'?v.toLowerCase().replace(/[^a-z0-9]/gu,''):'';
const unsafe=/(?:https?:\/\/|(?:battle|game-bestof3)-[a-z0-9-]+-[a-z0-9]+pw\b|\b(?:sk|sess)-[A-Za-z0-9_-]{12,}|(?:password|api[_ -]?key|credential|assertion|control[_ -]?lease|read[_ -]?receipt)\s*[:=]|[\u0000-\u001f\u007f])/iu;
const text=(v,max=64)=>typeof v==='string'&&!unsafe.test(v)&&Buffer.byteLength(v)<=max?v:undefined;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const scalar=v=>v===null||typeof v==='boolean'||finite(v)||text(v)!==undefined;
const pick=(value,keys)=>{const out={};if(object(value))for(const key of keys)if(own(value,key)&&scalar(value[key]))out[key]=value[key];return out;};
const EVENT_TYPES=new Set(['turn','move','switch','drag','replace','-mega','-damage','-heal','faint','-status','-curestatus','-boost','-unboost','-setboost','-clearboost','-item','-enditem','-ability','-weather','-fieldstart','-fieldend','cant','-activate','-fail','-miss','-crit','-immune','win','tie']);
function condition(value){
  if(value===null)return null;if(typeof value==='string')return text(value);
  if(!object(value))return undefined;
  const out=pick(value,['name','startedTurn','elapsedUpkeeps','durationWarning']);
  for(const key of ['duration','remainingTurns'])if(value[key]===null)out[key]=null;else if(object(value[key]))out[key]=pick(value[key],['min','max','includesCurrentTurnBeforeUpkeep']);
  return out;
}
function observedSnapshot(board,omitted){
  if(!object(board))return null;
  const out=pick(board,['turn','ownSide']);out.field={};
  for(const key of ['weather','terrain']){const value=condition(board.field?.[key]);if(value!==undefined)out.field[key]=value;}
  const room=board.field?.conditions?.trickroom??board.field?.conditions?.['Trick Room'];
  if(room!==undefined)out.field.trickRoom=condition(room);
  out.sides=[];
  for(const side of (Array.isArray(board.sides)?board.sides:[]).filter(s=>s?.id==='p1'||s?.id==='p2').slice(0,2)){
    const active=new Set((Array.isArray(side.active)?side.active:[]).map(v=>typeof v==='string'?v:v?.pokemon));
    const selected=(Array.isArray(side.pokemon)?side.pokemon:[]).filter(p=>{
      const known=p?.selection==='selected'||active.has(p?.id)||p?.activeSlot!=null||
        side.id!==board.ownSide&&board.turn>0&&p?.hp!=null&&p?.selection!=='not-in-current-request';
      if(!known)omitted.unselectedOrUnknown++;return known;
    }).sort((a,b)=>Number(active.has(b.id)||b.activeSlot!=null)-Number(active.has(a.id)||a.activeSlot!=null));
    omitted.knownPokemon+=Math.max(0,selected.length-4);
    const result={id:side.id,...pick(side,['selectedTeamSize','teamSize']),pokemon:[]};
    for(const p of selected.slice(0,4)){
      const mon=pick(p,['id','species','status','fainted','item','itemKnown','identityConfidence']);
      if(!mon.id){omitted.knownPokemon++;continue;}
      mon.active=active.has(p.id)||p.activeSlot!=null;
      if(p.hp===null)mon.hp=null;else if(object(p.hp))mon.hp=pick(p.hp,['current','max','precision']);else if(text(p.hp)!==undefined)mon.hp=p.hp;
      if(p.boosts===null)mon.boosts=null;else if(object(p.boosts))mon.boosts=pick(p.boosts,['atk','def','spa','spd','spe','accuracy','evasion']);
      if(Array.isArray(p.moves)){mon.moves=p.moves.filter(v=>text(v)!==undefined).slice(-4);omitted.moveNames+=p.moves.length-mon.moves.length;}
      result.pokemon.push(mon);
    }out.sides.push(result);
  }return out;
}

/** Only exact caller-selected old child data is projected. Missing final data
 * stays explicitly last-observed; an ended room alone does not finalize a board. */
export function preparePreviousGameSummary({state,gameId,parentId,teamId,account}={}){
  const game=canonical(gameId,'game'),parent=canonical(parentId,'parent');
  if(!game||!parent||typeof teamId!=='string'||!teamId||!object(state))return null;
  const rooms=(Array.isArray(state.rooms)?state.rooms:[]).filter(r=>canonical(r?.id,'game')===game);
  const boards=(Array.isArray(state.boards)?state.boards:[]).filter(b=>canonical(b?.room??b?.id,'game')===game);
  if(rooms.length>1||boards.length>1)return null;
  const room=rooms[0],board=object(room?.state)?room.state:boards[0];
  const parents=(Array.isArray(state.rooms)?state.rooms:[]).filter(r=>canonical(r?.id,'parent')===parent);
  const parentListed=parents.some(r=>Array.isArray(r.children)&&r.children.some(v=>canonical(typeof v==='string'?v:v?.id,'game')===game));
  const declaredParents=[room?.parentId,boards[0]?.parentId].filter(v=>v!==undefined&&v!==null);
  if(declaredParents.some(v=>canonical(v,'parent')!==parent)||!(declaredParents.length||parentListed))return null;
  const teams=[state.teamId,state.teamSha256,room?.teamId,boards[0]?.teamId,parents[0]?.teamId].filter(v=>typeof v==='string'&&v);
  if(teams.some(v=>v!==teamId)||state.username&&accountId(state.username)!==accountId(account))return null;
  const result=room?.result,official=room?.ended===true&&teams.length>0&&
    (result?.type==='tie'||result?.type==='win'&&text(result.winner)!==undefined&&result.winner.trim().length>0);
  const final=official&&board?.ended===true&&board.result?.type===result.type&&
    (result.type==='tie'||board.result.winner===result.winner);
  const omitted={events:0,unselectedOrUnknown:0,knownPokemon:0,moveNames:0,fields:0};
  const rawEvents=Array.isArray(room?.recentEvents)?room.recentEvents:Array.isArray(board?.recentEvents?.lines)?board.recentEvents.lines:[];
  const events=rawEvents.filter(v=>typeof v==='string'&&EVENT_TYPES.has(v.split('|',3)[1])&&text(v,220)!==undefined).slice(-12);
  omitted.events=rawEvents.length-events.length+(Number.isSafeInteger(board?.recentEvents?.omitted)?board.recentEvents.omitted:0);
  const summary={kind:'previous-game-observations',version:1,teamId,parentId:parent,gameId:game,
    source:{scope:'previous-game-only',status:final?'verified-final':board?'last-observed':'snapshot-unavailable',officialResultVerified:official,snapshotFinalVerified:final,
      finalEventObserved:events.some(line=>official&&(result.type==='tie'?/^\|tie(?:\||$)/u.test(line):line===`|win|${result.winner}`)),fullGameHistory:false},
    result:official?{type:result.type,...(result.type==='win'?{winner:result.winner}:{}),outcome:result.type==='tie'?'tie':accountId(account)?accountId(result.winner)===accountId(account)?'win':'loss':'unknown'}:null,
    observed:observedSnapshot(board,omitted),events,omitted};
  // Drop whole optional observations, with explicit coverage counters. Never
  // truncate serialized facts or silently infer a value to make the budget.
  while(bytes(summary)>LIMIT&&summary.events.length){summary.events.shift();omitted.events++;}
  if(bytes(summary)>LIMIT)for(const side of summary.observed?.sides??[])for(const mon of side.pokemon)if(mon.moves){omitted.moveNames+=mon.moves.length;delete mon.moves;}
  while(bytes(summary)>LIMIT){
    const side=(summary.observed?.sides??[]).find(s=>s.pokemon.some(mon=>!mon.active));if(!side)break;
    side.pokemon.splice(side.pokemon.findLastIndex(mon=>!mon.active),1);omitted.knownPokemon++;
  }
  if(bytes(summary)>LIMIT){summary.observed=null;omitted.fields++;summary.source.status='snapshot-unavailable';summary.source.snapshotFinalVerified=false;}
  return bytes(summary)<=LIMIT?summary:null;
}

const ALLOWED=new Set(['kind','version','teamId','parentId','gameId','source','scope','status','officialResultVerified','snapshotFinalVerified','finalEventObserved','fullGameHistory','result','type','winner','outcome',
  'observed','turn','ownSide','field','weather','terrain','trickRoom','name','startedTurn','elapsedUpkeeps','durationWarning','duration','remainingTurns','min','max','includesCurrentTurnBeforeUpkeep',
  'sides','id','selectedTeamSize','teamSize','pokemon','species','fainted','item','itemKnown','identityConfidence','active','hp','current','precision','boosts','atk','def','spa','spd','spe','accuracy','evasion','moves',
  'events','omitted','unselectedOrUnknown','knownPokemon','moveNames','fields']);
/** Bounded, exact-scope retention also rejects external history/plan injection. */
export function retainPreviousGameSummary(value,{teamId,parentId,currentGameId}={}){
  try{
    if(!object(value)||value.kind!=='previous-game-observations'||value.version!==1||value.teamId!==teamId||
      value.parentId!==canonical(parentId,'parent')||value.gameId===canonical(currentGameId,'game')||!canonical(value.gameId,'game')||value.gameId!==canonical(value.gameId,'game')||
      value.source?.scope!=='previous-game-only'||bytes(value)>LIMIT)return null;
    const safe=(node,depth=0)=>depth<=10&&(node===null||typeof node==='boolean'||finite(node)||typeof node==='string'&&!unsafe.test(node)||
      Array.isArray(node)&&node.length<=12&&node.every(v=>safe(v,depth+1))||object(node)&&Object.entries(node).every(([k,v])=>ALLOWED.has(k)&&safe(v,depth+1)));
    return safe(value)?structuredClone(value):null;
  }catch{return null;}
}
