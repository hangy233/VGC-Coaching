import {StringDecoder} from 'node:string_decoder';
export const LOGIN_URL = 'https://play.pokemonshowdown.com/api/login';
const normalized = name => name.toLowerCase().replace(/[^a-z0-9]/g,'');

/** User types AND presses Enter directly in a genuine terminal. Never pipe a password. */
export function readHiddenPassword({input=process.stdin,output=process.stderr,timeoutMs=120000,signals=process,signal}={}) {
  return new Promise((resolve,reject)=>{
    if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('Password entry requires a user-operated TTY; pipes and redirected input are not accepted')); return;
    }
    if(signal?.aborted){reject(new Error('Login cancelled'));return;}
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
      if(error)reject(new Error(error));else resolve(result);
    };
    const onError=()=>finish('Terminal input failed');
    const onEnd=()=>finish('Terminal input ended before submission');
    const onInterrupt=()=>finish('Login cancelled');
    const onData=chunk=>{
      const text=decoder.write(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
      for(const char of text){
        if(char==='\u0003'||char==='\u0004'){finish('Login cancelled');return;}
        if(char==='\r'||char==='\n'){
          if(!password){finish('Password cannot be empty');return;}
          finish();return;
        }
        if(char==='\u007f'||char==='\b'){password=Array.from(password).slice(0,-1).join('');continue;}
        if(char<' '||char==='\u001b'){finish('Unsupported terminal control input; login cancelled');return;}
        password+=char;
        if(Buffer.byteLength(password)>1024){finish('Password input exceeds length limit');return;}
      }
    };
    const timer=setTimeout(()=>finish('Password entry timed out'),timeoutMs);
    input.on('data',onData);input.on('error',onError);input.on('end',onEnd);
    signal?.addEventListener('abort',onInterrupt,{once:true});
    signals.on('SIGINT',onInterrupt);signals.on('SIGTERM',onInterrupt);signals.on('SIGHUP',onInterrupt);
    try { input.setRawMode(true); output.write('Showdown password (hidden; type it yourself, then Enter; Ctrl-C cancels): '); input.resume(); }
    catch {finish('Could not initialize hidden terminal input');}
  });
}

/** No cookie jar, session file, CLI password option, or environment-secret input. */
export function createTTYBroker({prompt=readHiddenPassword,fetchImpl=fetch,networkTimeoutMs=15000}={}) {
  return {async login({username,challenge,origin,signal,isCurrent=()=>true}) {
    if(origin!=='https://play.pokemonshowdown.com'||! /^[A-Za-z0-9 _-]{1,18}$/.test(username)||typeof challenge!=='string'||!challenge||/[\r\n]/.test(challenge)) throw new Error('Invalid login context');
    let password=null,body=null,data=null,responseText=null;
    try {
      if(signal?.aborted||!isCurrent())throw new Error('Stale connection');
      password=await prompt({signal});
      if(signal?.aborted||!isCurrent())throw new Error('Stale connection');
      if(typeof password!=='string'||!password||Buffer.byteLength(password)>1024)throw new Error('Invalid password input');
      body=new URLSearchParams({name:username,pass:password,challstr:challenge});
      password=null;
      const response=await fetchImpl(LOGIN_URL,{
        method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},
        body,credentials:'omit',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(networkTimeoutMs)]):AbortSignal.timeout(networkTimeoutMs),
      });
      body=null;
      if(!response.ok)throw new Error('Login rejected');
      responseText=await response.text();
      if(responseText.length>65536)throw new Error('Invalid response');
      data=JSON.parse(responseText.startsWith(']')?responseText.slice(1):responseText);responseText=null;
      if(!data?.curuser?.loggedin||normalized(data.curuser.username||'')!==normalized(username)||typeof data.assertion!=='string'||data.assertion.length<10||/[\r\n|]/.test(data.assertion))throw new Error('Login not accepted');
      const assertion=data.assertion;data=null;return assertion;
    } catch {
      // Never forward server, network, parser or prompt error details: they may contain secrets.
      throw new Error('Login was not completed. Check the account details or connection and start a new user-operated attempt.');
    } finally {password=null;body=null;data=null;responseText=null;}
  }};
}
