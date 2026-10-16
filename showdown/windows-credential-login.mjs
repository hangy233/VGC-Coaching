import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const normalize=name=>String(name || '').toLowerCase().replace(/[^a-z0-9]/g,'');
const validUser=name=>typeof name==='string' && /^[A-Za-z0-9 _-]{1,18}$/.test(name) && !!normalize(name);
const FAILURES=Object.freeze({
  SAVED_LOGIN_UNAVAILABLE_PLATFORM:'Saved sign-in requires Windows Credential Manager on this computer.',
  INVALID_LOGIN_CONTEXT:'Saved sign-in was not completed: invalid or mismatched approved account, origin, or challenge.',
  STALE_SESSION:'Saved sign-in was not completed: the connection or challenge changed, or the attempt was cancelled.',
  SAVED_CREDENTIAL_NOT_FOUND:'Saved sign-in was not completed: the exact account credential was not found in Windows Credential Manager.',
  SAVED_CREDENTIAL_ACCOUNT_MISMATCH:'Saved sign-in was not completed: the stored credential belongs to a different account.',
  SAVED_CREDENTIAL_INVALID:'Saved sign-in was not completed: the stored generic credential has an unsupported or empty password value.',
  SAVED_CREDENTIAL_UNAVAILABLE:'Saved sign-in was not completed: Windows could not read the exact account credential.',
  LOGIN_NETWORK:'Saved sign-in was not completed: the fixed login network request failed or timed out.',
  LOGIN_REJECTED:'Saved sign-in was not completed: the server rejected login for the approved account.',
  INVALID_LOGIN_RESPONSE:'Saved sign-in was not completed: the helper or login server returned an invalid response.',
  SAVED_LOGIN_HELPER_FAILED:'Saved sign-in was not completed: the local credential helper failed.',
  SAVED_LOGIN_HELPER_TIMEOUT:'Saved sign-in was not completed: the local credential helper timed out.',
});
const HELPER_FAILURES=new Set(['INVALID_LOGIN_CONTEXT','SAVED_CREDENTIAL_NOT_FOUND','SAVED_CREDENTIAL_ACCOUNT_MISMATCH','SAVED_CREDENTIAL_INVALID','SAVED_CREDENTIAL_UNAVAILABLE','LOGIN_NETWORK','LOGIN_REJECTED','INVALID_LOGIN_RESPONSE','SAVED_LOGIN_HELPER_FAILED']);
// Pinned Showdown server/users.ts validateToken: challenge, userid, user type,
// timestamp, hostname, optional future fields; then ';' and the signature.
// Showdown owns cryptographic verification; this only binds the returned token
// to this approved account and the challenge portion after the challstr key ID.
const matchesAssertion=(assertion,approved,challenge)=>{
  if(typeof assertion!=='string' || assertion.length<=10 || assertion.length>32768 || /[\u0000-\u001f\u007f|]/.test(assertion))return false;
  const separator=assertion.indexOf(';');
  if(separator<1 || !assertion.slice(separator+1).trim())return false;
  const fields=assertion.slice(0,separator).split(',');
  return fields.length>=5 && fields[0]===challenge.slice(challenge.indexOf('|')+1) && fields[1]===approved;
};
class SavedLoginError extends Error {
  constructor(code){super(FAILURES[code]);Object.defineProperty(this,'code',{value:code,enumerable:true});}
}

export function windowsCredentialTarget(username){
  if(!validUser(username))throw new SavedLoginError('INVALID_LOGIN_CONTEXT');
  return 'VGC-Coaching/PokemonShowdown/'+normalize(username);
}

/** Explicit opt-in only. The child owns the password and HTTPS request; Node receives an assertion. */
export function createWindowsCredentialBroker({
  username:approvedUsername,
  platform=process.platform,
  spawnImpl=spawn,
  helperPath=fileURLToPath(new URL('./windows-credential-helper.ps1',import.meta.url)),
  powershellPath=join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
  timeoutMs=20000,
  maxOutputBytes=65536,
}={}){
  if(!validUser(approvedUsername) || !Number.isInteger(timeoutMs) || timeoutMs<100 || timeoutMs>30000 || !Number.isInteger(maxOutputBytes) || maxOutputBytes<1024 || maxOutputBytes>65536)throw new SavedLoginError('INVALID_LOGIN_CONTEXT');
  const approved=normalize(approvedUsername);
  return {async login({username,challenge,origin,signal,isCurrent=()=>true}){
    if(!validUser(username) || normalize(username)!==approved || origin!=='https://play.pokemonshowdown.com' || typeof challenge!=='string' || !/^[0-9]{1,10}\|[^\r\n\0|]{1,8192}$/.test(challenge))throw new SavedLoginError('INVALID_LOGIN_CONTEXT');
    if(platform!=='win32')throw new SavedLoginError('SAVED_LOGIN_UNAVAILABLE_PLATFORM');
    const current=()=>{try{return !signal?.aborted && isCurrent()===true;}catch{return false;}};
    if(!current())throw new SavedLoginError('STALE_SESSION');
    const request=JSON.stringify({username:approvedUsername,origin,challenge});
    if(Buffer.byteLength(request)>16384)throw new SavedLoginError('INVALID_LOGIN_CONTEXT');
    return new Promise((resolve,reject)=>{
      let child,timer,done=false,size=0,chunks=[];
      const finish=(code,assertion)=>{
        if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);chunks=[];
        if(code){try{child?.kill();}catch{}reject(new SavedLoginError(code));}else resolve(assertion);
      };
      const onAbort=()=>finish('STALE_SESSION');
      try{
        child=spawnImpl(powershellPath,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helperPath],{windowsHide:true,shell:false,stdio:['pipe','pipe','ignore']});
        child.on('error',()=>finish('SAVED_LOGIN_HELPER_FAILED'));
        child.stdin.on('error',()=>finish('SAVED_LOGIN_HELPER_FAILED'));
        child.stdout.on('error',()=>finish('SAVED_LOGIN_HELPER_FAILED'));
        child.stdout.on('data',chunk=>{
          if(done)return;
          const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;
          if(size>maxOutputBytes){finish('INVALID_LOGIN_RESPONSE');return;}
          chunks.push(bytes);
        });
        child.once('close',exitCode=>{
          if(done)return;
          if(!current()){finish('STALE_SESSION');return;}
          let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8').trim());}catch{finish('INVALID_LOGIN_RESPONSE');return;}
          if(!result || typeof result!=='object' || Array.isArray(result)){finish('INVALID_LOGIN_RESPONSE');return;}
          if(result.ok===false && Object.keys(result).every(key=>['ok','code'].includes(key)) && HELPER_FAILURES.has(result.code)){finish(result.code);return;}
          if(exitCode!==0 || result.ok!==true || Object.keys(result).some(key=>!['ok','username','assertion'].includes(key)) || !validUser(result.username) || normalize(result.username)!==approved || !matchesAssertion(result.assertion,approved,challenge)){finish('INVALID_LOGIN_RESPONSE');return;}
          finish(null,result.assertion);
        });
        timer=setTimeout(()=>finish('SAVED_LOGIN_HELPER_TIMEOUT'),timeoutMs);
        signal?.addEventListener('abort',onAbort,{once:true});
        if(!current()){finish('STALE_SESSION');return;}
        child.stdin.end(request);
      }catch{finish('SAVED_LOGIN_HELPER_FAILED');}
    });
  }};
}
