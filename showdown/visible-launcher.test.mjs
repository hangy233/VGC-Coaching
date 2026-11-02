import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLaunchRecorder,runVisibleLauncher,safeLaunchErrorCode,parseVisibleLauncherArgs} from './visible-launcher.mjs';

const teamId='a'.repeat(64),parentId='game-bestof3-gen9championsvgc2026regmcbo3-123';
async function fixture(){const workspace=await mkdtemp(join(tmpdir(),'visible-launch-audit-'));await mkdir(join(workspace,'cache/bo3-runs',parentId),{recursive:true});const statusFile=`cache/bo3-runs/${parentId}/launch.json`;return {workspace,statusFile,path:join(workspace,statusFile),cleanup:()=>rm(workspace,{recursive:true,force:true})};}
test('launcher parser preserves only normal session configuration and explicit status owner',()=>{
  const options=parseVisibleLauncherArgs(['--status-file',`cache/bo3-runs/${parentId}/launch.json`,'--team-id',teamId,'--source-parent',parentId,'--','FixturePlayer','--team','approved.txt','--sets','1','--saved-login','--battle-timer','--save-replays']);
  assert.equal(options.session.loginMethod,'windows-credential-manager');assert.equal(options.session.authorizedSets,1);assert.equal(options.session.battleTimer,true);assert.equal(options.session.saveReplays,true);
  assert.throws(()=>parseVisibleLauncherArgs(['--','FixturePlayer']),/Supply/);
});
test('safe recorder keeps bounded phase/error code data and refuses replacement',async()=>{
  const f=await fixture();try{const recorder=createLaunchRecorder({...f,teamId,parentId,pid:123});recorder.phase('before-connect');recorder.phase('before-authenticate');const error=new Error('SYNTHETIC-PASSWORD assertion=private-stack');error.code='ETIMEDOUT';recorder.failure(error);recorder.phase('end');recorder.close();const text=await readFile(f.path,'utf8'),record=JSON.parse(text);assert.equal(record.authenticationAttempted,true);assert.equal(record.authenticatedObserved,false);assert.equal(record.events[2].code,'ETIMEDOUT');assert(!text.includes('SYNTHETIC-PASSWORD'));assert(!text.includes('assertion'));assert(!text.includes('stack'));assert.throws(()=>createLaunchRecorder({...f,teamId,parentId}),/EEXIST/);}finally{await f.cleanup();}
});
test('unknown raw error code/prose is reduced to SESSION_ERROR',()=>{assert.equal(safeLaunchErrorCode({code:'password-secret',message:'anything',stack:'private'}),'SESSION_ERROR');assert.equal(safeLaunchErrorCode({code:'EPERM'}),'EPERM');});
test('exact saved-login failure codes are retained while unknown code and prose stay absent',async()=>{
  const codes=['SAVED_LOGIN_UNAVAILABLE_PLATFORM','INVALID_LOGIN_CONTEXT','STALE_SESSION','SAVED_CREDENTIAL_NOT_FOUND','SAVED_CREDENTIAL_ACCOUNT_MISMATCH','SAVED_CREDENTIAL_INVALID','SAVED_CREDENTIAL_UNAVAILABLE','LOGIN_NETWORK','LOGIN_REJECTED','INVALID_LOGIN_RESPONSE','SAVED_LOGIN_HELPER_FAILED','SAVED_LOGIN_HELPER_TIMEOUT'];
  const f=await fixture();try{const recorder=createLaunchRecorder({...f,teamId,parentId});for(const code of codes){assert.equal(safeLaunchErrorCode({code,message:'SYNTHETIC_SECRET',stack:'PRIVATE_STACK'}),code);recorder.failure({code,message:'SYNTHETIC_SECRET',stack:'PRIVATE_STACK'});}recorder.failure({code:'unknown-SYNTHETIC_SECRET',message:'SYNTHETIC_SECRET'});recorder.close();const text=await readFile(f.path,'utf8');assert(!text.includes('SYNTHETIC_SECRET'));assert(!text.includes('PRIVATE_STACK'));assert.equal(JSON.parse(text).events.at(-1).code,'SESSION_ERROR');}finally{await f.cleanup();}
});
test('injected failure is held once with no retry and retains only known lifecycle',async()=>{
  const f=await fixture();try{const recorder=createLaunchRecorder({...f,teamId,parentId});let calls=0,held=0;const codes=[];const result=await runVisibleLauncher({options:{session:{}},recorder,run:async({onLifecycle})=>{calls++;onLifecycle('before-connect');throw Object.assign(new Error('RAWSECRET'),{code:'ECONNRESET'});},holdFailure:async()=>{held++;},writeCode:code=>codes.push(code)});assert.equal(calls,1);assert.equal(held,1);assert.equal(result.code,'ECONNRESET');assert.deepEqual(codes,['ECONNRESET']);const text=await readFile(f.path,'utf8');assert(!text.includes('RAWSECRET'));assert.equal(JSON.parse(text).authenticationAttempted,false);}finally{await f.cleanup();}
});
test('injected normal countercase finishes without holding or retry',async()=>{
  const f=await fixture();try{const recorder=createLaunchRecorder({...f,teamId,parentId});let calls=0,held=0;const result=await runVisibleLauncher({options:{session:{}},recorder,run:async({onLifecycle})=>{calls++;for(const phase of ['before-connect','before-authenticate','after-authenticate','before-bridge','end'])onLifecycle(phase);},holdFailure:async()=>{held++;},writeCode:()=>assert.fail('No error expected')});assert.equal(result.failed,false);assert.equal(calls,1);assert.equal(held,0);const record=JSON.parse(await readFile(f.path,'utf8'));assert.equal(record.authenticatedObserved,true);assert.equal(record.sessionFinished,true);}finally{await f.cleanup();}
});
test('status writer rejects output outside exact parent before creating it',async()=>{
  const f=await fixture();try{assert.throws(()=>createLaunchRecorder({...f,statusFile:'cache/elsewhere.json',teamId,parentId}),/direct private source-parent/);}finally{await f.cleanup();}
});
test('direct recorder caller must supply exact team and parent ownership before any file access',()=>{
  for(const invalid of [{teamId:'not-a-hash',parentId},{teamId,parentId:'../../escape'}])assert.throws(()=>createLaunchRecorder({workspace:'Z:/does-not-exist',statusFile:'unused.json',...invalid}),/Exact team and source-parent identity/);
});
