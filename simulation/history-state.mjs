// Apply only source-bound, mechanically proved history fields. This never
// selects a move, spread, target, replacement or undocumented counter value.
export function applyKnownNativeHistory(built,assembly){
  const history=assembly.facts?.nativeHistory;if(!history)return built;
  const need=(ok,message)=>{if(!ok)throw Error('Native history: '+message);};
  need(history.kind==='source-bound-native-history-v1'&&history.schemaVersion===1,'unknown history receipt');
  for(const key of ['sourceSha256','historySha256','sequence','teamId','room','rqid'])need(history.binding?.[key]===assembly.binding?.[key],'history is not bound to the current source: '+key);
  const position=structuredClone(built.position),resolved=new Set(),known=[];
  function put(target,key,value,path,check){
    need(check(value),'invalid derived field '+path);
    const assumed=(position.stateAssumptions??[]).some(row=>row.path===path||row.path===path.replace('.nativeState.','.'));
    if(target[key]!==undefined&&target[key]!==value)need(built.provenance?.approximate&&assumed,'supplied state conflicts with proved history at '+path);
    target[key]=value;resolved.add(path);known.push({path,value});
  }
  for(const side of position.sides){const proof=history.sides?.[side.id];
    if(proof?.totalFainted!==undefined){side.nativeState??={};put(side.nativeState,'totalFainted',proof.totalFainted,side.id+'.nativeState.totalFainted',v=>Number.isInteger(v)&&v>=0&&v<=100);}
    for(const p of side.pokemon){const row=history.pokemon?.[p.id];if(!row)continue;p.nativeState??={};
      if(Object.hasOwn(row,'lastMove')){
        need(history.completeHistory===true,'lastMove requires complete source history');
        p.lifecycle??={};put(p.lifecycle,'lastMove',row.lastMove,`${side.id}.${p.id}.lifecycle.lastMove`,v=>v===false||typeof v==='string'&&v.length>0&&v.length<=80);
      }
      for(const key of ['timesAttacked','lastMoveTargetLoc','moveLastTurnResult'])if(Object.hasOwn(row,key)){
        const valid=key==='moveLastTurnResult'?v=>typeof v==='boolean'||v===null:key==='lastMoveTargetLoc'?v=>Number.isInteger(v)&&v>=-4&&v<=4:v=>Number.isInteger(v)&&v>=0&&v<=10000;
        put(p.nativeState,key,row[key],`${side.id}.${p.id}.nativeState.${key}`,valid);
      }
    }
  }
  if(history.battle?.lastMove!==undefined){position.nativeState??={};put(position.nativeState,'lastMove',history.battle.lastMove,'battle.lastMove',v=>v===false||typeof v==='string'&&v.length>0&&v.length<=80);}
  position.stateAssumptions=position.stateAssumptions?.filter(row=>![...resolved].some(path=>row.path===path||row.path===path.replace('.nativeState.','.')));
  return {...built,position,provenance:{...built.provenance,nativeHistory:{binding:structuredClone(history.binding),known,unknowns:structuredClone(history.unknowns??[]),completeHistory:history.completeHistory,scope:'Only per-field native history proofs are applied; unknown values remain unknown.'}}};
}
