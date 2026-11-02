import {createHash} from 'node:crypto';
import PS from 'pokemon-showdown';
import {planningNumericCacheGeneration} from './numeric-cache.mjs';
import {digest as contextDigest} from './identity.mjs';

const {Dex} = PS.default || PS;
const dex = Dex.forFormat('gen9championsvgc2026regmc');
const STATS = ['hp','atk','def','spa','spd','spe'];
const id = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g,'');
const copy = value => structuredClone(value);
const has = (value,key) => Object.prototype.hasOwnProperty.call(value || {},key);
const canonical = value => value === undefined ? null : Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const live = actor => actor.raw?.fainted !== true && actor.hp?.current !== 0;
const active = actor => Number.isInteger(actor.slot) && actor.slot >= 1 && actor.slot <= 2 && live(actor);
const exactHP = hp => Number.isInteger(hp?.current) && hp.current > 0 &&
  ['server-own-exact','exact','actual','scenario-actual'].includes(hp.precision);
const weatherNames = {sunnyday:'Sun',sun:'Sun',raindance:'Rain',rain:'Rain',sandstorm:'Sand',sand:'Sand',
  snow:'Snow',snowscape:'Snow',hail:'Snow',desolateland:'Harsh Sunshine',harshsunshine:'Harsh Sunshine',primordialsea:'Heavy Rain',heavyrain:'Heavy Rain',deltastream:'Strong Winds',strongwinds:'Strong Winds'};
const terrainNames = {electricterrain:'Electric',electric:'Electric',grassyterrain:'Grassy',grassy:'Grassy',mistyterrain:'Misty',misty:'Misty',psychicterrain:'Psychic',psychic:'Psychic'};
const condition = (conditions,key) => Boolean(conditions?.[key]);
const sideOf = (ctx,actor) => (ctx.sides || []).find(side=>side.id===actor.side);
function fieldValue(value,names,label,warnings){
  if(value===null||value===undefined||value==='')return '';
  const object=value&&typeof value==='object'&&!Array.isArray(value),raw=object?(has(value,'id')?value.id:value.name):value;
  if(typeof raw!=='string'){warnings.push(`Unsupported ${label} descriptor: expected a canonical string, id or name`);return '';}
  const resolved=names[id(raw)];
  if(!resolved){warnings.push(`Unsupported ${label} ${raw||'(empty descriptor)'}`);return '';}
  if(object&&has(value,'id')&&typeof value.name==='string'){
    const named=names[id(value.name)];
    if(named&&named!==resolved)warnings.push(`Conflicting ${label} id/name descriptor`);
  }
  return resolved;
}
const hpAttackMoves = new Set(['eruption','waterspout','dragonenergy','flail','reversal','endeavor','finalgambit']);
const hpDefenseMoves = new Set(['brine','crushgrip','wringout','hardpress','endeavor','superfang','naturesmadness','ruination']);
const unresolvedPowerMoves = new Set(['ragefist','furycutter','rollout','iceball','trumpcard','assurance','retaliate','payback','revenge','avalanche','pursuit','lashout','boltbeak','fishiousrend','ficklebeam','present','magnitude','naturalgift']);
const hpAbilities = new Set(['multiscale','shadowshield','defeatist','torrent','blaze','overgrow','swarm','schooling','shieldsdown','powerconstruct','zenmode']);
const conditionalAbilities = new Map([['unburden','unburdenActive'],['slowstart','slowStartActive'],['protosynthesis','boosterEnergyActive'],['quarkdrive','boosterEnergyActive']]);
const damageConditional = new Set(['flashfire','electromorphosis','plus','minus','stakeout','slowstart','protean','libero']);
const speedVolatiles = new Set(['unburden','slowstart','protosynthesis','quarkdrive','gastroacid','embargo']);
const damageVolatiles = new Map([['helpinghand','isHelpingHand'],['charge','isCharge'],['foresight','isForesight'],['protect','isProtected'],['leechseed','isSeeded']]);

function currentField(ctx,scenario) {
  const field = ctx.field || {}, conditions = field.conditions || {}, override = scenario.field || {};
  const warnings = [];
  if(!ctx.field || typeof ctx.field!=='object' || !has(field,'weather') || !has(field,'terrain') || !field.conditions || typeof field.conditions!=='object')warnings.push('Current weather, terrain or field-condition state is missing');
  const weather=fieldValue(has(override,'weather')?override.weather:field.weather,weatherNames,'weather',warnings);
  const terrain=fieldValue(has(override,'terrain')?override.terrain:field.terrain,terrainNames,'terrain',warnings);
  const fieldActors = (ctx.actors || []).filter(active).map(actor=>({...actor,...scenario.pokemon?.[actor.id]}));
  const weatherSuppressed = fieldActors.some(actor=>['cloudnine','airlock'].includes(id(actor.ability)) && actor.raw?.abilitySuppressed!==true);
  if(fieldActors.some(actor=>!actor.ability))warnings.push('An active ability is unknown; external suppression/field modifiers are unverified');
  if(fieldActors.some(actor=>id(actor.ability)==='neutralizinggas' && actor.raw?.abilitySuppressed!==true))warnings.push('Neutralizing Gas interactions are unsupported in these independent snapshots');
  for(const current of [field.weather,field.terrain,...Object.values(conditions)]) if(current?.durationWarning)warnings.push(String(current.durationWarning));
  return {speed:{weather,terrain,trickRoom:has(override,'trickRoom')?override.trickRoom===true:condition(conditions,'trickroom'),
    magicRoom:condition(conditions,'magicroom'),weatherSuppressed},
    damage:{gameType:'Doubles',...(weather&&!weatherSuppressed?{weather}:{}),...(terrain?{terrain}:{}),
      isGravity:condition(conditions,'gravity'),isMagicRoom:condition(conditions,'magicroom'),isWonderRoom:condition(conditions,'wonderroom')},warnings};
}

function scenarioList(ctx,hypotheses,warnings) {
  const actors = new Map((ctx.actors || []).map(actor=>[actor.id,actor]));
  const scenarios = [{id:'observed',label:'Observed inputs; missing investments remain unknown',pokemon:{},assumptions:[]}];
  if(!Array.isArray(hypotheses)) {warnings.push('Hypotheses must be an array; no scenarios accepted');return scenarios;}
  if(hypotheses.length>3) warnings.push('Only the first three hypotheses are considered');
  const used = new Set(['observed']);
  for(const [index,hypothesis] of hypotheses.slice(0,3).entries()) {
    if(!hypothesis || typeof hypothesis!=='object' || Array.isArray(hypothesis)) {warnings.push(`Hypothesis ${index+1} is malformed`);continue;}
    const scenario = {...copy(hypothesis),id:String(hypothesis.id || `hypothesis-${index+1}`),label:String(hypothesis.label || `Hypothesis ${index+1}`),pokemon:hypothesis.pokemon || {},assumptions:[]};
    const conflicts = [];
    if(used.has(scenario.id)) conflicts.push('duplicate scenario id');
    if(!scenario.pokemon || typeof scenario.pokemon!=='object' || Array.isArray(scenario.pokemon)) conflicts.push('pokemon must map actor IDs to assumptions');
    for(const [actorId,patch] of Object.entries(scenario.pokemon)) {
      const actor = actors.get(actorId);
      if(!actor || !patch || typeof patch!=='object' || Array.isArray(patch)) {conflicts.push(`unknown actor or malformed assumptions: ${actorId}`);continue;}
      if(Object.keys(patch).some(key=>!['nature','statPoints','ability','item','hp'].includes(key))) conflicts.push(`${actorId}: unsupported assumption or form override`);
      for(const key of ['nature','ability']) if(has(patch,key) && actor[key] && id(patch[key])!==id(actor[key])) conflicts.push(`${actorId}: conflicts with observed ${key}`);
      if(has(patch,'item') && actor.itemKnown && id(patch.item)!==id(actor.item)) conflicts.push(`${actorId}: conflicts with observed held item`);
      if(has(patch,'statPoints') && actor.statPoints && digest(patch.statPoints)!==digest(actor.statPoints)) conflicts.push(`${actorId}: conflicts with known allocation`);
      if(has(patch,'hp') && exactHP(actor.hp)) conflicts.push(`${actorId}: cannot override observed exact HP`);
    }
    if(scenario.field && Object.keys(scenario.field).some(key=>!['weather','terrain','trickRoom'].includes(key))) conflicts.push('unsupported field hypothesis');
    if(conflicts.length) {warnings.push(`Rejected ${scenario.label}: ${conflicts.join('; ')}`);continue;}
    scenario.assumptions.push('Named scenario only; opposing allocations are neither revealed facts nor universal bounds');
    if(scenario.field) scenario.assumptions.push('Field alternative is conditional; transition and delivery have not been verified');
    used.add(scenario.id);scenarios.push(scenario);
  }
  return scenarios;
}

function snapshot(ctx,actor,scenario) {
  const patch = scenario.pokemon[actor.id] || {}, value = {...actor,...patch};
  const errors = [], assumptions = [...scenario.assumptions];
  if(!value.species || !dex.species.get(value.species).exists) errors.push('current species/form unknown or unsupported');
  for(const key of ['nature','ability']) {
    if(typeof value[key]!=='string' || !value[key].trim()) errors.push(`${key} unknown`);
    else if(!(key==='nature'?dex.natures:dex.abilities).get(value[key]).exists)errors.push(`${key} unsupported`);
  }
  if(!actor.itemKnown && !has(patch,'item')) errors.push('currently held item unknown');
  if(value.item && !dex.items.get(value.item).exists)errors.push('held item unsupported');
  if(!value.statPoints || typeof value.statPoints!=='object' || Array.isArray(value.statPoints)) errors.push('stat-point allocation unknown');
  else {
    if(!actor.own && STATS.some(stat=>!has(value.statPoints,stat))) errors.push('opposing allocation must explicitly provide all six stat points');
    const entries = Object.entries(value.statPoints);
    if(entries.some(([key,points])=>!STATS.includes(key)||!Number.isInteger(points)||points<0||points>32)||entries.reduce((sum,[,points])=>sum+Number(points),0)>66) errors.push('illegal native Champions stat-point allocation');
  }
  if(!value.boosts || typeof value.boosts!=='object' || Array.isArray(value.boosts)) errors.push('current boosts unknown');
  else if(Object.entries(value.boosts).some(([key,stage])=>!['atk','def','spa','spd','spe','accuracy','evasion'].includes(key)||!Number.isInteger(stage)||stage < -6||stage>6))errors.push('current boosts incomplete or unsupported');
  const hp = has(patch,'hp') ? typeof patch.hp==='number' ? {current:patch.hp,max:null,precision:'scenario-actual'} : {...patch.hp,precision:'scenario-actual'} : actor.hp;
  if(has(patch,'hp') && (!Number.isInteger(hp?.current)||hp.current<=0 || hp.max!==undefined&&hp.max!==null&&(!Number.isInteger(hp.max)||hp.max<hp.current)))errors.push('Scenario HP must supply positive actual HP units and a compatible maximum');
  if(has(patch,'hp')) assumptions.push(`${actor.id}: assumed actual HP; compatibility with the observed display is unverified`);
  if(Object.keys(patch).length) assumptions.push(`${actor.id}: ${Object.keys(patch).join(', ')} supplied by scenario ${scenario.id}`);
  if(!sideOf(ctx,actor)?.conditions || typeof sideOf(ctx,actor).conditions!=='object')errors.push('Current side-condition state unknown');
  const speed = {label:actor.id,species:value.species,nature:value.nature,statPoints:value.statPoints,ability:value.ability,item:value.item || '',
    boosts:Object.fromEntries(Object.entries(value.boosts || {}).filter(([key])=>STATS.includes(key))),status:value.status || '',tailwind:condition(sideOf(ctx,actor)?.conditions,'tailwind')};
  if(actor.raw?.abilitySuppressed===true) speed.abilitySuppressed=true;
  if(condition(value.volatiles,'embargo')) speed.itemSuppressed=true;
  const activationKey = conditionalAbilities.get(id(value.ability));
  if(activationKey) {
    const state = value.lifecycle?.[activationKey] ?? value.raw?.[activationKey] ?? value.volatiles?.[id(value.ability)]?.[activationKey];
    if(typeof state!=='boolean') errors.push(`${activationKey} unknown`);
    else speed[activationKey]=state;
  }
  const damage = {nature:value.nature,ability:value.ability,item:value.item || '',evs:value.statPoints,boosts:value.boosts,status:value.status || ''};
  if(exactHP(hp)) damage.curHP=hp.current;
  if(typeof value.lifecycle?.abilityOn==='boolean') damage.abilityOn=value.lifecycle.abilityOn;
  for(const key of ['boostedStat','alliesFainted']) if(value.lifecycle?.[key]!==undefined) damage[key]=value.lifecycle[key];
  return {actor,value,hp,speed,damage,errors,assumptions};
}

function priorityBrackets(snapshots) {
  const result = new Map();
  for(const snapshot of snapshots) for(const name of snapshot.actor.moves || []) {
    const move = dex.moves.get(name); if(!move.exists) continue;
    const reasons = [];
    if(move.onModifyPriority || ['prankster','galewings','triage'].includes(id(snapshot.value.ability))) reasons.push('move/ability-dependent priority requires resolution-state verification');
    const priority = reasons.length ? null : move.priority;
    const key = priority===null?'unverified':String(priority);
    if(!result.has(key)) result.set(key,{priority,actions:[],scope:'Move bracket only; does not establish delivery'});
    result.get(key).actions.push({actorId:snapshot.actor.id,move:move.name,...(reasons.length?{warnings:reasons}:{})});
  }
  return [...result.values()].sort((a,b)=>(b.priority??-Infinity)-(a.priority??-Infinity));
}

function observedConstraints(ctx) {
  return (ctx.observedOrderConstraints || ctx.resources?.observedOrderConstraints || []).slice(0,12).map(observation=>{
    const informative = observation.samePriority===true && observation.forcedOrder===false && observation.bothExecuted===true && observation.identityVerified===true;
    return {...copy(observation),numericalInference:'unverified',originalOrderInformative:informative,reusableForSpeed:informative&&observation.currentReuse===true,
      warning:informative?'Original-condition qualitative order only; a tie remains possible and current-state reuse needs verification':'Different/unknown priority, forced order, execution or identity does not establish relative Speed'};
  });
}

function sideModifiers(ctx,snapshot,snapshots) {
  const conditions = sideOf(ctx,snapshot.actor)?.conditions || {}, result = {};
  for(const [key,option] of [['reflect','isReflect'],['lightscreen','isLightScreen'],['auroraveil','isAuroraVeil'],['tailwind','isTailwind']]) result[option]=condition(conditions,key);
  for(const [key,option] of damageVolatiles) if(condition(snapshot.value.volatiles,key)) result[option]=true;
  const partner = snapshots.find(other=>other.actor.id!==snapshot.actor.id && other.actor.side===snapshot.actor.side && active(other.actor));
  if(partner && partner.actor.raw?.abilitySuppressed!==true) {
    const option = {friendguard:'isFriendGuard',battery:'isBattery',powerspot:'isPowerSpot',steelyspirit:'isSteelySpirit',flowergift:'isFlowerGift'}[id(partner.value.ability)];
    if(option) result[option]=true;
  }
  return result;
}

function damageLimits(attacker,defender,move,ctx,field,snapshots) {
  const warnings = [], errors = [...attacker.errors,...defender.errors];
  const pp=(attacker.actor.pp || []).find(entry=>id(entry.move || entry.id || entry.name)===move.id);
  if(pp && (pp.disabled===true || pp.pp===0))errors.push('Move is currently disabled or out of PP');
  if(id(attacker.value.item)==='metronome')errors.push('Metronome consecutive-use damage history is unsupported by this snapshot');
  for(const [role,snapshot] of [['attacker',attacker],['defender',defender]]) {
    if(snapshot.actor.raw?.abilitySuppressed===true || condition(snapshot.value.volatiles,'embargo')) errors.push(`${role} suppression is unsupported by this damage snapshot`);
    const unsupported = Object.keys(snapshot.value.volatiles || {}).filter(key=>!damageVolatiles.has(key));
    if(unsupported.length) errors.push(`${role} volatile state unsupported for damage: ${unsupported.join(', ')}`);
    if(damageConditional.has(id(snapshot.value.ability)) && typeof snapshot.damage.abilityOn!=='boolean') errors.push(`${role} conditional ability activation unknown`);
    if(id(snapshot.value.ability)==='download' || id(snapshot.value.ability)==='windrider' && condition(sideOf(ctx,snapshot.actor)?.conditions,'tailwind'))errors.push(`${role} damage calculator would reapply an entry/activation boost to the current snapshot`);
    if(['intimidate','intrepidsword','dauntlessshield'].includes(id(snapshot.value.ability)) && snapshot.damage.abilityOn===true)errors.push(`${role} entry ability activation cannot be reapplied to an observed current snapshot`);
    const seedTerrain={electricseed:'Electric',grassyseed:'Grassy',mistyseed:'Misty',psychicseed:'Psychic'}[id(snapshot.value.item)];
    if(seedTerrain && field.damage.terrain===seedTerrain)errors.push(`${role} terrain Seed consumption/entry boost cannot be reconstructed in a current snapshot`);
    if(hpAbilities.has(id(snapshot.value.ability)) && !exactHP(snapshot.hp)) errors.push(`${role} HP-dependent ability requires actual HP`);
    if(['protosynthesis','quarkdrive'].includes(id(snapshot.value.ability))) errors.push(`${role} activation-selected boosted stat is not verified in damage calculator`);
  }
  if(hpAttackMoves.has(move.id) && !exactHP(attacker.hp)) errors.push('HP-dependent attacker move requires actual current HP');
  if(hpDefenseMoves.has(move.id) && !exactHP(defender.hp)) errors.push('HP-dependent target move requires actual current HP');
  if(unresolvedPowerMoves.has(move.id))errors.push('Conditional/counter-dependent move power is unsupported by this snapshot contract');
  if(['electroball','gyroball'].includes(move.id) && [attacker,defender].some(snapshot=>conditionalAbilities.has(id(snapshot.value.ability))))errors.push('Speed-dependent damage with conditional ability activation is unsupported by this damage snapshot');
  if(Array.isArray(move.multihit) && id(attacker.value.ability)!=='skilllink')errors.push('Variable hit count requires an explicit supported hit scenario; default hit counts are not a bound');
  if((move.id==='lastrespects'||id(attacker.value.ability)==='supremeoverlord') && !Number.isInteger(attacker.damage.alliesFainted))errors.push('Fainted-allies damage state is unknown');
  if(!exactHP(defender.hp)) warnings.push('Defender actual HP unknown; engine uses full HP assumption, no current-HP knockout guarantee');
  if(!exactHP(attacker.hp)) warnings.push('Attacker actual HP unknown; engine uses full HP assumption');
  if(['allAdjacent','allAdjacentFoes'].includes(move.target)) {
    const recipients=(ctx.actors || []).filter(other=>active(other) && other.id!==attacker.actor.id && (move.target==='allAdjacent'||other.side!==attacker.actor.side));
    if(recipients.length<2) errors.push('Single-recipient spread damage is not supported by this calculator field contract');
    else warnings.push('Spread assumes at least two eligible recipients remain when the attack resolves');
  }
  if(id(attacker.value.ability)==='megasol') errors.push('Mega Sol effective-weather damage support is unverified');
  const fieldConditions = Object.keys(ctx.field?.conditions || {}).filter(key=>!['trickroom','magicroom','wonderroom','gravity'].includes(key));
  if(fieldConditions.length) errors.push(`Unsupported field conditions: ${fieldConditions.join(', ')}`);
  for(const snapshot of [attacker,defender]) {
    const unsupported=Object.keys(sideOf(ctx,snapshot.actor)?.conditions || {}).filter(key=>!['reflect','lightscreen','auroraveil','tailwind','spikes','toxicspikes','stealthrock','stickyweb'].includes(key));
    if(unsupported.length) errors.push(`Unsupported side conditions: ${unsupported.join(', ')}`);
  }
  if(snapshots.some(snapshot=>active(snapshot.actor)&&!snapshot.value.ability)) errors.push('Active partner ability unknown; partner modifiers unverified');
  return {errors:[...new Set([...errors,...field.warnings])],warnings};
}

function parseReply(reply) {
  if(reply?.isError) throw new Error((reply.content || []).filter(item=>item.type==='text').map(item=>item.text).join('\n') || 'MCP calculator rejected input');
  if(reply?.structuredContent && typeof reply.structuredContent==='object') return reply.structuredContent;
  for(const item of reply?.content || []) if(item.type==='text') {
    try {const parsed=JSON.parse(item.text);if(parsed&&typeof parsed==='object')return parsed;} catch {}
  }
  throw new Error('Calculator did not return structured mechanical results');
}

/** Actual MCP calculations only. callTool must forward timeoutMs/signal to the SDK. */
export async function analyzeNumerics(ctx,{hypotheses=[],maxCalls=24,budgetMs=2000,callTool,cache,concurrency=4}={}) {
  const started = performance.now(), deadline = started + Math.max(0,Math.min(30000,Number(budgetMs)||0));
  const limit = Math.max(0,Math.min(128,Math.floor(Number(maxCalls)||0)));
  const output = {order:[],damage:[],threats:[],checks:[],coverage:{scenarios:0,attemptedCalls:0,completedCalls:0,cachedCalls:0,
    unavailable:0,plannedDamage:0,completedDamage:0,deduplicatedCalls:0,maxConcurrentCalls:0,budgetExhausted:false,callLimitReached:false,scope:'Individual mechanical ranges only; no independent ranges are summed into a joint guarantee'},warnings:[]};
  const runtimeVersion = callTool?.runtimeVersion || ctx.calculatorRuntimeVersion;
  const memo = runtimeVersion && cache instanceof Map ? cache : new Map();
  const cacheGeneration=planningNumericCacheGeneration(memo);
  while(memo.size>256)memo.delete(memo.keys().next().value);
  if(cache && !runtimeVersion) output.warnings.push('Cross-analysis cache disabled: calculator runtime/build version is unknown');
  if(typeof callTool!=='function') output.warnings.push('MCP callTool unavailable; numerical checks remain unverified');
  const scenarios = scenarioList(ctx,hypotheses,output.warnings);
  output.coverage.scenarios=scenarios.length;
  const jobs=[],inFlight=new Map();let concurrentCalls=0,admittedCalls=0;
  const contextHashes={fieldSha256:contextDigest(ctx.field??{}),sidesSha256:contextDigest(ctx.sides??[]),hypothesesSha256:contextDigest(hypotheses)};
  const schedule=(tool,input,adopt,scenarioId)=>{
    const check={id:`numeric-${output.checks.length+1}`,tool,input:copy(input),status:'unavailable',reused:false,
      inputContext:{kind:'planning-numeric-context-v1',inputSha256:contextDigest({tool,input}),...contextHashes,scenarioId}};
    output.checks.push(check);jobs.push(async()=>{await run(tool,input,check);adopt(check);});
    return check;
  };
  const run = async (tool,input,check) => {
    const key = digest({tool,input,runtimeVersion:runtimeVersion || 'invocation-local',workspace:ctx.calculationCacheWorkspace??null,ownerTeamId:ctx.calculationCacheOwnerTeamId??null,evidenceScope:ctx.calculationEvidenceScope??null,contract:'planning-numerics-v3'});
    if(memo.has(key)) {
      const cached=memo.get(key);
      if(cached?.tool===tool && cached?.key===key) {
        check.status='complete';check.reused=true;check.result=copy(cached.result);check.receipt={calculationRef:cached.result.calculationRef || null,checkId:check.id,reused:true};
        output.coverage.cachedCalls++;return check;
      }
    }
    if(inFlight.has(key)) {
      const original=await inFlight.get(key);
      if(original.status==='complete'){
        check.status='complete';check.reused=true;check.result=copy(original.result);check.receipt={calculationRef:original.receipt?.calculationRef??null,checkId:check.id,reused:true};
        output.coverage.cachedCalls++;output.coverage.deduplicatedCalls++;
      }else{check.status=original.status;check.reason=original.reason;check.mayCompleteLate=original.mayCompleteLate;}
      return check;
    }
    const remaining = Math.floor(deadline-performance.now());
    if(typeof callTool!=='function' || output.coverage.budgetExhausted || remaining<=0 || admittedCalls>=limit) {
      check.reason=typeof callTool!=='function'?'MCP unavailable':output.coverage.budgetExhausted||remaining<=0?'budget exhausted':'call limit reached';
      output.coverage.budgetExhausted ||= remaining<=0;output.coverage.callLimitReached ||= admittedCalls>=limit;
      return check;
    }
    admittedCalls++;
    concurrentCalls++;output.coverage.maxConcurrentCalls=Math.max(output.coverage.maxConcurrentCalls,concurrentCalls);
    const controller=new AbortController(), callStarted=performance.now();let timer;
    let settle;inFlight.set(key,new Promise(resolve=>{settle=resolve;}));
    try {
      const task=Promise.resolve().then(()=>{
        const dispatchRemaining=Math.floor(deadline-performance.now());
        if(dispatchRemaining<=0)throw Object.assign(new Error('Calculator deadline elapsed before dispatch'),{numericTimeout:true});
        output.coverage.attemptedCalls++;
        return callTool(tool,copy(input),{timeoutMs:dispatchRemaining,signal:controller.signal});
      });
      const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(new Error('Calculator deadline elapsed; late completion is not evidence for this result'),{numericTimeout:true}));},remaining);});
      check.result=copy(parseReply(await Promise.race([task,timeout])));
      if(performance.now()>deadline){
        check.status='late';check.reason='Calculator completed after the analysis deadline; the late result was not adopted';
        check.receipt={calculationRef:check.result.calculationRef || null,checkId:check.id,reused:false};check.mayCompleteLate=false;
        output.coverage.budgetExhausted=true;return check;
      }
      check.status='complete';
      check.receipt={calculationRef:check.result.calculationRef || null,checkId:check.id,reused:false};
      output.coverage.completedCalls++;
      if(planningNumericCacheGeneration(memo)===cacheGeneration)memo.set(key,{key,tool,result:copy(check.result),ownerTeamId:ctx.calculationCacheOwnerTeamId??null,ownerWorkspace:ctx.calculationCacheWorkspace??null});
      while(memo.size>256)memo.delete(memo.keys().next().value);
    } catch(error) {
      check.status=error.numericTimeout?'timed-out':'unavailable';check.reason=String(error.message || error);
      if(error.numericTimeout){check.mayCompleteLate=true;output.coverage.budgetExhausted=true;}
    } finally {clearTimeout(timer);check.elapsedMs=performance.now()-callStarted;concurrentCalls--;settle(check);}
    return check;
  };
  const prepared=[],threatInputs=new Map();
  for(const scenario of scenarios) {
    const snapshots=(ctx.actors || []).filter(actor=>live(actor) && (active(actor)||actor.selected===true||actor.selected==='selected')).map(actor=>snapshot(ctx,actor,scenario));
    const field=currentField(ctx,scenario), candidates=snapshots.filter(snapshot=>!snapshot.errors.length &&
      !Object.keys(snapshot.value.volatiles || {}).some(key=>!speedVolatiles.has(key) && ['quash','afteryou','speedswap','powerswap','powersplit','guardsplit','transform'].includes(key)));
    const chosen=[...candidates.filter(snapshot=>active(snapshot.actor)),...candidates.filter(snapshot=>!active(snapshot.actor))].slice(0,6);
    const order={scenarioId:scenario.id,label:scenario.label,assumptions:scenario.assumptions,status:'unavailable',field:field.speed,
      pokemon:[],groups:[],priorityBrackets:priorityBrackets(snapshots),observedConstraints:observedConstraints(ctx),unavailable:snapshots.filter(snapshot=>snapshot.errors.length).map(snapshot=>({actorId:snapshot.actor.id,reasons:snapshot.errors})),warnings:[...field.warnings]};
    if(candidates.length>6)order.warnings.push('Speed snapshot capped at six actors; reserve order coverage is partial');
    if(chosen.length && !field.warnings.length) {
      const check=schedule('calculate_speed',{gen:0,pokemon:chosen.map(snapshot=>snapshot.speed),field:field.speed},check=>{
      order.checkId=check.id;
      if(check.status==='complete' && Array.isArray(check.result.pokemon) && Array.isArray(check.result.order) && check.result.gen===0) {
        order.status='complete';order.pokemon=check.result.pokemon;order.groups=check.result.order;order.receipt=check.receipt;
        order.warnings.push(...(check.result.limitations || []));
      } else order.warnings.push(check.reason || 'Speed reply lacks native gen0 structured entries/order');
      },scenario.id);
      order.checkId=check.id;
    }
    output.order.push(order);prepared.push({scenario,snapshots,field,order});
  }
  const queues=prepared.map(context=>{
    const {snapshots}=context, jobs=[];
    const attackers=[...snapshots.filter(snapshot=>active(snapshot.actor)),...snapshots.filter(snapshot=>!active(snapshot.actor))];
    for(const attacker of attackers) {
      for(const name of attacker.actor.moves || []) {
        const move=dex.moves.get(name);if(!move.exists || move.category==='Status' || ['self','allySide','allyTeam','adjacentAlly','adjacentAllyOrSelf'].includes(move.target))continue;
        for(const defender of snapshots.filter(snapshot=>snapshot.actor.side!==attacker.actor.side && (active(snapshot.actor)||active(attacker.actor)))) {
          const route=!active(attacker.actor)?'conditional-reserve-entry':!active(defender.actor)?'conditional-reserve-recipient':'active';
          jobs.push({...context,attacker,defender,move,route});
        }
      }
    }
    // Active opposing damage is evaluated alongside own damage before reserves.
    const own=jobs.filter(job=>job.attacker.actor.own&&job.route==='active'),foe=jobs.filter(job=>!job.attacker.actor.own&&job.route==='active'),reserve=jobs.filter(job=>job.route!=='active');
    return Array.from({length:Math.max(own.length,foe.length)},(_,index)=>[own[index],foe[index]].filter(Boolean)).flat().concat(reserve);
  });
  output.coverage.plannedDamage=queues.reduce((sum,queue)=>sum+queue.length,0);
  while(queues.some(queue=>queue.length)) for(const queue of queues) {
    if(!queue.length)continue;
    const {scenario,snapshots,field,order,attacker,defender,move,route}=queue.shift();
    const limits=damageLimits(attacker,defender,move,ctx,field,snapshots);
    const row={scenarioId:scenario.id,attackerId:attacker.actor.id,defenderId:defender.actor.id,move:move.name,route,status:'unavailable',range:null,
      attackerHP:null,defenderHP:null,percent:null,assumptions:[...new Set([...attacker.assumptions,...defender.assumptions])],warnings:limits.warnings};
    threatInputs.set(row,{defender,order});
    if(route!=='active')row.assumptions.push('Conditional known reserve route; original field/support modifiers and supplied boosts assumed at resolution. Entry slot, switch-in effects, entry survival, boosts reset, field changes, and later attack delivery remain unverified');
    if(limits.errors.length) {row.warnings.push(...limits.errors);output.coverage.unavailable++;output.damage.push(row);continue;}
    const damageField={...field.damage,attackerSide:sideModifiers(ctx,attacker,snapshots),defenderSide:sideModifiers(ctx,defender,snapshots)};
    for(const other of snapshots.filter(snapshot=>active(snapshot.actor) && snapshot.actor.raw?.abilitySuppressed!==true)) {
      const option={aurabreak:'isAuraBreak',fairyaura:'isFairyAura',darkaura:'isDarkAura',beadsofruin:'isBeadsOfRuin',swordofruin:'isSwordOfRuin',tabletsofruin:'isTabletsOfRuin',vesselofruin:'isVesselOfRuin'}[id(other.value.ability)];
      if(option)damageField[option]=true;
    }
    const check=schedule('calculate_damage',{gen:0,attacker:attacker.value.species,attackerOptions:attacker.damage,
      defender:defender.value.species,defenderOptions:defender.damage,move:move.name,field:damageField},check=>{
    row.checkId=check.id;
    const result=check.result;
    if(check.status==='complete' && result?.gen===0 && Array.isArray(result.range) && result.range.length===2 && result.range.every(Number.isFinite)) {
      const hpMismatch=[[attacker,result.attackerHP],[defender,result.defenderHP]].some(([snapshot,hp])=>exactHP(snapshot.hp) &&
        (hp?.current!==snapshot.hp.current || Number.isInteger(snapshot.hp.max)&&snapshot.hp.max!==hp?.max));
      if(hpMismatch) row.warnings.push('Calculator actual HP does not match the supplied exact snapshot; range remains unverified');
      else {
        row.status='complete';row.range=copy(result.range);row.attackerHP=result.attackerHP || null;row.defenderHP=result.defenderHP || null;
        row.percent=result.percent || null;row.receipt=check.receipt;row.description=result.description || null;output.coverage.completedDamage++;
      }
    } else row.warnings.push(check.reason || 'Damage reply lacks native gen0 numeric range');
    if(row.status!=='complete')output.coverage.unavailable++;
    },scenario.id);
    row.checkId=check.id;
    output.damage.push(row);
  }
  // The fixed queue keeps IDs, call-limit admission and output ordering stable;
  // independent tool requests may overlap I/O. CPU-bound handlers still execute
  // on their actual runtime and are not claimed to become parallel here.
  let nextJob=0;
  const width=Math.max(1,Math.min(8,Math.floor(Number(concurrency)||1)));
  await Promise.all(Array.from({length:Math.min(width,jobs.length)},async()=>{while(nextJob<jobs.length){const job=jobs[nextJob++];await job();}}));
  // Order and damage jobs are independent. Derive conditional threat labels
  // only after all jobs settle so a fast damage reply cannot race the order.
  for(const row of output.damage){
    const {defender,order}=threatInputs.get(row),hp=exactHP(defender.hp)?defender.hp.current:null;
    if(row.status!=='complete'||!defender.actor.own||hp===null||row.range[1]<hp||row.route!=='active')continue;
    const sourceGroup=order.groups.findIndex(group=>group.labels?.includes(row.attackerId)),targetGroup=order.groups.findIndex(group=>group.labels?.includes(row.defenderId));
    const speedRelation=order.status!=='complete'||sourceGroup<0||targetGroup<0?'unverified':sourceGroup===targetGroup?'tie':sourceGroup<targetGroup?'before-within-equal-priority':'after-within-equal-priority';
    output.threats.push({kind:row.range[0]>=hp?'attack-range-reaches-current-hp':'attack-range-may-reach-current-hp',scenarioId:row.scenarioId,targetId:row.defenderId,sourceId:row.attackerId,
      move:row.move,range:row.range,hp,speedRelation,delivery:'unverified',assumptions:[...row.assumptions,'Accuracy, priority, denial, Focus Sash/Sturdy and paired actions are not a verified knockout; no opponent intent inferred'],receipt:row.receipt});
  }
  if(output.coverage.budgetExhausted)output.warnings.push('Calculation deadline reached; unavailable or late checks do not establish numerical claims');
  if(output.coverage.callLimitReached)output.warnings.push('Calculation call limit reached; damage coverage is partial');
  output.coverage.elapsedMs=performance.now()-started;
  return output;
}
