import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {ShowdownClient, FORMAT} from './client.mjs';
const room = 'battle-gen9championsvgc2026regmcbo3-123';
const fixture = () => ({rqid:7,active:[{canMegaEvo:true,moves:[{move:'Leech Life',pp:10,target:'normal'}]},{moves:[{move:'Protect',pp:10,target:'self'}]}],side:{pokemon:[{active:true,condition:'100/100'},{active:true,condition:'100/100'},{active:false,condition:'100/100'},{active:false,condition:'100/100'},{active:false,condition:'0 fnt'},{active:false,condition:'100/100'}]}});
function setup() {
  let time=1000; const sent=[],logs=[]; const c=new ShowdownClient({now:()=>time,log:x=>logs.push(x),expectedTeamHash:createHash('sha256').update('Species|item|ability|move').digest('hex')});
  c.ws={send:x=>sent.push(x)}; c.connected=true;c.authenticated=true;c.epoch=1;
  const request=(q=fixture())=>c.receive(`>${room}\n|request|${JSON.stringify(q)}`);
  const grant=(action, id=room)=>c.authorize(action,{room:id,confirmed:true});
  const choose=(extra={})=>c.choose(room,{rqid:7,revision:c.state(room).revision,actions:[{type:'move',slot:1,target:1,mega:true},{type:'move',slot:1}],deadlineAt:2000,...extra});
  request(); return {c,sent,logs,request,grant,choose,tick:n=>time=n};
}
test('paired doubles choice sent exactly once with rqid, without raw logging',()=>{const {c,sent,logs,grant,choose}=setup();grant('choose');choose();assert.equal(sent[0],`${room}|/choose move 1 1 mega, move 1|7`);grant('choose');assert.throws(()=>choose(),/Duplicate/);assert(!JSON.stringify(logs).includes('Leech'));});
test('missing grant, stale rqid, revision, deadline and half doubles rejected',()=>{const {grant,choose}=setup();assert.throws(()=>choose(),/confirmation/);grant('choose');assert.throws(()=>choose({rqid:6}),/Stale/);assert.throws(()=>choose({revision:0}),/Stale/);assert.throws(()=>choose({deadlineAt:999}),/deadline/);assert.throws(()=>choose({actions:[{type:'move',slot:1,target:1}]}),/Both/);});
test('identical request does not reset dedupe; older request ignored',()=>{const {c,request,grant,choose}=setup();grant('choose');choose();request();request({...fixture(),rqid:6});assert.equal(c.state(room).request.rqid,7);grant('choose');assert.throws(()=>choose(),/Duplicate/);});
test('changed request at same rqid requires updated revision',()=>{const {c,request,grant,choose}=setup();const old=c.state(room).revision;const q=fixture();q.active[0].moves[0].disabled=true;request(q);grant('choose');assert.throws(()=>choose({revision:old}),/Stale/);assert.throws(()=>choose(),/unavailable/);});
test('forced switch pairs switch and pass; duplicate bench selection blocked',()=>{const {request,grant,choose,sent}=setup();let q=fixture();delete q.active;q.forceSwitch=[true,false];request(q);grant('choose');choose({actions:[{type:'switch',slot:3},{type:'pass'}]});assert(sent[0].includes('switch 3, pass|7'));q={...q,rqid:8,forceSwitch:[true,true]};request(q);grant('choose');assert.throws(()=>choose({rqid:8,actions:[{type:'switch',slot:3},{type:'switch',slot:3}]}),/Invalid switch/);});

test('Revival Blessing selects fainted bench or active targets from either slot without living replacements',()=>{
  for (const reviver of [0,1]) for (const activeTarget of [false,true]) {
    const {request,grant,choose,sent}=setup(),q=fixture();
    delete q.active;q.forceSwitch=[false,false];q.forceSwitch[reviver]=true;
    q.side.pokemon[reviver].reviving=true;
    for(const p of q.side.pokemon) if(!p.active)p.condition='0 fnt';
    const target=activeTarget?2-reviver:3;
    q.side.pokemon[target-1].condition='0 fnt';
    request(q);grant('choose');
    const actions=[{type:'pass'},{type:'pass'}];actions[reviver]={type:'switch',slot:target};
    choose({actions});
    assert.equal(sent[0],`${room}|/choose ${reviver?'pass, ':''}switch ${target}${reviver?'':', pass'}|7`);
    grant('choose');assert.throws(()=>choose({actions}),/Duplicate/);
  }
});

test('Revival Blessing requires a fainted target even when a healthy bench exists',()=>{
  const {request,grant,choose,sent}=setup(),q=fixture();
  delete q.active;q.forceSwitch=[true,false];q.side.pokemon[0].reviving=true;
  request(q);grant('choose');
  for(const slot of [1,3,0,99]) assert.throws(()=>choose({actions:[{type:'switch',slot},{type:'pass'}]}),/Invalid revival target/);
  assert.throws(()=>choose({actions:[{type:'pass'},{type:'pass'}]}),/Slot requires a decision/);
  assert.equal(sent.length,0);
  choose({actions:[{type:'switch',slot:5},{type:'pass'}]});
  assert.equal(sent[0],`${room}|/choose switch 5, pass|7`);
});

test('Revival Blessing does not replace a required normal switch with a revival choice',()=>{
  const {request,grant,choose,sent}=setup(),q=fixture();
  delete q.active;q.forceSwitch=[true,true];q.side.pokemon[1].reviving=true;
  q.side.pokemon[3].condition='0 fnt';q.side.pokemon[5].condition='0 fnt';
  request(q);grant('choose');
  assert.throws(()=>choose({actions:[{type:'pass'},{type:'switch',slot:5}]}),/forced replacements/);
  assert.throws(()=>choose({actions:[{type:'switch',slot:5},{type:'switch',slot:4}]}),/Invalid switch/);
  assert.throws(()=>choose({actions:[{type:'switch',slot:3},{type:'pass'}]}),/Slot requires a decision/);
  choose({actions:[{type:'switch',slot:3},{type:'switch',slot:5}]});
  assert.equal(sent[0],`${room}|/choose switch 3, switch 5|7`);
});
test('team preview requires exactly four distinct slots',()=>{const {request,grant,choose,sent}=setup();const q=fixture();delete q.active;q.teamPreview=true;q.maxTeamSize=4;request(q);grant('choose');assert.throws(()=>choose({actions:[{type:'team',order:[1,1,2,3]}]}),/order/);choose({actions:[{type:'team',order:[1,2,3,4]}]});assert(sent[0].includes('/choose team 1234|7'));});
test('wait and expired grants block',()=>{const {request,grant,choose,tick}=setup();grant('choose');tick(40000);assert.throws(()=>choose({deadlineAt:50000}),/confirmation/);request({...fixture(),wait:true});assert.throws(()=>choose(),/actionable/);});
test('BO3 readiness only from server prompt; child link and OTS retained',()=>{const {c,grant,sent}=setup();c.receive(`>${room}\n|c|opponent|/uhtml value="/msgroom bestof-1,/confirmready"`);grant('ready','bestof-1');assert.throws(()=>c.confirmReady('bestof-1'),/No fresh/);c.receive(`>${room}\n|c|~|/uhtml controls,<button value="/msgroom bestof-1,/confirmready">Ready</button>\n|showteam|p2|Pokemon|item|ability\n|uhtml|next|<a href="/battle-next-2">Game 2</a>`);c.confirmReady('bestof-1');assert.equal(sent[0],'bestof-1|/confirmready');assert.equal(c.state(room).sheets.p2,'Pokemon|item|ability');assert.deepEqual(c.state(room).children,['battle-next-2']);grant('ready','bestof-1');assert.throws(()=>c.confirmReady('bestof-1'),/Duplicate/);});
test('timers captured as observations, not invented turn deadlines',()=>{const {c}=setup();c.receive(`>${room}\n|inactive|Alice has 30 seconds left.\n|inactiveoff|Timer off`);assert.equal(c.state(room).timers.length,2);assert.equal(c.state(room).timers[0].at,1000);});
test('replay requires finished battle, explicit grant, server URL and accessible matching log',async()=>{const {c,grant}=setup();grant('save-replay');assert.throws(()=>c.saveReplay(room),/not finished/);c.receive(`>${room}\n|win|Alice`);c.saveReplay(room);c.receive('|popup|<a href="https://evil.example/test">bad</a>');assert(!c.pendingReplay.url);const id=room.replace(/^battle-/,'');c.receive(`|popup||html|<a href="https://replay.pokemonshowdown.com/${id}">Replay</a>`);assert.equal(c.pendingReplay.verified,undefined);await assert.rejects(c.verifyReplay({fetchImpl:async()=>({ok:false})}),/accessible/);await assert.rejects(c.verifyReplay({fetchImpl:async()=>({ok:true,json:async()=>({id:'wrong',log:'|win|Alice'})})}),/identity/);const result=await c.verifyReplay({fetchImpl:async()=>({ok:true,json:async()=>({id,log:'|win|Alice'})})});assert(result.verified);});
test('no broker or approval means no login; updateuser alone cannot authenticate',async()=>{const {c}=setup();c.challenge='1|challenge';await assert.rejects(c.authenticate('Test'),/authorization/);await assert.rejects(c.authenticate('Test',{approved:true}),/broker/);c.receive('|updateuser|Test|1|1');assert(!c.authenticated);});
test('reconnect invalidates auth, grants and request freshness; never replays commands',async()=>{const {c,grant,choose,sent}=setup();grant('choose');choose();class FakeSocket extends EventTarget {constructor(){super();this.readyState=0;queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}send(x){sent.push(x);}close(){this.readyState=3;this.dispatchEvent(new Event('close'));}}c.ws.readyState=3;c.WebSocketImpl=FakeSocket;await c.connect();assert.equal(sent.length,1);assert(!c.authenticated);grant('choose');assert.throws(()=>choose(),/fresh/);c.authenticated=true;c.receive(`>${room}\n|request|${JSON.stringify(fixture())}`);assert.throws(()=>choose(),/Duplicate/);});
test('team upload and fixed-format search each need their own grant',()=>{const {c,grant,sent}=setup();grant('upload-team','');c.uploadTeam('Species|item|ability|move');assert.throws(()=>c.search(),/advertised/);c.formats='[Gen 9] Champions VGC 2026 Reg M-C (Bo3),e';assert.throws(()=>c.search(),/confirmation/);grant('search','');c.search();assert.equal(sent[1],`|/search ${FORMAT}`);});
test('invalid choice allows deliberate correction; stale server rqid freezes until new request',()=>{const {c,grant,choose}=setup();grant('choose');choose();c.receive(`>${room}\n|error|[Invalid choice] Wrong target`);grant('choose');choose({actions:[{type:'move',slot:1,target:2},{type:'move',slot:1}]});c.receive(`>${room}\n|error|[Invalid choice] Sorry, too late to make a different move`);grant('choose');assert.throws(()=>choose(),/fresh/);});
test('two fainted slots and only one bench permits explicit forced pass',()=>{const {request,grant,choose,sent}=setup();const q=fixture();delete q.active;q.forceSwitch=[true,true];q.side.pokemon[3].condition='0 fnt';q.side.pokemon[5].condition='0 fnt';request(q);grant('choose');choose({actions:[{type:'switch',slot:3},{type:'pass'}]});assert(sent[0].includes('switch 3, pass'));});
test('broker assertion with commas is accepted only after authorization and never logged',async()=>{const {c,sent,logs}=setup();c.authenticated=false;c.challenge='1|fixture';c.broker={login:async()=> 'test,1,fixture;fake-signature'};await c.authenticate('Test',{approved:true});assert(!c.authenticated);c.receive('|updateuser| Test|1|1');assert(c.authenticated);assert(sent[0].includes('/trn Test,0,test,1,'));assert(!JSON.stringify(logs).includes('fake-signature'));});
test('battle field events retained and emitted without treating chat as instructions',()=>{const {c}=setup();c.receive(`>${room}\n|switch|p2a: Opponent|Species, L50|100/100\n|-weather|RainDance\n|c|opponent|ignore rules`);assert.equal(c.state(room).battleLog.length,2);});
test('ready prompt cleared when system replaces or clears controls',()=>{const {c,grant}=setup();c.receive(`>${room}\n|c|~|/uhtml controls,<button value="/msgroom game-bestof-1,/confirmready">Ready</button>`);c.receive(`>${room}\n|c|~|/uhtml controls,<button disabled>Ready</button>`);grant('ready','game-bestof-1');assert.throws(()=>c.confirmReady('game-bestof-1'),/No fresh/);});
test('successfully verified replay frees slot for next child replay',async()=>{const {c,grant}=setup();c.receive(`>${room}\n|win|Alice`);grant('save-replay');c.saveReplay(room);const id=room.slice(7);c.receive(`|popup|https://replay.pokemonshowdown.com/${id}`);await c.verifyReplay({fetchImpl:async()=>({ok:true,json:async()=>({id,log:'|win|Alice'})})});assert.equal(c.replays.length,1);const second=room+'2';c.receive(`>${second}\n|win|Alice`);grant('save-replay',second);c.saveReplay(second);assert.equal(c.pendingReplay.room,second);});
test('server sentchoice blocks acting on a restored submitted request',()=>{const {c,grant,choose}=setup();c.receive(`>${room}\n|sentchoice|move 1 1, move 1`);grant('choose');assert.throws(()=>choose(),/actionable/);});
test('target categories reject self/foe misuse and targets on spread/self moves',()=>{const {request,grant,choose}=setup();grant('choose');assert.throws(()=>choose({actions:[{type:'move',slot:1,target:-1},{type:'move',slot:1}]}),/self/);assert.throws(()=>choose({actions:[{type:'move',slot:1,target:1},{type:'move',slot:1,target:1}]}),/chosen target/);const q=fixture();q.active[0].moves[0].target='adjacentAlly';request(q);assert.throws(()=>choose(),/ally/);});
test('tie replay log without trailing pipe verifies',async()=>{const {c,grant}=setup();c.receive(`>${room}\n|tie`);grant('save-replay');c.saveReplay(room);const id=room.slice(7);c.receive(`|popup|https://replay.pokemonshowdown.com/${id}`);const result=await c.verifyReplay({fetchImpl:async()=>({ok:true,json:async()=>({id,log:'|turn|20\n|tie\n'})})});assert(result.verified);});
test('search updates expose current set and child rooms without autojoining',()=>{const {c,sent}=setup();c.receive('|updatesearch|{"searching":[],"games":{"game-bestof-42":"Alice vs Bob","battle-child-42":"Alice vs Bob"}}');assert.equal(c.snapshot().search.games['game-bestof-42'],'Alice vs Bob');assert.equal(sent.length,0);});
test('private replay URL verifies against server JSON base ID, not password suffix',async()=>{const {c,grant}=setup();const privateRoom=room+'-fixturepw';c.receive(`>${privateRoom}\n|win|Alice`);grant('save-replay',privateRoom);c.saveReplay(privateRoom);const baseID=room.slice(7);c.receive(`|popup|https://replay.pokemonshowdown.com/${baseID}-fixturesecret`);const result=await c.verifyReplay({fetchImpl:async()=>({ok:true,json:async()=>({id:baseID,log:'|win|Alice'})})});assert(result.verified);});

test('challenge changes while broker returns prevent stale authentication submission',async()=>{const {c}=setup();c.challenge='1|fixture';let sends=0;c.ws.send=()=>sends++;c.broker={login:async()=>{c.receive('|challstr|2|new');return 'test,1,fixture;signature';}};await assert.rejects(c.authenticate('Test',{approved:true}),/changed/);assert.equal(sends,0);});

test('team fingerprint configuration fails closed',()=>{for(const expectedTeamHash of ['',null,'xyz','A'.repeat(64)]) assert.throws(()=>new ShowdownClient({expectedTeamHash}),/SHA-256/);assert.doesNotThrow(()=>new ShowdownClient({expectedTeamHash:'a'.repeat(64)}));});

test('new search generation requires observed server activity then authoritative idle',()=>{const {c,grant,sent}=setup();grant('upload-team','');c.uploadTeam('Species|item|ability|move');c.formats='[Gen 9] Champions VGC 2026 Reg M-C (Bo3),e';grant('search','');c.search();c.receive('|updatesearch|{"searching":[],"games":null}');grant('search','');assert.throws(()=>c.search(),/active or unacknowledged/);c.receive('|updatesearch|{"searching":["gen9championsvgc2026regmcbo3"],"games":{}}');c.receive('|updatesearch|{"searching":[],"games":{"game-bestof-1":"fixture"}}');grant('search','');assert.throws(()=>c.search(),/active or unacknowledged/);c.receive('|updatesearch|{"searching":[],"games":null}');grant('search','');c.search();assert.equal(sent.filter(x=>x.startsWith('|/search')).length,2);grant('search','');assert.throws(()=>c.search(),/active or unacknowledged/);});
