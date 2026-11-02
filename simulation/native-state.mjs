// Conditional current-state hydration. All mechanics and initializers belong to
// the native engine; missing history is disclosed, never a move admission rule.
const reserved=new Set(['id','target','source','sourceSlot','__proto__','prototype','constructor']);
const scalarState=state=>Object.fromEntries(Object.entries(state).filter(([key,value])=>!reserved.has(key)&&(value===null||['string','number','boolean'].includes(typeof value))));
export function hydrateNativeExtras({battle,position,ids,dex}){
  const actionRng=battle.prng.getSeed();
  const assumptions=structuredClone(position.stateAssumptions??[]),byId=new Map(battle.getAllPokemon().map(p=>[ids.get(p),p]));
  const add=(path,reason,selected,origin='native-initialized-state-hypothesis')=>assumptions.push({path,reason,...(selected===undefined?{}:{selected}),origin});
  const patch=(state,values)=>{for(const [key,value]of Object.entries(values??{}))if(!reserved.has(key))Object.defineProperty(state,key,{value:structuredClone(value),enumerable:true,writable:true,configurable:true});};
  const before=battle.log.length,known=[];
  for(const sideInput of position.sides){const side=battle[sideInput.id];
    side.totalFainted=sideInput.nativeState?.totalFainted??sideInput.pokemon.filter(p=>p.hp===0).length;
    for(const input of sideInput.pokemon){const p=byId.get(input.id),state=input.nativeState??{};
      p.ability=dex.toID(input.ability);p.abilityState=battle.initEffectState({id:p.ability,target:p});
      if(state.baseAbility)p.baseAbility=dex.toID(state.baseAbility);
      else if(!Object.values(dex.species.get(input.species).abilities).some(name=>dex.toID(name)===p.ability))add(`${side.id}.${input.id}.baseAbility`,'Current copied ability is known, but its original base ability is not supplied; native switch reset is conditional.',p.baseAbility);
      for(const key of ['timesAttacked','lastMoveTargetLoc','moveLastTurnResult'])if(Object.hasOwn(state,key))p[key]=state[key];
      if(p.ability==='unburden'&&input.lifecycle.unburdenVolatile===undefined)add(`${side.id}.${input.id}.unburdenVolatile`,'Native Unburden activation history is unknown; absence is a conditional starting hypothesis.',!!p.volatiles.unburden);
      known.push({p,input,hp:p.hp,item:p.item,itemState:p.itemState,abilityState:p.abilityState,status:p.status,boosts:{...p.boosts},pp:p.moveSlots.map(m=>m.pp),statusState:p.statusState});
    }
  }
  if(position.nativeState?.lastMove!==undefined)battle.lastMove=position.nativeState.lastMove?dex.moves.get(position.nativeState.lastMove):null;
  function initialize(owner,table,key,entry,path){
    const effect=dex.conditions.get(key),source=entry.sourceId?byId.get(entry.sourceId):owner.getSlot?owner:owner.active?.find(p=>p?.hp>0)??battle.getAllActive()[0],sourceMove=entry.sourceMove?dex.moves.get(entry.sourceMove):undefined;
    let state,addNative;
    if(!effect.exists){add(path,'Known effect has no native condition; it is omitted in this conditional world.',{omitted:true},'known-but-not-hydrated');return;}
    try{
      if(owner.volatiles===table){addNative=()=>owner.addVolatile(key,source,sourceMove);addNative();state=owner.volatiles[key];}
      else if(owner.sideConditions===table){addNative=()=>owner.addSideCondition(key,source,sourceMove);addNative();state=owner.sideConditions[key];}
      else if(owner===battle.field){addNative=()=>owner.addPseudoWeather(key,source,sourceMove);addNative();state=owner.pseudoWeather[key];}
      else {state=battle.initEffectState({id:key,target:owner,...(source?{source,sourceSlot:source.getSlot()}:{} )});table[key]=state;battle.singleEvent('Start',effect,state,owner,source,sourceMove);}
      if(!state)throw Error('Native initializer did not retain this effect under the hypothesized current state');
    }catch(error){delete table[key];add(path,'Known effect could not be initialized in this conditional world; it is omitted, not known absent.',{omitted:true,diagnostic:String(error.message??error).slice(0,200)},'known-but-not-hydrated');return;}
    const provided=structuredClone(entry.state??{});
    if(Object.hasOwn(state,'layers')){
      if(!Number.isInteger(provided.layers)||provided.layers<1){if(Object.hasOwn(provided,'layers'))add(path+'.layers','Missing or invalid source layer count uses the native initialized layer hypothesis.',state.layers);delete provided.layers;}
      else if(addNative){for(let n=0;n<8&&state.layers<provided.layers;n++){const prior=state.layers;addNative();if(state.layers===prior)break;}if(state.layers!==provided.layers){add(path+'.layers','Supplied layers conflict with native layer limits; this world uses the native reachable count and does not establish that source field.',state.layers);delete provided.layers;}}
    }
    patch(state,provided);
    const generated=scalarState(state),unprovided=Object.fromEntries(Object.entries(generated).filter(([k])=>!Object.hasOwn(provided,k)));
    for(const [key,value]of Object.entries(unprovided))add(path+'.'+key,'Native initializer supplied a hidden effect field; this is a hypothesis about an existing effect, not an observation.',value);
    if(!entry.sourceId)add(path+'.source','Effect source was not observed; the initializer uses a conditional modeled source.',source?ids.get(source)??null:null);
  }
  for(const row of known){const {p,input}=row,state=input.nativeState??{},path=`${p.side.id}.${input.id}`;
    if(input.status&&(['slp','tox'].includes(input.status)||state.statusState)){
      const own={};initialize(p,own,input.status,{state:state.statusState},path+'.statusState');
      p.statusState=own[input.status]??battle.initEffectState({id:input.status,target:p});row.statusState=p.statusState;
    }
    const effects={...(state.volatiles??{}),...(state.abilitySuppressed&&!p.volatiles.gastroacid?{gastroacid:{}}:{})};
    for(const [key,entry]of Object.entries(effects)){
      if(Object.hasOwn(input.volatiles,key)){patch(p.volatiles[key],entry.state);continue;}
      initialize(p,p.volatiles,key,entry,path+'.volatiles.'+key);
    }
  }
  for(const sideInput of position.sides)for(const [key,entry]of Object.entries(sideInput.nativeConditions??{}))initialize(battle[sideInput.id],battle[sideInput.id].sideConditions,key,entry,sideInput.id+'.conditions.'+key);
  for(const [key,entry]of Object.entries(position.nativeField?.conditions??{}))initialize(battle.field,battle.field.pseudoWeather,key,entry,'field.'+key);
  // Existing effects may have entry-only Start side effects. Current public and
  // private facts remain authoritative; retain native counters, restore facts.
  for(const row of known){const {p,input}=row;p.hp=row.hp;p.fainted=p.hp===0;p.item=row.item;p.itemState=row.itemState;p.status=row.status;p.statusState=row.statusState;p.boosts=row.boosts;
    p.ability=dex.toID(input.ability);p.abilityState=row.abilityState;p.activeTurns=input.lifecycle.activeTurns;p.activeMoveActions=input.lifecycle.activeMoveActions;
    p.moveSlots.forEach((move,index)=>move.pp=row.pp[index]);
  }
  // Current-state initialization is not a historical action. Do not shift the
  // actual turn's RNG by drawing a duration that is then patched from evidence.
  // Unknown initialized values are explicit hypotheses, not probability draws.
  battle.prng.setSeed(actionRng);
  return {assumptions,initializationLogStart:before};
}
