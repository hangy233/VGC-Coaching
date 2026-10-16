import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {listTeams} from './store.mjs';
import {refreshMetricsSources} from './import.mjs';
import {ensureTeamReport,updateTeamReport} from './live-reports.mjs';
import {getMetricsTeamDeletion} from './catalog.mjs';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const teamPattern=/^[a-f0-9]{64}$/;
const token=(revision,teams)=>createHash('sha256').update(JSON.stringify([revision,teams.map(t=>({teamId:t.teamId,name:t.name,games:t.storedGames})).sort((a,b)=>a.teamId.localeCompare(b.teamId))])).digest('hex');

/** A private loopback viewer. It only observes/imports local sources; no battle controls. */
export async function startMetricsViewer({workspace=resolve(fileURLToPath(new URL('..',import.meta.url))),port=52615,refreshMs=10000}={}) {
  if(!Number.isSafeInteger(port)||port<0||port>65535)throw new Error('Use a valid local port');
  if(!Number.isSafeInteger(refreshMs)||refreshMs<500)throw new Error('Refresh interval must be at least 500 ms');
  let refreshing;
  const refresh=()=>refreshing||=(async()=>{try{return await refreshMetricsSources({workspace});}finally{refreshing=null;}})();
  const server=createServer(async(req,res)=>{
    const send=(status,body,type='application/json; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(type.startsWith('application/json')?JSON.stringify(body):body);};
    try{
      const boundPort=server.address()?.port;
      if(req.headers.host!==`127.0.0.1:${boundPort}`||req.headers['sec-fetch-site']==='cross-site')return send(403,{error:'Local metrics viewer only'});
      if(req.method!=='GET')return send(405,{error:'Read-only viewer'});
      const url=new URL(req.url,'http://127.0.0.1:'+boundPort);
      if(!['/','/api/version','/api/agent-report','/agent-report.md'].includes(url.pathname))return send(404,{error:'Not found'});
      if([...url.searchParams.keys()].some(k=>k!=='team'))return send(400,{error:'Unsupported report option'});
      const requested=url.searchParams.get('team');
      if(requested&&!teamPattern.test(requested))return send(400,{error:'Invalid team identifier'});
      const refreshed=await refresh();
      let teams=await listTeams({workspace});
      const teamId=requested||teams[0]?.teamId;
      if(!teamId)return send(200,'<!doctype html><title>Team reports</title><main><h1>No teams recorded yet</h1><p>Register a team or import a saved game to create its report.</p></main>','text/html; charset=utf-8');
      if(requested&&!(await listTeams({workspace,includeArchived:true})).some(team=>team.teamId===requested)){
        const deletion=await getMetricsTeamDeletion({workspace,teamId:requested});
        if(deletion)return send(410,{deleted:true,pending:deletion.state==='deleting'});
        return send(404,{error:'Team report not found; register a team first'});
      }
      if(url.pathname==='/'&&!requested){res.writeHead(302,{Location:'/?team='+teamId,'Cache-Control':'no-store'});res.end();return;}
      if(url.pathname==='/api/version'){
        const stable=await updateTeamReport({workspace,teamId});
        if(stable.archived)return send(410,{archived:true});
        return send(200,{revision:token(stable.revision,teams),warnings:refreshed.warnings||[]});
      }
      if(url.pathname==='/api/agent-report'||url.pathname==='/agent-report.md'){
        const stable=await updateTeamReport({workspace,teamId});
        if(stable.archived)return send(410,{archived:true});
        if(url.pathname==='/api/agent-report'){
          const report=JSON.parse(await readFile(stable.agentJsonPath,'utf8'));
          return send(200,{...report,refresh:refreshed});
        }
        return send(200,await readFile(stable.agentMarkdownPath,'utf8'),'text/plain; charset=utf-8');
      }
      const stable=await ensureTeamReport({workspace,teamId});
      teams=await listTeams({workspace});
      if(!stable.path)return send(404,{error:'Team report not found'});
      let html=await readFile(stable.path,'utf8');
      const initial=token(stable.revision,teams);
      const navigation=`<section aria-label="Saved team reports"><label>Team report<select id="team-version">${teams.map(t=>`<option value="${t.teamId}"${t.teamId===teamId?' selected':''}>${escape(t.name)} (${t.storedGames} games)</option>`).join('')}</select></label><p class="muted" id="live-status">Updates automatically when new games are recorded. ${teams.length} of 10 recent teams.</p><p>AI review: <a href="/agent-report.md?team=${teamId}">readable notes</a> · <a href="/api/agent-report?team=${teamId}">structured data</a></p></section>`;
      html=html.replace('<main>','<main>'+navigation).replace("default-src 'none';","default-src 'none'; connect-src 'self';");
      const script=`<script>
document.getElementById('team-version').addEventListener('change',event=>{location.href='/?team='+encodeURIComponent(event.target.value)});
let metricsRefreshing=false;const metricsRevision=${JSON.stringify(initial)};
setInterval(async()=>{if(document.hidden||metricsRefreshing)return;metricsRefreshing=true;try{const response=await fetch('/api/version?team='+${JSON.stringify(teamId)},{cache:'no-store'});if(response.status===410){location.href='/';return}if(!response.ok)throw new Error('Refresh unavailable');const next=await response.json();if(next.revision!==metricsRevision){location.reload();return}document.getElementById('live-status').textContent=next.warnings?.length?'Some local sources could not refresh; saved results are retained.':'Up to date. New games update this report automatically.';}catch{document.getElementById('live-status').textContent='Refresh unavailable. Saved results remain visible.';}finally{metricsRefreshing=false}},${refreshMs});
</script>`;
      html=html.replace('</body>',script+'</body>');
      send(200,html,'text/html; charset=utf-8');
    }catch{send(500,{error:'The local team report could not be refreshed. Saved metrics were retained.'});}
  });
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',ok);});
  return {server,url:`http://127.0.0.1:${server.address().port}/`,close:()=>new Promise((ok,fail)=>server.close(error=>error?fail(error):ok()))};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);let port=52615;
  if(args.length){if(args.length!==2||args[0]!=='--port'||!/^\d+$/.test(args[1]))throw new Error('Usage: node metrics/viewer.mjs [--port 52615]');port=Number(args[1]);}
  const viewer=await startMetricsViewer({port});console.log('Team reports: '+viewer.url);
}
