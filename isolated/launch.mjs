// Public manager entry point. Reports are private evidence; only the in-memory
// provider receipts below can admit this same selected provider to a live set.
import {lstat,mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {createCodexCliDecisionProvider} from './codex-cli-provider.mjs';
import {hasModelToolQualificationReceipt} from './model-tool-qualification.mjs';
import {qualifyPonderRuntime,verifyPonderQualificationReceipt,ponderQualificationSourcePins} from './ponder-qualification.mjs';
import {assessOfflineBudget,sha} from './qualification-budget.mjs';
import {ISOLATED_POLICY_SOURCE,verifyIsolatedPolicySource} from './decision-context.mjs';
import {runRunner,readRunnerConfiguration} from './runner.mjs';
import {createOperator} from '../showdown/operator-client.mjs';
import {createAttentionAlert} from './attention-alert.mjs';
import {admitQualificationReference,verifyQualificationReferenceAdmission} from './qualification-reference.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const PROFILE=Object.freeze({model:'gpt-6.1-sol',reasoningEffort:'low',serviceTier:'fast',contextMode:'session'});
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const need=(ok,code,message)=>{if(!ok)fail(code,message);};
const inside=(root,path)=>{const part=relative(root,path);return part!==''&&part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part);};
const canonical=value=>typeof value==='string'?value.replace(/-[a-z0-9]+pw$/u,''):undefined;

export function parseLaunchArgs(argv=[]){
  const options={};
  for(let i=0;i<argv.length;i++){
    const flag=argv[i];
    if(['--run','--qualify-only'].includes(flag)){need(!options.mode,'LAUNCH_ARGUMENTS','Select exactly one launch mode.');options.mode=flag.slice(2);}
    else if(['--model-tool-qualification','--session','--scope','--output','--codex-executable'].includes(flag)){
      const key=({'--model-tool-qualification':'requestFile','--codex-executable':'executable'})[flag]??flag.slice(2),value=argv[++i];
      need(!options[key]&&typeof value==='string'&&value&&!value.startsWith('--'),'LAUNCH_ARGUMENTS','A unique named path is required.');options[key]=value;
    }else fail('LAUNCH_ARGUMENTS','Unsupported launch argument.');
  }
  need(options.mode&&options.requestFile&&options.output,'LAUNCH_ARGUMENTS','Select --run or --qualify-only and provide --model-tool-qualification and --output.');
  need(options.mode==='run'?options.session&&options.scope:!options.session&&!options.scope,'LAUNCH_ARGUMENTS','Live mode needs an explicit manager session and one-set scope; qualification alone takes neither.');
  need(!options.executable||isAbsolute(options.executable),'LAUNCH_ARGUMENTS','The selected CLI executable must be an absolute path.');
  return options;
}

async function inputDocument(workspace,supplied){
  const root=await realpath(workspace),path=resolve(root,supplied);
  need(inside(root,path),'LAUNCH_SOURCE','Saved requests must stay in the manager workspace.');
  let current=root;for(const part of relative(root,path).split(sep)){current=join(current,part);need(!(await lstat(current)).isSymbolicLink(),'LAUNCH_SOURCE','Linked input paths are not supported.');}
  const stat=await lstat(path);need(stat.isFile()&&stat.size<=32*1024*1024,'LAUNCH_SOURCE','A bounded complete saved-request file is required.');
  const text=await readFile(path,'utf8'),document=JSON.parse(text);
  need(document?.kind==='saved-model-tool-qualification-requests'&&/^[a-f0-9]{64}$/u.test(document.teamId??'')&&Array.isArray(document.requests),'LAUNCH_SOURCE','The manager must supply complete saved native requests, not a report.');
  const policy=verifyIsolatedPolicySource();
  need(document.skillSha256===policy.skillSha256&&(!document.skillVersion||document.skillVersion===policy.skillVersion),'LAUNCH_SOURCE','Saved contexts must use current complete guidance.');
  if(document.profile)need(Object.entries(PROFILE).every(([key,value])=>document.profile[key]===value),'LAUNCH_PROFILE','Saved request profile differs from Sol/low/Fast/session.');
  return {document,sha256:sha(text),path,text};
}

async function privateOutput(workspace,supplied,teamId){
  const root=await realpath(workspace),cache=join(root,'cache'),path=resolve(root,supplied);
  need(inside(cache,path),'LAUNCH_OUTPUT','Private launch evidence must be under workspace/cache.');
  let current=root;for(const part of relative(root,path).split(sep)){
    current=join(current,part);try{const stat=await lstat(current);need(stat.isDirectory()&&!stat.isSymbolicLink(),'LAUNCH_OUTPUT','Private output cannot traverse linked or non-directory paths.');}catch(error){if(error.code!=='ENOENT')throw error;await mkdir(current,{mode:0o700});}
  }
  const save=async(name,value)=>writeFile(join(path,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  await save('ownership.json',{kind:'manager-cli-run-evidence',teamId,createdAt:Date.now(),containsPrivateBattleEvidence:true});
  return {path,save};
}

export function waitManagerGate(expected,{input=process.stdin,output=process.stdout}={}){
  need(input.isTTY===true,'LAUNCH_INPUT','Interactive manager input is required before live control.');
  output.write(JSON.stringify({state:'manager-gate',expected,cancel:'CANCEL_LIVE'})+'\n');
  if(input.destroyed||input.readableEnded){input.pause?.();input.unref?.();return Promise.resolve({cancelled:true,reason:'manager-input-closed',gate:expected});}
  return new Promise((resolveGate,reject)=>{const reader=createInterface({input,terminal:false});let settled=false;
    const cancel=reason=>{input.pause?.();input.unref?.();resolveGate({cancelled:true,reason,gate:expected});};
    reader.once('line',line=>{settled=true;reader.close();if(line===expected)resolveGate();
      else if(line==='CANCEL_LIVE')cancel('manager-cancelled');
      else reject(Object.assign(new Error('The exact manager gate was not released.'),{code:'LAUNCH_GATE'}));});
    reader.once('close',()=>{if(!settled){settled=true;cancel('manager-input-closed');}});
  });
}

export async function launchWorkflow(options,{workspace=ROOT,providerFactory=createCodexCliDecisionProvider,qualifyShadow=qualifyPonderRuntime,
  verifyMain=hasModelToolQualificationReceipt,verifyShadow=verifyPonderQualificationReceipt,sourcePins=ponderQualificationSourcePins,
  run=runRunner,readConfiguration=readRunnerConfiguration,operatorFactory=createOperator,gate=waitManagerGate,input=process.stdin,write=value=>process.stdout.write(JSON.stringify(value)+'\n')}={}){
  if(options.mode==='run')need(input.isTTY===true&&!input.destroyed&&!input.readableEnded,'LAUNCH_INPUT','Live mode requires open interactive input before any provider setup.');
  const source=await inputDocument(workspace,options.requestFile),{document}=source,output=await privateOutput(workspace,options.output,document.teamId);
  const alert=options.mode==='run'?createAttentionAlert({directory:output.path}):null;
  const liveWrite=value=>{
    const saved=alert?.accept(value);
    if(saved?.preserved===false)write({state:'attention-alert-unavailable',code:saved.code});
    write(value);
  };
  const provider=await providerFactory({workspace,...PROFILE,...(options.executable?{executable:options.executable}:{}),artifactDirectory:join(output.path,'cli-transient')});
  let live=false;
  try{
    const pins=await sourcePins();await output.save('source-pins.json',pins);
    const guardSha256=sha(await readFile(new URL('./qualification-budget.mjs',import.meta.url),'utf8'));
    const main=await provider.qualifyCodex({decisionMode:'model-tools',workspace,requests:document.requests,onEvent:event=>write({state:'qualification-progress',caseId:event.caseId,type:event.type??event.name})});
    await output.save('main-qualification.json',main);
    const mainBudget=assessOfflineBudget({kind:'main',result:main,requests:document.requests,guardSha256});await output.save('main-budget.json',mainBudget);
    need(main.qualified===true&&main.teamId===document.teamId&&main.compactChoiceSimulationQualified===true&&main.rangeWorkflowQualified===true&&verifyMain(provider,main)&&mainBudget.conformant,'LAUNCH_MAIN_QUALIFICATION','Actual same-provider main qualification and original 3/1 journal conformance are required.');
    const shadow=await qualifyShadow({provider,mainQualification:main,workspace,request:document.requests.find(row=>row.materialRequired),onEvent:event=>write({state:'shadow-progress',caseId:event.caseId,type:event.type??event.name})});
    await output.save('shadow-qualification.json',shadow);
    const shadowBudget=assessOfflineBudget({kind:'shadow',result:shadow,requests:document.requests,guardSha256});await output.save('shadow-budget.json',shadowBudget);
    need(shadow.qualified===true&&shadow.teamId===document.teamId&&shadow.frozenRangeWorkflowQualified===true&&await verifyShadow(provider,shadow)&&shadowBudget.conformant,'LAUNCH_SHADOW_QUALIFICATION','Actual same-provider frozen/preemption proof and original 3/1 journal conformance are required.');
    need(sha(pins)===sha(await sourcePins()),'LAUNCH_SOURCE_CHANGED','Loaded source changed after qualification.');
    write({state:'qualified',sourceSha256:pins.sha256,profile:PROFILE,liveAdmissionGranted:false});
    if(options.mode==='qualify-only')return {state:'qualified-offline',sourceSha256:pins.sha256,battlesStarted:0};
    const admission=await gate('START_LIVE',{input});
    if(admission?.cancelled===true){
      const result={state:'cancelled-before-live',gate:'START_LIVE',reason:admission.reason,searchesAttempted:0,searchDispatchAttempted:false,searchDispatched:false,nativeControlOpened:false,clientStopped:false};
      await output.save('live-result.json',result);write(result);return result;
    }
    const adoption=[],links=new Set();let searchReserved=false,searchDispatchAttempted=false,referenceAdmission;
    const runnerOptions={workspace,configurationReader:async args=>{
      const configuration=await readConfiguration(args);
      need(configuration.scope.manualReady===true&&configuration.scope.allowPonder===true&&configuration.scope.maxSets===1,'LAUNCH_SCOPE','The public live workflow requires manual readiness, pondering and one explicitly authorized set.');
      referenceAdmission=admitQualificationReference({...configuration,document,referenceFile:options.requestFile,referenceText:source.text,sourcePins:pins,profile:{provider:'codex-cli',...PROFILE,authenticationMethod:'chatgpt'}});
      return configuration;
    },codexProviderFactory:()=>({...provider,qualifyCodex:async args=>{
      need(args.decisionMode==='model-tools'&&sha(args.requests)===sha(document.requests)&&verifyMain(provider,main),'LAUNCH_RECEIPT','Main source/provider identity changed.');return main;}}),
      qualifyPonder:async()=>{need(await verifyShadow(provider,shadow),'LAUNCH_RECEIPT','Shadow source/provider identity changed.');return shadow;},
      beforeSearch:async()=>{
        need(!searchReserved&&!searchDispatchAttempted,'LAUNCH_SEARCH_RESERVED','The one search was already reserved.');
        await output.save('startup-adoption.json',{held:true,sourceSha256:pins.sha256,searchDispatched:false,qualificationReference:referenceAdmission,
          attentionAlert:{path:relative(workspace,alert.path).replaceAll('\\','/'),prepared:true,automaticActions:false},operations:adoption});
        write({state:'held-ready-awaiting-search',sourceSha256:pins.sha256});
        const released=await gate('START_SEARCH',{input});if(released?.cancelled===true)return released;
        need(sha(pins)===sha(await sourcePins()),'LAUNCH_SOURCE_CHANGED','Source changed before search.');
        if(referenceAdmission?.mode==='explicit-reference-team'){
          const freshSource=await inputDocument(workspace,options.requestFile);
          need(freshSource.sha256===source.sha256,'LAUNCH_SOURCE_CHANGED','Saved reference bytes changed before search.');
          const freshConfiguration=await readConfiguration({workspace,sessionFile:options.session,scopeFile:options.scope});
          verifyQualificationReferenceAdmission(referenceAdmission,{...freshConfiguration,requests:freshSource.document.requests,profile:{provider:'codex-cli',...PROFILE,authenticationMethod:'chatgpt'}});
        }
        searchReserved=true;
      },
      operatorFactory:config=>{live=true;const owned=operatorFactory({...config,onState:state=>{
        config.onState?.(state);for(const room of state.rooms??[])if(room.ended===false&&typeof room.id==='string'&&/^(?:battle|game-bestof3)-gen9championsvgc2026regmcbo3-\d+(?:-[a-z0-9]+pw)?$/u.test(room.id)&&!links.has(room.id)){
          links.add(room.id);write({state:'watch-link',kind:room.id.startsWith('game-')?'set':'game',room:canonical(room.id),url:'https://play.pokemonshowdown.com/'+room.id,source:'native-owned-room-id'});
        }} });return {...owned,dispatch:async(query,metadata)=>{
          if(query.op==='start-next'){
            need(searchReserved&&!searchDispatchAttempted,'LAUNCH_SEARCH_RESERVED','Search requires its released gate and cannot be repeated.');
            searchDispatchAttempted=true;
          }
          const response=await owned.dispatch(query,metadata);
          if(!searchReserved&&['status','arm','decision-policy','model-tool-mode','model-tool-catalog','call'].includes(query.op)){
            if(query.op!=='call'||['battle_skill_status','battle_review_status','battle_set_control_policy','battle_preflight'].includes(query.name)){
              adoption.push({op:query.op,...(query.name?{name:query.name}:{}),response});need(Buffer.byteLength(JSON.stringify(adoption))<=8*1024*1024,'LAUNCH_ADOPTION_BOUND','Startup evidence exceeded its bound.');
            }
          }return response;
        }};},
      // runRunner already publishes bounded, sanitized recovery context. Keep
      // that complete envelope so the same owner can protect/reconcile a live
      // request; a summary would discard its usable command/source contract.
      write:liveWrite,
    };
    const result=await run(['--run','--provider','codex-cli','--model',PROFILE.model,'--reasoning-effort',PROFILE.reasoningEffort,'--codex-context-mode','session','--codex-service-tier','fast','--model-tool-qualification',options.requestFile,'--session',options.session,'--scope',options.scope,...(options.executable?['--codex-executable',options.executable]:[])],runnerOptions);
    await output.save('live-result.json',result);return result;
  }finally{if(!live)await provider.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  launchWorkflow(parseLaunchArgs(process.argv.slice(2))).then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(error=>{process.stderr.write(JSON.stringify({state:'launch-failed',code:typeof error.code==='string'?error.code:'LAUNCH_FAILED',message:'The launch stopped; private evidence and any retained owned attention require manager review.'})+'\n');process.exitCode=1;});
}
