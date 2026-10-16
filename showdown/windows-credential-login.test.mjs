import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {createWindowsCredentialBroker,windowsCredentialTarget} from './windows-credential-login.mjs';

const context={username:'TofuRotom',challenge:'1|synthetic-public-challenge',origin:'https://play.pokemonshowdown.com'};
// The pinned server's validateToken destructures challenge before userid.
const signedData='synthetic-public-challenge,tofurotom,2,1792100000,sim3.psim.us';
const assertion=signedData+';synthetic-signature';
const success={ok:true,username:'tofurotom',assertion};
const SECRET='synthetic-password-must-never-reach-node-output';
function helper({reply=success,exitCode=0,hang=false,onInput}={}){
  const calls=[];
  const spawnImpl=(executable,args,options)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.killed=false;
    child.kill=()=>{child.killed=true;queueMicrotask(()=>child.emit('close',null));return true;};
    let input='';
    child.stdin=new Writable({write(chunk,_encoding,callback){input+=chunk.toString();callback();},final(callback){
      calls.at(-1).input=input;
      queueMicrotask(()=>{
        onInput?.(child);
        if(!hang){const text=typeof reply==='string'?reply:JSON.stringify(reply);child.stdout.write(text.slice(0,7));child.stdout.write(text.slice(7));child.emit('close',exitCode);}
      });callback();
    }});
    calls.push({executable,args,options,child,input:null});return child;
  };
  return {spawnImpl,calls};
}
const broker=(fake,options={})=>createWindowsCredentialBroker({username:'TofuRotom',platform:'win32',spawnImpl:fake.spawnImpl,...options});
function redacted(code){return error=>{
  assert.equal(error.code,code);assert(!error.message.includes(SECRET));assert(!error.stack.includes(SECRET));
  assert.equal(Object.getOwnPropertyDescriptor(error,'code').writable,false);return true;
};}

test('opt-in saved login pins one approved account and never accepts target overrides',async()=>{
  assert.equal(windowsCredentialTarget('Tofu Rotom'),'VGC-Coaching/PokemonShowdown/tofurotom');
  assert.throws(()=>createWindowsCredentialBroker(),redacted('INVALID_LOGIN_CONTEXT'));
  assert.throws(()=>windowsCredentialTarget('../other'),redacted('INVALID_LOGIN_CONTEXT'));
  const fake=helper();
  for(const invalid of [{username:'Other'},{origin:'https://evil.example'},{challenge:'not-a-challenge'},{challenge:'1|a\nb'},{challenge:'1|x|y'},{challenge:'1|'+'x'.repeat(8193)}])await assert.rejects(broker(fake).login({...context,...invalid}),redacted('INVALID_LOGIN_CONTEXT'));
  assert.equal(fake.calls.length,0);
});

test('unsupported platforms and stale contexts never spawn or read the vault',async()=>{
  const fake=helper();
  await assert.rejects(broker(fake,{platform:'linux'}).login(context),redacted('SAVED_LOGIN_UNAVAILABLE_PLATFORM'));
  await assert.rejects(broker(fake).login({...context,isCurrent:()=>false}),redacted('STALE_SESSION'));
  await assert.rejects(broker(fake).login({...context,isCurrent:()=>{throw new Error(SECRET);}}),redacted('STALE_SESSION'));
  const abort=new AbortController();abort.abort();
  await assert.rejects(broker(fake).login({...context,signal:abort.signal}),redacted('STALE_SESSION'));
  assert.equal(fake.calls.length,0);
});

test('helper receives only nonpassword context privately and returns a matching assertion',async()=>{
  const fake=helper();assert.equal(await broker(fake).login(context),assertion);
  assert.equal(fake.calls.length,1);const call=fake.calls[0];
  assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);
  assert.deepEqual(call.options.stdio,['pipe','pipe','ignore']);
  assert(call.args.includes('-NoProfile'));assert(call.args.includes('-NonInteractive'));
  assert(!JSON.stringify(call.args).includes(context.username));assert(!JSON.stringify(call.args).includes(context.challenge));
  assert.deepEqual(JSON.parse(call.input),context);
  assert(!call.input.includes('password'));assert(!call.input.includes('assertion'));
});

test('helper errors use an allowlist and cannot forward raw errors or password fields',async()=>{
  for(const code of ['SAVED_CREDENTIAL_NOT_FOUND','SAVED_CREDENTIAL_ACCOUNT_MISMATCH','SAVED_CREDENTIAL_INVALID','SAVED_CREDENTIAL_UNAVAILABLE','LOGIN_NETWORK','LOGIN_REJECTED','INVALID_LOGIN_RESPONSE']){
    const fake=helper({reply:{ok:false,code},exitCode:1});
    await assert.rejects(broker(fake).login(context),redacted(code));assert.equal(fake.calls.length,1);
  }
  for(const reply of [SECRET,'null',[],{ok:false,code:SECRET},{ok:false,code:'LOGIN_REJECTED',message:SECRET},{...success,password:SECRET},{...success,username:'other'},{...success,username:{toString:SECRET}},{...success,assertion:'synthetic-public-challenge,other,2,1792100000,sim3.psim.us;synthetic-signature'},{...success,assertion:assertion+'\n'}]){
    const fake=helper({reply});await assert.rejects(broker(fake).login(context),redacted('INVALID_LOGIN_RESPONSE'));
    assert.equal(fake.calls.length,1);
  }
});

test('assertion contract binds challenge field 0 and userid field 1, with five fields and a signature',async()=>{
  for(const invalid of [
    'different-challenge,tofurotom,2,1792100000,sim3.psim.us;synthetic-signature',
    '1|synthetic-public-challenge,tofurotom,2,1792100000,sim3.psim.us;synthetic-signature',
    'synthetic-public-challenge,other,2,1792100000,sim3.psim.us;synthetic-signature',
    'synthetic-public-challenge,TofuRotom,2,1792100000,sim3.psim.us;synthetic-signature',
    'tofurotom,synthetic-public-challenge,2,1792100000,sim3.psim.us;synthetic-signature',
    'tofurotom,1,synthetic-time,synthetic-host;synthetic-signature',
    'synthetic-public-challenge,tofurotom,2,1792100000;synthetic-signature',
    signedData,
    signedData+';',
    signedData+';   ',
  ]){
    const fake=helper({reply:{...success,assertion:invalid}});
    await assert.rejects(broker(fake).login(context),redacted('INVALID_LOGIN_RESPONSE'));
    assert.equal(fake.calls.length,1);
  }
  const keyID=helper();
  assert.equal(await broker(keyID).login({...context,challenge:'87|synthetic-public-challenge'}),assertion);
  const extended=assertion.replace(';',',future-field;'),future=helper({reply:{...success,assertion:extended}});
  assert.equal(await broker(future).login(context),extended);
});

test('spawn failures and nonzero success envelopes are redacted without retry or fallback',async()=>{
  let calls=0;const fake={spawnImpl:()=>{calls++;throw Object.assign(new Error(SECRET),{code:'LOGIN_REJECTED'});}};
  await assert.rejects(broker(fake).login(context),redacted('SAVED_LOGIN_HELPER_FAILED'));assert.equal(calls,1);
  const nonzero=helper({exitCode:1});await assert.rejects(broker(nonzero).login(context),redacted('INVALID_LOGIN_RESPONSE'));
});

test('abort, changed session, timeout, child errors and output cap terminate the helper',async()=>{
  const abort=new AbortController();const cancelled=helper({hang:true});
  const pending=broker(cancelled).login({...context,signal:abort.signal});abort.abort();
  await assert.rejects(pending,redacted('STALE_SESSION'));assert(cancelled.calls[0].child.killed);
  let current=true;const stale=helper({onInput:()=>{current=false;}});
  await assert.rejects(broker(stale).login({...context,isCurrent:()=>current}),redacted('STALE_SESSION'));assert(stale.calls[0].child.killed);
  const timed=helper({hang:true});await assert.rejects(broker(timed,{timeoutMs:100}).login(context),redacted('SAVED_LOGIN_HELPER_TIMEOUT'));assert(timed.calls[0].child.killed);
  const errored=helper({hang:true,onInput:child=>child.emit('error',Object.assign(new Error(SECRET),{code:'LOGIN_REJECTED'}))});
  await assert.rejects(broker(errored).login(context),redacted('SAVED_LOGIN_HELPER_FAILED'));assert(errored.calls[0].child.killed);
  const outputError=helper({hang:true,onInput:child=>child.stdout.emit('error',new Error(SECRET))});
  await assert.rejects(broker(outputError).login(context),redacted('SAVED_LOGIN_HELPER_FAILED'));assert(outputError.calls[0].child.killed);
  const tooLarge=helper({reply:'x'.repeat(1025)});await assert.rejects(broker(tooLarge,{maxOutputBytes:1024}).login(context),redacted('INVALID_LOGIN_RESPONSE'));assert(tooLarge.calls[0].child.killed);
});

test('helper source restricts vault access and HTTPS behavior without executing credential operations',async()=>{
  const source=await readFile(new URL('./windows-credential-helper.ps1',import.meta.url),'utf8');
  assert(source.includes("$target = 'VGC-Coaching/PokemonShowdown/' + $account"));
  assert(source.includes('CredRead(target, 1, 0, out pointer)'));
  assert(!/CredEnumerate|CredWrite|Get-StoredCredential|Export-Clixml|Write-Host/.test(source));
  assert(source.includes('$handler.AllowAutoRedirect = $false'));assert(source.includes('$handler.UseCookies = $false'));
  assert(source.includes("'https://play.pokemonshowdown.com/api/login'"));
  assert(source.includes('CancellationTokenSource]::new(15000)'));assert(source.includes('$memory.Length + $count -gt 65536'));
  assert(source.includes('[Console]::Out.WriteLine($reply)'));assert(!source.includes('$_'));
  assert(source.includes("$tokenFields[0] -cne $challenge.Substring($challenge.IndexOf('|') + 1)"));
  assert(source.includes('$tokenFields[1] -cne $account'));
  assert(source.includes('$tokenFields.Length -lt 5'));
  assert(source.includes('[string]::IsNullOrWhiteSpace($assertion.Substring($separator + 1))'));
});
