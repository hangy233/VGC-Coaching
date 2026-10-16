import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const execute=promisify(execFile);
const modulePath=fileURLToPath(new URL('./viewer.mjs',import.meta.url));
const starts=new Map();
const pause=ms=>new Promise(ok=>setTimeout(ok,ms));
function options(workspace,port,teamId){if(typeof workspace!=='string'||!Number.isSafeInteger(port)||port<1||port>65535||(teamId!==undefined&&!/^[a-f0-9]{64}$/u.test(teamId)))throw new Error('Use a workspace, valid loopback port and optional exact team fingerprint.');}
async function legacyOwner(port,workspace){
  if(process.platform!=='win32')return false;
  try{
    const script=`$listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($listener) { $processInfo = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $listener.OwningProcess); @{pid=$processInfo.ProcessId;executable=$processInfo.ExecutablePath;commandLine=$processInfo.CommandLine} | ConvertTo-Json -Compress }`;
    const result=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:4000,maxBuffer:4096});
    const owner=JSON.parse(result.stdout);if(resolve(owner.executable).toLowerCase()!==resolve(process.execPath).toLowerCase())return false;
    const command=owner.commandLine||'';
    if(!command.toLowerCase().includes(modulePath.toLowerCase())||/--eval|\s-e\s|--require|--import/iu.test(command))return false;
    const explicit=/--workspace\s+(?:"([^"]+)"|(\S+))/u.exec(command),ownerWorkspace=explicit?(explicit[1]||explicit[2]):fileURLToPath(new URL('..',import.meta.url));
    if(resolve(ownerWorkspace).toLowerCase()!==resolve(workspace).toLowerCase())return false;
    return {pid:owner.pid};
  }catch{return false;}
}
export async function getMetricsViewerStatus({workspace,port=52615,teamId,fetcher=fetch,legacyCheck=legacyOwner}={}){
  options(workspace,port,teamId);const base=`http://127.0.0.1:${port}/`,url=base+(teamId?'?team='+teamId:'');
  let responded=false;
  try{
    const response=await fetcher(base+'api/viewer-status',{signal:AbortSignal.timeout(1500),redirect:'error'});
    responded=true;
    if(response.ok){const raw=await response.text();if(raw.length>4096)throw new Error('Oversized status');const identity=JSON.parse(raw),expected=createHash('sha256').update(resolve(workspace).toLowerCase()).digest('hex');if(identity.service!=='vgc-private-team-metrics'||identity.workspaceSha256!==expected||!Number.isSafeInteger(identity.pid)||identity.pid<1)return {running:false,occupied:true,verified:false,url,reason:'Port belongs to an unverified or different workspace service.'};return {running:true,occupied:true,verified:true,url,version:identity.version,pid:identity.pid,startedAt:identity.startedAt,independentOfMcpTransport:true};}
    const owner=response.status===404?await legacyCheck(port,workspace):false;
    if(owner)return {running:true,occupied:true,verified:true,url,pid:owner.pid,version:1,legacy:true,independentOfMcpTransport:true,note:'Existing verified viewer is reused. New viewer status features load on its next normal start.'};
    return {running:false,occupied:true,verified:false,url,reason:'The occupied port could not be verified as this workspace viewer.'};
  }catch{return {running:false,occupied:responded,verified:false,url,reason:responded?'The responding service could not prove viewer identity.':'No responding verified viewer.'};}
}
export async function ensureMetricsViewer({workspace,port=52615,teamId,spawnViewer=spawn,status=getMetricsViewerStatus}={}){
  options(workspace,port,teamId);const key=resolve(workspace)+'#'+port;
  if(starts.has(key))return starts.get(key);
  const operation=(async()=>{
    const existing=await status({workspace,port,teamId});if(existing.running)return {...existing,reused:true};if(existing.occupied)throw new Error('The requested local port is occupied by an unverified service; no process was stopped.');
    const child=spawnViewer(process.execPath,[modulePath,'--port',String(port),'--workspace',resolve(workspace)],{cwd:resolve(workspace),detached:true,stdio:'ignore',windowsHide:true});
    let startupError;child.once('error',error=>{startupError=error;});child.unref();
    let adopted=false;
    try{
      for(let attempt=0;attempt<20;attempt++){await pause(100);if(startupError)throw new Error('The private viewer could not start.');const current=await status({workspace,port,teamId});if(current.running){adopted=current.pid===child.pid;return {...current,reused:!adopted};}if(current.occupied)throw new Error('The viewer port was claimed by an unverified service; its listener was left untouched.');}
      throw new Error('The private viewer did not confirm startup.');
    }finally{
      // Stop only our exact unadopted child, including early startup failures
      // and another verified viewer winning a concurrent startup race.
      if(!adopted&&child.exitCode===null){try{child.kill();}catch{}}
    }
  })();
  starts.set(key,operation);try{return await operation;}finally{starts.delete(key);}
}
