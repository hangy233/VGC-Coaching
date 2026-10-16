import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
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
    client.emit('result',{room:parent,type:'win',winner:'Fixture'});await new Promise(resolve=>queueMicrotask(resolve));await recorder.flush();
    const report=await getTeamReport({workspace});assert.equal(report.totals.wins,1);assert.equal(report.totals.sets.wins,1);assert.equal(report.pokemon[0].knockouts,1);
    assert.equal(report.pokemon[0].moves.find(m=>m.move==='Protect').uses,0);assert.equal(typeof client.send,'undefined');
  }finally{await recorder.close();assert.equal(client.listenerCount('battle-event'),0);await rm(workspace,{recursive:true,force:true});}
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
