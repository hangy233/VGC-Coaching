/** Only verified links for this exact game can become clickable report content. */
export function replayUrlForGame(game){
  const reference=game?.replay;
  if(reference?.verified!==true||typeof reference.url!=='string')return null;
  try{
    const url=new URL(reference.url);
    if(url.origin!=='https://replay.pokemonshowdown.com'||url.username||url.password||url.search||url.hash)return null;
    const identity=url.pathname.slice(1).replace(/-[a-z0-9]+pw$/,'');
    if(!/^[a-z0-9]+-\d+$/.test(identity)||'battle-'+identity!==String(game.roomId).replace(/-[a-z0-9]+pw$/,''))return null;
    return url.href;
  }catch{return null;}
}
