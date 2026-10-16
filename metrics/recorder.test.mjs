import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm,rmdir,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {attachMetricsRecorder} from './recorder.mjs';
import {getTeamReport} from './store.mjs';

test('live recorder saves observation metrics and official parent result without sending or authenticating',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgcm-recorder-')),client=new EventEmitter();
  const room='battle-gen9championsvgc2026regmcbo3-45',parent='game-bestof3-gen9championsvgc2026regmcbo3-44';
  const session={ownedRooms:new Set([room,parent]),roomParents:new Map([[room,parent]])};
  const recorder=attachMetricsRecorder(client,{workspace,username:'Fixture',teamId:'a'.repeat(64),team:[{species:'Sylveon',moves:['Hyper Voice','Protect']}],session,onError:()=>assert.fail('Metrics persistence failed')});
  try{
    const emit=(type,...data)=>client.emit('battle-event',{room,type,data});
    emit('player','p1','Fixture');emit('player','p2','Opponent');emit('start');emit('switch','p1a: Sylveon','Sylveon, L50','202/202');emit('switch','p2a: Target','Pikachu, L50','100/100');emit('turn','1');emit('move','p1a: Sylveon','Hyper Voice','p2a: Target');emit('-damage','p2a: Target','0 fnt');emit('faint','p2a: Target');emit('win','Fixture');
    client.emit('result',{room:parent,type:'win',winner:'Fixture'});await recorder.flush();
    const report=await getTeamReport({workspace});assert.equal(report.totals.wins,1);assert.equal(report.totals.sets.wins,1);assert.equal(report.pokemon[0].knockouts,1);
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
      if(submitted)client.emit('action-status',{room,status:'sent'});
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
