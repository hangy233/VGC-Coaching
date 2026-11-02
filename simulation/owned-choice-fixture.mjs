// Synthetic pinned-engine history and a fake socket; no network or login.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {ShowdownClient} from '../showdown/client.mjs';
import {AgentSession} from '../showdown/agent-session.mjs';
const {Battle,Teams}=createRequire(import.meta.url)('pokemon-showdown');
const {extractChannelMessages}=createRequire(import.meta.url)('pokemon-showdown/dist/sim/battle.js');
const room='battle-gen9championsvgc2026regmcbo3-881',parent='game-bestof3-gen9championsvgc2026regmcbo3-880';
const set=(species,ability,item,moves)=>({species,name:species,ability,item,moves,level:50,nature:'Modest',evs:{hp:32,spa:32,spd:2}});
export async function createOwnedSimulationFixture({itemless=false}={}){
  const own=[set('Politoed','Drizzle','Leftovers',['Weather Ball','Muddy Water','Ice Beam','Protect']),set('Farigiraf','Armor Tail','Sitrus Berry',['Psychic','Helping Hand','Trick Room','Protect']),set('Golisopod','Emergency Exit','Golisopite',['Sucker Punch','Iron Head','Leech Life','Protect']),set('Archaludon','Stamina','Choice Scarf',['Dragon Pulse','Flash Cannon','Aura Sphere','Electro Shot']),set('Sylveon','Pixilate','Fairy Feather',['Hyper Voice','Quick Attack','Mystical Fire','Protect']),set('Rillaboom','Grassy Surge','Miracle Seed',['Wood Hammer','High Horsepower','Grassy Glide','Protect'])];
  const foe=structuredClone(own),packed=Teams.pack(own),teamId=createHash('sha256').update(packed).digest('hex');
  if(itemless)foe[2].item='';
  let time=100000,lastLine=0,rqid=0;const sent=[];
  const client=new ShowdownClient({expectedTeamHash:teamId,now:()=>time});
  client.connected=true;client.authenticated=true;client.epoch=1;client.formats='[Gen 9] Champions VGC 2026 Reg M-C (Bo3),e';
  client.ws={send:line=>sent.push(line),close:()=>{client.connected=false;client.authenticated=false;client.emit('disconnected');}};
  const session=new AgentSession(client,{username:'Owner',packed,authorizedSets:1,autoReady:false,now:()=>time,controllerRequired:false});
  assert.equal((await session.execute({id:'synthetic-start',op:'start',confirmed:true})).ok,true);
  client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'Owner vs Foe'}})}`);
  client.receive(`>${parent}\n|uhtml|game|<a href="/${room}">Game 1</a>`);
  client.receive(`>${room}\n|showteam|p2|${Teams.pack(foe)}`);
  const battle=new Battle({formatid:'gen9championsvgc2026regmc',seed:[1,2,3,4],p1:{name:'Owner',team:own},p2:{name:'Foe',team:foe}});
  const receive=()=>{
    const lines=extractChannelMessages(battle.log.join('\n'),[1])[1];
    for(const line of lines.slice(lastLine)){time++;client.receive(`>${room}\n${line}`);}lastLine=lines.length;
    if(battle.p1.activeRequest){time++;client.receive(`>${room}\n|request|${JSON.stringify({...battle.p1.activeRequest,rqid:++rqid})}`);}
  };
  const choose=(a,b)=>{assert.equal(battle.choose('p1',a),true,battle.p1.choice.error);assert.equal(battle.choose('p2',b),true,battle.p2.choice.error);receive();};
  receive();choose('team 1234','team 1234');
  const source=()=>{const a=session.actions().find(row=>row.kind==='turn');assert.ok(a);return {sessionId:session.id,teamId,room,rqid:a.rqid,token:a.token};};
  return {battle,session,client,sent,source,choose,tick:()=>time++,close(){session.dispose();battle.destroy();}};
}
export {room,parent};
