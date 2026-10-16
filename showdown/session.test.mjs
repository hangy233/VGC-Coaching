import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Writable} from 'node:stream';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {runSession,parseSessionArgs} from './session.mjs';
import {ShowdownClient} from './client.mjs';
import {callLocalSession} from './local-bridge.mjs';

// Self-contained native Champions team; no dependence on a user's untracked files.
const TEAM = `Golisopod-Mega @ Golisopite
Ability: Emergency Exit
Level: 50
EVs: 32 HP / 32 Atk / 2 SpD
Brave Nature
- Sucker Punch
- Iron Head
- Leech Life
- Protect

Kommo-o @ Sitrus Berry
Ability: Soundproof
Level: 50
EVs: 32 HP / 12 Def / 22 SpA
Modest Nature
- Clangorous Soul
- Clanging Scales
- Aura Sphere
- Protect

Rillaboom @ Miracle Seed
Ability: Grassy Surge
Level: 50
EVs: 25 HP / 32 Atk / 1 Def / 6 SpD / 2 Spe
Adamant Nature
- Wood Hammer
- Grassy Glide
- High Horsepower
- Fake Out

Politoed @ Leftovers
Ability: Drizzle
Level: 50
EVs: 32 HP / 2 Def / 32 SpA
Modest Nature
- Weather Ball
- Muddy Water
- Ice Beam
- Protect

Farigiraf @ Grassy Seed
Ability: Armor Tail
Level: 50
EVs: 32 HP / 16 Def / 18 SpD
Sassy Nature
- Psychic
- Helping Hand
- Trick Room
- Protect

Sylveon @ Fairy Feather
Ability: Pixilate
Level: 50
EVs: 32 HP / 2 Def / 32 SpA
Quiet Nature
- Hyper Voice
- Hyper Beam
- Calm Mind
- Protect
`;
const ASSERTION = 'synthetic-assertion-not-a-real-credential';
const CHALLENGE = '1|synthetic-challenge';
const deadline = (promise,ms=3000) => {
  let timer;
  return Promise.race([promise,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Synthetic session lifecycle timed out')),ms);})]).finally(()=>clearTimeout(timer));
};

function terminal() {
  let rendered = '';
  const updates = new EventEmitter();
  const output = new Writable({write(chunk,_encoding,done) { rendered+=chunk;updates.emit('text');done(); }});
  output.isTTY=true;
  const input = Object.assign(new EventEmitter(),{isTTY:true,setRawMode(){}});
  const until = pattern => {
    if(pattern.test(rendered))return Promise.resolve();
    return new Promise(resolve=>{const onText=()=>{if(pattern.test(rendered)){updates.off('text',onText);resolve();}};updates.on('text',onText);});
  };
  return {input,output,rendered:()=>rendered,until};
}

class SyntheticClient extends ShowdownClient {
  constructor(options) {
    super(options);this.connectCalls=0;this.closeCalls=0;this.commands=[];
    // This transport never opens a socket. The real authenticate implementation
    // still exercises broker handoff and server identity acknowledgment.
    this.ws={readyState:1,send:command=>{
      if(command.startsWith('|/trn '))queueMicrotask(()=>this.receive('|updateuser|TofuRotom|1|1'));
      else this.commands.push(command);
    },close:()=>this.close()};
  }
  async connect() {
    this.connectCalls++;this.connected=true;this.epoch++;
    this.formats='[Gen 9] Champions VGC 2026 Reg M-C (Bo3),e';
    queueMicrotask(()=>this.receive('|challstr|'+CHALLENGE));
  }
  close() {this.closeCalls++;this.connected=false;this.authenticated=false;this.emit('disconnected');}
}

async function fixture({login=async()=>ASSERTION,disconnectDuringSetup=false,autoReady=true,loginMethod='terminal'}={}) {
  const directory=await mkdtemp(join(tmpdir(),'vgc-session-'));
  const teamFile=join(directory,'team.txt'),descriptorPath=join(directory,'control.json');
  await writeFile(teamFile,TEAM);
  const tty=terminal(),signals=new EventEmitter(),loginCalls=[],brokerOptions=[];let client;
  const options={username:'TofuRotom',teamFile,descriptorPath,authorizedSets:1,autoReady,loginMethod,input:tty.input,output:tty.output,signals,
    brokerFactory:configuration=>{brokerOptions.push(configuration);return {login:async context=>{loginCalls.push({username:context.username,origin:context.origin});assert.equal(context.challenge,CHALLENGE);return login(context);}};},
    clientFactory:configuration=>{
      client=new SyntheticClient(configuration);
      if(disconnectDuringSetup){
        let connect=client.connect;
        Object.defineProperty(client,'connect',{configurable:true,get:()=>connect,set:value=>{
          connect=value;
          // runSession disables reconnection immediately before asynchronous
          // bridge creation. Disconnect precisely across that setup boundary.
          if(client.authenticated)queueMicrotask(()=>client.close());
        }});
      }
      return client;
    }};
  const running=runSession(options);running.catch(()=>{});
  const cleanup=async()=>{
    client?.close();
    await deadline(running).catch(()=>{});
    await rm(directory,{recursive:true,force:true});
  };
  return {directory,teamFile,descriptorPath,tty,signals,loginCalls,brokerOptions,options,running,client:()=>client,cleanup};
}

test('requires a genuine user TTY before constructing a broker, client, or connection',async()=>{
  for(const loginMethod of ['terminal','windows-credential-manager'])for(const change of [({input})=>{input.isTTY=false;},({output})=>{output.isTTY=false;},({input})=>{delete input.setRawMode;}]){
    const tty=terminal();change(tty);let touched=false;
    await assert.rejects(runSession({username:'TofuRotom',teamFile:'unused-before-TTY-check',loginMethod,input:tty.input,output:tty.output,
      clientFactory:()=>{touched=true;throw new Error('Must not construct');},brokerFactory:()=>{touched=true;throw new Error('Must not construct');}}),/visible user-operated terminal/);
    assert.equal(touched,false);
  }
});

test('rejects invalid teams before authentication or connection',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'vgc-invalid-team-')),teamFile=join(directory,'team.txt'),tty=terminal();let touched=false;
  try{
    await writeFile(teamFile,'Pikachu\n- Protect\n');
    await assert.rejects(runSession({username:'TofuRotom',teamFile,input:tty.input,output:tty.output,
      clientFactory:()=>{touched=true;},brokerFactory:()=>{touched=true;}}),/six-Pokémon team/);
    assert.equal(touched,false);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('login is terminal-only, publishes local controls afterward, streams events, and stops cleanly over IPC',async()=>{
  let finishLogin;
  const f=await fixture({login:()=>new Promise(resolve=>{finishLogin=resolve;})});
  try{
    await deadline(f.tty.until(/Sign in as TofuRotom/));
    await assert.rejects(readFile(f.descriptorPath),/ENOENT/);
    assert(!f.tty.rendered().includes('MCP battle controls are ready'));
    finishLogin(ASSERTION);
    await deadline(f.tty.until(/MCP battle controls are ready/));
    assert.equal(f.client().connectCalls,1);
    assert.deepEqual(f.loginCalls,[{username:'TofuRotom',origin:'https://play.pokemonshowdown.com'}]);
    assert.deepEqual(f.brokerOptions,[{username:'TofuRotom',loginMethod:'terminal'}]);
    const descriptor=JSON.parse(await readFile(f.descriptorPath,'utf8'));
    assert.equal(descriptor.version,1);
    assert.equal(typeof descriptor.address,'string');
    assert(!('port' in descriptor));
    const reply=await callLocalSession(f.descriptorPath,{id:'status',op:'status'});
    assert.equal(reply.ok,true);assert.equal(reply.result.username,'TofuRotom');
    assert.equal(reply.result.authenticated,true);assert.equal(reply.result.searchesSent,0);
    assert.equal(reply.result.authorizedSets,1);assert.equal(reply.result.autoReady,true);
    assert.match(reply.result.teamSha256,/^[a-f0-9]{64}$/);
    assert.equal(reply.result.metrics.enabled,true);assert.equal(reply.result.metrics.teamId,reply.result.teamSha256);
    const synced=await callLocalSession(f.descriptorPath,{id:'metrics-initialize',op:'metrics-sync'});
    assert.equal(synced.ok,true);assert.equal(synced.result.state,'ready');assert.equal(synced.result.stableReport.games,0);
    assert.match(await readFile(synced.result.stableReport.path,'utf8'),/<!doctype html>/i);
    assert.deepEqual(f.client().commands,[]); // Signing in must not search or upload.
    await assert.rejects(f.client().connect(),/new user-operated login/);
    const room='battle-gen9championsvgc2026regmcbo3-321';
    f.client().receive(`>${room}\n|turn|1\n|move|p1a: Kommo-o|Aura Sphere|p2a: Archaludon\n|-damage|p2a: Archaludon|28/100\n|win|TofuRotom`);
    assert.match(f.tty.rendered(),/\[Battle 321\] Turn 1/);
    assert.match(f.tty.rendered(),/Kommo-o used Aura Sphere/);
    assert.match(f.tty.rendered(),/Archaludon HP → 28\/100/);
    assert.match(f.tty.rendered(),/Winner: TofuRotom/);
    for(const entry of await readdir(f.directory,{withFileTypes:true}))if(entry.isFile()){
      const saved=await readFile(join(f.directory,entry.name),'utf8');
      assert(!saved.includes(ASSERTION));assert(!saved.includes(CHALLENGE));assert(!saved.includes('password'));
    }
    assert(!f.tty.rendered().includes(ASSERTION));assert(!f.tty.rendered().includes(CHALLENGE));
    const stopped=await callLocalSession(f.descriptorPath,{id:'stop',op:'stop',confirmed:true});
    assert.equal(stopped.ok,true);assert.equal(stopped.result.stopped,true);
    await deadline(f.running);
    assert.equal(f.client().connected,false);
    await assert.rejects(readFile(f.descriptorPath),/ENOENT/);
    for(const signal of ['SIGINT','SIGTERM','SIGHUP'])assert.equal(f.signals.listenerCount(signal),0);
    assert.equal(f.client().listenerCount('battle-event'),0);
    assert.equal(f.client().listenerCount('disconnected'),0);
    assert.match(f.tty.rendered(),/Connection closed/);
  }finally{await f.cleanup();}
});

test('manual readiness preference reaches the local session and Ctrl-C closes without queuing',async()=>{
  const f=await fixture({autoReady:false});
  try{
    await deadline(f.tty.until(/MCP battle controls are ready/));
    assert.match(f.tty.rendered(),/Auto-ready within the authorized set: off/);
    const status=await callLocalSession(f.descriptorPath,{id:'status',op:'status'});
    assert.equal(status.result.autoReady,false);
    f.signals.emit('SIGINT');
    await deadline(f.running);
    assert.equal(f.client().commands.length,0);
    await assert.rejects(readFile(f.descriptorPath),/ENOENT/);
    assert.equal(f.signals.eventNames().length,0);
  }finally{await f.cleanup();}
});

test('authentication failure closes client and never leaves controls or lifecycle listeners',async()=>{
  const f=await fixture({login:async()=>{throw new Error('Synthetic login declined');}});
  try{
    await assert.rejects(deadline(f.running),/Synthetic login declined/);
    assert.equal(f.client().connected,false);
    await assert.rejects(readFile(f.descriptorPath),/ENOENT/);
    assert.equal(f.signals.eventNames().length,0);
    assert.equal(f.client().listenerCount('challenge'),0);
    assert.equal(f.client().listenerCount('identity'),0);
    assert.equal(f.client().listenerCount('disconnected'),0);
    assert(!f.tty.rendered().includes('MCP battle controls are ready'));
  }finally{await f.cleanup();}
});

test('disconnect during asynchronous bridge setup is observed and removes the descriptor',async()=>{
  const f=await fixture({disconnectDuringSetup:true});
  try{
    await deadline(f.running);
    assert.equal(f.client().connected,false);
    assert.equal(f.client().commands.length,0);
    await assert.rejects(readFile(f.descriptorPath),/ENOENT/);
    assert(!f.tty.rendered().includes('MCP battle controls are ready'));
    assert.equal(f.signals.eventNames().length,0);
    assert.equal(f.client().listenerCount('battle-event'),0);
    assert.equal(f.client().listenerCount('disconnected'),0);
  }finally{await f.cleanup();}
});

test('existing session descriptor is preserved and failed setup still closes the new client',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'vgc-existing-session-')),teamFile=join(directory,'team.txt'),descriptorPath=join(directory,'control.json');
  const previous='{"sessionId":"previous-session","pid":12345}',tty=terminal(),signals=new EventEmitter();let client;
  try{
    await writeFile(teamFile,TEAM);await writeFile(descriptorPath,previous);
    await assert.rejects(deadline(runSession({username:'TofuRotom',teamFile,descriptorPath,input:tty.input,output:tty.output,signals,
      clientFactory:options=>(client=new SyntheticClient(options)),brokerFactory:()=>({login:async()=>ASSERTION})})),/descriptor already exists/);
    assert.equal(await readFile(descriptorPath,'utf8'),previous);
    assert.equal(client.connected,false);assert.equal(client.commands.length,0);
    assert.equal(signals.eventNames().length,0);
    assert.equal(client.listenerCount('disconnected'),0);
    assert(!tty.rendered().includes('MCP battle controls are ready'));
  }finally{client?.close();await rm(directory,{recursive:true,force:true});}
});

test('saved login is explicit in CLI parsing; default and unrelated controls are unchanged',()=>{
  const defaults=parseSessionArgs(['TofuRotom','--team','approved-team.txt']);
  assert.deepEqual(defaults,{username:'TofuRotom',teamFile:resolve('approved-team.txt'),authorizedSets:1,autoReady:true,loginMethod:'terminal',saveReplays:false});
  const saved=parseSessionArgs(['TofuRotom','--saved-login','--team','approved-team.txt','--sets','2','--manual-ready']);
  assert.deepEqual(saved,{...defaults,authorizedSets:2,autoReady:false,loginMethod:'windows-credential-manager'});
  for(const args of [
    ['TofuRotom','--team','approved-team.txt','--password','do-not-echo-me'],
    ['TofuRotom','--team','approved-team.txt','--saved-login=do-not-echo-me'],
    ['TofuRotom','--team','--saved-login'],
    ['TofuRotom','--team','approved-team.txt','--sets'],
    ['TofuRotom','--team','approved-team.txt','--sets','0'],
    ['TofuRotom','--team','approved-team.txt','--sets','1.5'],
    ['TofuRotom','--team','approved-team.txt','--sets','101'],
  ])assert.throws(()=>parseSessionArgs(args),error=>!error.message.includes('do-not-echo-me'));
});

test('unknown login methods fail before any broker, client, or connection',async()=>{
  const tty=terminal();let touched=false;
  await assert.rejects(runSession({username:'TofuRotom',teamFile:'unused-team.txt',loginMethod:'automatic',input:tty.input,output:tty.output,
    brokerFactory:()=>{touched=true;},clientFactory:()=>{touched=true;}}),/Unsupported login method/);
  assert.equal(touched,false);
});

test('explicit saved-login selection passes approved account to its broker and still never searches on login',async()=>{
  const f=await fixture({loginMethod:'windows-credential-manager'});
  try{
    await deadline(f.tty.until(/MCP battle controls are ready/));
    assert.deepEqual(f.brokerOptions,[{username:'TofuRotom',loginMethod:'windows-credential-manager'}]);
    assert.equal(f.loginCalls.length,1);
    assert.match(f.tty.rendered(),/Sign in as TofuRotom using Windows Credential Manager/);
    assert(!f.tty.rendered().includes('password'));
    const status=await callLocalSession(f.descriptorPath,{id:'saved-status',op:'status'});
    assert.equal(status.ok,true);assert.equal(status.result.authenticated,true);assert.equal(status.result.searchesSent,0);
    assert.deepEqual(f.client().commands,[]);
    assert(!JSON.stringify(status).includes(ASSERTION));assert(!f.tty.rendered().includes(ASSERTION));
    const descriptor=await readFile(f.descriptorPath,'utf8');
    assert(!descriptor.includes(ASSERTION));assert(!descriptor.includes(CHALLENGE));
    await callLocalSession(f.descriptorPath,{id:'saved-stop',op:'stop',confirmed:true});
    await deadline(f.running);
    assert.equal(f.client().connected,false);
    await assert.rejects(readFile(f.descriptorPath),/ENOENT/);
  }finally{await f.cleanup();}
});

test('saved-login failure makes one attempt without falling back to terminal login',async()=>{
  const f=await fixture({loginMethod:'windows-credential-manager',login:async()=>{throw new Error('Synthetic saved login unavailable');}});
  try{
    await assert.rejects(deadline(f.running),/Synthetic saved login unavailable/);
    assert.deepEqual(f.brokerOptions,[{username:'TofuRotom',loginMethod:'windows-credential-manager'}]);
    assert.equal(f.loginCalls.length,1);assert.equal(f.client().connectCalls,1);
    assert.equal(f.client().connected,false);
    assert(!f.tty.rendered().includes('MCP battle controls are ready'));
    await assert.rejects(readFile(f.descriptorPath),/ENOENT/);
    assert.equal(f.signals.eventNames().length,0);
  }finally{await f.cleanup();}
});
