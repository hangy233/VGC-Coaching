// A visible normal-session launcher with no authentication retry. Status retains
// stage names and allowlisted error codes only; it never retains error prose.
import {openSync,writeSync,fsyncSync,closeSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,relative,sep,basename,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runSession,parseSessionArgs} from './session.mjs';

const PHASES=new Set(['before-connect','before-authenticate','after-authenticate','before-bridge','end']);
// Exact public SavedLoginError codes from windows-credential-login.mjs FAILURES.
// This static allowlist contains no broker inputs, assertion or secret values.
const CODES=new Set(['EACCES','EPERM','ENOENT','EEXIST','ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','AUDIT_WRITE_FAILED',
  'SAVED_LOGIN_UNAVAILABLE_PLATFORM','INVALID_LOGIN_CONTEXT','STALE_SESSION','SAVED_CREDENTIAL_NOT_FOUND','SAVED_CREDENTIAL_ACCOUNT_MISMATCH','SAVED_CREDENTIAL_INVALID','SAVED_CREDENTIAL_UNAVAILABLE','LOGIN_NETWORK','LOGIN_REJECTED','INVALID_LOGIN_RESPONSE','SAVED_LOGIN_HELPER_FAILED','SAVED_LOGIN_HELPER_TIMEOUT']);
export const safeLaunchErrorCode=error=>CODES.has(error?.code)?error.code:'SESSION_ERROR';
const required=(condition,message)=>{if(!condition)throw new Error(message);};

export function parseVisibleLauncherArgs(argv){
  const split=argv.indexOf('--');
  required(split===6,'Supply --status-file PATH --team-id SHA --source-parent ID -- then normal session arguments');
  const before=argv.slice(0,split),options={};
  for(let i=0;i<before.length;i+=2){required(['--status-file','--team-id','--source-parent'].includes(before[i])&&!Object.hasOwn(options,before[i]),'Explicit unique launcher options required');options[before[i]]=before[i+1];}
  required(/^[a-f0-9]{64}$/.test(options['--team-id']||'')&&/^game-bestof3-gen9championsvgc2026regmcbo3-\d+$/.test(options['--source-parent']||''),'Exact team and source-parent identity required');
  return {statusFile:options['--status-file'],teamId:options['--team-id'],parentId:options['--source-parent'],session:parseSessionArgs(argv.slice(split+1))};
}

export function createLaunchRecorder({workspace=process.cwd(),statusFile,teamId,parentId,now=Date.now,pid=process.pid}={}){
  required(typeof teamId==='string'&&/^[a-f0-9]{64}$/.test(teamId)&&typeof parentId==='string'&&/^game-bestof3-gen9championsvgc2026regmcbo3-\d+$/.test(parentId),'Exact team and source-parent identity required');
  const root=realpathSync(workspace),directory=join(root,'cache','bo3-runs',parentId),file=resolve(root,statusFile||'');
  required(dirname(file)===directory&&/^[A-Za-z0-9_.-]{1,100}\.json$/.test(basename(file)),'Status must be a direct private source-parent JSON artifact');
  let current=root;
  for(const part of relative(root,directory).split(sep)){current=join(current,part);required(!lstatSync(current).isSymbolicLink(),'Linked status directories are not allowed');}
  required(realpathSync(directory)===directory,'Status directory must remain inside the exact workspace');
  const document={schemaVersion:1,kind:'private-visible-session-launch-status',teamId,parentId,pid,createdAt:now(),events:[],networkAttempted:false,authenticationAttempted:false,authenticatedObserved:false,bridgeAboutToStart:false,sessionFinished:false};
  const handle=openSync(file,'wx',0o600);let closed=false;
  const persist=()=>{const text=JSON.stringify(document)+'\n';required(Buffer.byteLength(text)<=8192&&document.events.length<=16,'Bounded launch status exceeded');try{writeSync(handle,text,0,'utf8');fsyncSync(handle);}catch{const error=new Error('Launch status write failed');error.code='AUDIT_WRITE_FAILED';throw error;}};
  // Explicit position zero plus truncation is unnecessary: documents only grow.
  persist();
  return {phase(phase){required(!closed&&PHASES.has(phase),'Known launch lifecycle phase required');document.events.push({phase,at:now()});if(phase==='before-connect')document.networkAttempted=true;if(phase==='before-authenticate')document.authenticationAttempted=true;if(phase==='after-authenticate')document.authenticatedObserved=true;if(phase==='before-bridge')document.bridgeAboutToStart=true;if(phase==='end')document.sessionFinished=true;persist();},
    failure(error){required(!closed,'Open launch recorder required');document.events.push({phase:'failure',at:now(),code:safeLaunchErrorCode(error)});persist();},
    close(){if(!closed){closed=true;closeSync(handle);}},snapshot:()=>structuredClone(document)};
}

export async function runVisibleLauncher({options,run=runSession,recorder,holdFailure=async()=>{process.stderr.write('Session attempt ended. Safe stage status was retained. Press Enter to close this visible console.\n');process.stdin.resume();await new Promise(resolve=>process.stdin.once('data',resolve));},writeCode=code=>process.stderr.write(`Session attempt ended with code ${code}.\n`)}={}){
  let failure;
  try{await run({...options.session,onLifecycle:phase=>recorder.phase(phase)});return {finished:true,failed:false};}
  catch(error){failure=error;try{recorder.failure(error);}catch{writeCode('AUDIT_WRITE_FAILED');}writeCode(safeLaunchErrorCode(error));return {finished:true,failed:true,code:safeLaunchErrorCode(error)};}
  finally{recorder.close();if(failure)await holdFailure();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let recorder;
  try{const options=parseVisibleLauncherArgs(process.argv.slice(2));recorder=createLaunchRecorder(options);const result=await runVisibleLauncher({options,recorder});process.exitCode=result.failed?1:0;}
  catch(error){recorder?.close();process.stderr.write(`Launch preparation ended with code ${safeLaunchErrorCode(error)}.\n`);process.exitCode=1;}
}
