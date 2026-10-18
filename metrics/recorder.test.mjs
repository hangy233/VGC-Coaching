import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,rm,rmdir,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {attachMetricsRecorder} from './recorder.mjs';
import {getTeamReport,listBattles} from './store.mjs';
import {readGameEvidence} from './retention.mjs';
import {attachVerifiedReplay} from './replay-evidence.mjs';

const {Teams}=createRequire(import.meta.url)('pokemon-showdown');

async function previewFixture({replayAttacher}={}){
  const workspace=await mkdtemp(join(tmpdir(),'vgcm-preview-')),client=new EventEmitter(),room='battle-gen9championsvgc2026regmcbo3-60',state={sheets:{}};
  const team=[['Sylveon','Pixilate'],['Farigiraf','Armor Tail'],['Politoed','Drizzle'],['Golisopod','Emergency Exit'],['Kommo-o','Soundproof'],['Rillaboom','Grassy Surge']].map(([species,ability])=>({species,ability,level:50,nature:'Modest',evs:{hp:32,spa:32,spd:2},moves:['Protect']}));
  const teamId=createHash('sha256').update(Teams.pack(team)).digest('hex');
  client.state=()=>state;
  const recorder=attachMetricsRecorder(client,{workspace,username:'Fixture',teamId,team,replayAttacher});
  const emit=(type,...data)=>client.emit('battle-event',{room,type,data});
  const pokemon=['Sylveon','Farigiraf','Politoed','Golisopod','Kommo-o','Rillaboom'].map((species,index)=>({ident:`p1: ${species}`,details:species+', L50',active:index<2,condition:'100/100'}));
  const request=request=>client.emit('request',{room,request});
  const preview=()=>request({rqid:1,teamPreview:true,maxChosenTeamSize:4,side:{id:'p1',name:'Fixture',pokemon}});
  const action=(status,actions=[{type:'team',order:[4,2,1,3]}],rqid=1)=>{state.lastAction={rqid,actions};client.emit('action-status',{room,status});};
  emit('gametype','doubles');emit('player','p1','Fixture');emit('player','p2','Opponent');
  const start=()=>{emit('start');emit('switch','p1a: Sylveon','Sylveon, L50','100/100');emit('switch','p1b: Farigiraf','Farigiraf, L50','100/100');emit('switch','p2a: Target','Pikachu, L50','100/100');emit('turn','1');request({rqid:2,active:[],side:{id:'p1',name:'Fixture',pokemon:pokemon.slice(0,4)}});};
  const finish=async()=>{action('sent',[{type:'move',slot:1},{type:'move',slot:1}],2);action('accepted',[{type:'move',slot:1},{type:'move',slot:1}],2);emit('move','p1a: Sylveon','Protect','p1a: Sylveon');emit('win','Fixture');await recorder.flush();return {report:await getTeamReport({workspace,includeOperational:true}),evidence:await readGameEvidence({workspace,teamId,roomId:room})};};
  return {workspace,client,room,teamId,recorder,emit,request,pokemon,preview,action,start,finish,close:async()=>{await recorder.close();await rm(workspace,{recursive:true,force:true});}};
}

test('preview choice order and selected/sent/accepted phases survive duplicate requests and canonical recording',async()=>{
  const f=await previewFixture();try{
    f.preview();f.action('sent');f.action('accepted');f.preview();
    f.start();const {report,evidence}=await f.finish(),preview=evidence.decisions.filter(value=>value.phase==='preview');
    assert.deepEqual(preview.map(value=>value.status),['selected','sent','accepted','accepted']);
    assert.deepEqual(preview[0].actions[0].order,[4,2,1,3]);assert(preview.every(value=>value.turn===0));
    assert.equal(preview.at(-1).evidence.type,'preview-transition');assert.equal(preview.at(-1).accepted,true);assert(!preview.some(value=>value.executed===true));
    assert.equal(report.games[0].quality.operational,false);assert.equal(report.selection.gamesWithSelection,1);
    assert.equal(f.recorder.status().recordingSchemaVersion,2);assert.equal(f.recorder.status().features.previewDecisionEvidence,true);
  }finally{await f.close();}
});

test('watchdog fallback, forfeit, uncertainty and recovered planning failures retain operational evidence without changing official results',async()=>{
  for(const type of ['fallback-sent','watchdog-forfeit','watchdog-uncertain','watchdog-recovery-started']){
    const f=await previewFixture();try{
      f.preview();f.action('sent');f.action('accepted');f.start();
      f.client.emit('control-trace',{room:f.room+'-privatepw',type,seq:4,at:1234,elapsedMs:120,rqid:2,revision:1,controllerId:'fixture-operator',generation:1,source:'watchdog',status:'sent-not-acknowledged',reasonCode:'DEADLINE_REACHED',controlFailure:type==='watchdog-recovery-started',planningDeadlineAt:1200,emergencyAt:9000,clockSource:'server-timer-observation',emergencyEligible:true,password:'NEVER-PERSIST',command:'NEVER-PERSIST'});
      const {report,evidence}=await f.finish();
      assert.equal(report.games[0].outcome,'win');assert.equal(report.games[0].quality.operational,true);
      assert.equal((await getTeamReport({workspace:f.workspace})).totals.games,0);
      assert.equal(evidence.controlTrace.length,1);assert.equal(evidence.controlTrace[0].type,type);assert.equal(evidence.controlTrace[0].at,1234);assert.equal(evidence.controlTrace[0].turn,1);
      assert.equal(evidence.controlTrace[0].planningDeadlineAt,1200);assert.equal(evidence.controlTrace[0].emergencyAt,9000);assert.equal(evidence.controlTrace[0].emergencyEligible,true);
      assert(!JSON.stringify(evidence.controlTrace).includes('NEVER-PERSIST'));assert(!JSON.stringify(evidence.controlTrace).includes('privatepw'));
      assert.equal(f.recorder.status().features.controlTraceEvidence,true);
    }finally{await f.close();}
  }
});

test('ordinary control telemetry preserves provenance without excluding a clean game',async()=>{
  const f=await previewFixture();try{
    f.preview();f.action('sent');f.action('accepted');f.start();
    f.client.emit('control-trace',{room:f.room,type:'request-received',seq:1,at:1000,rqid:2,revision:1});
    f.client.emit('control-trace',{room:f.room,type:'choice-validated',seq:2,at:1020,latencyMs:20,rqid:2,revision:1});
    const {report,evidence}=await f.finish();
    assert.equal(report.games[0].quality.operational,false);assert.equal(evidence.controlTrace.length,2);assert.equal(evidence.controlTrace[1].latencyMs,20);
    assert.equal(evidence.events.filter(value=>value.type==='win').length,1);
    await f.recorder.flush({savePending:true});
    assert.deepEqual((await readGameEvidence({workspace:f.workspace,teamId:f.teamId,roomId:f.room})).controlTrace,evidence.controlTrace);
  }finally{await f.close();}
});

test('emergency default choices retain distinct provenance and exclude performance without inventing acceptance',async()=>{
  for(const type of ['selected','emergency-default-sent','watchdog-emergency-default-selected']){
    const f=await previewFixture();try{
      f.preview();f.action('sent');f.action('accepted');f.start();
      f.client.emit('control-trace',{room:f.room,type,seq:7,at:2000,rqid:2,revision:1,source:'emergency-default',status:'sent-not-acknowledged',password:'NEVER-PERSIST',actions:[{type:'move',slot:1}]});
      const {report,evidence}=await f.finish(),trace=evidence.controlTrace[0];
      assert.equal(report.games[0].outcome,'win');assert.equal(report.games[0].quality.operational,true);
      assert.equal((await getTeamReport({workspace:f.workspace})).totals.games,0);
      assert.equal(trace.type,type);assert.equal(trace.source,'emergency-default');assert.equal(trace.status,'sent-not-acknowledged');
      assert.equal(trace.accepted,undefined);assert.equal(trace.executed,undefined);assert.equal(trace.serverDefaulted,undefined);
      assert(!JSON.stringify(trace).includes('NEVER-PERSIST'));assert.equal(trace.actions,undefined);
    }finally{await f.close();}
  }
});

test('turn and disconnect boundaries archive partial control diagnostics before any official result',async()=>{
  const f=await previewFixture();try{
    f.preview();f.action('sent');f.action('accepted');f.start();
    f.client.emit('control-trace',{room:f.room,type:'request-received',seq:1,at:1000,rqid:2,revision:1});
    f.emit('turn','2');await f.recorder.flush();
    let evidence=await readGameEvidence({workspace:f.workspace,teamId:f.teamId,roomId:f.room});
    assert.equal(evidence.complete,false);assert.equal(evidence.completionKind,'partial');assert.deepEqual(evidence.controlTrace.map(value=>value.seq),[1]);
    f.client.emit('control-trace',{room:f.room,type:'watchdog-uncertain',seq:2,at:1020,rqid:2,revision:1,reasonCode:'socket-write-uncertain'});
    f.client.emit('disconnected');await f.recorder.flush();
    evidence=await readGameEvidence({workspace:f.workspace,teamId:f.teamId,roomId:f.room});
    assert.equal(evidence.complete,false);assert.deepEqual(evidence.controlTrace.map(value=>value.seq),[1,2]);assert.equal(evidence.controlTrace[1].at,1020);
    assert(!evidence.events.some(value=>['win','tie'].includes(value.type)));
    const report=await getTeamReport({workspace:f.workspace,includeIncomplete:true,includeOperational:true});
    assert.equal(report.games[0].completed,false);assert.equal(report.games[0].outcome,'unknown');assert.equal(report.games[0].quality.operational,true);
    await f.recorder.close();
    assert.deepEqual((await readGameEvidence({workspace:f.workspace,teamId:f.teamId,roomId:f.room})).controlTrace,evidence.controlTrace);
  }finally{await f.close();}
});

test('unsubmitted or rejected previews remain operational when later moves were promptly submitted',async()=>{
  for(const mode of ['unsubmitted','rejected']){
    const f=await previewFixture();try{
      f.preview();if(mode==='rejected'){f.action('sent');f.action('rejected');}
      f.start();const {report,evidence}=await f.finish(),transition=evidence.decisions.find(value=>value.phase==='preview'&&value.evidence?.type==='preview-transition');
      assert.equal(transition.status,mode);assert.notEqual(transition.serverDefaulted,true);
      assert.equal(report.games[0].quality.operational,true);assert.equal((await getTeamReport({workspace:f.workspace})).totals.games,0);
      assert(evidence.decisions.some(value=>value.rqid===2&&value.status==='accepted'));assert.equal(report.selection.gamesWithSelection,1);
    }finally{await f.close();}
  }
});

test('a sent preview without acknowledgment has unknown acceptance rather than a confirmed default',async()=>{
  const f=await previewFixture();try{
    f.preview();f.action('sent');f.start();const {report,evidence}=await f.finish();
    const transition=evidence.decisions.find(value=>value.phase==='preview'&&value.evidence?.type==='preview-transition');
    assert.equal(transition.status,'unknown');assert.equal(transition.submitted,true);assert.equal(transition.accepted,undefined);assert.equal(transition.serverDefaulted,undefined);
    assert.match(transition.reason,/not a confirmed server default/);assert.equal(report.games[0].quality.operational,false);
    assert(report.games[0].quality.warnings.some(value=>/acceptance.*not observed/.test(value)));
  }finally{await f.close();}
});

test('accepted retry clears preview rejection and forced replacements keep separate provenance',async()=>{
  const f=await previewFixture();try{
    f.preview();f.action('sent');f.action('rejected');f.action('sent',[{type:'team',order:[1,2,3,4]}]);f.action('accepted',[{type:'team',order:[1,2,3,4]}]);f.start();
    f.request({rqid:3,forceSwitch:[true,false],side:{id:'p1',name:'Fixture',pokemon:f.pokemon.slice(0,4)}});
    f.emit('switch','p1a: Politoed','Politoed, L50','100/100');
    const {report,evidence}=await f.finish(),transition=evidence.decisions.find(value=>value.phase==='preview'&&value.evidence?.type==='preview-transition');
    assert.equal(transition.status,'accepted');assert.deepEqual(transition.actions[0].order,[1,2,3,4]);
    assert.equal(report.games[0].quality.operational,true);assert(!report.games[0].quality.warnings.some(value=>/after a rejected preview/.test(value)));
  }finally{await f.close();}
});

test('missing preview history and untracked choice acknowledgments remain explicit unknowns',async()=>{
  for(const observed of [false,true]){
    const f=await previewFixture();try{
      if(observed){f.preview();f.client.emit('choice-status',{room:f.room,submitted:true});}
      f.start();const {report,evidence}=await f.finish(),transition=evidence.decisions.find(value=>value.phase==='preview'&&value.evidence?.type==='preview-transition');
      assert.equal(transition.status,'unknown');assert.equal(transition.serverDefaulted,undefined);assert.equal(report.games[0].quality.operational,false);
    }finally{await f.close();}
  }
});

test('postresult disconnect and sync preserve completed preview provenance without a recorder failure',async()=>{
  const f=await previewFixture();try{
    f.preview();f.action('sent');f.start();const {evidence}=await f.finish();
    f.emit('player','p1','');f.emit('player','p1','Fixture');
    const status=await f.recorder.flush({savePending:true});
    assert.equal(status.state,'ready');assert.equal(status.lastError,null);
    const retained=await readGameEvidence({workspace:f.workspace,teamId:f.teamId,roomId:f.room});
    assert.deepEqual(retained.decisions,evidence.decisions);assert.deepEqual(retained.events.slice(0,evidence.events.length),evidence.events);
    assert.deepEqual(retained.events.slice(-2).map(value=>value.data),[['p1',''],['p1','Fixture']]);
    assert.equal((await f.recorder.flush({savePending:true})).state,'ready');
  }finally{await f.close();}
});

test('a whole-series concession during preview archives without treating its message as battle progress',async()=>{
  const f=await previewFixture();try{
    f.emit('tier','[Gen 9 Champions] VGC 2026 Reg M-C (Bo3)');f.emit('teampreview','4');
    f.preview();f.action('sent');f.emit('-message','Fixture forfeited the series.');f.emit('win','Opponent');
    const status=await f.recorder.flush({savePending:true});
    assert.equal(status.state,'ready');assert.equal(status.lastError,null);
    const evidence=await readGameEvidence({workspace:f.workspace,teamId:f.teamId,roomId:f.room});
    assert.equal(evidence.complete,true);assert.equal(evidence.completionKind,'preview-terminal');
    assert.deepEqual(evidence.observedHistory,{started:false,progress:false});
    assert.deepEqual(evidence.decisions.map(value=>value.status),['selected','sent']);
    assert(evidence.decisions.every(value=>value.accepted===undefined&&value.executed===undefined&&value.serverDefaulted===undefined));
  }finally{await f.close();}
});

test('preview departure preserves identities through recorder, canonical evidence and verified replay attachment',async()=>{
  for(const side of ['p1','p2'])for(const afterTerminal of [false,true]){
    let fetches=0;
    const lifecycle=`|player|${side}|`,terminal='|win|Fixture';
    const replayLog=['|gametype|doubles','|tier|[Gen 9 Champions] VGC 2026 Reg M-C (Bo3)',
      '|player|p1|Fixture','|player|p2|Opponent','|teampreview|4',
      ...(afterTerminal?[terminal,lifecycle]:[lifecycle,terminal])].join('\n');
    const f=await previewFixture({replayAttacher:args=>attachVerifiedReplay({...args,fetchImpl:async()=>{
      fetches++;return new Response(JSON.stringify({id:f.room.slice(7),formatid:'gen9championsvgc2026regmcbo3',log:replayLog}));
    }})});
    try{
      f.emit('tier','[Gen 9 Champions] VGC 2026 Reg M-C (Bo3)');f.emit('teampreview','4');
      f.preview();f.action('sent');
      f.emit('-message','Opponent lost due to inactivity.');
      if(!afterTerminal)f.emit('player',side,'');
      f.emit('win','Fixture');
      if(afterTerminal)f.emit('player',side,'');
      assert.equal((await f.recorder.flush({savePending:true})).state,'ready');
      f.client.emit('replay-verified',{roomId:f.room,url:`https://replay.pokemonshowdown.com/${f.room.slice(7)}`});
      const status=await f.recorder.flush();
      assert.equal(status.state,'ready');assert.equal(status.lastError,null);assert.equal(fetches,1);
      const [record]=await listBattles({workspace:f.workspace});
      assert.deepEqual(record.players,{p1:'Fixture',p2:'Opponent'});assert.equal(record.ownSide,'p1');
      assert.equal(record.completed,true);assert.equal(record.outcome,'win');assert.equal(record.turns,0);
      assert.equal(record.quality.operational,true);assert.equal(record.selectionKnown,false);assert.deepEqual(record.selected,[]);
      assert.equal(record.metadata.replay.verified,true);assert(record.metadata.replay.evidencePath);
      assert.equal((await getTeamReport({workspace:f.workspace})).totals.games,0);
      const evidence=await readGameEvidence({workspace:f.workspace,teamId:f.teamId,roomId:f.room});
      assert.equal(evidence.complete,true);assert.equal(evidence.completionKind,'preview-terminal');
      assert.deepEqual(evidence.observedHistory,{started:false,progress:false});
      assert(evidence.events.some(value=>value.type==='player'&&value.data[0]===side&&value.data[1]===''));
      assert.deepEqual(evidence.decisions.map(value=>value.status),['selected','sent']);
      assert(evidence.decisions.every(value=>!value.accepted&&!value.executed&&!value.serverDefaulted));
      assert.equal(typeof f.client.send,'undefined');
    }finally{await f.close();}
  }
});

test('recorder reports allowlisted failure codes without leaking private error messages or replay URLs',async()=>{
  for(const [message,code,reasonCode]of [
    ['Game evidence: completed evidence differs;','EUNKNOWN','COMPLETED_EVIDENCE_CONFLICT'],
    ['Disk operation failed:','ENOSPC','LOCAL_STORAGE_FULL'],
    ['Unexpected private failure:','EUNKNOWN','METRICS_SAVE_FAILED'],
  ]){
    const workspace=await mkdtemp(join(tmpdir(),'vgcm-safe-error-')),client=new EventEmitter(),room='battle-gen9championsvgc2026regmcbo3-61',errors=[];
    const secret='DO-NOT-REFLECT',url='https://replay.pokemonshowdown.com/gen9championsvgc2026regmcbo3-61-privatepw';
    const recorder=attachMetricsRecorder(client,{workspace,username:'Fixture',teamId:'2'.repeat(64),team:[{species:'Sylveon',moves:['Protect']}],onError:error=>errors.push(error),replayAttacher:async()=>{throw Object.assign(new Error(`${message} ${secret} ${url} ${workspace}`),{code});}});
    try{
      await recorder.flush();client.emit('battle-event',{room,type:'player',data:['p1','Fixture']});client.emit('replay-verified',{roomId:room,url});
      const status=await recorder.flush();assert.equal(status.state,'error');assert.equal(status.lastError.reasonCode,reasonCode);assert.equal(errors.length,1);assert.equal(errors[0].reasonCode,reasonCode);
      const serialized=JSON.stringify({status,errors});assert(!serialized.includes(secret));assert(!serialized.includes(url));assert(!serialized.includes(workspace));assert.equal(status.lastError.stack,undefined);assert.equal(typeof status.lastError.detail,'string');
    }finally{await recorder.close();await rm(workspace,{recursive:true,force:true});}
  }
});

test('late preview and unidentified acknowledgments cannot count as submitting the following turn',async()=>{
  for(const source of ['previous-preview','unidentified']){
    const f=await previewFixture();try{
      f.preview();f.action('sent');f.start();
      if(source==='previous-preview')f.action('accepted');
      else{f.client.state(f.room).lastAction=null;f.client.emit('action-status',{room:f.room,status:'accepted'});}
      f.client.emit('choice-status',{room:f.room,submitted:true});
      f.emit('move','p1a: Sylveon','Protect','p1a: Sylveon');f.emit('win','Fixture');await f.recorder.flush();
      const report=await getTeamReport({workspace:f.workspace,includeOperational:true}),evidence=await readGameEvidence({workspace:f.workspace,teamId:f.teamId,roomId:f.room});
      assert.equal(report.games[0].quality.operational,true);
      assert.equal(evidence.decisions.find(value=>value.evidence?.type==='preview-transition').status,'unknown');
      assert(!evidence.decisions.some(value=>value.rqid===2&&value.status==='accepted'));
    }finally{await f.close();}
  }
});

test('live recorder saves observation metrics and official parent result without sending or authenticating',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgcm-recorder-')),client=new EventEmitter();
  const room='battle-gen9championsvgc2026regmcbo3-45',parent='game-bestof3-gen9championsvgc2026regmcbo3-44';
  const unrecorded='battle-gen9championsvgc2026regmcbo3-46';
  client.state=target=>target===parent?{children:[room,unrecorded+'-privatepw']}:{sheets:{}};
  const session={ownedRooms:new Set([room,parent]),roomParents:new Map([[room,parent]])};
  const recorder=attachMetricsRecorder(client,{workspace,username:'Fixture',teamId:'a'.repeat(64),team:[{species:'Sylveon',moves:['Hyper Voice','Protect']}],session,onError:()=>assert.fail('Metrics persistence failed')});
  try{
    const emit=(type,...data)=>client.emit('battle-event',{room,type,data});
    emit('player','p1','Fixture');emit('player','p2','Opponent');emit('start');emit('switch','p1a: Sylveon','Sylveon, L50','202/202');emit('switch','p2a: Target','Pikachu, L50','100/100');emit('turn','1');emit('move','p1a: Sylveon','Hyper Voice','p2a: Target');emit('-damage','p2a: Target','0 fnt');emit('faint','p2a: Target');emit('win','Fixture');
    client.emit('result',{room:parent,type:'win',winner:'Fixture'});await recorder.flush();
    const report=await getTeamReport({workspace});assert.equal(report.totals.wins,1);assert.equal(report.totals.sets.wins,1);assert.equal(report.pokemon[0].knockouts,1);
    assert.deepEqual(report.games[0].setResult.expectedChildIds,[room,unrecorded]);
    assert.equal(report.games.length,1); // Membership survives a missing child buffer.
    assert.equal(report.pokemon[0].moves.find(m=>m.move==='Protect').uses,0);assert.equal(typeof client.send,'undefined');
    assert.equal(recorder.status().state,'ready');assert.equal(recorder.status().pending,0);
    assert.equal(recorder.status().stableReport.games,1);assert.equal(recorder.status().lastError,null);
  }finally{await recorder.close();assert.equal(client.listenerCount('battle-event'),0);await rm(workspace,{recursive:true,force:true});}
});

test('explicit sync persists current observations and repeated sync cannot duplicate a game',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgcm-sync-')),client=new EventEmitter(),room='battle-test-48';
  const recorder=attachMetricsRecorder(client,{workspace,username:'Fixture',teamId:'d'.repeat(64),team:[{species:'Sylveon',moves:['Protect']}]});
  try{
    const emit=(type,...data)=>client.emit('battle-event',{room,type,data});
    emit('player','p1','Fixture');emit('player','p2','Opponent');emit('start');emit('switch','p1a: Sylveon','Sylveon, L50','202/202');
    // No turn/win boundary has queued an automatic save yet.
    emit('move','p1a: Sylveon','Protect','p1a: Sylveon');
    await recorder.flush({savePending:true});await recorder.flush({savePending:true});
    const report=await getTeamReport({workspace,includeIncomplete:true});
    assert.equal(report.totals.games,1);assert.equal(report.pokemon[0].moves[0].uses,1);
    assert.equal(recorder.status().state,'ready');
  }finally{await recorder.close();await rm(workspace,{recursive:true,force:true});}
});

test('persistence failures are inspectable without reflecting errors, and an explicit sync retries registration',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgcm-sync-failure-')),client=new EventEmitter();let errors=0;
  await writeFile(join(workspace,'cache'),'synthetic-private-value');
  const recorder=attachMetricsRecorder(client,{workspace,username:'Fixture',teamId:'e'.repeat(64),team:[{species:'Sylveon',moves:['Protect']}],onError:()=>{errors++;}});
  try{
    const failed=await recorder.flush();
    assert.equal(failed.state,'error');assert.equal(failed.pending,0);assert.equal(errors,1);
    assert.equal(failed.lastError.operation,'register-team');
    assert(!JSON.stringify(failed).includes(workspace));assert(!JSON.stringify(failed).includes('synthetic-private-value'));
    await unlink(join(workspace,'cache'));
    const retried=await recorder.flush({savePending:true});
    assert.equal(retried.state,'ready');assert.equal(retried.lastError,null);assert.equal(retried.stableReport.games,0);
  }finally{await recorder.close();await rm(workspace,{recursive:true,force:true});}
});

test('sync retries a failed report write even when the game row was already saved',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgcm-report-retry-')),client=new EventEmitter(),room='battle-test-49';
  const recorder=attachMetricsRecorder(client,{workspace,username:'Fixture',teamId:'f'.repeat(64),team:[{species:'Sylveon',moves:['Protect']}]});
  try{
    const initial=await recorder.flush(),target=initial.stableReport.path;
    // A malformed target blocks report regeneration after the battle row saves.
    await unlink(target);await mkdir(target);
    const emit=(type,...data)=>client.emit('battle-event',{room,type,data});
    emit('player','p1','Fixture');emit('player','p2','Opponent');emit('start');emit('switch','p1a: Sylveon','Sylveon, L50','202/202');emit('move','p1a: Sylveon','Protect','p1a: Sylveon');emit('win','Fixture');
    const failed=await recorder.flush();
    assert.equal(failed.state,'error');assert.equal(failed.lastError.operation,'battle:'+room);
    assert.equal((await getTeamReport({workspace})).totals.games,1);assert.equal(failed.stableReport.games,0);
    await rmdir(target);
    const fixed=await recorder.flush({savePending:true});
    assert.equal(fixed.state,'ready');assert.equal(fixed.lastError,null);assert.equal(fixed.stableReport.games,1);
  }finally{await recorder.close();await rm(workspace,{recursive:true,force:true});}
});

test('explicit sync retries failed replay preservation once, including failed reports, without another verified event',async()=>{
  for(const failure of ['attachment','report']){
    const workspace=await mkdtemp(join(tmpdir(),'vgcm-replay-retry-')),client=new EventEmitter();
    const room='battle-gen9championsvgc2026regmcbo3-50',url='https://replay.pokemonshowdown.com/gen9championsvgc2026regmcbo3-50-syntheticprivatepw';
    let attempts=0,target,releaseRetry,retryStarted;
    const started=new Promise(resolve=>{retryStarted=resolve;});
    const recorder=attachMetricsRecorder(client,{workspace,username:'Fixture',teamId:'1'.repeat(64),team:[{species:'Sylveon',moves:['Protect']}],replayAttacher:async options=>{
      assert.equal(options.url,url);assert.equal(options.roomId,room);attempts++;
      if(attempts===1){
        if(failure==='attachment')throw new Error('Synthetic transport error '+url);
        await unlink(target);await mkdir(target);return;
      }
      retryStarted();await new Promise(resolve=>{releaseRetry=resolve;});
    }});
    try{
      const emit=(type,...data)=>client.emit('battle-event',{room,type,data});
      emit('player','p1','Fixture');emit('player','p2','Opponent');emit('start');emit('switch','p1a: Sylveon','Sylveon, L50','202/202');emit('win','Fixture');
      target=(await recorder.flush()).stableReport.path;
      client.emit('replay-verified',{roomId:room,url});
      const failed=await recorder.flush();
      assert.equal(failed.state,'error');assert.equal(failed.lastError.operation,'replay:'+room);
      assert(!JSON.stringify(failed).includes('syntheticprivatepw'));
      if(failure==='report')await rmdir(target);
      const first=recorder.flush({savePending:true}),second=recorder.flush({savePending:true});
      await started;assert.equal(attempts,2);releaseRetry();
      for(const fixed of await Promise.all([first,second])){
        assert.equal(fixed.state,'ready');assert.equal(fixed.lastError,null);assert.equal(fixed.stableReport.games,1);
      }
      await recorder.flush({savePending:true});assert.equal(attempts,2);
      assert.equal(typeof client.send,'undefined');
    }finally{releaseRetry?.();await recorder.close();await rm(workspace,{recursive:true,force:true});}
  }
});

test('observed resolution without a submission is flagged separately from an acknowledged move',async()=>{
  for(const submitted of [false,true]){
    const workspace=await mkdtemp(join(tmpdir(),'vgcm-submission-')),client=new EventEmitter();
    const room='battle-test-46';
    const recorder=attachMetricsRecorder(client,{workspace,username:'Fixture',teamId:'b'.repeat(64),team:[{species:'Sylveon',moves:['Protect']}],onError:()=>assert.fail('Metrics persistence failed')});
    try{
      const emit=(type,...data)=>client.emit('battle-event',{room,type,data});
      emit('player','p1','Fixture');emit('player','p2','Opponent');emit('start');emit('switch','p1a: Sylveon','Sylveon, L50','202/202');emit('turn','1');
      client.emit('request',{room,request:{rqid:3,active:[],side:{id:'p1',name:'Fixture',pokemon:[{ident:'p1: Sylveon',details:'Sylveon, L50',active:true}]}}});
      if(submitted){client.state=()=>({lastAction:{rqid:3,actions:[{type:'move',slot:1}]}});client.emit('action-status',{room,status:'sent'});}
      emit('move','p1a: Sylveon','Protect','p1a: Sylveon');emit('win','Fixture');await recorder.flush();
      assert.equal((await getTeamReport({workspace})).totals.games,submitted?1:0);
      const all=await getTeamReport({workspace,includeOperational:true});assert.equal(all.totals.games,1);assert.equal(all.pokemon[0].moves[0].uses,1);
    }finally{await recorder.close();await rm(workspace,{recursive:true,force:true});}
  }
});

test('defaulted required replacement is flagged, while an involuntary switch is not',async()=>{
  for(const required of [false,true]){
    const workspace=await mkdtemp(join(tmpdir(),'vgcm-replace-')),client=new EventEmitter(),room='battle-test-47';
    const recorder=attachMetricsRecorder(client,{workspace,username:'Fixture',teamId:'c'.repeat(64),team:[{species:'Sylveon',moves:['Protect']}],onError:()=>assert.fail('Metrics save failed')});
    try{
      const emit=(type,...data)=>client.emit('battle-event',{room,type,data});
      emit('player','p1','Fixture');emit('player','p2','Opponent');emit('start');emit('switch','p1a: Sylveon','Sylveon, L50','202/202');emit('turn','1');
      client.emit('request',{room,request:{rqid:3,forceSwitch:[required,false],side:{id:'p1',name:'Fixture',pokemon:[{ident:'p1: Sylveon',details:'Sylveon, L50',active:true}]}}});
      emit('switch','p1a: Sylveon','Sylveon, L50','202/202');emit('win','Fixture');await recorder.flush();
      assert.equal((await getTeamReport({workspace})).totals.games,required?0:1);
    }finally{await recorder.close();await rm(workspace,{recursive:true,force:true});}
  }
});
