import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Writable} from 'node:stream';
import {attachTerminalLog,formatBattleEvent} from './terminal-log.mjs';
import {ShowdownClient} from './client.mjs';

const room = 'battle-gen9championsvgc2026regmcbo3-123';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const client = new EventEmitter(); let rendered = '',time = 1000;
  const output = new Writable({write(chunk,_encoding,done) { rendered += chunk; done(); }});
  const cleanup = attachTerminalLog(client,{output,now:()=>time});
  return {client,output,cleanup,rendered:()=>rendered,setTime:value=>{time=value;}};
}

test('streams a realistic protocol sequence and labels server submission separately from battle execution',async()=>{
  let rendered = '';
  const output = new Writable({write(chunk,_encoding,done) { rendered += chunk; done(); }});
  const client = new ShowdownClient();
  const cleanup = attachTerminalLog(client,{output,now:()=>1000});
  client.receive(`>${room}\n|player|p1|TofuRotom|1|\n|teampreview\n|start\n|switch|p1a: Kommo-o|Kommo-o, L50, M|182/182\n|switch|p2a: Archaludon|Archaludon, L50, M|100/100\n|turn|1\n|sentchoice|move 3 1, move 1\n|move|p1a: Kommo-o|Aura Sphere|p2a: Archaludon\n|-supereffective|p2a: Archaludon\n|-damage|p2a: Archaludon|28/100\n|-boost|p2a: Archaludon|def|1\n|-weather|RainDance|[from] ability: Drizzle\n|-fieldstart|move: Grassy Terrain|[from] ability: Grassy Surge\n|-status|p1a: Kommo-o|par\n|-heal|p1a: Kommo-o|155/182 par|[from] item: Sitrus Berry\n|faint|p2a: Archaludon\n|win|TofuRotom`);
  assert.match(rendered,/\[Battle 123\] Turn 1/);
  assert.match(rendered,/Choice confirmed submitted by server; waiting for resolution/);
  assert.match(rendered,/Kommo-o used Aura Sphere → p2a: Archaludon/);
  assert.match(rendered,/Archaludon HP → 28\/100/);
  assert.match(rendered,/Defense \+1/);
  assert.match(rendered,/Rain began/);
  assert.match(rendered,/Grassy Terrain started/);
  assert.match(rendered,/is paralyzed/);
  assert.match(rendered,/healed; HP → 155\/182 par/);
  assert.match(rendered,/Archaludon fainted/);
  assert.equal((rendered.match(/Winner: TofuRotom/g)||[]).length,1);
  assert(!rendered.includes('move 3 1'));
  cleanup(); await tick(); await tick();
  assert.equal(output.listenerCount('error'),0);
});

test('renders readiness, timer, forced replacements, search state, and elapsed time',async()=>{
  const f = fixture();
  f.client.emit('search-state',{searching:['format'],games:null});
  f.client.emit('search-state',{searching:['format'],games:null});
  f.setTime(42000);
  f.client.emit('timer',{room,text:'TofuRotom has 30 seconds left.'});
  f.client.emit('ready',{room:'game-bestof3-gen9championsvgc2026regmcbo3-45'});
  f.client.emit('request',{room,request:{rqid:7,forceSwitch:[true,false]}});
  f.client.emit('request',{room,request:{rqid:8,teamPreview:true}});
  f.client.emit('request',{room,request:{rqid:9,wait:true}});
  f.client.emit('search-state',{searching:[],games:{[room]:'private title'}});
  f.client.emit('search-state',{searching:[],games:null});
  f.client.emit('choice-status',{room,submitted:false});
  f.client.emit('result',{room,type:'tie'});
  assert.equal((f.rendered().match(/Searching for a battle/g)||[]).length,1);
  assert.match(f.rendered(),/\[\+00:41\].*Timer: TofuRotom has 30 seconds left/);
  assert.match(f.rendered(),/\[Set 45\] Ready confirmation requested/);
  assert.match(f.rendered(),/Replacement required \(request 7\)/);
  assert.match(f.rendered(),/Choose your team and leads \(request 8\)/);
  assert.match(f.rendered(),/Waiting for the opponent/);
  assert.match(f.rendered(),/Battle rooms active: 1/);
  assert(!f.rendered().includes('private title'));
  assert.match(f.rendered(),/Search idle/);
  assert.match(f.rendered(),/Server reports no submitted choice/);
  assert.match(f.rendered(),/Result: tie/);
  f.cleanup(); await tick();
});

test('never renders chat, HTML, authentication, arbitrary unknown protocol messages, or server error bodies',async()=>{
  const f = fixture();
  for (const name of ['challenge','identity','server-notice','authentication-submitted']) f.client.emit(name,{text:'secret assertion'});
  for (const type of ['c','chat','html','uhtml','error','challstr','updateuser','-message','unknown']) {
    f.client.emit('battle-event',{room,type,data:['secret assertion','<script>malicious HTML</script>']});
  }
  f.client.emit('timer',{room,text:'<b>secret assertion</b>'});
  f.client.emit('server-error',{room,text:'password=secret assertion'});
  assert(!f.rendered().includes('secret'));
  assert(!f.rendered().includes('script'));
  assert.match(f.rendered(),/Server reported an action error/);
  f.cleanup(); await tick();
});

test('strips terminal escapes, line breaks, controls, and bidi characters from every displayed server field',async()=>{
  const f = fixture();
  const malicious = '\u001b[2J\u001b]0;bad-title\u0007p1a: Clean\n\r\u0000\u202eName';
  f.client.emit('battle-event',{room:'battle-\u001b[2Jcustom\nroom',type:'move',data:[malicious,'Aura\u001b[31m Sphere','p2a: Target\u009b31m']});
  f.client.emit('timer',{room,text:'30 seconds\n\u001b[2Jleft\u202e.'});
  f.client.emit('result',{room,type:'win',winner:'Alice\r\n\u001b]8;;https://bad\u0007Bob\u001b]8;;\u0007'});
  const rendered = f.rendered();
  assert(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/.test(rendered));
  assert(!rendered.includes('bad-title'));
  assert(!rendered.includes('https://bad'));
  assert.equal(rendered.split('\n').filter(Boolean).length,3);
  assert.match(rendered,/Clean Name used Aura Sphere/);
  f.cleanup(); await tick();
});

test('malformed fields and HTML in otherwise known event types are hidden without breaking subsequent events',async()=>{
  const f = fixture();
  for (const event of [null,{type:'move',data:null},{type:'move',data:[{},'<b>bad</b>']},{type:'-boost',data:['A','spe','100']},{type:'turn',data:['<b>1</b>']}]) f.client.emit('battle-event',event);
  f.client.emit('request',{room,request:{forceSwitch:{some:'invalid'}}});
  f.client.emit('battle-event',{room,type:'turn',data:['2']});
  assert.match(f.rendered(),/Turn 2/);
  assert(!f.rendered().includes('bad'));
  assert(!f.rendered().includes('100'));
  f.cleanup(); await tick();
});

test('cleanup is idempotent and detaches every client subscription',async()=>{
  const f = fixture();
  f.client.emit('battle-event',{room,type:'turn',data:['1']});
  f.cleanup(); f.cleanup();
  f.client.emit('battle-event',{room,type:'turn',data:['2']});
  f.client.emit('ready',{room});
  assert(!f.rendered().includes('Turn 2'));
  assert(!f.rendered().includes('Ready'));
  assert.equal(f.client.eventNames().length,0);
  await tick(); await tick(); assert.equal(f.output.listenerCount('error'),0);
});

test('synchronous output failures and asynchronous EPIPE errors stop logging without throwing or affecting the client',async()=>{
  for (const asynchronous of [false,true]) {
    const client = new EventEmitter();
    const output = new Writable({write(_chunk,_encoding,done) { if (asynchronous) setImmediate(()=>done(Object.assign(new Error('closed pipe'),{code:'EPIPE'}))); else throw new Error('closed terminal'); }});
    const cleanup = attachTerminalLog(client,{output});
    assert.doesNotThrow(()=>client.emit('battle-event',{room,type:'turn',data:['1']}));
    await tick(); await tick();
    assert.doesNotThrow(()=>client.emit('ready',{room}));
    assert.equal(client.eventNames().length,0);
    cleanup(); await tick();
    assert.equal(output.listenerCount('error'),0);
  }
});

test('cleanup during a pending failed write still absorbs its later error event',async()=>{
  const client = new EventEmitter(); let finish;
  const output = new Writable({write(_chunk,_encoding,done) { finish=done; }});
  const cleanup = attachTerminalLog(client,{output});
  client.emit('battle-event',{room,type:'turn',data:['1']});
  cleanup();
  finish(Object.assign(new Error('pipe closed'),{code:'EPIPE'}));
  await tick(); await tick();
  assert.equal(output.listenerCount('error'),0);
});

test('field, protection, ability, item, and recovery events preserve observations without computing damage or speed',()=>{
  const format = (type,...data)=>formatBattleEvent({type,data});
  assert.equal(format('-sidestart','p1: Alice','move: Tailwind'),'p1: Alice: Tailwind started.');
  assert.equal(format('-fieldend','move: Trick Room'),'Trick Room ended.');
  assert.equal(format('-weather','RainDance','[upkeep]'),null);
  assert.equal(format('-weather','none'),'Weather ended.');
  assert.equal(format('-singleturn','p1a: A','Protect'),'p1a: A: Protect.');
  assert.equal(format('-enditem','p1a: A','Sitrus Berry'),'p1a: A\'s Sitrus Berry was consumed or removed.');
  assert.equal(format('-ability','p1a: A','Drizzle'),'p1a: A\'s ability: Drizzle.');
  assert.equal(format('-unboost','p1a: A','def','1'),'p1a: A: Defense −1.');
  assert.equal(format('win','Alice'),null);
  assert.equal(format('tie'),null);
});

test('streams sent, accepted, observed resolution, and rejection without duplicate server acknowledgments',async()=>{
  const f = fixture();
  f.client.emit('action-status',{room,status:'sent'});
  f.client.emit('choice-status',{room,submitted:true});
  f.client.emit('action-status',{room,status:'accepted'});
  f.client.emit('action-status',{room,status:'execution-observed',evidence:{type:'move',slot:'p1a',move:'Aura Sphere'}});
  assert.match(f.rendered(),/Choice sent; awaiting server confirmation/);
  assert.equal((f.rendered().match(/Choice confirmed submitted by server/g)||[]).length,1);
  assert.match(f.rendered(),/Action resolution observed \(move, slot p1a, Aura Sphere\)/);
  assert(!f.rendered().includes('turn completed'));
  f.client.emit('action-status',{room,status:'sent'});
  f.client.emit('action-status',{room,status:'accepted'});
  f.client.emit('choice-status',{room,submitted:true});
  assert.equal((f.rendered().match(/Choice confirmed submitted by server/g)||[]).length,2);
  f.client.emit('action-status',{room,status:'rejected',evidence:{type:'<b>secret</b>',move:'password'}});
  assert.match(f.rendered(),/Server rejected the choice/);
  assert(!f.rendered().includes('password'));
  f.client.emit('action-status',{room,status:'execution-observed',evidence:{type:'cant',slot:2,move:'Protect\u001b[31m'}});
  assert.match(f.rendered(),/Action resolution observed \(cant, slot 2, Protect\)/);
  f.cleanup(); await tick(); await tick();
});

test('legacy acknowledgments reset only for a changed actionable request',async()=>{
  const f = fixture();
  const request = {rqid:7,active:[{}]};
  f.client.emit('request',{room,revision:1,request});
  f.client.emit('choice-status',{room,submitted:true});
  f.client.emit('request',{room,revision:1,request});
  f.client.emit('choice-status',{room,submitted:true});
  assert.equal((f.rendered().match(/Choice confirmed submitted by server/g)||[]).length,1);
  f.client.emit('request',{room,revision:2,request:{...request,rqid:8}});
  f.client.emit('choice-status',{room,submitted:true});
  assert.equal((f.rendered().match(/Choice confirmed submitted by server/g)||[]).length,2);
  f.cleanup(); await tick(); await tick();
});

test('prints official set and game URLs once from server games keys, including when room counts do not change',async()=>{
  const f=fixture();
  const set='game-bestof3-gen9championsvgc2026regmcbo3-1001';
  const game1='battle-gen9championsvgc2026regmcbo3-1002';
  const game2='battle-gen9championsvgc2026regmcbo3-1003';
  const state=game=>({searching:[],games:{[set]:'Do not render this title',[game]:'another title'}});
  f.client.emit('search-state',state(game1));
  f.client.emit('search-state',state(game1));
  f.client.emit('battle-event',{room:game1,type:'start',data:[]});
  // The second game replaces the first, so the active-room count is unchanged.
  f.client.emit('search-state',state(game2));
  f.client.emit('battle-event',{room:game2,type:'start',data:[]});
  const urls=f.rendered().split('\n').filter(line=>line.includes('https://'));
  assert.equal(urls.length,3);
  assert.match(urls[0],new RegExp(`Watch set: https://play\\.pokemonshowdown\\.com/${set}$`));
  assert.match(urls[1],new RegExp(`Watch battle: https://play\\.pokemonshowdown\\.com/${game1}$`));
  assert.match(urls[2],new RegExp(`Watch battle: https://play\\.pokemonshowdown\\.com/${game2}$`));
  assert(!f.rendered().includes('Do not render this title'));
  assert(!f.rendered().includes('another title'));
  f.cleanup();await tick();await tick();
});

test('prints a game URL from an actual start event and preserves its entire private suffix',async()=>{
  const f=fixture();
  const privateRoom='battle-gen9championsvgc2026regmcbo3-1003-'+('a'.repeat(180))+'pw';
  f.client.emit('battle-event',{room:privateRoom,type:'turn',data:['1']});
  assert(!f.rendered().includes('https://'));
  f.client.emit('battle-event',{room:privateRoom,type:'start',data:[]});
  f.client.emit('battle-event',{room:privateRoom,type:'start',data:[]});
  f.client.emit('search-state',{searching:[],games:{[privateRoom]:'private battle'}});
  const urls=f.rendered().split('\n').filter(line=>line.includes('https://'));
  assert.equal(urls.length,1);
  assert(urls[0].endsWith('https://play.pokemonshowdown.com/'+privateRoom));
  f.cleanup();await tick();await tick();
});

test('never discovers battle URLs from chat, HTML, titles, readiness, or malformed room IDs',async()=>{
  const f=fixture(),other='battle-gen9championsvgc2026regmcbo3-555';
  for(const type of ['c','html','uhtml','unknown'])f.client.emit('battle-event',{room,type,data:['opponent',`https://play.pokemonshowdown.com/${other}`]});
  f.client.emit('ready',{room:other});
  f.client.emit('request',{room:other,request:{teamPreview:true}});
  const invalid=['lobby','battle-','game-bestof0-gen9-123','battle-gen9-123/evil','battle-gen9-123\n','battle-gen9-123?next=https://evil.example','<a href="/battle-gen9-123">'];
  f.client.emit('search-state',{searching:[],games:Object.fromEntries(invalid.map(id=>[id,'https://evil.example']))});
  for(const id of invalid)f.client.emit('battle-event',{room:id,type:'start',data:[]});
  assert(!f.rendered().includes('https://'));
  assert(!f.rendered().includes('evil.example'));
  f.cleanup();await tick();await tick();
});
