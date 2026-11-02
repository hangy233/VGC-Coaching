import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
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
import {registerMetricsTeam} from '../metrics/catalog.mjs';

const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
const TEAM=[['Golisopod','Emergency Exit'],['Kommo-o','Soundproof'],['Rillaboom','Grassy Surge'],['Politoed','Drizzle'],['Farigiraf','Armor Tail'],['Sylveon','Pixilate']].map(([name,ability])=>`${name}\nAbility: ${ability}\nLevel: 50\nEVs: 32 HP / 32 SpA / 2 SpD\nModest Nature\n- Protect`).join('\n\n');
const room='battle-gen9championsvgc2026regmcbo3-2002',parent='game-bestof3-gen9championsvgc2026regmcbo3-2001';
const digest=team=>createHash('sha256').update(Teams.pack(team)).digest('hex');
async function fixtureWorkspace(prefix){const base=join(process.cwd(),'cache');await mkdir(base,{recursive:true});return mkdtemp(join(base,prefix));}
const planPair=[{type:'move',slot:1},{type:'move',slot:1}];
const turnPlan={objective:'Preserve both answers while scouting the opposing pair.',priorityThreat:'Unknown opposing target',preserveIds:['pokemon-poli'],chosenPair:planPair,opposingPair:['Attack the first slot','Protect the partner'],risk:'The opponent may boost.',nextTurnCondition:'Reassess after the revealed actions.'};
function fixture(options={}){
  const team=Teams.import(TEAM),packed=Teams.pack(team),sent=[],client=new ShowdownClient({expectedTeamHash:digest(team)});
  client.connected=true;client.authenticated=true;client.epoch=1;client.searchState={searching:[],games:{}};
  client.ws={send:line=>sent.push(line),close:()=>{client.connected=false;client.authenticated=false;}};
  const session=new AgentSession(client,{username:'Fixture',packed,autoReady:false,controllerRequired:false,...options});
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

test('same-operation turn plans never wait for persistence, bind the exact request and separate later observed execution',async()=>{
  const writes=[],releases=[];const f=fixture({decisionNoteWriter:async value=>{writes.push(value);await new Promise(resolve=>releases.push(resolve));return value;}});
  try{
    f.session.supervisor.configure({enabled:true,forfeitIfStuck:false,emergencyDefaultChoice:false,planningMs:45000,previewPlanningMs:45000,safetyMarginMs:5000,unknownClockMs:20000});
    f.request();const action=f.session.snapshot().actions[0];
    assert.equal((await f.session.execute({id:'stage-plan',op:'stage-fallback',confirmed:true,token:action.token,actions:planPair,turnPlan})).ok,true);
    assert.equal(f.session.turnSnapshot().boards[0].actionPlan.intentStatus,'staged');
    const sent=await f.session.execute({id:'choose-plan',op:'choose',confirmed:true,token:action.token,actions:planPair,turnPlan});
    assert.equal(sent.ok,true,sent.error);assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,1);
    assert.equal(writes.filter(value=>value.note.turnPlan).length,1,'same plan is preserved once across stage and send');
    let memory=f.session.turnPlans.history()[0];assert.deepEqual(memory.observations.map(value=>value.status),['sent']);assert(!memory.observations.some(value=>value.status==='accepted'));
    f.client.receive(`>${room}\n|move|p1a: A|Protect|p1a: A\n|move|p1b: B|Protect|p1b: B`);
    memory=f.session.turnPlans.history()[0];assert.equal(memory.observations.filter(value=>value.status==='execution-observed').length,2);assert.equal(memory.observations[1].slot,1);assert.equal(memory.observations[2].slot,2);
    f.client.receive(`>${room}\n|turn|4\n|request|${JSON.stringify({rqid:8,active:[{moves:[{move:'Protect',pp:9,target:'self'}]},{moves:[{move:'Protect',pp:9,target:'self'}]}],side:{id:'p1',name:'Fixture',pokemon:[{ident:'p1: A',details:'Golisopod, L50',active:true,condition:'100/100'},{ident:'p1: B',details:'Farigiraf, L50',active:true,condition:'100/100'}]}})}`);
    const next=f.session.turnSnapshot().boards[0].actionPlan;assert.equal(next.kind,'carried-intent');assert(!('chosenPair' in next));assert(!('priorityThreat' in next));
    const stale=await f.session.execute({id:'stale-plan',op:'choose',confirmed:true,token:action.token,actions:planPair,turnPlan});assert.equal(stale.ok,false);assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,1);
    assert.equal(f.session.turnPlanPersistence().pending>0,true);
  }finally{await Promise.resolve();for(const release of releases)release();await Promise.all([...f.session.turnPlanWrites]);f.session.dispose();}
});

test('owned MCP stage/choose expand only explicit actions and retain a full plan without mutating compact input',async()=>{
  const notes=[],f=fixture({decisionNoteWriter:async value=>notes.push(value)}),registered=new Map(),bridged=[];
  registerBattleTools({registerTool:(name,settings,handler)=>registered.set(name,{settings,handler})},{workspace:process.cwd(),call:async(_descriptor,command)=>{bridged.push(structuredClone(command));return f.session.execute(command);}});
  try{
    f.session.supervisor.configure({enabled:true,forfeitIfStuck:false,emergencyDefaultChoice:false,planningMs:45000,previewPlanningMs:45000,safetyMarginMs:5000,unknownClockMs:20000});
    f.request();const token=f.session.snapshot().actions[0].token,actions=[{type:'move',slot:1,mega:false},{type:'move',slot:1}],short={objective:'Keep this explicit pair protected.'};
    const input={confirmed:true,commandId:'compact-owned-stage',controllerLease:'a'.repeat(64),token,actions,turnPlan:short},original=structuredClone(input);
    const stage=registered.get('battle_stage_fallback'),parsed=stage.settings.inputSchema.parse(input);
    assert.equal((await stage.handler(parsed)).isError,false);assert.deepEqual(input,original);assert(!Object.hasOwn(parsed.turnPlan,'chosenPair'));
    assert.deepEqual(bridged[0].turnPlan,{...short,chosenPair:actions});assert.deepEqual(f.session.turnPlans.history()[0].plan.chosenPair,actions);assert.equal(f.sent.length,0);
    const choose=registered.get('battle_choose'),full={...short,chosenPair:actions};
    assert.equal((await choose.handler(choose.settings.inputSchema.parse({...input,commandId:'full-owned-choose',turnPlan:full}))).isError,false);
    assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,1);await Promise.all([...f.session.turnPlanWrites]);
    assert.deepEqual(notes.find(value=>value.note.turnPlan).note.turnPlan,full);assert.equal(f.session.capabilities().features.turnPlanPairFromExplicitActions,true);
    const note=registered.get('battle_note_decision');assert.equal(note.settings.inputSchema.safeParse({token,turnPlan:short}).success,false);
  }finally{f.session.dispose();}
});

test('owned MCP rejects malformed, conflicting and expansion-oversize plans before the control bridge',async()=>{
  const calls=[],registered=new Map();registerBattleTools({registerTool:(name,settings,handler)=>registered.set(name,{settings,handler})},{workspace:process.cwd(),call:async(_descriptor,command)=>{calls.push(command);return {ok:true};}});
  const short={objective:'Preserve the explicitly authored pair.'},large={objective:'界'.repeat(180),priorityThreat:'界'.repeat(120),risk:'界'.repeat(180),nextTurnCondition:'界'.repeat(175)};
  for(const tool of ['battle_stage_fallback','battle_choose']){
    const entry=registered.get(tool),base={confirmed:true,commandId:'refuse-plan',controllerLease:'a'.repeat(64),token:'b'.repeat(64),actions:planPair};
    for(const turnPlan of [{...short,chosenPair:[{type:'move',slot:4},{type:'move',slot:4}]},{...short,chosenPair:null},{...short,chosenPair:undefined},{...short,unknown:true},large]){
      const result=await entry.handler({...base,turnPlan});assert.equal(result.isError,true);assert.equal(calls.length,0);
    }
    for(const actions of [null,[],[{type:'pass'}],[{type:'pass',unknown:true},{type:'pass'}]])assert.equal((await entry.handler({...base,actions,turnPlan:short})).isError,true);
  }
  assert.equal(calls.length,0);
});

test('invalid plan bindings and secret fields prevent mutation; failed optional writes never retry or delay a sent choice',async()=>{
  const f=fixture({decisionNoteWriter:async()=>{throw new Error('secret transport error must not enter telemetry');}});
  try{
    f.request();const action=f.session.snapshot().actions[0];
    for(const [id,plan] of [['wrong-pair',{...turnPlan,chosenPair:[{type:'move',slot:4},{type:'move',slot:4}]}],['secret-field',{...turnPlan,password:'secret'}]]){
      const reply=await f.session.execute({id,op:'choose',confirmed:true,token:action.token,actions:planPair,turnPlan:plan});assert.equal(reply.ok,false);assert.equal(f.sent.length,0);
    }
    const reply=await f.session.execute({id:'valid-plan',op:'choose',confirmed:true,token:action.token,actions:planPair,turnPlan});assert.equal(reply.ok,true,reply.error);
    await Promise.all([...f.session.turnPlanWrites]);assert.equal(f.session.turnPlanWriteFailures>0,true);assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,1);assert(!JSON.stringify(f.session.turnPlanPersistence()).includes('secret'));
    assert.deepEqual(await f.session.execute({id:'valid-plan',op:'choose',confirmed:true,token:action.token,actions:planPair,turnPlan}),reply);assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,1);
  }finally{f.session.dispose();}
});

test('unsupported preview metadata and invalid plan contexts fail before staging or sending, while preview without metadata remains available',async()=>{
  const f=fixture();
  try{
    f.session.supervisor.configure({enabled:true,forfeitIfStuck:false,emergencyDefaultChoice:false,planningMs:45000,previewPlanningMs:45000,safetyMarginMs:5000,unknownClockMs:20000});
    f.own();const party=f.team.map((set,index)=>({ident:`p1: Member${index}`,details:`${set.species}, L50`,condition:'100/100'}));
    f.client.receive(`>${room}\n|request|${JSON.stringify({rqid:6,teamPreview:true,maxTeamSize:4,side:{id:'p1',name:'Fixture',pokemon:party}})}`);
    const action=f.session.snapshot().actions[0],teamActions=[{type:'team',order:[1,2,3,4]}],previewPlan={objective:'Choose the preview four.',chosenPair:teamActions};
    for(const op of ['stage-fallback','choose']){
      const result=await f.session.execute({id:'preview-plan-'+op,op,confirmed:true,token:action.token,actions:teamActions,turnPlan:previewPlan});
      assert.equal(result.ok,false);assert.match(result.error,/active battle turns and replacements/);assert.equal(f.session.supervisor.status().pending.find(value=>value.token===action.token).hasFallback,false);assert.equal(f.sent.length,0);
    }
    const staged=await f.session.execute({id:'preview-without-plan',op:'stage-fallback',confirmed:true,token:action.token,actions:teamActions});assert.equal(staged.ok,true,staged.error);assert.equal(f.session.supervisor.status().pending.find(value=>value.token===action.token).hasFallback,true);
  }finally{f.session.dispose();}
  const normal=fixture();try{
    normal.session.supervisor.configure({enabled:true,forfeitIfStuck:false,emergencyDefaultChoice:false,planningMs:45000,previewPlanningMs:45000,safetyMarginMs:5000,unknownClockMs:20000});
    normal.request();const action=normal.session.snapshot().actions[0],context=normal.session.actionContexts.get(action.token);context.teamId='invalid';
    const rejected=await normal.session.execute({id:'invalid-context-before-stage',op:'stage-fallback',confirmed:true,token:action.token,actions:planPair,turnPlan});
    assert.equal(rejected.ok,false);assert.equal(normal.session.supervisor.status().pending.find(value=>value.token===action.token).hasFallback,false);assert.equal(normal.sent.length,0);
    context.teamId=normal.client.expectedTeamHash;
    const staged=await normal.session.execute({id:'valid-context-stage',op:'stage-fallback',confirmed:true,token:action.token,actions:planPair,turnPlan});assert.equal(staged.ok,true,staged.error);assert.equal(normal.session.turnPlans.history()[0].intentStatus,'staged');
  }finally{normal.session.dispose();}
});

test('optional plan writes remain bounded under a stalled writer and expose saturation without socket work',async()=>{
  const releases=[];const f=fixture({decisionNoteWriter:async()=>new Promise(resolve=>releases.push(resolve))});
  try{
    f.request();const action=f.session.snapshot().actions[0];
    for(let index=0;index<40;index++)f.session.captureTurnPlan(action,{...turnPlan,objective:'Distinct bounded intent '+index},planPair,'selected');
    assert.equal(f.session.turnPlanPersistence().pending,32);assert.equal(f.session.turnPlanPersistence().dropped,8);assert.equal(f.sent.length,0);assert.equal(f.session.turnPlans.history().length,1);
  }finally{await Promise.resolve();for(const release of releases)release();await Promise.all([...f.session.turnPlanWrites]);f.session.dispose();}
});

test('atomic preview notes durably preserve exact intent and capture time without converting later notes into first intent',async()=>{
  const workspace=await fixtureWorkspace('vgc-preview-notes-');
  try{
    const teamId=digest(Teams.import(TEAM));await registerMetricsTeam({workspace,teamId,name:'Preview note fixture',format:'gen9championsvgc2026regmc',roster:Teams.import(TEAM).map(value=>value.species)});
    const previewPlan={objective:'Use the authored opening.',risk:'Control may be contested.',preserveIds:['selected-reserve'],nextTurnCondition:'Convert into the reserve action.',unverified:['Opposing selection.'],chosenTeamOrder:[6,2,4,1]};
    const planHash=createHash('sha256').update(JSON.stringify(previewPlan)).digest('hex'),capture={capturedAt:1000,intentStatus:'selected',planHash};
    const note={noteId:'atomic-preview',sessionId:randomUUID(),token:'a'.repeat(64),rqid:7,revision:2,turn:0,actionStatusAtNote:'selected',previewPlan,previewPlanCapture:capture};
    const saved=await saveDecisionNote({workspace,teamId,room,note});assert.deepEqual(saved.note.previewPlan,previewPlan);assert.deepEqual(saved.note.previewPlanCapture,capture);assert(!Object.hasOwn(saved.note,'token'));assert(saved.note.requestRef);assert.notEqual(saved.note.recordedAt,1000);
    const read=await readDecisionNotes({workspace,teamId,room});assert.deepEqual(read.notes[0].previewPlan,previewPlan);assert.deepEqual(read.notes[0].previewPlanCapture,capture);
    for(const change of [{previewPlanCapture:undefined},{previewPlanCapture:{...capture,intentStatus:'accepted'}},{previewPlanCapture:{...capture,planHash:'b'.repeat(64)}},{previewPlanCapture:{...capture,capturedAt:Date.now()+60000}}])await assert.rejects(saveDecisionNote({workspace,teamId,room,note:{...note,noteId:'bad-preview',...change}}),/capture/);
    const later=await saveDecisionNote({workspace,teamId,room,note:{noteId:'later-note',sessionId:note.sessionId,token:note.token,rqid:7,turn:0,ourPlan:'A later author claim only.'}});assert(!Object.hasOwn(later.note,'previewPlanCapture'));assert(!Object.hasOwn(later.note,'previewPlan'));
  }finally{await rm(workspace,{recursive:true,force:true});}
});

test('decision journals persist privately, sanitize text, verify actual calculator refs and reject cross-turn receipts',async()=>{
  const workspace=await fixtureWorkspace('vgc-notes-');
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

test('turn plans and actual resolution append to team-owned journals, verify plan evidence and disappear with the team',async()=>{
  const workspace=await fixtureWorkspace('vgc-plan-notes-');
  try{
    const {teamId}=await registerTeamFromText({workspace,teamText:TEAM});
    const receipt=await recordCalculation({workspace,tool:'calculate_speed',input:{fixture:true},result:{fixture:true},context:{teamId,roomId:room,turn:3}});
    const context={sessionId:randomUUID(),token:'a'.repeat(64),rqid:7,revision:2,turn:3};
    const saved=await saveDecisionNote({workspace,teamId,room,note:{...context,noteId:'plan-intent',turnPlan:{...turnPlan,evidenceRefs:[receipt.id]}}});
    assert.equal(saved.note.token,undefined);assert.match(saved.note.requestRef,/^[a-f0-9]{64}$/u);assert.equal(saved.note.calculationRefs[0].provenance,'actual-mcp-tool');assert.equal(saved.note.turnPlan.objective,turnPlan.objective);
    const resolution={planHash:'b'.repeat(64),status:'execution-observed',source:'observed-control-event',type:'move',slot:1,executed:true,at:Date.now()};
    const observed=await saveDecisionNote({workspace,teamId,room,note:{...context,noteId:'plan-resolution',reason:'Observed progress only',turnPlanResolution:resolution}});
    assert.equal(observed.note.requestRef,saved.note.requestRef);assert.equal(observed.note.turnPlan,undefined);assert.equal(observed.note.token,undefined);assert.match(observed.note.observationProvenance,/only one slot/);
    await assert.rejects(saveDecisionNote({workspace,teamId,room,note:{...context,noteId:'plan-wrong-turn',turn:4,turnPlan:{...turnPlan,evidenceRefs:[receipt.id]}}}),/different battle or turn/);
    const notes=await readDecisionNotes({workspace,teamId,room});assert.equal(notes.notes.length,2);assert.equal(notes.notes.filter(value=>value.turnPlan).length,1);assert.equal(notes.notes.filter(value=>value.turnPlanResolution).length,1);
    const deleted=await deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true});assert.equal(deleted.complete,true);await assert.rejects(readDecisionNotes({workspace,teamId,room}),/deleted|delet/i);
  }finally{await rm(workspace,{recursive:true,force:true});}
});

test('idle team replacement preserves login, budget and old-room attribution while switching reports',async()=>{
  const workspace=await fixtureWorkspace('vgc-team-switch-');let f;
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

test('successful team replacement settles old plan notes before recorder close and clears only old-team ephemeral intent',async()=>{
  let release,oldClosed=0,newClosed=0;
  const nextText=TEAM.replace('32 HP / 32 SpA / 2 SpD','31 HP / 32 SpA / 3 SpD'),nextId=digest(Teams.import(nextText));
  const f=fixture({decisionNoteWriter:async()=>new Promise(resolve=>{release=resolve;}),recorderFactory:async()=>({status:()=>({teamId:nextId,state:'ready'}),flush:async()=>({teamId:nextId,state:'ready'}),close:async()=>{newClosed++;}})}),old=f.client.expectedTeamHash;
  try{
    f.session.attachMetricsRecorder({status:()=>({teamId:old,state:'ready'}),flush:async()=>({teamId:old,state:'ready'}),close:async()=>{assert.equal(f.session.turnPlanPersistence().pending,0);oldClosed++;}});
    f.request();const action=f.session.snapshot().actions[0];f.session.captureTurnPlan(action,turnPlan,planPair,'staged');
    f.client.receive(`>${room}\n|win|Fixture`);f.client.receive(`>${parent}\n|win|Fixture`);
    const switching=f.session.execute({id:'switch-with-old-plan',op:'switch-team',confirmed:true,teamText:nextText,teamId:nextId});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(f.session.switchingTeam,true);assert.equal(f.client.expectedTeamHash,old);assert.equal(oldClosed,0);assert.equal(f.session.turnPlans.history().length,1);
    release();const result=await switching;assert.equal(result.ok,true,result.error);assert.equal(oldClosed,1);assert.equal(f.client.expectedTeamHash,nextId);assert.equal(f.session.turnPlans.history().length,0);assert.equal(f.session.turnPlanPersistence().pending,0);assert.equal(newClosed,0);assert.equal(f.sent.length,0);
  }finally{release?.();await Promise.all([...f.session.turnPlanWrites]);f.session.dispose();}
});

test('failed or stalled plan persistence preserves the old team and its intent instead of releasing its recorder',async()=>{
  const nextText=TEAM.replace('32 HP / 32 SpA / 2 SpD','31 HP / 32 SpA / 3 SpD'),nextId=digest(Teams.import(nextText));let oldClosed=0,newClosed=0;
  const f=fixture({decisionNoteWriter:async()=>{throw new Error('Writer unavailable');},recorderFactory:async()=>({status:()=>({teamId:nextId,state:'ready'}),flush:async()=>({teamId:nextId,state:'ready'}),close:async()=>{newClosed++;}})}),old=f.client.expectedTeamHash;
  try{
    f.session.attachMetricsRecorder({status:()=>({teamId:old,state:'ready'}),flush:async()=>({teamId:old,state:'ready'}),close:async()=>{oldClosed++;}});
    f.request();const action=f.session.snapshot().actions[0];f.session.captureTurnPlan(action,turnPlan,planPair,'staged');await Promise.all([...f.session.turnPlanWrites]);
    f.client.receive(`>${room}\n|win|Fixture`);f.client.receive(`>${parent}\n|win|Fixture`);
    const result=await f.session.execute({id:'retain-old-plan-on-failure',op:'switch-team',confirmed:true,teamText:nextText,teamId:nextId});
    assert.equal(result.ok,false);assert.match(result.error,/Turn plan persistence is incomplete/);assert.equal(f.client.expectedTeamHash,old);assert.equal(oldClosed,0);assert.equal(newClosed,1);assert.equal(f.session.turnPlans.history().length,1);
    // A stalled writer is also bounded without clearing its evidence or starting
    // another socket operation. Releasing it later remains possible.
    let release;const stalled=new Promise(resolve=>{release=resolve;});f.session.turnPlanWrites.add(stalled);
    await assert.rejects(f.session.settleTurnPlanWrites({timeoutMs:10}),/bounded budget/);assert.equal(f.session.turnPlans.history().length,1);f.session.turnPlanWrites.delete(stalled);release();assert.equal(f.sent.length,0);
  }finally{f.session.dispose();}
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
  assert.equal(entry.settings.inputSchema.safeParse({confirmed:true,commandId:'switch',controllerLease:'a'.repeat(64),teamText:TEAM}).success,true);
  assert.equal(entry.settings.inputSchema.safeParse({confirmed:true,teamText:TEAM}).success,false);
  assert.equal((await entry.handler({confirmed:true,commandId:'bad',teamText:'Pikachu\n- Protect'})).isError,true);assert.equal(calls.length,0);
  assert.equal((await entry.handler({confirmed:true,commandId:'switch',controllerLease:'a'.repeat(64),teamText:TEAM})).isError,false);assert.equal(calls[0].op,'switch-team');assert.equal(calls[0].teamId,digest(Teams.import(TEAM)));assert.equal(calls[0].confirmed,true);
  const noteSchema=registrations.get('battle_note_decision').settings.inputSchema;
  assert.equal(noteSchema.safeParse({commandId:'note',token:'a'.repeat(64),calculationRefs:['unverified arbitrary prose']}).success,false);
  for(const tool of ['battle_stage_fallback','battle_choose']){
    const schema=registrations.get(tool).settings.inputSchema,base={commandId:'plan',confirmed:true,controllerLease:'a'.repeat(64),token:'b'.repeat(64),actions:planPair,turnPlan};
    assert.equal(schema.safeParse(base).success,true);assert.equal(schema.safeParse({...base,turnPlan:{...turnPlan,accepted:true}}).success,false);
  }
});
