import {StringDecoder} from 'node:string_decoder';
export const LOGIN_URL = 'https://play.pokemonshowdown.com/api/login';
const normalized = name => name.toLowerCase().replace(/[^a-z0-9]/g,'');
const LOGIN_FAILURES = Object.freeze({
  TERMINAL_REQUIRED:'Login was not completed: password entry requires a user-operated TTY; pipes and redirected input are not accepted.',
  TERMINAL_TIMEOUT:'Login was not completed: password entry timed out.',
  TERMINAL_CANCELLED:'Login was not completed: terminal entry was cancelled.',
  TERMINAL_INPUT_ERROR:'Login was not completed: terminal input failed, was empty, exceeded its limit, or contained unsupported terminal control input.',
  LOGIN_NETWORK:'Login was not completed: the login network request failed or timed out.',
  LOGIN_REJECTED:'Login was not completed: the server did not accept login for the requested account.',
  INVALID_LOGIN_RESPONSE:'Login was not completed: the server returned an invalid login response.',
  STALE_SESSION:'Login was not completed: the connection or challenge changed during login.',
  INVALID_LOGIN_CONTEXT:'Login was not completed: invalid login context.',
});
// Only errors created in this module may carry a trusted diagnostic code.
class LoginStageError extends Error {
  constructor(code) {
    super(LOGIN_FAILURES[code]);
    Object.defineProperty(this,'code',{value:code,enumerable:true});
  }
}

/** User types AND presses Enter directly in a genuine terminal. Never pipe a password. */
export function readHiddenPassword({input=process.stdin,output=process.stderr,timeoutMs=120000,signals=process,signal}={}) {
  return new Promise((resolve,reject)=>{
    if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
      reject(new LoginStageError('TERMINAL_REQUIRED')); return;
    }
    if(signal?.aborted){reject(new LoginStageError('TERMINAL_CANCELLED'));return;}
    let password='',done=false;
    const decoder=new StringDecoder('utf8'), previousRaw=!!input.isRaw, previousFlowing=input.readableFlowing;
    const cleanup=()=>{
      clearTimeout(timer); signal?.removeEventListener('abort',onInterrupt); input.removeListener('data',onData); input.removeListener('error',onError); input.removeListener('end',onEnd);
      signals.removeListener('SIGINT',onInterrupt); signals.removeListener('SIGTERM',onInterrupt); signals.removeListener('SIGHUP',onInterrupt);
      try { input.setRawMode(previousRaw); } catch {}
      if(previousFlowing !== true) input.pause();
      try { output.write('\n'); } catch {}
    };
    const finish=(error)=>{
      if(done)return; done=true; cleanup();
      const result=password; password='';
        if(error)reject(new LoginStageError(error));else resolve(result);
    };
    const onError=()=>finish('TERMINAL_INPUT_ERROR');
    const onEnd=()=>finish('TERMINAL_INPUT_ERROR');
    const onInterrupt=()=>finish('TERMINAL_CANCELLED');
    const onData=chunk=>{
      const text=decoder.write(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
      for(const char of text){
        if(char==='\u0003'||char==='\u0004'){finish('TERMINAL_CANCELLED');return;}
        if(char==='\r'||char==='\n'){
          if(!password){finish('TERMINAL_INPUT_ERROR');return;}
          finish();return;
        }
        if(char==='\u007f'||char==='\b'){password=Array.from(password).slice(0,-1).join('');continue;}
        if(char<' '||char==='\u001b'){finish('TERMINAL_INPUT_ERROR');return;}
        password+=char;
        if(Buffer.byteLength(password)>1024){finish('TERMINAL_INPUT_ERROR');return;}
      }
    };
    const timer=setTimeout(()=>finish('TERMINAL_TIMEOUT'),timeoutMs);
    input.on('data',onData);input.on('error',onError);input.on('end',onEnd);
    signal?.addEventListener('abort',onInterrupt,{once:true});
    signals.on('SIGINT',onInterrupt);signals.on('SIGTERM',onInterrupt);signals.on('SIGHUP',onInterrupt);
    try { input.setRawMode(true); output.write('Showdown password (hidden; type it yourself, then Enter; Ctrl-C cancels): '); input.resume(); }
    catch {finish('TERMINAL_INPUT_ERROR');}
  });
}

/** No cookie jar, session file, CLI password option, or environment-secret input. */
export function createTTYBroker({prompt=readHiddenPassword,fetchImpl=fetch,networkTimeoutMs=15000}={}) {
  return {async login({username,challenge,origin,signal,isCurrent=()=>true}) {
    if(origin!=='https://play.pokemonshowdown.com'||! /^[A-Za-z0-9 _-]{1,18}$/.test(username)||typeof challenge!=='string'||!challenge||/[\r\n]/.test(challenge)) throw new LoginStageError('INVALID_LOGIN_CONTEXT');
    let password=null,body=null,data=null,responseText=null;
    let stage='TERMINAL_INPUT_ERROR';
    try {
      if(signal?.aborted||!isCurrent())throw new LoginStageError('STALE_SESSION');
      password=await prompt({signal});
      if(signal?.aborted||!isCurrent())throw new LoginStageError('STALE_SESSION');
      if(typeof password!=='string'||!password||Buffer.byteLength(password)>1024)throw new LoginStageError('TERMINAL_INPUT_ERROR');
      body=new URLSearchParams({name:username,pass:password,challstr:challenge});
      password=null;
      stage='LOGIN_NETWORK';
      const response=await fetchImpl(LOGIN_URL,{
        method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},
        body,credentials:'omit',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(networkTimeoutMs)]):AbortSignal.timeout(networkTimeoutMs),
      });
      body=null;
      if(!response.ok)throw new LoginStageError('LOGIN_REJECTED');
      responseText=await response.text();
      stage='INVALID_LOGIN_RESPONSE';
      if(typeof responseText!=='string'||responseText.length>65536)throw new LoginStageError('INVALID_LOGIN_RESPONSE');
      data=JSON.parse(responseText.startsWith(']')?responseText.slice(1):responseText);responseText=null;
      if(data?.actionsuccess===false || typeof data?.assertion==='string' && data.assertion.startsWith(';'))throw new LoginStageError('LOGIN_REJECTED');
      if(!data?.curuser || typeof data.curuser!=='object')throw new LoginStageError('INVALID_LOGIN_RESPONSE');
      if(!data.curuser.loggedin||normalized(data.curuser.username||'')!==normalized(username))throw new LoginStageError('LOGIN_REJECTED');
      if(typeof data.assertion!=='string'||data.assertion.length<10||/[\r\n|]/.test(data.assertion))throw new LoginStageError('INVALID_LOGIN_RESPONSE');
      if(signal?.aborted||!isCurrent())throw new LoginStageError('STALE_SESSION');
      const assertion=data.assertion;data=null;return assertion;
    } catch (error) {
      // Never forward server, network, parser or prompt error details: they may contain secrets.
      if(error instanceof LoginStageError)throw new LoginStageError(error.code);
      throw new LoginStageError(signal?.aborted?'STALE_SESSION':stage);
    } finally {password=null;body=null;data=null;responseText=null;}
  }};
}
