import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {compactTurnBoard} from '../showdown/turn-board.mjs';
import {validateChoice, replacementOptions, legalReplacementPairs} from '../showdown/choice-validation.mjs';
import {buildTurnFacts} from '../planning/board.mjs';
import {buildRecipientEffects} from '../planning/recipient-effects.mjs';
import {boardDigest, requestDigest, digest} from '../planning/identity.mjs';
import {compactContextPayload} from './context-compaction.mjs';
import {MAX_CONTEXT_BYTES} from './context-limits.mjs';
import {retainPreviousGameSummary} from './game-summary.mjs';
import {loadMaintainedMatchupGuidance,verifyMatchupGuidance} from './matchup-guidance.mjs';

const {Teams,Dex} = createRequire(import.meta.url)('pokemon-showdown');
const orderDex=Dex.forFormat('gen9championsvgc2026regmc');
const POLICY = readFileSync(new URL('./live-policy.txt', import.meta.url), 'utf8').trim();
export const ISOLATED_POLICY_SOURCE = Object.freeze({
  policyVersion:'matchup-skill-runner-protocol.v2',
  skillVersion:'2026-11-01.123',
  skillSha256:'0ea8f3c0772bc0813f67000881c142c5df8b315f2af13997329698c99bbc05cf',
  policySha256:'9a8848539cecf11a0b728e4beccdc79333a59b3ca32f385cb04460c6e09a650a',
});
// Exact same length-prefixed complete-folder hashing as the maintained sync tool.
// Freshness is verified at use; a version label alone never adopts new guidance.
export function verifyIsolatedPolicySource({skillVersion=ISOLATED_POLICY_SOURCE.skillVersion,skillSha256=ISOLATED_POLICY_SOURCE.skillSha256} = {}) {
  check(skillVersion === ISOLATED_POLICY_SOURCE.skillVersion && skillSha256 === ISOLATED_POLICY_SOURCE.skillSha256, 'Guidance source differs from the reviewed pinned skill; review and refresh before use');
  const root = fileURLToPath(new URL('../skills/champions-mc-matchups/',import.meta.url)), entries = [];
  const visit = (directory,prefix='') => {
    for (const name of readdirSync(directory).sort()) {
      const relative=prefix ? `${prefix}/${name}` : name, absolute=join(directory,name), stat=lstatSync(absolute);
      check(!stat.isSymbolicLink(),'Policy source cannot contain symlinks or junctions');
      if(stat.isDirectory()){entries.push([relative,'directory','']);visit(absolute,relative);}
      else {check(stat.isFile(),'Policy source must contain regular files only');entries.push([relative,'file',createHash('sha256').update(readFileSync(absolute)).digest('hex')]);}
    }
  };
  visit(root);
  const sourceHash=createHash('sha256');
  for(const [relative,type,hash] of entries.sort(([left],[right]) => left < right ? -1 : left > right ? 1 : 0)) sourceHash.update(`${type}:${Buffer.byteLength(relative)}:${relative}:${hash}\n`);
  const actualSha256=sourceHash.digest('hex');
  const main=readFileSync(join(root,'SKILL.md'),'utf8'), actualVersion=/Cycle revision:\s*\*\*([^*]+)\*\*/u.exec(main)?.[1];
  check(actualVersion === ISOLATED_POLICY_SOURCE.skillVersion && actualSha256 === ISOLATED_POLICY_SOURCE.skillSha256, 'Maintained skill changed after guidance review; refresh and validate delivery before use');
  check(createHash('sha256').update(POLICY).digest('hex') === ISOLATED_POLICY_SOURCE.policySha256, 'Loaded runner protocol differs from its reviewed hash');
  check(createHash('sha256').update(readFileSync(new URL('./live-policy.txt',import.meta.url),'utf8').trim()).digest('hex') === ISOLATED_POLICY_SOURCE.policySha256, 'Runner protocol changed after module load; use a fresh verified runtime');
  return {...ISOLATED_POLICY_SOURCE,actualSha256,files:entries.filter(([,type]) => type === 'file').length,verified:true};
}
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
const check = (ok, message) => { if (!ok) throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unwrap = value => value?.result ?? value;
const privateKey = /(?:token|credential|password|secret|assertion|readreceipt|controllease|watchurl|accessurl|authorization|apikey|conversation|transcript|rehearsal|codinglog)/iu;
const cleanText = (value, length = 240) => String(value ?? '')
  .replace(/https?:\/\/[^\s<>"']+/giu, '[redacted-url]')
  .replace(/(?:battle|game-bestof3)-[a-z0-9-]+-[a-z0-9]+pw\b/giu, '[private-room]')
  .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}\b/gu, '[redacted-secret]')
  .replace(/\b(?:password|api[_ -]?key|control[_ -]?lease|read[_ -]?receipt|assertion|credential)\s*[:=]\s*[^\s,;]+/giu, '[redacted-secret]')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').slice(0, length);
function sanitize(value, depth = 0) {
  if (depth > 18) return '[omitted-depth]';
  if (typeof value === 'string') return cleanText(value, 2000);
  if (Array.isArray(value)) return value.map(item => sanitize(item, depth + 1));
  if (object(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !privateKey.test(key)).map(([key, item]) => [key, sanitize(item, depth + 1)]));
  return value;
}
const idList = values => [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string').map(value => cleanText(value, 100)))].slice(0, 6);
const shortIntent = value => ({objective:cleanText(value?.objective), preserveIds:idList(value?.preserveIds), nextCondition:cleanText(value?.nextCondition)});
const positionClaim = value => {
  if (!object(value) || bytes(value)>4096) return null;
  // Carry the route and next action, not the just-rejected comparison again.
  // Full authored plans stay in the decision trace; current battle facts are
  // never compacted here. Preview and turn claims have separate jobs.
  const allowed=Array.isArray(value.roles)
    ? ['mode','finish','roles','selectedOrder','leads','backs','claimScope']
    : ['payoff','nextBoard','continuation','resources','claimScope'];
  return sanitize(Object.fromEntries(allowed.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]])));
};
const uniqueTail = (values, limit) => [...new Map(values.map(value => [JSON.stringify(value), value])).values()].slice(-limit);
// Room identity is internal bookkeeping, not prose. Preserve the public ID
// before sanitizing away its access suffix so the next turn can match it.
const memoryRoomId=value=>{
  const match=typeof value==='string'&&/^((?:battle|game-bestof3)-[a-z0-9-]+-\d+)(?:-[a-z0-9]+pw)?$/iu.exec(value);
  return match?match[1].toLowerCase():cleanText(value,160);
};

/** Bounded event observations are facts; an authored plan is only a claim. */
export function updateStrategicMemory(previous = {}, decision, observation = {}) {
  const sameTeam = !previous.teamId || !observation.teamId || previous.teamId === observation.teamId;
  const prior = sameTeam ? previous : {};
  const sameSet = !prior.parentId || !observation.parentId || memoryRoomId(prior.parentId) === memoryRoomId(observation.parentId);
  const sameGame = sameSet && (!prior.gameId || !observation.gameId || memoryRoomId(prior.gameId) === memoryRoomId(observation.gameId));
  const rows = (values, limit, length = 480) => (Array.isArray(values) ? values : []).slice(-limit).map(value => typeof value === 'string' ? cleanText(value, length) : sanitize(value));
  const facts = {
    observedOrderConstraints: uniqueTail([...(sameSet ? rows(prior.facts?.observedOrderConstraints, 6) : []), ...rows(observation.observedOrderConstraints, 6)], 6),
    confirmedReveals: uniqueTail([...(sameGame ? rows(prior.facts?.confirmedReveals, 10) : []), ...rows(observation.confirmedReveals, 10)], 10),
    recentEvents: uniqueTail([...(sameGame ? rows(prior.facts?.recentEvents, 8) : []), ...rows(observation.events, 8)], 8),
  };
  const previousGameSummary=sameTeam&&sameSet?retainPreviousGameSummary(
    Object.hasOwn(observation,'previousGameSummary')?observation.previousGameSummary:prior.facts?.previousGameSummary,
    {teamId:observation.teamId??prior.teamId,parentId:observation.parentId??prior.parentId,currentGameId:observation.gameId??prior.gameId}):null;
  if(previousGameSummary)facts.previousGameSummary=previousGameSummary;
  const selectionPlan=positionClaim(observation.positionPlan?.roles ? observation.positionPlan : sameGame ? prior.claims?.selectionPlan : null);
  const nextPosition=observation.positionPlan?.roles ? null : positionClaim(observation.positionPlan ?? (sameGame ? prior.claims?.positionPlan : null));
  const memory = {
    version:1,
    teamId:cleanText(observation.teamId ?? prior.teamId, 100),
    parentId:memoryRoomId(observation.parentId ?? prior.parentId),
    gameId:memoryRoomId(observation.gameId ?? prior.gameId),
    facts,
    claims:{
      currentPlan:shortIntent(decision?.planUpdate ?? (sameGame ? prior.claims?.currentPlan : {})),
      ...(selectionPlan ? {selectionPlan} : {}),
      ...(nextPosition ? {positionPlan:nextPosition} : {}),
      lastGameAdaptations:sameSet ? uniqueTail([...rows(prior.claims?.lastGameAdaptations, 3, 360), ...rows(observation.lastGameAdaptations, 3, 360)].map(row => typeof row === 'string' ? row : cleanText(JSON.stringify(row), 360)), 3) : [],
    },
    limits:'Observed order retains original conditions and possible ties. Plans/adaptations are agent claims; no remembered action is a current choice.',
  };
  // A single external event object cannot smuggle an entire prior conversation.
  for (const key of ['observedOrderConstraints','confirmedReveals','recentEvents']) memory.facts[key] = memory.facts[key].map(row => {
    if (bytes(row) <= 800) return row;
    return {summary:cleanText(typeof row === 'string' ? row : JSON.stringify(row), 480), detailOmitted:true};
  });
  return memory;
}

function contextParts(rawState) {
  const state = unwrap(rawState);
  check(object(state), 'A fresh battle snapshot is required');
  check(!state.stopped && state.connected !== false && state.authenticated !== false, 'Battle connection is unavailable');
  const actions = (state.actions || []).filter(action => ['turn','preview','switch','replacement'].includes(action.kind));
  check(actions.length === 1, 'Exactly one current battle request is required');
  const action = actions[0];
  check(action.actionable !== false && !['sent','uncertain','accepted','reserved','submitting'].includes(action.submissionStatus), 'Request already has a sent or reserved submission');
  check(typeof action.token === 'string' && action.token && typeof action.room === 'string' && Number.isInteger(action.rqid) && Number.isInteger(action.revision), 'Current request identity is incomplete');
  const pending = [...(state.controlPolicy?.pending || []), ...(state.pending || []), ...(state.timing?.requests || [])].filter(row => row.token === action.token || row.room === action.room && row.rqid === action.rqid && row.revision === action.revision);
  check(!pending.some(row => row.attempted || ['sent','uncertain','accepted','reserved','submitting','submission-reserved','sent-awaiting-server','send-uncertain'].includes(row.submissionStatus ?? row.state)), 'Request already has a reserved submission');
  const room = (state.rooms || []).find(row => row.id === action.room);
  check(room?.ended !== true, 'Battle room has ended');
  let board = (state.boards || []).find(row => row.room === action.room);
  if (!board && room?.battleState) board = compactTurnBoard(room.battleState, {request:room.request, events:room.battleLog || []});
  check(board && ['p1','p2','p3','p4'].includes(board.ownSide), 'The current board and own side are required');
  check(board.request?.rqid == null || board.request.rqid === action.rqid, 'Board request identity is stale');
  check(board.request?.wait !== true, 'Board request is waiting');
  const legal = action.legalActions;
  check(object(legal) && Array.isArray(legal.pokemon), 'Complete current legal actions are required');
  const request = {rqid:action.rqid, side:{id:board.ownSide,pokemon:structuredClone(legal.pokemon)},
    ...(legal.teamPreview ? {teamPreview:true,maxChosenTeamSize:legal.maxChosenTeamSize || 4} : {}),
    ...(Array.isArray(legal.active) ? {active:structuredClone(legal.active)} : {}),
    ...(Array.isArray(legal.forceSwitch) ? {forceSwitch:[...legal.forceSwitch]} : {})};
  check((action.kind === 'preview') === !!request.teamPreview, 'Request kind conflicts with team preview');
  check(!request.teamPreview || request.maxChosenTeamSize === 4, 'M-C preview requires exactly four selected Pokemon');
  check(request.side.pokemon.every(pokemon => typeof pokemon.ident === 'string' && pokemon.ident.split(':',1)[0].replace(/[a-z]$/u,'') === board.ownSide), 'Current party identity does not match the own side');
  return {state,action,board,request,legal,room};
}

function completeLegalOptions(request) {
  if (request.teamPreview) return {kind:'preview', orderLength:request.maxChosenTeamSize || 4,
    party:request.side.pokemon.map((pokemon, index) => ({partyIndex:index + 1, name:cleanText(pokemon.details?.split(',')[0], 100), condition:pokemon.condition ?? null})),
    constraints:['Choose four unique party indexes in lead/back order.']};
  const switches = replacementOptions(request).map(({pokemonId,name,condition,forSlots,revival}) => ({pokemonId,name,condition,forSlots,revival}));
  check(switches.every(option => option.pokemonId), 'A legal switch has an ambiguous stable identity');
  const options = [0,1].map(index => {
    const actions = [{type:'pass'}, ...switches.filter(option => option.forSlots.includes(index + 1)).map(option => ({type:'switch',pokemonId:option.pokemonId}))];
    if (!request.forceSwitch) for (const [slot,move] of (request.active?.[index]?.moves || []).entries()) {
      if (move.disabled || move.pp === 0) continue;
      const targeted = ['normal','any','adjacentAlly','adjacentAllyOrSelf','adjacentFoe'].includes(move.target);
      const targets = targeted ? [-2,-1,1,2] : [undefined];
      for (const target of targets) for (const mega of request.active?.[index]?.canMegaEvo ? [false,true] : [false]) actions.push({type:'move',slot:slot + 1,...(target === undefined ? {} : {target}),mega});
    }
    return actions;
  });
  const viable = [new Set(), new Set()];
  for (const first of options[0]) for (const second of options[1]) {
    try {validateChoice(request, [first,second]); viable[0].add(JSON.stringify(first)); viable[1].add(JSON.stringify(second));} catch { /* Native legality excludes this combination. */ }
  }
  check(viable.every(set => set.size), 'The request has no complete legal doubles choice');
  const slots = options.map((choices,index) => ({activeSlot:index + 1,
    requestFlags:Object.fromEntries(['trapped','maybeTrapped'].map(key => [key,{present:Object.hasOwn(request.active?.[index] ?? {},key),value:request.active?.[index]?.[key] ?? null}])),
    options:choices.filter(action => viable[index].has(JSON.stringify(action))).map(action => action.type === 'move' ? {...action,move:request.active[index].moves[action.slot - 1].move ?? request.active[index].moves[action.slot - 1].id} : action)}));
  const replacementPairs = request.forceSwitch ? legalReplacementPairs(request).map(pair => pair.map(action => action.type === 'switch' ? {type:'switch',pokemonId:replacementOptions(request).find(option => option.slot === action.slot)?.pokemonId} : action)) : undefined;
  return {kind:request.forceSwitch ? 'replacement' : 'turn', slots, switches,
    ...(replacementPairs ? {replacementPairs} : {}),
    targetConvention:'Positive 1/2 = opposing slots; negative -1/-2 = own slots.',
    constraints:['Return both slots in order. At most one Mega. No duplicate switch recipient. Native fresh validation checks the full pair.',
      'Request flags retain presence; absent/null is unknown. maybeTrapped makes an offered switch provisional: hidden trapping can reject it. A switch selector proves neither escape nor a counter reset.']};
}

/** Native facts only: no Speed formula, calculated ranking or chosen actions. */
function moveOrderFacts(facts,legalActions){
  const active=facts.actors.filter(actor=>actor.slot!==null&&actor.slot!==undefined&&actor.raw?.fainted!==true&&actor.selected==='selected');
  return {
    basis:'Native base move priority and current own server-request Speed stats; no effective-Speed calculation or complete action-order prediction.',
    actors:active.map(actor=>{
      const menu=actor.own?legalActions.active?.[actor.slot-1]?.moves:null;
      const names=menu?menu.filter(move=>!move.disabled&&move.pp!==0).map(move=>move.move??move.id):actor.moves;
      const uniqueNames=[...new Set(names)];
      const moves=uniqueNames.map(name=>{const data=orderDex.moves.get(name);return [name,data.exists?data.priority:null];});
      const moveTargets=uniqueNames.map(name=>{
        const data=orderDex.moves.get(name),current=menu?.find(move=>(move.move??move.id)===name);
        return [name,data.exists?data.target:null,current?.target??null];
      });
      const index=actor.raw?.requestIndex,request=actor.own&&Number.isInteger(index)?legalActions.pokemon?.[index-1]:null;
      const speed=request?.stats?.spe;
      return {actorId:actor.id,movePriorities:moves,moveTargets,moveSource:menu?'current-clickable-menu':'known-or-published-moves',
        ...(Number.isSafeInteger(speed)&&speed>0?{reportedSpeed:{value:speed,source:'current-own-server-request',atTurn:facts.turn,meaning:'Reported stat; item, boosts, status, abilities, priority and field ordering have not been applied.'}}:{})};
    }),
    targetColumns:['move','nativeBaseTarget','currentOwnMenuTarget'],
    targetMeaning:'Base targets are mechanics metadata, not an opposing clickable menu. Own menu targets take precedence for command selection; form or field effects can change recipients. Do not add chosen targets to spread/self/field moves. Native validation remains authoritative.',
    observedRelationsRef:'observedOrderConstraints',fieldRef:'board.field and board.sides[].conditions',
    uncertainty:'Priority-changing effects are not applied to base priorities. Opposing Speed remains unknown unless separately checked. Numerical order uses calculate_speed within the shared budget; observed ties and reuse warnings remain in force.',
  };
}

const strictObject = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const string = maxLength => ({type:'string',maxLength});
const textList = (maxItems,maxLength) => ({type:'array',maxItems,items:{type:'string',minLength:1,maxLength}});
const literal = value => ({type:typeof value,const:value});
function decisionSchema(request) {
  const move = strictObject({type:literal('move'),slot:{type:'integer',minimum:1,maximum:4},target:{type:'integer',enum:[-2,-1,1,2]},mega:{type:'boolean'}});
  const untargeted = strictObject({type:literal('move'),slot:{type:'integer',minimum:1,maximum:4},mega:{type:'boolean'}});
  const switching = strictObject({type:literal('switch'),pokemonId:string(80)});
  const passing = strictObject({type:literal('pass')});
  const count = request.teamPreview ? 1 : 2;
  return strictObject({
    actions:{type:'array',minItems:count,maxItems:count,items:request.teamPreview ? strictObject({type:literal('team'),order:{type:'array',items:{type:'integer',minimum:1,maximum:request.side.pokemon.length},minItems:4,maxItems:4}}) : {anyOf:request.forceSwitch ? [switching,passing] : [move,untargeted,switching,passing]}},
    planUpdate:strictObject({objective:{type:'string',minLength:1,maxLength:180},preserveIds:textList(6,80),nextCondition:string(180)}),
    reason:string(500),
  });
}

function validateSchema(value, schema, path = 'decision') {
  if (schema.anyOf) {check(schema.anyOf.some(variant => {try {validateSchema(value,variant,path); return true;} catch {return false;}}), `${path} does not match a permitted action shape`); return;}
  if (Object.hasOwn(schema,'const')) check(value === schema.const, `${path} has an invalid literal`);
  if (schema.enum) check(schema.enum.includes(value), `${path} has an invalid value`);
  if (schema.type === 'object') {
    check(object(value), `${path} must be an object`);
    check(Object.keys(value).every(key => Object.hasOwn(schema.properties,key)) && schema.required.every(key => Object.hasOwn(value,key)), `${path} contains unknown or missing fields`);
    for (const [key, child] of Object.entries(schema.properties)) validateSchema(value[key],child,`${path}.${key}`);
  } else if (schema.type === 'array') {
    check(Array.isArray(value) && value.length >= (schema.minItems || 0) && value.length <= (schema.maxItems ?? Infinity), `${path} has an invalid length`);
    if (schema.uniqueItems) check(new Set(value.map(item => JSON.stringify(item))).size === value.length, `${path} requires unique entries`);
    value.forEach((item,index) => validateSchema(item,schema.items,`${path}[${index}]`));
  } else if (schema.type === 'string') check(typeof value === 'string' && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity), `${path} must be a bounded string`);
  else if (schema.type === 'integer') check(Number.isInteger(value) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity), `${path} must be a valid integer`);
  else if (schema.type === 'boolean') check(typeof value === 'boolean', `${path} must be boolean`);
  else if (schema.type === 'null') check(value === null, `${path} must be null`);
}

function makeBinding(parts, ownTeam) {
  const {state,action,board,legal,room} = parts;
  const approvedIds = [state.teamId,state.teamSha256,room?.teamId,state.metrics?.teamId].filter(value => typeof value === 'string' && value);
  check(new Set(approvedIds).size <= 1, 'Approved team identity sources conflict');
  const teamId = approvedIds[0] ?? createHash('sha256').update(Teams.pack(ownTeam)).digest('hex');
  check(typeof state.sessionId === 'string' && state.sessionId && typeof teamId === 'string' && teamId, 'Session and team identity are required');
  const binding = {sessionId:state.sessionId,teamId,room:action.room,parentId:action.parentId ?? room?.parentId ?? null,rqid:action.rqid,revision:action.revision,kind:action.kind,token:action.token,boardHash:boardDigest(board,legal),legalHash:digest(legal)};
  return {...binding,requestDigest:requestDigest(binding)};
}

/** Host-only source projection. No facts are discarded to meet a model budget. */
export function buildDecisionContextSource({state,ownTeamText,opponentSheet,strategicMemory,skillVersion,skillSha256,matchupGuidance,includeMatchupSkill=false,now = Date.now} = {}) {
  check(typeof skillVersion === 'string' && skillVersion.length <= 100 && typeof skillSha256 === 'string' && /^[a-f0-9]{64}$/u.test(skillSha256), 'Versioned skill policy fingerprint is required');
  check(typeof ownTeamText === 'string' && bytes(ownTeamText) <= 16000, 'A bounded approved own team export is required');
  const policySource=verifyIsolatedPolicySource({skillVersion,skillSha256});
  const skill=includeMatchupSkill?verifyMatchupGuidance(matchupGuidance ?? loadMaintainedMatchupGuidance({skillVersion,skillSha256}),{skillVersion,skillSha256}):null;
  const instructions=POLICY;
  const ownTeam = Teams.import(ownTeamText);
  check(Array.isArray(ownTeam) && ownTeam.length > 0 && ownTeam.length <= 6, 'Own team export could not be parsed');
  const parts = contextParts(state), {board,action,request,legal} = parts;
  const binding = makeBinding(parts,ownTeam);
  const rawSheet = opponentSheet ?? Object.values(board.opponentSheets || {})[0] ?? [];
  check(Array.isArray(rawSheet) && rawSheet.length <= 6, 'Opponent sheet must contain at most six registered sets');
  const setFields = ['species','item','ability','moves','nature','level','gender','shiny','statPoints','evs','ivs'];
  const sheet = sanitize(rawSheet.map(set => Object.fromEntries(setFields.filter(key => Object.hasOwn(set || {},key)).map(key => [key,set[key]]))));
  const memory = updateStrategicMemory(strategicMemory,undefined,{teamId:binding.teamId,parentId:binding.parentId,gameId:action.room});
  const facts = buildTurnFacts({board,legalActions:legal,ownTeam,opponentSheet:sheet,objective:memory.claims.currentPlan});
  const legalOptions = sanitize(completeLegalOptions(request));
  const recipientEffects = buildRecipientEffects(facts);
  delete recipientEffects.source;
  const payload = sanitize({
    format:'gen9championsvgc2026regmc',kind:legalOptions.kind,
    guidance:{version:skillVersion,sha256:skillSha256,policyVersion:policySource.policyVersion,policySha256:policySource.policySha256,delivery:skill?'complete-inline-skill':'host-only-source'},
    board:{turn:board.turn,ownSide:board.ownSide,field:board.field,sides:(board.sides || []).map(side => ({id:side.id,selectedTeamSize:side.selectedTeamSize,selectionKnowledge:side.selectionKnowledge,unrevealedSelected:side.unrevealedSelected,active:side.active,reserves:side.reserves,conditions:side.conditions}))},
    actors:facts.actors.map(({raw,pp,lifecycle,capabilities,...actor}) => ({...actor,fainted:raw?.fainted ?? null,abilitySuppressed:raw?.abilitySuppressed ?? null,itemHistory:raw?.itemHistory ?? null,mega:raw?.mega ?? null,requestIndex:raw?.requestIndex ?? null,capabilities})),
    ownTeam,opponentSheet:sheet,opponentSheetStatus:{registeredCount:sheet.length,completeRegisteredSix:sheet.length === 6,selectionUnknown:true,investmentsUnknownUnlessExplicit:true},
    legalOptions,recipientEffects,resources:facts.resources,
    observedOrderConstraints:facts.observedOrderConstraints.slice(0,6),moveOrder:moveOrderFacts(facts,legal),
    recentEvents:board.recentEvents?.lines?.slice(-12) || [],
    strategicMemory:{version:memory.version,facts:memory.facts,claims:memory.claims,limits:memory.limits},
    uncertainty:'Published six do not establish selected opposing reserves or unknown investments. No state, item, field duration or calculation was fabricated.',
  });
  // Maintained guidance is trusted source, not battle prose. Do not run it
  // through battle-text shortening/redaction: its exact file hashes must survive.
  if(skill)payload.matchupSkill=skill;
  const schema = decisionSchema(request), input = JSON.stringify(payload), at = typeof now === 'function' ? now() : now;
  check(Number.isFinite(at), 'A finite context observation time is required');
  const metadata={version:2,policyVersion:policySource.policyVersion,policySha256:policySource.policySha256,sourceVerified:true,sourceOnly:true,modelReady:false,createdAt:at,
    inputBytes:bytes(input),instructionBytes:bytes(instructions),schemaBytes:bytes(schema),totalBytes:bytes(input)+bytes(instructions)+bytes(schema),sha256:digest(payload),omitted:[],historyIncluded:false,
    skillDelivery:skill?'complete-inline-skill':'host-only-source',skillFiles:skill?.files.length??0,skillContentBytes:skill?.files.reduce((total,file)=>total+bytes(file.content),0)??0};
  // This is a host preparation ceiling, separate from the model prompt budget.
  // Bounded compaction can handle sources larger than the old 96 KB model cap.
  if(bytes(input)>MAX_CONTEXT_BYTES){const error=new Error('Current context source exceeds the bounded preparation ceiling');error.code='ISOLATED_CONTEXT_OVERFLOW';error.promptMetadata={...metadata,sourcePreparationLimitBytes:MAX_CONTEXT_BYTES,reason:'source-preparation-limit',legalOptionsPreserved:true,criticalFactsPreserved:true};throw error;}
  return {input,instructions,schema,binding,legalOptions,promptMetadata:metadata,matchupGuidance:skill};
}

/** Budget the complete source before a model call; only archived history is optional. */
export function buildDecisionContext(args = {}) {
  const maxBytes=args.maxBytes??MAX_CONTEXT_BYTES;
  check(Number.isSafeInteger(maxBytes)&&maxBytes>=4000&&maxBytes<=MAX_CONTEXT_BYTES,'Context byte limit must be 4000-8388608');
  const source=buildDecisionContextSource({...args,includeMatchupSkill:true});
  return rebudgetDecisionContext({...source,sourcePayload:JSON.parse(source.input)},{maxBytes});
}

/** Host-added contracts use the same protected-source budget and disclosure. */
export function rebudgetDecisionContext(context,{payload=context.sourcePayload,instructions=context.instructions,maxBytes=context.promptMetadata?.maxBytes??MAX_CONTEXT_BYTES}={}) {
  check(Number.isSafeInteger(maxBytes)&&maxBytes>=4000&&maxBytes<=MAX_CONTEXT_BYTES,'Context byte limit must be 4000-8388608');
  check(object(payload),'Complete normalized context source is required');
  payload={...payload,matchupSkill:verifyMatchupGuidance(payload.matchupSkill,ISOLATED_POLICY_SOURCE)};
  check(payload.guidance?.version===ISOLATED_POLICY_SOURCE.skillVersion&&payload.guidance?.sha256===ISOLATED_POLICY_SOURCE.skillSha256,'Model guidance metadata differs from the complete supplied skill');
  const compacted=compactContextPayload(payload,{maxBytes,targetBytes:maxBytes,instructionBytes:bytes(instructions),schemaBytes:bytes(context.schema)});
  const input=JSON.stringify(compacted.payload),promptMetadata={...context.promptMetadata,...compacted.metadata,
    sourceOnly:false,modelReady:compacted.fits,inputBytes:bytes(input),instructionBytes:bytes(instructions),schemaBytes:bytes(context.schema),totalBytes:bytes(input)+bytes(instructions)+bytes(context.schema),
    sha256:digest(compacted.payload),omitted:compacted.metadata.omittedHistory.map(row=>row.path),legalOptionsPreserved:true,criticalFactsPreserved:true,
    fullContextLossless:compacted.metadata.lossless,historyPruned:compacted.metadata.omittedHistory.length>0,currentEvidenceLossless:true};
  if(!compacted.fits){const error=new Error('Protected current facts and complete legality exceed the context byte limit after bounded compaction');error.code='ISOLATED_CONTEXT_OVERFLOW';error.promptMetadata=promptMetadata;throw error;}
  return {...context,instructions,input,sourcePayload:structuredClone(payload),promptMetadata};
}

function canonicalActions(request,actions) {
  return validateChoice(request,actions.map(action => action.type === 'move' && !action.mega ? Object.fromEntries(Object.entries(action).filter(([key]) => key !== 'mega')) : action));
}

/** JSON shape and current native request legality are independently enforced. */
export function validateIsolatedDecision(decision,{state,binding,ownTeamText,maxDecisionBytes = 80000} = {}) {
  check(object(binding) && bytes(binding) <= 3000, 'A bounded host request binding is required');
  const parsed = typeof decision === 'string' ? JSON.parse(decision) : decision;
  check(bytes(parsed) <= maxDecisionBytes, 'Decision metadata exceeds its byte limit');
  const parts = contextParts(state);
  const current = makeBinding(parts,typeof ownTeamText === 'string' ? Teams.import(ownTeamText) || [] : []);
  for (const key of ['sessionId','teamId','room','parentId','rqid','revision','kind','token','boardHash','legalHash','requestDigest']) check(binding[key] === current[key], `Stale or mismatched ${key} binding; obtain a fresh decision`);
  validateSchema(parsed,decisionSchema(parts.request));
  check(bytes(parsed.planUpdate)+bytes(parsed.reason)<=6000,'Decision plan metadata exceeds its byte limit');
  const selected=canonicalActions(parts.request,parsed.actions);
  return {...structuredClone(parsed),actions:selected.actions,choice:selected.choice,validationScope:'fresh-native-choice-legality-only',materialEvidenceVerified:false};
}
