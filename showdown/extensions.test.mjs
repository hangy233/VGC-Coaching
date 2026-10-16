import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ShowdownClient} from './client.mjs';
import {AgentSession} from './agent-session.mjs';
import {saveDecisionNote,readDecisionNotes} from './decision-notes.mjs';
import {registerBattleTools} from './mcp-tools.mjs';
import {attachMetricsRecorder} from '../metrics/recorder.mjs';
import {registerTeamFromText} from '../metrics/import.mjs';
import {getTeamReport} from '../metrics/store.mjs';
import {recordCalculation} from '../workflow/calculations.mjs';
import {deleteTeamReport} from '../metrics/team-cleanup.mjs';

const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
const TEAM=[['Golisopod','Emergency Exit'],['Kommo-o','Soundproof'],['Rillaboom','Grassy Surge'],['Politoed','Drizzle'],['Farigiraf','Armor Tail'],['Sylveon','Pixilate']].map(([name,ability])=>`${name}\nAbility: ${ability}\nLevel: 50\nEVs: 32 HP / 32 SpA / 2 SpD\nModest Nature\n- Protect`).join('\n\n');
const room='battle-gen9championsvgc2026regmcbo3-2002',parent='game-bestof3-gen9championsvgc2026regmcbo3-2001';
const digest=team=>createHash('sha256').update(Teams.pack(team)).digest('hex');
function fixture(options={}){
  const team=Teams.import(TEAM),packed=Teams.pack(team),sent=[],client=new ShowdownClient({expectedTeamHash:digest(team)});
  client.connected=true;client.authenticated=true;client.epoch=1;client.searchState={searching:[],games:{}};
  client.ws={send:line=>sent.push(line),close:()=>{client.connected=false;client.authenticated=false;}};
  const session=new AgentSession(client,{username:'Fixture',packed,autoReady:false,...options});
  const own=()=>{session.ownedParents.add(parent);session.ownedRooms.add(parent);session.ownedRooms.add(room);session.roomParents.set(parent,parent);session.roomParents.set(room,parent);session.roomTeams.set(parent,client.expectedTeamHash);session.roomTeams.set(room,client.expectedTeamHash);};
  const request=()=>{own();client.receive(`>${room}\n|gametype|doubles\n|player|p1|Fixture\n|player|p2|Opponent\n|start\n|turn|3\n|request|${JSON.stringify({rqid:7,active:[{moves:[{move:'Protect',pp:10,target:'self'}]},{moves:[{move:'Protect',pp:10,target:'self'}]}],side:{id:'p1',name:'Fixture',pokemon:[{ident:'p1: A',details:'Golisopod, L50',active:true,condition:'100/100'},{ident:'p1: B',details:'Farigiraf, L50',active:true,condition:'100/100'}]}})}`);};
  return {client,session,sent,team,own,request};
}

test('loaded capabilities report actual optional implementations and immutable runtime identity',()=>{
  const f=fixture();try{
    const caps=f.session.snapshot().capabilities;
    assert.equal(caps.schemaVersion,2);assert.match(caps.buildRevision,/^[a-f0-9]{64}$/);assert(!caps.operations.includes('switch-team'));assert.equal(caps.features.decisionNotes,false);
    assert.equal(f.session.capabilities().loadedAt,caps.loadedAt);assert.equal(caps.sourceChangesRequireNewSession,true);assert.equal(f.sent.length,0);
    f.session.awaitingSet=true;f.client.searchPending=true;
    assert.equal(f.session.snapshot().awaitingSet,true);assert.equal(f.session.snapshot().searchPending,true);
  }finally{f.session.dispose();}
});

test('optional slow note saving never serializes choice and preserves observed request identity after completion',async()=>{
  let release,received;const f=fixture({decisionNoteWriter:async value=>{received=value;await new Promise(resolve=>{release=resolve;});return value;}});
  try{
    f.request();const action=f.session.snapshot().actions[0];
    const note=f.session.execute({id:'note-1',op:'note-decision',token:action.token,reason:'Predict a double target; use Protect.'});await Promise.resolve();await Promise.resolve();
    assert.equal(received.note.turn,3);assert.equal(received.note.rqid,7);assert.equal(received.teamId,f.client.expectedTeamHash);assert.equal(received.note.actionStatusAtNote,'unsubmitted');
    const chosen=await f.session.execute({id:'choose-1',op:'choose',confirmed:true,token:action.token,actions:[{type:'move',slot:1},{type:'move',slot:1}]});assert.equal(chosen.ok,true);
    release();assert.equal((await note).ok,true);
    f.client.receive(`>${room}\n|win|Fixture`);
    const after=f.session.execute({id:'note-after',op:'note-decision',token:action.token,ourPlan:'Protect pair'});await Promise.resolve();await Promise.resolve();release();assert.equal((await after).ok,true);
    assert.equal(received.note.actionStatusAtNote,'sent');assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,1);
    assert.equal((await f.session.execute({id:'foreign',op:'note-decision',token:'f'.repeat(64),reason:'Unknown token'})).ok,false);
  }finally{release?.();f.session.dispose();}
});

test('decision journals persist privately, sanitize text, verify actual calculator refs and reject cross-turn receipts',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgc-notes-'));
  try{
    const {teamId}=await registerTeamFromText({workspace,teamText:TEAM});
    const receipt=await recordCalculation({workspace,tool:'calculate_speed',input:{fixture:true},result:{fixture:true},context:{teamId,roomId:room,turn:3}});
    const note={noteId:'note-1',sessionId:randomUUID(),token:'a'.repeat(64),rqid:7,turn:3,reason:'Observe first.\nhttps://example.com/private',calculationRefs:[receipt.id]};
    const saved=await saveDecisionNote({workspace,teamId,room,note});assert.equal(saved.note.calculationRefs[0].provenance,'actual-mcp-tool');assert(!saved.note.reason.includes('example.com'));
    assert.equal((await saveDecisionNote({workspace,teamId,room,note})).unchanged,true);
    const read=await readDecisionNotes({workspace,teamId,room,fromTurn:3,toTurn:3});assert.equal(read.notes.length,1);assert.match(read.limitation,/execution/);
    assert.equal((await readDecisionNotes({workspace,teamId,room,fromTurn:4})).notes.length,0);
    await assert.rejects(saveDecisionNote({workspace,teamId,room,note:{...note,noteId:'wrong-turn',turn:4}}),/different battle or turn/);
    assert.equal(JSON.parse(await readFile(join(workspace,'cache','team-metrics','decision-notes',teamId+'--'+room+'.json'),'utf8')).notes.length,1);
    // A process crash can leave the writer's standard pending file. Explicit
    // team deletion must remove both the journal and that abandoned temp.
    const pending=join(workspace,'cache','team-metrics','decision-notes','.pending-'+teamId+'-'+randomUUID()+'.tmp');
    await writeFile(pending,'Abandoned decision-note write');
    assert.equal((await deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true})).complete,true);
    await assert.rejects(readFile(pending),{code:'ENOENT'});
    await assert.rejects(readDecisionNotes({workspace,teamId,room}),/deleted|delet/i);
  }finally{await rm(workspace,{recursive:true,force:true});}
});

test('idle team replacement preserves login, budget and old-room attribution while switching reports',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgc-team-switch-'));let f;
  const factory=({team,teamId,name,session})=>attachMetricsRecorder(f.client,{workspace,username:'Fixture',teamId,team,name,session});
  f=fixture({authorizedSets:3,recorderFactory:factory});
  try{
    const original=f.client.expectedTeamHash;f.session.attachMetricsRecorder(factory({team:f.team,teamId:original,name:'Original',session:f.session}));await f.session.metricsRecorder.flush();
    f.request();f.client.receive(`>${room}\n|win|Fixture`);f.client.receive(`>${parent}\n|win|Fixture`);await f.session.metricsRecorder.flush();
    const nextText=TEAM.replace('32 HP / 32 SpA / 2 SpD','31 HP / 32 SpA / 3 SpD'),nextId=digest(Teams.import(nextText)),before=f.sent.length;
    const command={id:'switch-once',op:'switch-team',confirmed:true,teamText:nextText,teamId:nextId,name:'Next'};
    const result=await f.session.execute(command);assert.equal(result.ok,true,result.error);assert.equal(result.result.teamId,nextId);assert.equal(result.result.queued,false);assert.equal(f.client.teamHash,null);
    assert.deepEqual(await f.session.execute(command),result);assert.equal(f.sent.length,before);assert.equal(f.session.authorizedSets,3);assert.equal(f.session.searchesSent,0);assert.equal(f.client.authenticated,true);assert.equal(f.session.roomTeamId(room),original);
    // Late old-game observations cannot appear in the next team's report.
    f.client.emit('battle-event',{room,type:'turn',data:['4']});await f.session.metricsRecorder.flush({savePending:true});
    assert.equal((await getTeamReport({workspace,teamId:nextId,includeIncomplete:true})).totals.games,0);assert.equal((await getTeamReport({workspace,teamId:original,includeIncomplete:true,includeOperational:true})).totals.games,1);
  }finally{await f.session.metricsRecorder?.close();f.session.dispose();await rm(workspace,{recursive:true,force:true});}
});

test('team replacement rejects active, unknown idle, invalid and racing switches without altering approved hash',async()=>{
  const teamText=TEAM.replace('32 HP / 32 SpA / 2 SpD','31 HP / 32 SpA / 3 SpD'),teamId=digest(Teams.import(teamText));
  let finish;const f=fixture({recorderFactory:async()=>{await new Promise(resolve=>{finish=resolve;});return {status:()=>({teamId,state:'error'}),flush:async()=>({teamId,state:'error'}),close:async()=>{}};}}),old=f.client.expectedTeamHash;
  try{
    const command={op:'switch-team',confirmed:true,teamText,teamId};
    f.client.searchState=null;assert.equal((await f.session.execute({id:'unknown-idle',...command})).ok,false);
    f.client.searchState={searching:[],games:{[parent]:'Fixture vs Opponent'}};assert.equal((await f.session.execute({id:'active-match',...command})).ok,false);
    f.client.searchState={searching:[],games:{}};assert.equal((await f.session.execute({id:'invalid-team',...command,teamText:'Pikachu\n- Protect'})).ok,false);
    const pending=f.session.execute({id:'prepare-fails',...command});await Promise.resolve();await Promise.resolve();
    assert.equal((await f.session.execute({id:'race',...command})).ok,false);assert.equal((await f.session.execute({id:'start-race',op:'start',confirmed:true})).ok,false);
    finish();assert.equal((await pending).ok,false);assert.equal(f.client.expectedTeamHash,old);assert.equal(f.sent.length,0);assert.equal(f.session.switchingTeam,false);
  }finally{finish?.();f.session.dispose();}
});

test('a late idle-state race rolls back the old recorder and never changes the approved team',async()=>{
  const teamText=TEAM.replace('32 HP / 32 SpA / 2 SpD','31 HP / 32 SpA / 3 SpD'),teamId=digest(Teams.import(teamText));let reopened=0,newClosed=0;
  const f=fixture({recorderFactory:async()=>({status:()=>({teamId,state:'ready'}),flush:async()=>({teamId,state:'ready'}),close:async()=>{newClosed++;}})}),old=f.client.expectedTeamHash;
  try{
    f.session.attachMetricsRecorder({status:()=>({teamId:old,state:'ready'}),flush:async()=>({teamId:old,state:'ready'}),close:async()=>{f.client.searchState={searching:[],games:{[parent]:'Fixture vs Opponent'}};},reopen:async()=>{reopened++;}});
    const result=await f.session.execute({id:'late-idle-race',op:'switch-team',confirmed:true,teamText,teamId});
    assert.equal(result.ok,false);assert.match(result.error,/confirm idle/);assert.equal(f.client.expectedTeamHash,old);assert.equal(f.session.metricsStatus().teamId,old);assert.equal(reopened,1);assert.equal(newClosed,1);assert.equal(f.sent.length,0);assert.equal(f.session.switchingTeam,false);
  }finally{f.session.dispose();}
});

test('historical replay saving returns the original team and requires an exact-team report import',async()=>{
  const f=fixture();try{
    f.own();const old=f.client.expectedTeamHash;
    f.client.state(parent).ended=true;f.client.state(parent).result={type:'win',winner:'Fixture'};
    f.client.state(room).ended=true;f.client.state(room).result={type:'win',winner:'Fixture'};
    f.client.replayRequests.set(room,{verified:true,url:'https://replay.pokemonshowdown.com/'+room.slice(7),verifiedAt:'2026-10-15T00:00:00Z'});
    // Model a completed switch; this cached replay needs no upload or request.
    f.client.expectedTeamHash='b'.repeat(64);
    const saved=await f.session.execute({id:'historical-replay',op:'save-replays',confirmed:true,room:parent});
    assert.equal(saved.ok,true,saved.error);assert.equal(saved.result.teamId,old);assert.equal(saved.result.requiresReplayImport,true);assert.equal(saved.result.replays.length,1);assert.equal(f.sent.length,0);
  }finally{f.session.dispose();}
});

test('battle MCP exposes bounded schemas and legal-team switching without automatic registration or socket actions',async()=>{
  const registrations=new Map(),calls=[];registerBattleTools({registerTool:(name,settings,handler)=>registrations.set(name,{settings,handler})},{workspace:tmpdir(),call:async(_descriptor,command)=>{calls.push(command);return {ok:true,result:command};}});
  for(const name of ['battle_capabilities','battle_note_decision','battle_decision_notes','battle_switch_team'])assert(registrations.has(name));
  const entry=registrations.get('battle_switch_team');
  assert.equal(entry.settings.annotations.destructiveHint,true);
  assert.equal(entry.settings.inputSchema.safeParse({confirmed:true,commandId:'switch',teamText:TEAM}).success,true);
  assert.equal(entry.settings.inputSchema.safeParse({confirmed:true,teamText:TEAM}).success,false);
  assert.equal((await entry.handler({confirmed:true,commandId:'bad',teamText:'Pikachu\n- Protect'})).isError,true);assert.equal(calls.length,0);
  assert.equal((await entry.handler({confirmed:true,commandId:'switch',teamText:TEAM})).isError,false);assert.equal(calls[0].op,'switch-team');assert.equal(calls[0].teamId,digest(Teams.import(TEAM)));assert.equal(calls[0].confirmed,true);
  const noteSchema=registrations.get('battle_note_decision').settings.inputSchema;
  assert.equal(noteSchema.safeParse({commandId:'note',token:'a'.repeat(64),calculationRefs:['unverified arbitrary prose']}).success,false);
});
