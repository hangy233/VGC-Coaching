import {analyzeBattle} from './parser.mjs';
import {saveBattle,registerMetricsTeam} from './store.mjs';
import {canonicalRoom,collectBattleEvents,saveMetricsTeamSnapshot} from './import.mjs';
import {updateTeamReport} from './live-reports.mjs';
import {saveGameEvidence} from './retention.mjs';
import {attachVerifiedReplay} from './replay-evidence.mjs';

/** Observation only: no socket, authentication, commands, or battle decisions. */
export function attachMetricsRecorder(client,{workspace,username,teamId,team,name='Team',session,onError=()=>{}}={}) {
  const buffers=new Map(),listeners=[];let chain=Promise.resolve(),disposed=false;
  // Team registration creates an empty version report without queuing a battle.
  chain=chain.then(async()=>{
    // Production sessions provide a validated six-Pokémon export. Retain it so
    // later replay imports can refer to this exact version by its saved ID.
    if(team.length===6)await saveMetricsTeamSnapshot({workspace,teamId,team});
    await registerMetricsTeam({workspace,teamId,name,format:'gen9championsvgc2026regmc',roster:team.map(p=>p.species)});
    await updateTeamReport({workspace,teamId});
  }).catch(()=>onError());
  const owned=room=>!session||session.ownedRooms.has(client.resolveRoom?.(room)||room);
  const get=room=>{const id=canonicalRoom(room);if(!/^battle-/.test(id)||!owned(room))return null;if(!buffers.has(id))buffers.set(id,{roomId:id,events:[],truncated:false});return buffers.get(id);};
  const on=(event,handler)=>{client.on(event,handler);listeners.push([event,handler]);};
  const append=(room,value)=>{const b=get(room);if(!b)return;if(b.events.length>=20000){b.truncated=true;return;}b.events.push({...value,room,at:Date.now()});};
  const save=(b,parentResult)=>{
    const events=[...b.events],roomId=b.roomId;
    const parent=[...(session?.roomParents||[])].find(([child])=>canonicalRoom(child)===roomId)?.[1]||null;
    const data=collectBattleEvents(events).get(roomId);if(!data)return;
    const record=analyzeBattle({roomId,username,teamId,team,events:data.events,parentId:parent?canonicalRoom(parent):null,metadata:{source:'live-client',operational:!!b.operational}});
    record.team={name,format:'gen9championsvgc2026regmc',roster:team.map(p=>p.species)};
    record.metadata={...(record.metadata||{}),sources:['live-client'],...(parentResult?{setResult:parentResult}:{})};
    if(b.operational){record.quality.operational=true;record.quality.warnings.push('Observed inactivity or submission failure; excluded from default team comparisons.');}
    if(b.truncated){record.quality.complete=false;record.quality.warnings.push('Recorder event limit reached; partial observations only.');}
    chain=chain.then(async()=>{
      const saved=await saveBattle({workspace,record});
      if(record.completed&&/^battle-gen9championsvgc2026regmc(?:bo3)?-\d+$/.test(roomId))await saveGameEvidence({workspace,teamId,roomId,events,sheets:client.state?.(roomId)?.sheets});
      if(saved.status!=='unchanged')await updateTeamReport({workspace,teamId});
    }).catch(()=>onError());
  };
  on('request',value=>{
    append(value.room,{event:'request',request:value.request});
    const b=get(value.room),q=value.request;
    if(b&&q&&!q.wait&&!q.teamPreview&&q.side?.id)b.pending={rqid:q.rqid,side:q.side.id,forceSwitch:q.forceSwitch||[],submitted:false};
  });
  on('action-status',value=>{
    const b=get(value.room);if(!b?.pending)return;
    const action=client.state?.(value.room)?.lastAction;
    if(action)append(value.room,{event:'decision',status:value.status,rqid:action.rqid,actions:action.actions,expectedMoves:action.expectedMoves});
    if(['sent','accepted'].includes(value.status))b.pending.submitted=true;
    if(value.status==='rejected')b.pending.submitted=false;
  });
  on('choice-status',value=>{const b=get(value.room);if(b?.pending&&value.submitted)b.pending.submitted=true;});
  on('battle-event',value=>{
    append(value.room,{event:'battle-event',type:value.type,data:value.data});
    if(value.type==='gametype'){const b=get(value.room);if(b)b.pending=null;}
    const pending=get(value.room)?.pending;
    if(pending&&['move','cant'].includes(value.type)&&value.data?.[0]?.startsWith(pending.side)&&!pending.submitted){
      const b=get(value.room);b.operational=true;
    }
    if(pending&&value.type==='switch'&&!pending.submitted){
      const ref=/^(p[1-4])([ab]):/.exec(value.data?.[0]||'');
      if(ref&&ref[1]===pending.side&&pending.forceSwitch[ref[2]==='a'?0:1])get(value.room).operational=true;
    }
    if(value.type==='-message'&&/lost due to inactivity/i.test(value.data?.join(' ')||'')){const b=get(value.room);if(b)b.operational=true;}
    if(value.type==='turn'){const b=get(value.room);if(b)save(b);}
    if(['win','tie'].includes(value.type)){const b=get(value.room);if(b)save(b);}
  });
  on('result',value=>{
    // The protocol win follows the result callback synchronously in this client.
    if(/^game-bestof/.test(value.room)){
      const own=String(username).toLowerCase().replace(/[^a-z0-9]/g,'');
      const winner=String(value.winner||'').toLowerCase().replace(/[^a-z0-9]/g,'');
      const result={outcome:value.type==='tie'?'tie':winner===own?'win':'loss',completed:true};
      queueMicrotask(()=>{if(disposed)return;for(const b of buffers.values()){
        const parent=[...(session?.roomParents||[])].find(([child])=>canonicalRoom(child)===b.roomId)?.[1];
        if(canonicalRoom(parent)===canonicalRoom(value.room))save(b,result);
      }});
    }
  });
  on('timer',value=>{if(/lost due to inactivity|disconnected.*lost|inactivity.*loss/i.test(value.text||'')){const b=get(value.room);if(b)b.operational=true;}});
  on('replay-verified',value=>{
    const b=get(value.roomId||value.room);if(!b)return;
    chain=chain.then(async()=>{await attachVerifiedReplay({workspace,teamId,roomId:b.roomId,url:value.url});await updateTeamReport({workspace,teamId});}).catch(()=>onError());
  });
  on('disconnected',()=>{for(const b of buffers.values())save(b);});
  return {
    async flush(){await chain;},
    async close(){disposed=true;for(const [event,handler]of listeners)client.off(event,handler);for(const b of buffers.values())save(b);await chain;},
  };
}
