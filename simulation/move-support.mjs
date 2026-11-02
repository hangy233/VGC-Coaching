// Diagnostics only. Native clickability and command legality belong to the
// caller/native engine; callback/effect coverage never denies a known move.
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const {Dex}=createRequire(import.meta.url)('pokemon-showdown');
const dex=Dex.forFormat('gen9championsvgc2026regmc');
const scalarReads=[
  ['side.totalFainted',/(?:\.totalFainted\b|\[['"]totalFainted['"]\])/u],
  ['pokemon.timesAttacked',/(?:\.timesAttacked\b|\[['"]timesAttacked['"]\])/u],
  ['pokemon.moveLastTurnResult',/(?:\.moveLastTurnResult\b|\[['"]moveLastTurnResult['"]\])/u],
  ['pokemon.lastMoveTargetLoc',/(?:\.lastMoveTargetLoc\b|\[['"]lastMoveTargetLoc['"]\])/u],
  ['battle.lastMove',/\bthis(?:\.lastMove\b|\[['"]lastMove['"]\])/u],
];
const statefulReferences=new Set(['volatileStatus','sideCondition','slotCondition','pseudoWeather','condition','selfSwitch','forceSwitch']);
const knownMove=move=>!!move&&typeof move==='object'&&typeof move.id==='string'&&move.id.length>0&&move.exists===true&&dex.moves.get(move.id).exists;

export function currentMoveSupport(move){
  return knownMove(move)?{supported:true}:{supported:false,reason:'Unknown native move'};
}

/** Symbolic callback/effect paths, never executed formulas or an admission gate.
 * Text inspection discovers listed scalar reads; it cannot prove the absence
 * of transitive native history dependencies. Keep that coverage limit explicit.
 */
export function nativeHistoryRequirementDetails(move){
  if(!knownMove(move))return [];
  const rows=[],seen=new Set();
  const inspect=(value,path='')=>{
    if(!value||typeof value!=='object'||seen.has(value))return;seen.add(value);
    for(const [key,item]of Object.entries(value)){
      const field=path?path+'.'+key:key;
      if(typeof item==='function'){
        const source=Function.prototype.toString.call(item),fields=scalarReads.filter(([,pattern])=>pattern.test(source)).map(([name])=>name);
        // Native calls/events may access additional state beyond this callback's
        // visible scalar reads. This conservative marker never blocks a move.
        rows.push({path:field,kind:'native-callback',fields:[...fields,'native.callback-history'].sort(),unclassified:true,
          sourceSha256:createHash('sha256').update(source).digest('hex')});
      }else if(statefulReferences.has(key)&&item!==undefined&&item!==false&&item!==null){
        rows.push({path:field,kind:'native-effect-reference',fields:['native.callback-history'],unclassified:true});
        if(item&&typeof item==='object')inspect(item,field);
      }else if(path==='flags'&&['charge','recharge','futuremove'].includes(key)&&item){
        rows.push({path:field,kind:'native-multiturn-reference',fields:['native.callback-history'],unclassified:true});
      }else if(item&&typeof item==='object')inspect(item,field);
    }
  };
  inspect(move);
  return rows.sort((a,b)=>a.path.localeCompare(b.path));
}

/** Stable symbolic field names for caller-owned hydration/uncertainty reports. */
export function nativeHistoryRequirements(move){
  return [...new Set(nativeHistoryRequirementDetails(move).flatMap(row=>row.fields))].sort();
}
