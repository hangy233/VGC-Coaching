import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ShowdownClient} from '../showdown/client.mjs';
import {AgentSession} from '../showdown/agent-session.mjs';
import {serveLocalSession} from '../showdown/local-bridge.mjs';
import {attachMetricsRecorder} from '../metrics/recorder.mjs';

const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
const TEAM=[['Golisopod','Emergency Exit'],['Kommo-o','Soundproof'],['Rillaboom','Grassy Surge'],['Politoed','Drizzle'],['Farigiraf','Armor Tail'],['Sylveon','Pixilate']]
  .map(([name,ability])=>`${name}\nAbility: ${ability}\nLevel: 50\nEVs: 32 HP / 32 SpA / 2 SpD\nModest Nature\n- Protect`).join('\n\n');
const decode=result=>JSON.parse(result.content.find(item=>item.type==='text').text);

test('combined MCP creates, appends, and queries exact-team reports from observed battle completion',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgc-report-cycle-'));
  const mcp=new Client({name:'report-cycle-tests',version:'1'},{capabilities:{}});
  let bridge,session,recorder;
  const sent=[],errors=[];
  try{
    await mcp.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./fixtures/report-cycle-mcp-server.mjs',import.meta.url)),workspace],stderr:'pipe'}));
    const tools=(await mcp.listTools()).tools.map(tool=>tool.name);
    for(const name of ['battle_status','battle_choose','team_metrics_register_team','team_metrics_sync_battles','team_metrics_report','team_metrics_agent_report','team_metrics_game_evidence'])assert(tools.includes(name),name);
    const call=async(name,args={})=>{
      const response=await mcp.callTool({name,arguments:args});
      assert.notEqual(response.isError,true,response.content?.find(item=>item.type==='text')?.text);
      return decode(response);
    };
    const registered=await call('team_metrics_register_team',{teamText:TEAM,name:'Fixture rain'});
    const teamId=registered.teamId;
    assert.match(teamId,/^[a-f0-9]{64}$/);
    assert.equal((await call('team_metrics_report',{teamId})).totals.games,0);
    assert.equal((await call('team_metrics_agent_report',{teamId})).team.teamId,teamId);

    const team=Teams.import(TEAM),packed=Teams.pack(team);
    assert.equal(createHash('sha256').update(packed).digest('hex'),teamId);
    const live=new ShowdownClient({expectedTeamHash:teamId});
    live.connected=true;live.authenticated=true;live.epoch=1;
    live.ws={send:line=>sent.push(line),close:()=>{live.connected=false;live.authenticated=false;}};
    session=new AgentSession(live,{username:'Fixture',packed,autoReady:false});
    recorder=attachMetricsRecorder(live,{workspace,username:'Fixture',teamId,team,name:'Fixture rain',session,onError:()=>errors.push('Recorder persistence failed')});
    session.attachMetricsRecorder(recorder);
    bridge=await serveLocalSession(session,{descriptorPath:join(workspace,'cache','showdown-session.json')});

    // These are pre-existing owned observations, not a matchmaking search.
    const room='battle-gen9championsvgc2026regmcbo3-1002';
    const parent='game-bestof3-gen9championsvgc2026regmcbo3-1001';
    session.ownedRooms.add(parent);session.ownedRooms.add(room);session.ownedParents.add(parent);
    session.roomParents.set(parent,parent);session.roomParents.set(room,parent);
    live.receive(`>${parent}\n|uhtml|game|<a href="/${room}">Game 1</a>`);
    const request={rqid:7,active:[{moves:[{move:'Protect',pp:10,target:'self'}]},{moves:[{move:'Protect',pp:10,target:'self'}]}],side:{id:'p1',name:'Fixture',pokemon:[
      {ident:'p1: Shell',details:'Golisopod, L50',active:true,condition:'182/182'},
      {ident:'p1: Longneck',details:'Farigiraf, L50',active:true,condition:'227/227'},
      {ident:'p1: Rain',details:'Politoed, L50',active:false,condition:'197/197'},
      {ident:'p1: Ribbon',details:'Sylveon, L50',active:false,condition:'202/202'},
    ]}};
    live.receive(`>${room}\n|gen|9\n|gametype|doubles\n|tier|[Gen 9] Champions VGC 2026 Reg M-C (Bo3)\n|player|p1|Fixture\n|player|p2|Opponent\n|start\n|switch|p1a: Shell|Golisopod, L50|182/182\n|switch|p1b: Longneck|Farigiraf, L50|227/227\n|switch|p2a: Target|Pikachu, L50|100/100\n|switch|p2b: Partner|Eevee, L50|100/100\n|turn|1\n|request|${JSON.stringify(request)}`);
    const before=(await call('battle_status')).result;
    assert.equal(before.searchesSent,0);assert.equal(before.metrics.teamId,teamId);
    const action=before.actions.find(action=>action.room===room);
    assert(action?.token);
    const chosen=await call('battle_choose',{confirmed:true,commandId:'fixture-protect-pair',token:action.token,actions:[{type:'move',slot:1},{type:'move',slot:1}]});
    assert.equal(chosen.result.status,'sent-not-acknowledged');
    live.receive(`>${room}\n|sentchoice|move 1, move 1\n|move|p1a: Shell|Protect|p1a: Shell\n|move|p1b: Longneck|Protect|p1b: Longneck\n|win|Fixture`);
    live.receive(`>${parent}\n|win|Fixture`);
    // No direct recorder flush: the MCP operation must drain completion writes.
    const synced=await call('team_metrics_sync_battles',{teamId});
    assert.equal(synced.recording.teamId,teamId);
    assert.equal(synced.recording.state,'ready');
    assert.equal(synced.report.totals.games,1);assert.equal(synced.report.totals.sets.wins,1);
    assert.equal(synced.report.totals.wins,1);
    assert.equal(synced.report.pokemon.find(p=>p.species==='Golisopod').moves.find(move=>move.move==='Protect').uses,1);
    assert.equal(synced.report.quality.excludedOperational,0);
    assert.equal((await call('team_metrics_sync_battles',{teamId})).report.totals.games,1);
    const queried=await call('team_metrics_report',{teamId});
    assert.equal(queried.totals.games,1);assert.equal(queried.totals.sets.wins,1);
    const brief=await call('team_metrics_agent_report',{teamId,includeGames:true});
    assert.equal(brief.team.teamId,teamId);assert.equal(brief.totals.games,1);assert.equal(brief.games[0].roomId,room);
    assert.equal(JSON.parse(await readFile(synced.stableReport.agentJsonPath,'utf8')).totals.games,1);
    const evidence=await call('team_metrics_game_evidence',{teamId,roomId:room,fromTurn:1,toTurn:1});
    assert.equal(evidence.complete,true);
    assert(evidence.events.some(event=>event.type==='move'&&event.data[1]==='Protect'));

    const changed=await call('team_metrics_register_team',{teamText:TEAM.replace('32 HP / 32 SpA / 2 SpD','31 HP / 32 SpA / 3 SpD'),name:'Fixture changed'});
    assert.notEqual(changed.teamId,teamId);
    assert.equal((await call('team_metrics_report',{teamId:changed.teamId})).totals.games,0);
    const wrongTeam=await mcp.callTool({name:'team_metrics_sync_battles',arguments:{teamId:changed.teamId}});
    assert.equal(wrongTeam.isError,true);
    assert.equal((await call('team_metrics_report',{teamId})).totals.games,1);
    assert.equal((await call('team_metrics_report',{teamId:changed.teamId})).totals.games,0);
    assert.deepEqual(errors,[]);
    assert.equal(sent.filter(line=>line.includes('/choose ')).length,1);
    assert.equal(sent.some(line=>/\/(?:search|trn|savereplay|utm)\b/.test(line)),false);
    assert.equal((await call('battle_status')).result.searchesSent,0);
  }finally{
    await mcp.close();await bridge?.close();await recorder?.close();session?.dispose();
    await rm(workspace,{recursive:true,force:true});
  }
});
