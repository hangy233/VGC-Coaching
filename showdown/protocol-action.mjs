// Engine-confirmed holder-first cant events: pokemon-showdown/data/abilities.ts
// Armor Tail, Dazzling and Queenly Majesty name the denied move user in [of].
const holderCantAbilities=new Set(['ability: Armor Tail','ability: Dazzling','ability: Queenly Majesty']);
const activeActor=value=>typeof value==='string'&&/^p[1-4][ab]: .+$/u.test(value);

/** Attribute only known protocol shapes; retain unknown ability events as unknown.
 * Ordinary cant source tags keep their meaning. Raw protocol is never modified.
 */
export function cantActionAttribution(parts) {
  const [holder,reason,move]=Array.isArray(parts)?parts:[];
  if(holderCantAbilities.has(reason)){
    const sources=parts.slice(3).filter(value=>typeof value==='string'&&value.startsWith('[of] '));
    const actor=sources.length===1?sources[0].slice(5):null;
    return activeActor(holder)&&activeActor(actor)&&holder.slice(0,2)!==actor.slice(0,2)&&typeof move==='string'&&move?
      {kind:'blocked-user',actor,holder,reason,move}:{kind:'unknown-ability',actor:null,holder,reason,move};
  }
  if(typeof reason==='string'&&reason.startsWith('ability:'))return {kind:'unknown-ability',actor:null,holder,reason,move};
  return {kind:'ordinary',actor:holder,reason,move};
}

/** A called action or animation-suppressed announcement is no ordinary execution proof. */
export function ordinaryMoveExecution(parts) {
  return Array.isArray(parts)&&!parts.some(part=>typeof part==='string'&&(part.startsWith('[from]')||part==='[still]'));
}
