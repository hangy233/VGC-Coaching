import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {z} from 'zod';
import {callLocalSession} from '../showdown/local-bridge.mjs';
import {loadMetricsTeam} from '../metrics/import.mjs';
import {boardDigest,digest,requestDigest} from './identity.mjs';
import {publishedSheetDigest} from '../simulation/observed-position.mjs';
const {Teams,TeamValidator}=createRequire(import.meta.url)('pokemon-showdown');
const check=(ok,message)=>{if(!ok)throw new Error(message);};
const data=z.record(z.string(),z.unknown());
const sheet=z.array(data).min(1).max(6);
export const planningSourceSchema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('explicit'),label:z.string().min(1).max(500),board:data,legalActions:data,ownTeam:z.string().min(1).max(131072),opponentSheet:sheet}),
  z.strictObject({kind:z.literal('observed'),sessionId:z.string().min(1).max(200),teamId:z.string().regex(/^[a-f0-9]{64}$/),room:z.string().regex(/^battle-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*(?:-[a-z0-9]+pw)?$/),rqid:z.number().int().min(0),token:z.string().regex(/^[a-f0-9]{64}$/)}),
]);
const unwrap=reply=>{check(reply?.ok!==false&&!reply?.isError,'Planning source unavailable');return reply?.result??reply;};
export function boundAction(state,source,{now=Date.now}={}){
  // Native compact turn snapshots omit the team hash. Callers must establish
  // the locked team from full status/arming; a supplied conflicting hash fails.
  check(state?.sessionId===source.sessionId&&(!state.teamSha256||state.teamSha256===source.teamId),'Planning session/team changed');
  check(state.connected!==false&&state.authenticated!==false&&state.stopped!==true,'Planning source client is disconnected, unauthenticated or stopped');
  const matches=state.actions?.filter(action=>action.room===source.room&&action.rqid===source.rqid&&action.token===source.token);
  check(matches?.length===1&&matches[0].actionable!==false&&!['sent','uncertain','accepted','execution-observed'].includes(matches[0].submissionStatus),'Planning request is stale, absent or already reserved');
  check(!state.controlPolicy?.pending?.some(p=>p.token===source.token&&p.attempted),'Planning request has a send reservation');
  check(!state.controlPolicy?.pending?.some(p=>p.token===source.token&&Number.isFinite(p.cutoffAt)&&p.cutoffAt<=now()),'Planning request cutoff expired');
  const action=matches[0],boards=state.boards?.filter(board=>board.room===source.room&&board.request?.rqid===source.rqid);
  check(boards?.length===1&&action.legalActions,'Matching planning board/legality is unavailable');
  return {action,board:boards[0]};
}
function parseTeam(text){
  const team=Teams.import(text);check(team?.length>=2&&team.length<=6,'Explicit planning requires a native team export');
  const validator=new TeamValidator('gen9championsvgc2026regmc');
  const errors=team.length===6?validator.validateTeam(team):team.flatMap(set=>validator.validateSet(set,{})??[]);
  check(!errors?.length,'Planning team failed native validation: '+errors?.join('; '));return team;
}
function published(packed){const columns=packed.split(']').map(value=>value.split('|'));return (Teams.unpack(packed)??[]).map((set,i)=>({species:set.species,item:set.item||'',ability:set.ability||'',moves:set.moves,nature:columns[i]?.[5]?set.nature:null,level:columns[i]?.[10]?set.level:null}));}
const boardSheet=board=>{
  check(['p1','p2'].includes(board?.ownSide),'Actual published opposing sheet requires an identified own side');
  return board.opponentSheets?.[board.ownSide==='p1'?'p2':'p1'];
};
/** Keep only complete registered sheets from this operator's actual observations.
 * Native compact snapshots publish OTS at preview and omit it on later turns.
 * The retained projection matches the packed planning reader, including unknown
 * nature/level, rather than hashing preview-only presentation fields. */
export function createObservedPlanningSheetCache(){
  let owner;const entries=new Map();
  const retain=(room,entry)=>{entries.set(room,entry);while(entries.size>12)entries.delete(entries.keys().next().value);};
  const withoutRetained=board=>board?.opponentSheetObservation?
    Object.fromEntries(Object.entries(board).filter(([key])=>!['opponentSheets','opponentSheetObservation'].includes(key))):board;
  const projection=sets=>sets.map(set=>({species:set.species,item:set.item||'',ability:set.ability||'',moves:structuredClone(set.moves),
    nature:typeof set.nature==='string'&&set.nature?set.nature:null,level:Number.isInteger(set.level)?set.level:null}));
  const complete=sets=>Array.isArray(sets)&&sets.length===6&&Buffer.byteLength(JSON.stringify(sets))<=65536&&sets.every(set=>
    set&&typeof set==='object'&&typeof set.species==='string'&&set.species.length>0&&set.species.length<=100&&
    typeof set.item==='string'&&set.item.length<=100&&typeof set.ability==='string'&&set.ability.length<=100&&
    (set.nature==null||typeof set.nature==='string'&&set.nature.length<=100)&&
    (set.level==null||Number.isInteger(set.level)&&set.level>=1&&set.level<=100)&&
    Array.isArray(set.moves)&&set.moves.length>0&&set.moves.length<=4&&set.moves.every(move=>typeof move==='string'&&move.length>0&&move.length<=100));
  return {
    observe(state,identity){
      if(typeof state?.sessionId!=='string')return state;
      const expected=identity&&`${identity.sessionId}:${identity.teamId}`;
      if(!expected||state?.sessionId!==identity.sessionId||state.teamSha256!==undefined&&state.teamSha256!==identity.teamId||
        state.connected===false||state.authenticated===false||state.stopped===true){entries.clear();owner=undefined;return state;}
      if(owner!==expected){entries.clear();owner=expected;}
      // Scoped diagnostics can include the session id without being a room
      // snapshot. They neither refresh nor erase an actual sheet observation.
      if(!Array.isArray(state.rooms)){if(Array.isArray(state.boards))entries.clear();return state;}
      const liveRoom=room=>state.rooms.filter(entry=>entry?.id===room).length===1&&state.rooms.some(entry=>entry?.id===room&&entry.ended===false&&
        (entry.teamId===undefined||entry.teamId===identity.teamId));
      for(const room of entries.keys())if(!liveRoom(room))entries.delete(room);
      if(!Array.isArray(state.boards))return state;
      const boards=state.boards.map(board=>{
        const room=board?.room,ownSide=board?.ownSide,foe=ownSide==='p1'?'p2':'p1';
        if(typeof room!=='string'||!/^battle-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*(?:-[a-z0-9]+pw)?$/.test(room)||
          !['p1','p2'].includes(ownSide)||!liveRoom(room)||state.boards.filter(row=>row?.room===room).length!==1){entries.delete(room);return withoutRetained(board);}
        const prior=entries.get(room),actual=board.opponentSheets?.[foe];
        if(prior&&!prior.invalid&&prior.ownSide!==ownSide)retain(room,{invalid:true});
        // Our decorated responses can be observed again by an action helper.
        // They are never new native observations or a later freshness receipt.
        if(!board.opponentSheetObservation&&actual!==undefined&&actual!==null){
          if(!complete(actual)){retain(room,{invalid:true});return board;}
          const sets=projection(actual),sheetSha256=digest(sets);
          if(prior&&(prior.invalid||prior.ownSide!==ownSide||prior.sheetSha256!==sheetSha256))retain(room,{invalid:true});
          else retain(room,{ownSide,sheetSha256,sets,source:{kind:'retained-registered-open-team-sheet',sessionId:identity.sessionId,teamId:identity.teamId,
            room,ownSide,opposingSide:foe,...(Number.isSafeInteger(state.revision)?{snapshotRevision:state.revision}:{}),
            ...(Number.isSafeInteger(board.request?.rqid)?{rqid:board.request.rqid}:{}),observedSheetSha256:digest(actual),planningSheetSha256:sheetSha256,
            freshness:'previous-observation-same-child-only',limits:'Registered six only; no selected four, investments, next actions or continuous freshness is established.'}});
          return board;
        }
        const retained=entries.get(room);
        if(actual!==undefined&&actual!==null&&!board.opponentSheetObservation)return board;
        if(!retained||retained.invalid||retained.ownSide!==ownSide)return withoutRetained(board);
        return {...board,opponentSheets:{...(board.opponentSheets??{}),[foe]:structuredClone(retained.sets)},opponentSheetObservation:structuredClone(retained.source)};
      });
      return {...state,boards};
    },
  };
}
/** Use the actual compact sheet when present, otherwise exactly one matching
 * full-status room. Absent, malformed or ambiguous sheets cannot be guessed. */
export function observedPlanningSheet(board,full,room){
  const actual=boardSheet(board);
  if(actual!==undefined&&actual!==null){check(sheet.safeParse(actual).success,'Actual published opposing sheet unavailable or malformed');return actual;}
  const matches=full?.rooms?.filter(entry=>entry.id===room);
  check(matches?.length===1,'Actual published opposing sheet unavailable or matching room ambiguous');
  const packed=matches[0].sheets?.[board.ownSide==='p1'?'p2':'p1'];
  check(typeof packed==='string'&&packed.length>0,'Actual published opposing sheet unavailable');
  let parsed;try{parsed=published(packed);}catch{throw new Error('Actual published opposing sheet unavailable or malformed');}
  check(sheet.safeParse(parsed).success,'Actual published opposing sheet unavailable or malformed');
  return parsed;
}
export function boundedSnapshot(board,legal){
  check(['p1','p2'].includes(board?.ownSide)&&board?.sides?.length===2&&new Set(board.sides.map(side=>side.id)).size===2&&board.sides.every(side=>['p1','p2'].includes(side.id)),'Planning requires one identified native doubles board with both sides');
  const ids=new Set();
  for(const side of board.sides){
    check(Array.isArray(side.pokemon)&&side.pokemon.length<=12&&Array.isArray(side.active)&&side.active.length<=2,'Planning side exceeds bounded native party/active state');
    for(const pokemon of side.pokemon){check(typeof pokemon.id==='string'&&pokemon.id.length<=200&&!ids.has(pokemon.id),'Planning identities must be unique and bounded');ids.add(pokemon.id);check(!pokemon.moves||Array.isArray(pokemon.moves)&&pokemon.moves.length<=24,'Planning move history exceeds bounded snapshot');}
  }
  check(!legal?.active||Array.isArray(legal.active)&&legal.active.length<=2&&legal.active.every(value=>value===null||Array.isArray(value.moves)&&value.moves.length<=24),'Planning legality exceeds bounded doubles move state');
  const lines=board.recentEvents?.lines;
  check(!lines||Array.isArray(lines)&&lines.length<=80&&lines.every(line=>typeof line==='string'&&line.length<=4000),'Planning event history exceeds bounded snapshot; use the compact board');
}
export async function resolvePlanningSource(request,{workspace,call=callLocalSession,loadTeam=loadMetricsTeam,deadline=Date.now()+3500}={}){
  const input=planningSourceSchema.parse(request);
  check(Buffer.byteLength(JSON.stringify(input))<=512*1024,'Planning input exceeds bounded snapshot size');
  if(input.kind==='explicit'){
    boundedSnapshot(input.board,input.legalActions);
    const ownTeam=parseTeam(input.ownTeam),boardHash=boardDigest(input.board,input.legalActions);
    return {board:input.board,legalActions:input.legalActions,ownTeam,opponentSheet:input.opponentSheet,
      // Internal cache ownership only; an explicit hypothetical export has not
      // been registered as a saved report or authorized as a live roster.
      cacheTeamId:createHash('sha256').update(Teams.pack(ownTeam)).digest('hex'),
      source:{kind:'explicit-hypothetical-snapshot',label:input.label,boardHash,opposingSheetSha256:digest(input.opponentSheet),liveFreshness:false},revalidate:async()=>true};
  }
  const descriptor=join(workspace,'cache','showdown-session.json');
  const bounded=async(task,label,cap)=>{const remaining=Math.min(cap,deadline-Date.now());check(remaining>0,'Planning source deadline expired');let timer;const controller=new AbortController();try{return await Promise.race([Promise.resolve().then(()=>task({timeoutMs:remaining,signal:controller.signal})),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error(label));},remaining);})]);}finally{clearTimeout(timer);}};
  const read=async op=>unwrap(await bounded(options=>call(descriptor,{id:randomUUID(),op},options),'Bounded planning source read expired',750));
  // These reads have independent inputs. Await all settlements so a rejected
  // identity/read cannot leave an unobserved rejection from another branch.
  const acquired=await Promise.allSettled([
    read('turn-status'),read('status'),
    bounded(()=>loadTeam({workspace,teamId:input.teamId}),'Bounded planning locked-team read expired',Math.max(1,deadline-Date.now()-750)),
  ]);
  for(const result of acquired)if(result.status==='rejected')throw result.reason;
  const [observed,full,own]=acquired.map(result=>result.value),{action,board}=boundAction(observed,input);
  boundedSnapshot(board,action.legalActions);
  check(full.sessionId===input.sessionId&&full.teamSha256===input.teamId,'Planning sheet source identity changed');
  const opponentSheet=observedPlanningSheet(board,full,input.room),originalUsesFullStatus=boardSheet(board)==null;
  check(own.teamId===input.teamId,'Planning locked team fingerprint changed');
  const boardHash=boardDigest(board,action.legalActions),source={kind:'bound-observed-turn',sessionId:input.sessionId,teamId:input.teamId,room:input.room,rqid:input.rqid,boardHash,opposingSheetSha256:digest(opponentSheet),observedAt:observed.observedAt??null,liveFreshness:'read-and-revalidated-only'};
  source.requestDigest=requestDigest({...input,boardHash});
  // Private converter input only: retain actual observations and sheet facts,
  // never reconstruct unknown investments, history or selected reserves here.
  let canonicalSheetSha256;
  try{canonicalSheetSha256=publishedSheetDigest(opponentSheet);}catch{}
  if(canonicalSheetSha256)source.publishedOpposingSheetSha256=canonicalSheetSha256;
  const observedPositionInput={teamText:Teams.export(own.team),opposingSheet:structuredClone(opponentSheet),
    observed:{sessionId:observed.sessionId,teamSha256:full.teamSha256,
      ...(observed.revision!==undefined?{revision:observed.revision}:{}),...(observed.observedAt!==undefined?{observedAt:observed.observedAt}:{}),
      actions:[structuredClone(action)],boards:[structuredClone(board)],opponentSheets:{[board.ownSide==='p1'?'p2':'p1']:structuredClone(opponentSheet)}},
    expected:{teamId:input.teamId,room:input.room,rqid:input.rqid,token:input.token,...(canonicalSheetSha256?{opposingSheetSha256:canonicalSheetSha256}:{})}};
  const pending=observed.controlPolicy?.pending?.find(value=>value.token===input.token);
  return {board,legalActions:action.legalActions,ownTeam:own.team,opponentSheet,source,cacheTeamId:input.teamId,
    observedPositionInput,observedPositionSheetBinding:{status:canonicalSheetSha256?'bound':'unavailable',
      ...(canonicalSheetSha256?{opposingSheetSha256:canonicalSheetSha256}:{reason:'Actual published sheet lacks fields required by the authoritative observed-position schema; no facts or digest were supplied.'})},
    planningCutoffAt:Number.isFinite(pending?.cutoffAt)?pending.cutoffAt:null,
    revalidate:async()=>{try{
      const fresh=await read('turn-status'),bound=boundAction(fresh,input);
      if(boardDigest(bound.board,bound.action.legalActions)!==boardHash)return false;
      let freshFull;
      if(originalUsesFullStatus||boardSheet(bound.board)==null){
        freshFull=await read('status');
        check(freshFull.sessionId===input.sessionId&&freshFull.teamSha256===input.teamId,'Planning sheet source identity changed');
      }
      return digest(observedPlanningSheet(bound.board,freshFull,input.room))===source.opposingSheetSha256;
    }catch{return false;}}};
}
