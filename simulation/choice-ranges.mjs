// Descriptive aggregation of actual native samples; never a damage formula,
// exhaustive spread envelope, probability, or action-delivery gate.
const check=(value,message)=>{if(!value)throw Error('Choice ranges: '+message);};
const range=values=>({min:Math.min(...values),max:Math.max(...values)});
function hpValue(raw){
  const value=String(raw??'').split('|')[3]??'';
  if(/^0(?:\s|$)/u.test(value))return 0;
  const match=/^(\d+)\/(\d+)(?:\s|$)/u.exec(value);
  return match?Number(match[1]):null;
}

export function summarizeChoiceSamples(worlds){
  const groups=new Map();let sampleCount=0;
  for(const world of worlds)for(const sample of world.samples??[]){
    sampleCount++;
    const start=world.initialState?.sides?.flatMap(side=>side.pokemon)??[];
    const final=sample.final?.sides?.flatMap(side=>side.pokemon)??[];
    const hp=new Map(start.map(p=>[p.id,p.hp])),lost=new Map(),healed=new Map();
    for(const event of sample.events??[]){
      if(!['-damage','-heal','-sethp','faint'].includes(event.type)||!hp.has(event.actorId))continue;
      const after=event.type==='faint'?0:hpValue(event.raw),before=hp.get(event.actorId);
      check(Number.isSafeInteger(after)&&after>=0&&Number.isSafeInteger(before),'exact native HP event required');
      if(event.type==='-damage')lost.set(event.actorId,(lost.get(event.actorId)??0)+Math.max(0,before-after));
      if(event.type==='-heal')healed.set(event.actorId,(healed.get(event.actorId)??0)+Math.max(0,after-before));
      hp.set(event.actorId,after);
    }
    for(const initial of start){
      const end=final.find(p=>p.id===initial.id);check(end&&Number.isSafeInteger(end.hp),'native boundary state required');
      const key=JSON.stringify([sample.branchId,initial.id]);
      if(!groups.has(key))groups.set(key,{branchId:sample.branchId,pokemonId:initial.id,observations:[]});
      groups.get(key).observations.push({worldId:world.id,seed:sample.seed,initialHp:initial.hp,maxHp:initial.maxhp,
        damageTaken:lost.get(initial.id)??0,healingReceived:healed.get(initial.id)??0,hpAtBoundary:end.hp,
        fainted:end.fainted===true,boundary:sample.boundary});
    }
  }
  return {kind:'sampled-native-turn-ranges-v1',sampleCount,exhaustive:false,koProbability:false,
    actors:[...groups.values()].map(row=>({...row,damageTaken:range(row.observations.map(v=>v.damageTaken)),
      healingReceived:range(row.observations.map(v=>v.healingReceived)),hpAtBoundary:range(row.observations.map(v=>v.hpAtBoundary)),
      faintedSamples:row.observations.filter(v=>v.fainted).length})),
    limitations:['Min/max cover only the returned native worlds, authored branches and seeds; unevaluated spreads and random outcomes remain unknown.',
      'Damage taken includes native move, recoil and residual HP-loss events. Healing is separate; this is not a single-move damage-roll envelope.',
      'A replacement boundary can leave actions/residuals unresolved. Use calculate_damage_range for the roll envelope over a declared spread domain.']};
}
