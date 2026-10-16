import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {saveBattle,registerMetricsTeam,isMetricsTeamActive,listTeams} from './store.mjs';
import {updateTeamReport,ensureTeamReport} from './live-reports.mjs';
import {startMetricsViewer} from './viewer.mjs';

const teamId='a'.repeat(64);
const record=(game,team=teamId)=>({schemaVersion:1,roomId:'battle-fixture-'+game,parentId:null,teamId:team,username:'Fixture',ownSide:'p1',players:{p1:'Fixture',p2:'Opponent'},outcome:'win',completed:true,turns:1,opponentRoster:['Charizard'],selected:['Golisopod'],selectionKnown:true,leads:['Golisopod'],pokemon:[{key:'golisopod:1',species:'Golisopod',forms:[],selected:true,lead:true,moves:[{move:'Protect',uses:1}]}],quality:{complete:true,operational:false,warnings:[]},team:{name:'Golisopod rain',format:'gen9championsvgc2026regmc',roster:['Golisopod']},metadata:{}});
const embedded=html=>JSON.parse(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/.exec(html)[1]);

test('new games refresh one stable team report while another version stays separate',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgcm-profile-'));
  try{
    await saveBattle({workspace,record:record(1)});const first=await updateTeamReport({workspace,teamId});
    assert.equal(embedded(await readFile(first.path,'utf8')).totals.games,1);
    assert.equal(JSON.parse(await readFile(first.agentJsonPath,'utf8')).totals.games,1);
    assert((await readFile(first.agentMarkdownPath,'utf8')).includes(teamId));
    await saveBattle({workspace,record:record(2)});const next=await updateTeamReport({workspace,teamId});
    assert.equal(next.path,first.path);assert.notEqual(next.revision,first.revision);assert.equal(next.games,2);
    assert.equal(next.agentJsonPath,first.agentJsonPath);
    assert.equal(JSON.parse(await readFile(next.agentJsonPath,'utf8')).totals.games,2);
    await saveBattle({workspace,record:record(2)});const unchanged=await updateTeamReport({workspace,teamId});assert.equal(unchanged.changed,false);
    const secondTeam='b'.repeat(64);await registerMetricsTeam({workspace,teamId:secondTeam,name:'New team',format:'gen9championsvgc2026regmc',roster:['Sylveon']});
    const empty=await ensureTeamReport({workspace,teamId:secondTeam});assert.notEqual(empty.path,first.path);assert.equal(empty.games,0);
    assert.equal(embedded(await readFile(first.path,'utf8')).totals.games,2);
  }finally{await rm(workspace,{recursive:true,force:true});}
});

test('background report regeneration cannot restore a team evicted from the ten-team LRU',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgcm-archive-'));
  try{
    for(let i=0;i<11;i++)await registerMetricsTeam({workspace,teamId:i.toString(16).padStart(64,'0'),name:'Team '+i,format:'gen9championsvgc2026regmc',roster:['Sylveon']});
    const archived='0'.repeat(64);assert.equal(await isMetricsTeamActive({workspace,teamId:archived}),false);
    assert.equal((await updateTeamReport({workspace,teamId:archived})).archived,true);
    assert.equal(await isMetricsTeamActive({workspace,teamId:archived}),false);
    await ensureTeamReport({workspace,teamId:archived});assert.equal(await isMetricsTeamActive({workspace,teamId:archived}),true);
    assert.equal((await listTeams({workspace})).length,10);
  }finally{await rm(workspace,{recursive:true,force:true});}
});

test('live viewer discovers a new game through its read-only revision endpoint',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgcm-viewer-'));let viewer;
  try{
    await saveBattle({workspace,record:record(1)});viewer=await startMetricsViewer({workspace,port:0,refreshMs:500});
    const initial=await fetch(viewer.url);assert.equal(initial.status,200);assert(initial.url.endsWith('?team='+teamId));const html=await initial.text();assert(html.includes('id="team-version"'));assert(html.includes('connect-src \'self\''));assert.equal(embedded(html).totals.games,1);
    const before=await (await fetch(viewer.url+'api/version?team='+teamId)).json();
    const brief=await (await fetch(viewer.url+'api/agent-report?team='+teamId)).json();
    assert.equal(brief.kind,'vgc-team-agent-report');assert.equal(brief.team.teamId,teamId);assert.equal(brief.totals.games,1);
    const notes=await fetch(viewer.url+'agent-report.md?team='+teamId);
    assert(notes.headers.get('content-type').startsWith('text/plain'));assert((await notes.text()).includes(teamId));
    await saveBattle({workspace,record:record(2)});
    const recency=(await listTeams({workspace}))[0].usageOrder;
    const after=await (await fetch(viewer.url+'api/version?team='+teamId)).json();assert.notEqual(after.revision,before.revision);
    assert.equal((await listTeams({workspace}))[0].usageOrder,recency);
    assert.equal((await fetch(viewer.url,{method:'POST'})).status,405);
    assert.equal((await fetch(viewer.url+'?team=invalid')).status,400);
    const beforeUnknown=(await listTeams({workspace})).length;
    assert.equal((await fetch(viewer.url+'?team='+'d'.repeat(64))).status,404);
    assert.equal((await fetch(viewer.url+'api/version?team='+'d'.repeat(64))).status,404);
    assert.equal((await fetch(viewer.url+'api/agent-report?team='+'d'.repeat(64))).status,404);
    await assert.rejects(updateTeamReport({workspace,teamId:'d'.repeat(64)}),/not found/);
    assert.equal((await listTeams({workspace})).length,beforeUnknown);
    assert.equal(embedded(await (await fetch(viewer.url+'?team='+teamId)).text()).totals.games,2);
  }finally{await viewer?.close();await rm(workspace,{recursive:true,force:true});}
});
