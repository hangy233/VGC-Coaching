import {analyzeBattle} from './parser.mjs';
import {saveBattle,registerMetricsTeam} from './store.mjs';
import {canonicalRoom,collectBattleEvents,saveMetricsTeamSnapshot} from './import.mjs';
import {updateTeamReport} from './live-reports.mjs';
import {saveGameEvidence,sanitizeControlTrace} from './retention.mjs';
import {attachVerifiedReplay} from './replay-evidence.mjs';

function safeFailure(error){
  const message=typeof error?.message==='string'?error.message:'';
  if(/completed evidence differs/u.test(message))return {reasonCode:'COMPLETED_EVIDENCE_CONFLICT',detail:'A completed archive conflicts with a later observation; retained evidence was not overwritten.'};
  if(/existing evidence hash|evidence hash/u.test(message))return {reasonCode:'EVIDENCE_HASH_MISMATCH',detail:'Stored evidence could not pass its registered hash check.'};
  if(/registered snapshot roster|snapshot does not match|Team snapshot does not match/u.test(message))return {reasonCode:'TEAM_SNAPSHOT_MISMATCH',detail:'The saved exact team snapshot and report identity do not match.'};
  if(error?.code==='METRICS_TEAM_DELETED')return {reasonCode:'TEAM_REPORT_DELETED',detail:'The exact team report was deleted or is being deleted.'};
  if(error?.code==='METRICS_TEAM_BUSY')return {reasonCode:'TEAM_REPORT_BUSY',detail:'The exact report has an active writer or cleanup transaction.'};
  if(['EACCES','EPERM'].includes(error?.code))return {reasonCode:'LOCAL_FILE_ACCESS_DENIED',detail:'A local generated-data operation was denied.'};
  if(['ENOSPC','EDQUOT'].includes(error?.code))return {reasonCode:'LOCAL_STORAGE_FULL',detail:'Local generated-data storage has no available capacity.'};
  return {reasonCode:'METRICS_SAVE_FAILED',detail:'The local metrics operation failed; retain its source evidence for investigation.'};
}

/** Observation only: no socket, authentication, commands, or battle decisions. */
export function attachMetricsRecorder(client,{workspace,username,teamId,team,name='Team',session,onError=()=>{},replayAttacher=attachVerifiedReplay}={}) {
  const buffers=new Map(),listeners=[],parentResults=new Map(),failures=new Map(),observers=new Set(),verifiedReplayUrls=new Map(),activeReplays=new Set();
  let chain=Promise.resolve(),disposed=false,initialized=false,pending=0,lastSavedAt=null,stableReport=null;
  const status=()=>({enabled:true,recordingSchemaVersion:2,features:{previewDecisionEvidence:true,controlTraceEvidence:true},teamId,state:failures.size?'error':disposed?'closed':pending?'pending':initialized?'ready':'initializing',pending,lastSavedAt,lastError:[...failures.values()].at(-1)||null,stableReport});
  const notify=()=>{for(const observer of observers)try{observer(status());}catch{}};
  const enqueue=(key,operation)=>{
    pending++;notify();
    chain=chain.then(operation).then(()=>{failures.delete(key);lastSavedAt=new Date().toISOString();},error=>{
      const failure={operation:key,at:new Date().toISOString(),message:'Team metrics could not be saved. Retain local battle evidence and retry metrics sync.',...safeFailure(error)};failures.set(key,failure);
      try{onError(failure);}catch{}
    }).finally(()=>{pending--;notify();});
    return chain;
  };
  const attachReplay=(roomId,url)=>{
    if(activeReplays.has(roomId))return;
    activeReplays.add(roomId);
    enqueue('replay:'+roomId,async()=>{
      // This rereads an already saved replay; it never requests another upload.
      await replayAttacher({workspace,teamId,roomId,url});
      stableReport=await updateTeamReport({workspace,teamId});
    }).finally(()=>activeReplays.delete(roomId));
  };
  // Team registration creates an empty version report without queuing a battle.
  const initialize=()=>enqueue('register-team',async()=>{
    // Production sessions provide a validated six-Pokémon export. Retain it so
    // later replay imports can refer to this exact version by its saved ID.
    if(team.length===6)await saveMetricsTeamSnapshot({workspace,teamId,team});
    await registerMetricsTeam({workspace,teamId,name,format:'gen9championsvgc2026regmc',roster:team.map(p=>p.species)});
    stableReport=await updateTeamReport({workspace,teamId});initialized=true;
  });
  initialize();
  const owned=room=>!session||session.ownedRooms.has(client.resolveRoom?.(room)||room)&&(!session.roomTeamId||session.roomTeamId(room)===teamId);
  const get=room=>{const id=canonicalRoom(room);if(!/^battle-/.test(id)||!owned(room))return null;if(!buffers.has(id))buffers.set(id,{roomId:id,events:[],truncated:false});return buffers.get(id);};
  const on=(event,handler)=>{client.on(event,handler);listeners.push([event,handler]);};
  const append=(room,value)=>{const b=get(room);if(!b)return;if(b.events.length>=20000){b.truncated=true;return;}b.events.push({...value,room,at:Number.isFinite(value.at)&&value.at>=0?value.at:Date.now()});};
  const finishPreview=(room,transition)=>{
    const b=get(room);if(!b||b.previewClosed)return;
    const preview=b.preview;b.previewClosed=true;
    let status='unknown',reason='Preview request or agent submission history was not observed; the selected four do not establish who chose them.';
    if(preview?.accepted){status='accepted';reason='The battle advanced after an observed server acknowledgment of the tracked preview choice; this does not establish attack execution.';}
    else if(preview?.rejected){status='rejected';reason='The battle advanced after a rejected preview choice without a later tracked retry; no accepted agent selection is established.';b.operational=true;}
    else if(preview&&!preview.sent&&!preview.externalAcknowledgment){status='unsubmitted';reason='The battle advanced without an observed agent preview submission. Selection may be server-defaulted or supplied elsewhere; no server default is claimed as confirmed.';b.operational=true;}
    else if(preview?.sent)reason='A preview choice was sent, but its server acceptance was not observed before battle advancement; submission outcome is unknown, not a confirmed server default.';
    else if(preview?.externalAcknowledgment)reason='A server choice acknowledgment was observed without a matching tracked agent preview submission; selection ownership is unknown.';
    b.previewOutcome={status,reason};
    append(room,{event:'decision',phase:'preview',status,turn:0,...(preview?{rqid:preview.rqid,submitted:!!preview.sent,...(preview.actions?{selected:true,actions:preview.actions}:{})}:{}),...(status==='accepted'?{accepted:true}:status==='rejected'?{accepted:false}:{}),reason,evidence:{type:'preview-transition',transition}});
  };
  const save=(b,parentResult)=>{
    const events=[...b.events],roomId=b.roomId;
    const parent=[...(session?.roomParents||[])].find(([child])=>canonicalRoom(child)===roomId)?.[1]||null;
    const officialResult=parentResult||parentResults.get(canonicalRoom(parent));
    const operational=!!b.operational,truncated=b.truncated,previewOutcome=b.previewOutcome;
    enqueue('battle:'+roomId,async()=>{
      const data=collectBattleEvents(events.filter(value=>value.event!=='control-trace')).get(roomId);if(!data)return;
      const record=analyzeBattle({roomId,username,teamId,team,events:data.events,parentId:parent?canonicalRoom(parent):null,metadata:{source:'live-client',operational}});
      record.team={name,format:'gen9championsvgc2026regmc',roster:team.map(p=>p.species)};
      record.metadata={...(record.metadata||{}),sources:['live-client'],...(officialResult?{setResult:officialResult}:{})};
      if(operational){record.quality.operational=true;record.quality.warnings.push('Observed control fallback, inactivity or submission failure; excluded from default team comparisons.');}
      if(previewOutcome&&previewOutcome.status!=='accepted')record.quality.warnings.push(previewOutcome.reason);
      if(truncated){record.quality.complete=false;record.quality.warnings.push('Recorder event limit reached; partial observations only.');}
      const saved=await saveBattle({workspace,record});
      // Persist partial state and control diagnostics at the existing turn,
      // disconnect and explicit-flush boundaries as well. A crash before an
      // official result must not leave its last submission evidence only in RAM.
      if(/^battle-gen9championsvgc2026regmc(?:bo3)?-\d+$/.test(roomId))await saveGameEvidence({workspace,teamId,roomId,events,sheets:client.state?.(roomId)?.sheets});
      if(saved.status!=='unchanged'||!stableReport||failures.has('battle:'+roomId))stableReport=await updateTeamReport({workspace,teamId});
    });
  };
  on('request',value=>{
    append(value.room,{event:'request',request:value.request});
    const b=get(value.room),q=value.request;
    if(b&&q?.teamPreview&&!q.wait&&q.side?.id){
      if(!b.preview||b.preview.rqid!==q.rqid)b.preview={rqid:q.rqid,side:q.side.id,sent:false,accepted:false,rejected:false};
      // Preview has its own provenance; it cannot become a move/switch request.
      b.pending=null;
    }else if(b&&q&&!q.teamPreview&&(Array.isArray(q.active)||Array.isArray(q.forceSwitch)||q.wait&&q.side?.pokemon?.length===4))finishPreview(value.room,'post-preview-request');
    if(b&&q&&!q.wait&&!q.teamPreview&&q.side?.id)b.pending={rqid:q.rqid,side:q.side.id,forceSwitch:q.forceSwitch||[],submitted:false};
  });
  on('action-status',value=>{
    const b=get(value.room);if(!b)return;
    const action=client.state?.(value.room)?.lastAction;
    const preview=b.preview;
    if(preview&&!b.previewClosed&&action?.rqid===preview.rqid&&action.actions?.length===1&&action.actions[0]?.type==='team'){
      if(value.status==='sent'){
        preview.actions=structuredClone(action.actions);preview.sent=true;preview.accepted=false;preview.rejected=false;
        append(value.room,{event:'decision',phase:'preview',status:'selected',turn:0,rqid:preview.rqid,selected:true,actions:preview.actions});
      }
      if(value.status==='accepted')preview.accepted=true;
      if(value.status==='rejected'){preview.accepted=false;preview.rejected=true;}
      append(value.room,{event:'decision',phase:'preview',status:value.status,turn:0,rqid:preview.rqid,selected:true,submitted:!!preview.sent,...(value.status==='accepted'?{accepted:true}:value.status==='rejected'?{accepted:false}:{}),actions:action.actions});
      return;
    }
    if(!b.pending)return;
    if(!action||action.rqid!==b.pending.rqid)return;
    if(action&&action.rqid===b.pending.rqid)append(value.room,{event:'decision',status:value.status,rqid:action.rqid,actions:action.actions,expectedMoves:action.expectedMoves});
    if(['sent','accepted'].includes(value.status))b.pending.submitted=true;
    if(value.status==='rejected')b.pending.submitted=false;
  });
  on('choice-status',value=>{
    const b=get(value.room);if(!b)return;
    if(b.preview&&!b.previewClosed&&value.submitted&&!b.preview.accepted)b.preview.externalAcknowledgment=true;
    const action=client.state?.(value.room)?.lastAction;
    if(b.pending&&value.submitted&&action?.rqid===b.pending.rqid)b.pending.submitted=true;
  });
  on('control-trace',value=>{
    const b=get(value.room);if(!b)return;
    const trace=sanitizeControlTrace({...value,event:'control-trace'},null);if(!trace)return;
    append(value.room,trace);
    if(trace.controlFailure===true||trace.source==='emergency-default'||['fallback-sent','emergency-default-sent','watchdog-emergency-default-selected','watchdog-emergency-default-sent','watchdog-forfeit','watchdog-uncertain'].includes(trace.type))b.operational=true;
    // A post-result recovery observation is useful evidence too. An idle flush
    // must not leave it solely in a disposable log until the client closes.
    if(client.state?.(value.room)?.ended)save(b);
  });
  on('battle-event',value=>{
    append(value.room,{event:'battle-event',type:value.type,data:value.data});
    if(value.type==='gametype'){const b=get(value.room);if(b)b.pending=null;}
    if(value.type==='start')finishPreview(value.room,'battle-start');
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
      if(!owned(value.room))return;
      // Membership comes from the observed official parent, independently of
      // whichever child buffers happened to be recorded/imported successfully.
      // An unavailable/empty parent list leaves coverage explicitly unknown.
      const parentState=client.rooms?.get(client.resolveRoom?.(value.room)||value.room)||client.state?.(value.room);
      const rawChildren=parentState?.children;
      if(Array.isArray(rawChildren)&&rawChildren.length>0&&rawChildren.length<=3){
        const expected=rawChildren.map(canonicalRoom);
        if(new Set(expected).size===expected.length&&expected.every(child=>/^battle-gen9championsvgc2026regmc(?:bo3)?-\d+$/.test(child)))result.expectedChildIds=expected.sort();
      }
      parentResults.set(canonicalRoom(value.room),result);
      queueMicrotask(()=>{if(disposed)return;for(const b of buffers.values()){
        const parent=[...(session?.roomParents||[])].find(([child])=>canonicalRoom(child)===b.roomId)?.[1];
        if(canonicalRoom(parent)===canonicalRoom(value.room))save(b,result);
      }});
    }
  });
  on('timer',value=>{if(/lost due to inactivity|disconnected.*lost|inactivity.*loss/i.test(value.text||'')){const b=get(value.room);if(b)b.operational=true;}});
  on('replay-verified',value=>{
    const b=get(value.roomId||value.room);if(!b)return;
    // Private replay capabilities remain in memory and the canonical replay
    // metadata only; status/errors expose no URL and retry needs no client event.
    verifiedReplayUrls.set(b.roomId,value.url);attachReplay(b.roomId,value.url);
  });
  on('disconnected',()=>{for(const b of buffers.values())save(b);});
  return {
    status,
    onChange(observer){observers.add(observer);return()=>observers.delete(observer);},
    async flush({savePending=false}={}){
      // The parent's result callback precedes its protocol event. Drain that
      // microtask before capturing the queue so an immediate MCP sync includes it.
      await Promise.resolve();
      let observed;do{observed=chain;await observed;}while(observed!==chain);
      if(savePending){
        if(!initialized)initialize();for(const b of buffers.values())save(b);
        for(const [roomId,url]of verifiedReplayUrls)if(failures.has('replay:'+roomId))attachReplay(roomId,url);
        do{observed=chain;await observed;}while(observed!==chain);
      }
      return status();
    },
    async reopen(){
      // Only a failed, idle team-switch transaction resumes the same observer.
      // Buffers retain the original exact-team identity and decision journal.
      if(!disposed)return status();disposed=false;
      for(const [event,handler]of listeners)client.on(event,handler);
      return this.flush({savePending:true});
    },
    async close(){disposed=true;for(const [event,handler]of listeners)client.off(event,handler);for(const b of buffers.values())save(b);let observed;do{observed=chain;await observed;}while(observed!==chain);notify();observers.clear();},
  };
}
