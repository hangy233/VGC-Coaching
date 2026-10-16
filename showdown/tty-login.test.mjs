import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {readHiddenPassword,createTTYBroker,LOGIN_URL} from './tty-login.mjs';
function terminal(){const input=new PassThrough(),output=new PassThrough(),signals=new EventEmitter();input.isTTY=true;output.isTTY=true;input.isRaw=false;const raw=[];input.setRawMode=value=>{raw.push(value);input.isRaw=value;};let printed='';output.on('data',x=>printed+=x.toString());return {input,output,signals,raw,printed:()=>printed};}
test('hidden terminal prompt echoes no password and requires user Enter; restores mode',async()=>{const t=terminal(),p=readHiddenPassword(t);t.input.write('synthetic');let resolved=false;p.then(()=>resolved=true);await Promise.resolve();assert(!resolved);assert(!t.printed().includes('synthetic'));t.input.write('\r');assert.equal(await p,'synthetic');assert.deepEqual(t.raw,[true,false]);assert.equal(t.input.listenerCount('data'),0);assert.equal(t.signals.listenerCount('SIGTERM'),0);});
test('nonTTY input/output fail before reading anything',async()=>{for(const side of ['input','output']){const t=terminal();t[side].isTTY=false;await assert.rejects(readHiddenPassword(t),/TTY/);assert.deepEqual(t.raw,[]);}});
test('backspace handles Unicode without echo',async()=>{const t=terminal(),p=readHiddenPassword(t);t.input.write('aé\x7fb\r');assert.equal(await p,'ab');assert(!t.printed().includes('aé'));});
test('cancel, EOF, timeout, input failure, length and signals all restore echo',async()=>{for(const mode of ['ctrlc','eof','timeout','error','length','signal']){const t=terminal(),p=readHiddenPassword({...t,timeoutMs:mode==='timeout'?5:1000});if(mode==='ctrlc')t.input.write('fixture\x03');if(mode==='eof')t.input.end();if(mode==='error')t.input.emit('error',new Error('do not leak fixture'));if(mode==='length')t.input.write('x'.repeat(1025));if(mode==='signal')t.signals.emit('SIGTERM');await assert.rejects(p);assert.equal(t.input.isRaw,false);assert(!t.printed().includes('fixture'));}});
test('existing raw mode is restored; incomplete escape sequence fails closed',async()=>{const t=terminal();t.input.isRaw=true;const p=readHiddenPassword(t);t.input.write('\x1b[A');await assert.rejects(p,/control/);assert.equal(t.input.isRaw,true);});
test('broker sends user-entered password only to fixed HTTPS endpoint and keeps proof off output',async()=>{let called=0;const broker=createTTYBroker({prompt:async()=> 'fixture-password',fetchImpl:async(url,options)=>{called++;assert.equal(url,LOGIN_URL);assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.body.get('pass'),'fixture-password');assert.equal(options.body.get('challstr'),'1|fixture-challenge');return {ok:true,text:async()=>']'+JSON.stringify({curuser:{loggedin:true,username:'Test'},assertion:'test,1,fixture;signature'})};}});assert.equal(await broker.login({username:'Test',challenge:'1|fixture-challenge',origin:'https://play.pokemonshowdown.com'}),'test,1,fixture;signature');assert.equal(called,1);});
test('broker rejects wrong origin before prompting and redacts every failure',async()=>{let prompts=0;const broker=createTTYBroker({prompt:async()=>{prompts++;return 'fixture-secret';},fetchImpl:async()=>{throw new Error('fixture-secret');}});await assert.rejects(broker.login({username:'Test',challenge:'x',origin:'https://evil.example'}),/context/);assert.equal(prompts,0);await assert.rejects(broker.login({username:'Test',challenge:'x',origin:'https://play.pokemonshowdown.com'}),e=>!e.message.includes('fixture-secret')&&e.message.includes('not completed'));});
test('broker rejects mismatched account and never retries failed login',async()=>{let calls=0;const broker=createTTYBroker({prompt:async()=> 'fixture',fetchImpl:async()=>{calls++;return {ok:true,text:async()=>JSON.stringify({curuser:{loggedin:true,username:'Other'},assertion:'other,1,fixture;signature'})};}});await assert.rejects(broker.login({username:'Test',challenge:'x',origin:'https://play.pokemonshowdown.com'}));assert.equal(calls,1);});
test('disconnect abort restores prompt and stale challenge never transmits credentials',async()=>{const t=terminal(),abort=new AbortController(),p=readHiddenPassword({...t,signal:abort.signal});t.input.write('fixture');abort.abort();await assert.rejects(p,/cancelled/);assert.equal(t.input.isRaw,false);let calls=0,current=true;const broker=createTTYBroker({prompt:async()=>{current=false;return 'fixture';},fetchImpl:async()=>{calls++;throw new Error('must not run');}});await assert.rejects(broker.login({username:'Test',challenge:'x',origin:'https://play.pokemonshowdown.com',isCurrent:()=>current}));assert.equal(calls,0);});

test('broker preserves trusted terminal timeout, cancellation and input-stage codes without transmitting credentials',async()=>{
  for(const [mode,code] of [['timeout','TERMINAL_TIMEOUT'],['cancel','TERMINAL_CANCELLED'],['input','TERMINAL_INPUT_ERROR']]){
    const t=terminal();let calls=0;
    const broker=createTTYBroker({prompt:()=>readHiddenPassword({...t,timeoutMs:mode==='timeout'?5:1000}),fetchImpl:async()=>{calls++;throw new Error('synthetic-secret');}});
    const pending=broker.login({username:'Test',challenge:'fixture',origin:'https://play.pokemonshowdown.com'});
    if(mode==='cancel')t.input.write('synthetic-secret\x03');
    if(mode==='input')t.input.emit('error',Object.assign(new Error('synthetic-secret'),{code:'LOGIN_REJECTED'}));
    await assert.rejects(pending,error=>error.code===code && /not completed/.test(error.message) && !error.message.includes('synthetic-secret'));
    assert.equal(calls,0);assert.equal(t.input.isRaw,false);assert.equal(t.input.listenerCount('data'),0);
    assert(!t.printed().includes('synthetic-secret'));
  }
});

test('login network, rejection and malformed responses have fixed redacted stage diagnostics with no retries',async()=>{
  const secret='synthetic-private-body-or-assertion';
  const cases=[
    ['LOGIN_NETWORK',async()=>{throw Object.assign(new Error(secret),{code:'TERMINAL_CANCELLED'});}],
    ['LOGIN_NETWORK',async()=>({ok:true,text:async()=>{throw new Error(secret);}})],
    ['LOGIN_REJECTED',async()=>({ok:false,status:403,text:async()=>secret})],
    ['LOGIN_REJECTED',async()=>({ok:true,text:async()=>JSON.stringify({actionsuccess:false,actionerror:secret})})],
    ['LOGIN_REJECTED',async()=>({ok:true,text:async()=>JSON.stringify({curuser:{loggedin:false,username:'Test'},assertion:secret})})],
    ['INVALID_LOGIN_RESPONSE',async()=>({ok:true,text:async()=>secret})],
    ['INVALID_LOGIN_RESPONSE',async()=>({ok:true,text:async()=>JSON.stringify({curuser:{loggedin:true,username:'Test'},assertion:secret+'\n'})})],
    ['INVALID_LOGIN_RESPONSE',async()=>({ok:true,text:async()=>JSON.stringify({unexpected:secret})})],
  ];
  for(const [code,response] of cases){
    let calls=0;const broker=createTTYBroker({prompt:async()=>secret,fetchImpl:async()=>{calls++;return response();}});
    await assert.rejects(broker.login({username:'Test',challenge:'fixture',origin:'https://play.pokemonshowdown.com'}),error=>{
      assert.equal(error.code,code);assert.match(error.message,/Login was not completed:/);
      assert(!error.message.includes(secret));assert(!error.stack.includes(secret));
      assert.equal(Object.getOwnPropertyDescriptor(error,'code').writable,false);return true;
    });
    assert.equal(calls,1);
  }
});

test('arbitrary prompt error fields cannot spoof a trusted login code and stale sessions have their own code',async()=>{
  const context={username:'Test',challenge:'fixture',origin:'https://play.pokemonshowdown.com'};
  const broker=createTTYBroker({prompt:async()=>{throw Object.assign(new Error('synthetic-secret'),{code:'LOGIN_REJECTED'});}});
  await assert.rejects(broker.login(context),error=>error.code==='TERMINAL_INPUT_ERROR' && !error.message.includes('synthetic-secret'));
  let prompts=0,calls=0;
  const stale=createTTYBroker({prompt:async()=>{prompts++;return 'fixture';},fetchImpl:async()=>{calls++;}});
  await assert.rejects(stale.login({...context,isCurrent:()=>false}),error=>error.code==='STALE_SESSION');
  assert.equal(prompts,0);assert.equal(calls,0);
  // Even a failing context callback must not escape the broker's redaction.
  await assert.rejects(stale.login({...context,isCurrent:()=>{throw new Error('synthetic-secret');}}),error=>!error.message.includes('synthetic-secret'));
});
