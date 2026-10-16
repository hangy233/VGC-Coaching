import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,cp,mkdir} from 'node:fs/promises';
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
import {saveDecisionNote} from '../showdown/decision-notes.mjs';
import {startMetricsViewer} from '../metrics/viewer.mjs';

const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
const TEAM=[['Golisopod','Emergency Exit'],['Kommo-o','Soundproof'],['Rillaboom','Grassy Surge'],['Politoed','Drizzle'],['Farigiraf','Armor Tail'],['Sylveon','Pixilate']]
  .map(([name,ability])=>`${name}\nAbility: ${ability}\nLevel: 50\nEVs: 32 HP / 32 SpA / 2 SpD\nModest Nature\n- Protect`).join('\n\n');
const decode=result=>JSON.parse(result.content.find(item=>item.type==='text').text);

test('combined MCP creates, appends, and queries exact-team reports from observed battle completion',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgc-report-cycle-'));
  const mcp=new Client({name:'report-cycle-tests',version:'1'},{capabilities:{}});
  let bridge,session,recorder,viewer;
  const sent=[],errors=[];
  try{
    const source=join(workspace,'skills','champions-mc-matchups'),target=join(workspace,'installed','champions-mc-matchups');
    await mkdir(join(workspace,'skills'));await cp(fileURLToPath(new URL('../skills/champions-mc-matchups',import.meta.url)),source,{recursive:true});await cp(source,target,{recursive:true});
    await mcp.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./fixtures/report-cycle-mcp-server.mjs',import.meta.url)),workspace,target],stderr:'pipe'}));
    const tools=(await mcp.listTools()).tools.map(tool=>tool.name);
    for(const name of ['battle_status','battle_choose','team_metrics_register_team','team_metrics_sync_battles','team_metrics_report','team_metrics_agent_report','team_metrics_game_evidence','battle_skill_read','battle_review_save','battle_preflight','battle_switch_team','battle_note_decision','team_metrics_health','team_metrics_compare','team_metrics_annotate_game','team_metrics_open_viewer'])assert(tools.includes(name),name);
    const call=async(name,args={})=>{
      const response=await mcp.callTool({name,arguments:['battle_choose','battle_switch_team'].includes(name) ? {controllerLease:'a'.repeat(64),...args} : args});
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
    live.connected=true;live.authenticated=true;live.epoch=1;live.searchState={searching:[],games:{}};
    live.ws={send:line=>sent.push(line),close:()=>{live.connected=false;live.authenticated=false;}};
    const recorderFactory=({team,teamId,name,session:owner})=>attachMetricsRecorder(live,{workspace,username:'Fixture',teamId,team,name,session:owner,onError:()=>errors.push('Recorder persistence failed')});
    session=new AgentSession(live,{username:'Fixture',packed,autoReady:false,controllerRequired:false,recorderFactory,decisionNoteWriter:args=>saveDecisionNote({workspace,...args})});
    recorder=recorderFactory({teamId,team,name:'Fixture rain',session});
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
    const calculated=await call('calculate_speed',{pokemon:[{species:'Golisopod',nature:'Modest',ability:'Emergency Exit',statPoints:{hp:32,spa:32,spd:2}}],evidenceContext:{teamId,roomId:room,turn:1}});
    assert.equal(calculated.gen,0);const calculationId=calculated.calculationRef.id;
    assert.equal((await call('battle_calculation_evidence',{teamId,id:calculationId})).provenance,'actual-mcp-tool');
    const chosen=await call('battle_choose',{confirmed:true,commandId:'fixture-protect-pair',token:action.token,actions:[{type:'move',slot:1},{type:'move',slot:1}]});
    assert.equal(chosen.result.status,'sent-not-acknowledged');
    const note=await call('battle_note_decision',{commandId:'fixture-note',token:action.token,ourPlan:'Protect both slots in this protocol fixture.',predictedOpposingActions:['Unknown; the fixture does not reveal a next move.'],alternatives:['No counterfactual claim from the abbreviated fixture.'],reason:'Keep selected intent separate from server execution.',calculationRefs:[calculationId]});
    assert.equal(note.result.note.calculationRefs[0].provenance,'actual-mcp-tool');
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
    assert.equal((await call('battle_decision_notes',{teamId,room,fromTurn:1,toTurn:1})).notes.length,1);
    assert.equal((await call('battle_capabilities')).result.features.idleTeamSwitch,true);
    const guidance=await call('battle_skill_read');assert(guidance.filesRead.length>0);
    const review={teamId,parentId:parent,readReceipt:guidance.readReceipt,calculationIds:[calculationId],decisionReview:[{roomId:room,turn:1,knownBefore:'Protect was present in the supplied legal fixture.',opposingRead:'Next opponent actions are unknown.',selected:'Protect in both own slots.',accepted:'The server sentchoice line acknowledged the pair.',executed:'Both Protect announcements were observed.',partnerProgress:'Partner Protect executed in this abbreviated fixture.',limitation:'The fixture does not establish a tactical alternative.'}],positiveEvidence:[{roomId:room,turn:1,observation:'Selection, acknowledgment and execution have separate evidence.',whyPreserve:'Do not infer a decision solely from the final outcome.'}],executionAndVariance:[],reusableOutcome:{kind:'no-change',reason:'The fixture provides no new tactical lesson.',evidence:[{roomId:room,turn:1,observation:'Only Protect and the fixture result were observed.'}]},validation:[{check:'Evidence boundaries',result:'Reviewed',evidence:'No opposing choice or numerical outcome was inferred.'}]};
    const reviewed=await call('battle_review_save',review);assert.equal(reviewed.complete,true);
    assert.equal((await call('battle_review_status',{teamId,parentId:parent})).complete,true);
    assert.equal((await call('battle_preflight',{teamId})).ready,true);
    const health=await call('team_metrics_health',{teamId});assert.equal(health.teams[0].snapshot.status,'verified');assert.equal(health.teams[0].missingReplays.length,1);

    const changed=await call('team_metrics_register_team',{teamText:TEAM.replace('32 HP / 32 SpA / 2 SpD','31 HP / 32 SpA / 3 SpD'),name:'Fixture changed'});
    assert.notEqual(changed.teamId,teamId);
    assert.equal((await call('team_metrics_report',{teamId:changed.teamId})).totals.games,0);
    const comparison=await call('team_metrics_compare',{teamA:teamId,teamB:changed.teamId});assert(comparison.setChanges.some(change=>change.change==='modified'));
    await call('team_metrics_annotate_game',{teamId,roomId:room,action:'exclude',reason:'Synthetic technical exclusion for audit coverage.'});
    assert.equal((await call('team_metrics_report',{teamId})).totals.games,0);
    assert.equal((await call('team_metrics_report',{teamId,includeManuallyExcluded:true})).totals.games,1);
    assert.equal((await call('team_metrics_game_annotations',{teamId,roomId:room})).originalOutcome,'win');
    assert.equal((await call('battle_review_status',{teamId,parentId:parent})).complete,false);
    await call('team_metrics_annotate_game',{teamId,roomId:room,action:'include',reason:'Restore the controlled fixture sample.'});
    assert.equal((await call('battle_review_save',{...review,expectedRevision:reviewed.revision})).revision,2);
    const wrongTeam=await mcp.callTool({name:'team_metrics_sync_battles',arguments:{teamId:changed.teamId}});
    assert.equal(wrongTeam.isError,true);
    assert.equal((await call('team_metrics_report',{teamId})).totals.games,1);
    assert.equal((await call('team_metrics_report',{teamId:changed.teamId})).totals.games,0);
    const switched=await call('battle_switch_team',{confirmed:true,commandId:'switch-approved-fixture',teamId:changed.teamId});assert.equal(switched.result.authenticated,true);assert.equal(switched.result.uploaded,false);
    const preflight=await call('battle_preflight',{teamId:changed.teamId});assert.equal(preflight.ready,true);assert.equal(preflight.reviewTeamId,teamId);
    viewer=await startMetricsViewer({workspace,port:0});const port=Number(new URL(viewer.url).port);
    const opened=await call('team_metrics_open_viewer',{teamId:changed.teamId,port});assert.equal(opened.reused,true);assert(opened.url.includes(changed.teamId));
    assert.equal((await call('team_metrics_viewer_status',{port})).verified,true);
    assert.deepEqual(errors,[]);
    assert.equal(sent.filter(line=>line.includes('/choose ')).length,1);
    assert.equal(sent.some(line=>/\/(?:search|trn|savereplay|utm)\b/.test(line)),false);
    assert.equal((await call('battle_status')).result.searchesSent,0);
  }finally{
    await mcp.close();await bridge?.close();await viewer?.close();await (session?.metricsRecorder||recorder)?.close();session?.dispose();
    await rm(workspace,{recursive:true,force:true});
  }
});
