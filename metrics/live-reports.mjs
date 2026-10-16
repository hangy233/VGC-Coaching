import {mkdir,lstat,realpath,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {join,relative,isAbsolute,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {getTeamReport,isMetricsTeamActive} from './store.mjs';
import {renderDashboard} from './dashboard.mjs';
import {createAgentTeamReport} from './agent-service.mjs';
import {renderAgentReportMarkdown} from './agent-report.mjs';
import {acquireMetricsBattleLock,assertMetricsTeamWritable} from './catalog.mjs';

const queues=new Map();
const validTeam=teamId=>typeof teamId==='string'&&/^[a-f0-9]{64}$/.test(teamId);
const inside=(root,path)=>{const r=relative(root,path);return r!==''&&r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r);};

export async function teamReportPath({workspace,teamId,create=false,format='html'}) {
  if(!validTeam(teamId))throw new Error('Use an exact team fingerprint for a stable report');
  if(create)await assertMetricsTeamWritable({workspace,teamId});
  const suffix={html:'.html',json:'.agent.json',markdown:'.agent.md'}[format];
  if(!suffix)throw new Error('Unsupported stable report format');
  const root=await realpath(workspace);let directory=root;
  for(const part of ['cache','team-metrics','reports','teams']){
    directory=join(directory,part);
    let info;try{info=await lstat(directory);}catch(error){
      if(error.code!=='ENOENT')throw error;
      if(!create)return join(root,'cache','team-metrics','reports','teams',teamId+suffix);
      try{await mkdir(directory);}catch(mkdirError){if(mkdirError.code!=='EEXIST')throw mkdirError;}
      info=await lstat(directory);
    }
    if(!info.isDirectory()||info.isSymbolicLink()||!inside(root,await realpath(directory)))throw new Error('Stable reports must use real workspace directories');
  }
  const path=join(directory,teamId+suffix);
  try{const info=await lstat(path);if(info.isSymbolicLink()||!info.isFile())throw new Error('Stable report target must be a regular file');}catch(error){if(error.code!=='ENOENT')throw error;}
  return path;
}

/** Rebuild a derived report without changing LRU recency or restoring an archive. */
export async function updateTeamReport({workspace,teamId}={}) {
  if(!validTeam(teamId))throw new Error('Use an exact team fingerprint for a stable report');
  const key=workspace+'|'+teamId,previous=queues.get(key)||Promise.resolve();
  const action=previous.catch(()=>{}).then(async()=>{
    const release=await acquireMetricsBattleLock({workspace,teamId,roomId:'team-report'});
    try{
    const active=await isMetricsTeamActive({workspace,teamId});
    if(active===false)return {teamId,archived:true,path:null};
    if(active===null)throw new Error('Team report not found; register a legal team first');
    const report=await getTeamReport({workspace,teamId,touch:false});
    const data=renderDashboard(report);
    const agent=await createAgentTeamReport({workspace,report});
    const agentJson=JSON.stringify(agent,null,2)+'\n',agentMarkdown=renderAgentReportMarkdown(agent);
    const path=await teamReportPath({workspace,teamId,create:true});
    const agentJsonPath=await teamReportPath({workspace,teamId,create:true,format:'json'});
    const agentMarkdownPath=await teamReportPath({workspace,teamId,create:true,format:'markdown'});
    const revision=createHash('sha256').update(data).update(agentJson).update(agentMarkdown).digest('hex');
    let changed=false;
    for(const [target,content]of [[path,data],[agentJsonPath,agentJson],[agentMarkdownPath,agentMarkdown]]){
      let current;try{current=await readFile(target,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
      if(current===content)continue;
      const temp=join(target.slice(0,target.lastIndexOf(sep)),'.pending-'+teamId+'-'+randomUUID()+'.tmp');
      try{await writeFile(temp,content,{flag:'wx',mode:0o600});await rename(temp,target);changed=true;}finally{await rm(temp,{force:true});}
    }
    return {teamId,path,agentJsonPath,agentMarkdownPath,revision,changed,games:report.totals.games};
    }finally{await release();}
  });
  queues.set(key,action);try{return await action;}finally{if(queues.get(key)===action)queues.delete(key);}
}

/** An explicit report access can bring an archived team back into the ten-team LRU. */
export async function ensureTeamReport({workspace,teamId}={}) {
  const report=await getTeamReport({workspace,...(teamId?{teamId}:{})});
  if(!report.team.teamId)return {teamId:null,path:null,games:0};
  return updateTeamReport({workspace,teamId:report.team.teamId});
}
