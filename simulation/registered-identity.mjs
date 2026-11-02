// A battle Mega's registered predecessor is native changesFrom, which need not
// equal baseSpecies (Floette-Mega comes from Floette-Eternal). Ordinary formes
// retain their own identity; this is not Species Clause or Transform matching.
export function registeredSpeciesKey(species,dex){
  const current=dex.species.get(species);
  if(!current.exists)throw Error('Unknown registered species identity');
  if(!current.isMega)return current.id;
  const predecessor=current.changesFrom;
  if(typeof predecessor!=='string'||!predecessor)throw Error('Native registered predecessor is missing or ambiguous');
  const registered=dex.species.get(predecessor);
  if(!registered.exists||registered.isMega)throw Error('Native registered predecessor is missing or ambiguous');
  return registered.id;
}
