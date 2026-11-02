// Control retains private room aliases; evidence belongs to the exact child.
export function canonicalEvidenceRoom(room){
  if(typeof room!=='string')throw new TypeError('A canonical M-C child room or valid private alias is required');
  const match=/^(battle-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*)(?:-[a-z0-9]+pw)?$/u.exec(room);
  if(!match||match[0]!==room)throw new TypeError('A canonical M-C child room or valid private alias is required');
  return match[1];
}
