import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {boundAction,resolvePlanningSource,observedPlanningSheet,createObservedPlanningSheetCache} from './source.mjs';
import {boardDigest,requestDigest} from './identity.mjs';
import {planningFixture} from './fixtures.mjs';
import {currentFixture} from '../simulation/observed-position.fixtures.mjs';
import {buildObservedPosition,publishedSheetDigest} from '../simulation/observed-position.mjs';
const {Teams} = createRequire(import.meta.url)('pokemon-showdown');
const teamId = 'a'.repeat(64), token = 'b'.repeat(64), room = 'battle-gen9championsvgc2026regmcbo3-701';
function retainedFixture(){
  const identity={sessionId:'retained-sheet-fixture',teamId},cache=createObservedPlanningSheetCache(),sets=currentFixture().opposingSheet;
  const preview={sessionId:identity.sessionId,connected:true,authenticated:true,stopped:false,revision:2,rooms:[{id:room,ended:false}],
    boards:[{room,ownSide:'p1',request:{rqid:2},opponentSheets:{p2:sets.map(set=>({...set,gender:'F',shiny:false}))}}]};
  const turn=structuredClone(preview);turn.revision=4;turn.boards[0].request.rqid=4;delete turn.boards[0].opponentSheets;
  return {cache,identity,preview,turn};
}
test('observed registered sheets survive preview omission with exact source, planning normalization and independent copies',()=>{
  const f=retainedFixture(),before=structuredClone(f.preview);f.cache.observe(f.preview,f.identity);
  const result=f.cache.observe(f.turn,f.identity),board=result.boards[0],packed={rooms:[{id:room,sheets:{p2:Teams.pack(before.boards[0].opponentSheets.p2)}}]};
  assert.deepEqual(board.opponentSheets.p2,observedPlanningSheet(f.turn.boards[0],packed,room));
  assert.equal(board.opponentSheets.p2.length,6);assert.equal(board.opponentSheets.p2[0].gender,undefined);
  assert.equal(board.opponentSheetObservation.snapshotRevision,2);assert.equal(board.opponentSheetObservation.rqid,2);
  assert.equal(board.opponentSheetObservation.room,room);assert.equal(board.opponentSheetObservation.teamId,teamId);
  assert.equal(board.opponentSheetObservation.freshness,'previous-observation-same-child-only');
  assert.deepEqual(f.preview,before);assert.equal(f.turn.boards[0].opponentSheets,undefined);
  assert.equal(boardDigest(board,{}),boardDigest(f.turn.boards[0],{}),'retained sheet presentation does not change mechanical/request digests');
  f.preview.boards[0].opponentSheets.p2[0].moves[0]='Fake Out';board.opponentSheets.p2[0].moves[0]='Protect';
  const again=f.cache.observe(f.turn,f.identity);assert.deepEqual(again.boards[0].opponentSheets.p2,observedPlanningSheet(f.turn.boards[0],packed,room));
  const reobserved=f.cache.observe(again,f.identity);assert.equal(reobserved.boards[0].opponentSheetObservation.snapshotRevision,2,'helper re-observation cannot advance native sheet provenance');
  f.cache.observe({controllerLease:'fixture-only'},f.identity);assert(f.cache.observe(f.turn,f.identity).boards[0].opponentSheets,'ordinary non-state replies do not erase the retained observation');
  f.cache.observe({sessionId:f.identity.sessionId,entries:[]},f.identity);assert(f.cache.observe(f.turn,f.identity).boards[0].opponentSheets,'scoped session diagnostics are not room snapshots');
  const unknown=retainedFixture();delete unknown.preview.boards[0].opponentSheets.p2[0].nature;delete unknown.preview.boards[0].opponentSheets.p2[0].level;
  unknown.cache.observe(unknown.preview,unknown.identity);const unknownSet=unknown.cache.observe(unknown.turn,unknown.identity).boards[0].opponentSheets.p2[0];
  assert.equal(unknownSet.nature,null);assert.equal(unknownSet.level,null);assert.equal(unknownSet.evs,undefined);assert.equal(unknownSet.ivs,undefined);
});
test('retained sheets refuse missing, partial, conflicting, cross-session/team/child/side and ambiguous observations',()=>{
  const missing=retainedFixture();assert.equal(missing.cache.observe(missing.turn,missing.identity).boards[0].opponentSheets,undefined);
  for(const change of [
    state=>{state.boards[0].opponentSheets.p2.pop();},state=>{state.boards[0].opponentSheets.p2[0].moves=[];},
  ]){const f=retainedFixture();change(f.preview);f.cache.observe(f.preview,f.identity);assert.equal(f.cache.observe(f.turn,f.identity).boards[0].opponentSheets,undefined);}
  for(const change of [
    state=>{state.sessionId='foreign-session';},state=>{state.teamSha256='f'.repeat(64);},state=>{state.boards[0].ownSide='p2';},
    state=>{state.boards[0].room=room+'-differentpw';state.rooms=[{id:state.boards[0].room,ended:false}];},
    state=>{state.boards[0].room=room.replace('battle-','game-bestof3-');state.rooms=[{id:state.boards[0].room,ended:false}];},
    state=>{state.rooms[0].ended=true;},state=>{state.rooms[0].teamId='f'.repeat(64);},state=>{state.rooms=[];},state=>{state.rooms.push({...state.rooms[0]});},
    state=>{state.boards.push(structuredClone(state.boards[0]));},
  ]){const f=retainedFixture();f.cache.observe(f.preview,f.identity);change(f.turn);assert(f.cache.observe(f.turn,f.identity).boards.every(board=>board.opponentSheets===undefined));}
  const conflict=retainedFixture();conflict.cache.observe(conflict.preview,conflict.identity);
  const revised=structuredClone(conflict.preview);revised.boards[0].opponentSheets.p2[0].moves[0]='Fake Out';
  conflict.cache.observe(revised,conflict.identity);assert.equal(conflict.cache.observe(conflict.turn,conflict.identity).boards[0].opponentSheets,undefined,'conflicting published facts cannot become a retained all-clear');
  const flipped=retainedFixture();flipped.cache.observe(flipped.preview,flipped.identity);
  const opposite=structuredClone(flipped.turn);opposite.boards[0].ownSide='p2';flipped.cache.observe(opposite,flipped.identity);
  assert.equal(flipped.cache.observe(flipped.turn,flipped.identity).boards[0].opponentSheets,undefined,'an own-side conflict stays invalidated');
});
function fixture() {
  const data = planningFixture();data.ownTeam[2].item = 'Miracle Seed';data.ownTeam[3].item = 'Grassy Seed';data.opponentSheet[2].item = 'Grassy Seed';
  const request = {kind:'observed',sessionId:'isolated-source',teamId,room,rqid:2,token};
  data.board = {...data.board,room,request:{...data.board.request,rqid:2},opponentSheets:{p2:data.opponentSheet}};
  const state = {sessionId:request.sessionId,teamSha256:teamId,actions:[{room,rqid:2,token,legalActions:data.legalActions}],boards:[data.board],controlPolicy:{pending:[]}};
  return {data,request,state};
}

test('explicit source validates native M-C sets and fingerprints mechanical board plus legal request',async() => {
  const {data} = fixture(), request = {kind:'explicit',label:'Offline native fixture',board:data.board,legalActions:data.legalActions,ownTeam:Teams.export(data.ownTeam),opponentSheet:data.opponentSheet};
  const result = await resolvePlanningSource(request);
  assert.equal(result.source.kind,'explicit-hypothetical-snapshot');assert.equal(result.source.liveFreshness,false);
  assert.equal(result.source.boardHash,boardDigest(data.board,data.legalActions));assert.equal(await result.revalidate(),true);
  assert.equal(result.ownTeam[0].nature,'Careful');assert.equal(result.opponentSheet[0].nature,null);assert.equal(result.opponentSheet[0].evs,undefined);
  const clockOnly = structuredClone(data.board);clockOnly.observedAt = 999;clockOnly.requestAgeMs = 1234;
  assert.equal(boardDigest(clockOnly,data.legalActions),result.source.boardHash);
  clockOnly.sides[0].pokemon[0].hp.current--;assert.notEqual(boardDigest(clockOnly,data.legalActions),result.source.boardHash);
  const invalid = structuredClone(request);invalid.ownTeam = invalid.ownTeam.replace('Miracle Seed','Assault Vest');
  await assert.rejects(resolvePlanningSource(invalid),/native validation/);
});

test('observed source reads only existing session, binds identity and revalidates mechanical hash',async() => {
  const {data,request,state} = fixture(), commands = [];
  const call = async(path,command) => {commands.push(command.op);return {ok:true,result:command.op === 'status' ? {sessionId:request.sessionId,teamSha256:teamId,rooms:[]} : structuredClone(state)};};
  const result = await resolvePlanningSource(request,{workspace:process.cwd(),call,loadTeam:async() => ({teamId,team:data.ownTeam})});
  assert.equal(result.source.kind,'bound-observed-turn');assert.equal(result.source.boardHash,boardDigest(data.board,data.legalActions));
  assert.equal(result.source.requestDigest,requestDigest({...request,boardHash:result.source.boardHash}));
  assert.equal(result.source.token,undefined);assert.equal(await result.revalidate(),true);assert.deepEqual(commands,['turn-status','status','turn-status']);
  state.boards[0].sides[0].pokemon[0].hp.current--;
  assert.equal(await result.revalidate(),false,'Same token cannot authorize candidates for a changed board');
});

test('observed source revalidation rejects a compact opposing-sheet-only change with the same mechanical board and request',async()=>{
  const {data,request,state}=fixture(),commands=[];
  const call=async(_path,{op})=>{commands.push(op);return {ok:true,result:op==='status'?{sessionId:request.sessionId,teamSha256:teamId,rooms:[]}:structuredClone(state)};};
  const result=await resolvePlanningSource(request,{workspace:process.cwd(),call,loadTeam:async()=>({teamId,team:data.ownTeam})});
  assert.equal(await result.revalidate(),true);
  state.boards[0].opponentSheets.p2[0].item='Sitrus Berry';
  assert.equal(boardDigest(state.boards[0],data.legalActions),result.source.boardHash);
  assert.equal(await result.revalidate(),false,'A changed actual sheet cannot retain a current source binding');
  assert.deepEqual(commands,['turn-status','status','turn-status','turn-status']);
});

test('packed published sheets are freshly read, identity checked and compared on every source revalidation',async()=>{
  const {data,request,state}=fixture(),commands=[],packed=Teams.pack(data.opponentSheet);
  delete state.boards[0].opponentSheets;
  const full={sessionId:request.sessionId,teamSha256:teamId,rooms:[{id:room,sheets:{p2:packed}}]};
  const call=async(_path,{op})=>{commands.push(op);return {ok:true,result:structuredClone(op==='status'?full:state)};};
  const result=await resolvePlanningSource(request,{workspace:process.cwd(),call,loadTeam:async()=>({teamId,team:data.ownTeam})});
  assert.deepEqual(result.opponentSheet,observedPlanningSheet(state.boards[0],full,room));
  assert.equal(await result.revalidate(),true);assert.deepEqual(commands,['turn-status','status','turn-status','status']);
  const changed=structuredClone(data.opponentSheet);changed[0].item='Sitrus Berry';full.rooms[0].sheets.p2=Teams.pack(changed);
  assert.equal(boardDigest(state.boards[0],data.legalActions),result.source.boardHash);
  assert.equal(await result.revalidate(),false,'Sheet-only changes in fresh full status invalidate the source');
  full.rooms[0].sheets.p2=packed;full.teamSha256='c'.repeat(64);assert.equal(await result.revalidate(),false);
  full.teamSha256=teamId;full.sessionId='different-session';assert.equal(await result.revalidate(),false);
  full.sessionId=request.sessionId;full.rooms=[];assert.equal(await result.revalidate(),false,'The initial packed sheet is never reused when fresh full status lacks it');
  full.rooms=[{id:room,sheets:{p2:packed}},{id:room,sheets:{p2:packed}}];assert.equal(await result.revalidate(),false,'Duplicate matching rooms are ambiguous');
});

test('the observed sheet helper prefers an actual board sheet and refuses absent or ambiguous fallback sources',()=>{
  const {data}=fixture(),full={rooms:[{id:room,sheets:{p2:Teams.pack(data.opponentSheet)}}]};
  assert.equal(observedPlanningSheet(data.board,undefined,room),data.opponentSheet);
  const compact=structuredClone(data.board);delete compact.opponentSheets;
  assert(observedPlanningSheet(compact,full,room).length>0);
  for(const unavailable of [undefined,{rooms:[]},{rooms:[{id:room,sheets:{}}]},{rooms:[...full.rooms,...full.rooms]}])
    assert.throws(()=>observedPlanningSheet(compact,unavailable,room),/published opposing sheet unavailable/);
  assert.throws(()=>observedPlanningSheet({...compact,ownSide:null},full,room),/identified own side/);
  compact.opponentSheets={p2:[]};assert.throws(()=>observedPlanningSheet(compact,full,room),/published opposing sheet unavailable/);
});

test('stale, sent, reserved, duplicate and mismatched sources never bind an actionable request',() => {
  for (const mutate of [
    state => {state.sessionId = 'another';},state => {state.teamSha256 = 'c'.repeat(64);},
    state => {state.actions[0].token = 'd'.repeat(64);},state => {state.actions[0].submissionStatus = 'sent';},
    state => {state.actions[0].actionable = false;},state => {state.actions.push({...state.actions[0]});},
    state => {state.connected = false;},state => {state.authenticated = false;},state => {state.stopped = true;},
    state => {state.controlPolicy.pending = [{token,attempted:true}];},state => {state.boards[0].request.rqid = 3;},
  ]) {
    const {request,state} = fixture();mutate(state);assert.throws(() => boundAction(state,request));
  }
});

test('observed locked team identity mismatch and missing published sheets are explicit refusals',async() => {
  const {data,request,state} = fixture();
  const options = {workspace:process.cwd(),call:async(path,command) => ({ok:true,result:command.op === 'status' ? {sessionId:request.sessionId,teamSha256:teamId,rooms:[]} : state}),loadTeam:async() => ({teamId:'e'.repeat(64),team:data.ownTeam})};
  await assert.rejects(resolvePlanningSource(request,options),/locked team fingerprint changed/);
  delete state.boards[0].opponentSheets;
  await assert.rejects(resolvePlanningSource(request,options),/published opposing sheet unavailable/);
});

test('explicit source rejects oversized event/party inputs and ambiguous mechanical identities before planning',async() => {
  for (const mutate of [
    board => {board.sides[1].id = 'p1';},
    board => {board.sides[1].pokemon = Array.from({length:13},(_,index) => ({...board.sides[1].pokemon[0],id:`oversized-${index}`}));},
    board => {board.recentEvents = {lines:Array(81).fill('|turn|2')};},
    board => {board.sides[1].pokemon[0].id = board.sides[0].pokemon[0].id;},
  ]) {
    const {data} = fixture();mutate(data.board);
    await assert.rejects(resolvePlanningSource({kind:'explicit',label:'Invalid bounded input',board:data.board,legalActions:data.legalActions,ownTeam:Teams.export(data.ownTeam),opponentSheet:data.opponentSheet}),/bounded|both sides|identities/);
  }
});

test('independent source reads and locked-team acquisition overlap, while all bindings and final freshness are checked',async()=>{
  const {data,request,state}=fixture(),started=[];let release;
  const barrier=new Promise(resolve=>{release=resolve;});
  const call=async(path,{op})=>{started.push(op);await barrier;return {ok:true,result:op==='status'?{sessionId:request.sessionId,teamSha256:teamId,rooms:[]}:structuredClone(state)};};
  const pending=resolvePlanningSource(request,{workspace:process.cwd(),call,loadTeam:async()=>{started.push('team');await barrier;return {teamId,team:data.ownTeam};}});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(started,['turn-status','status','team']);release();
  const result=await pending;assert.equal(await result.revalidate(),true);
  state.sessionId='different';assert.equal(await result.revalidate(),false);
});

test('parallel source acquisition settles a failed team read without accepting otherwise matching state',async()=>{
  const {request,state}=fixture(),started=[];
  await assert.rejects(resolvePlanningSource(request,{workspace:process.cwd(),call:async(path,{op})=>{started.push(op);return {ok:true,result:op==='status'?{sessionId:request.sessionId,teamSha256:teamId,rooms:[]}:state};},loadTeam:async()=>{started.push('team');throw new Error('Locked-team storage unavailable');}}),/Locked-team storage unavailable/);
  assert.deepEqual(started,['turn-status','status','team']);
});

test('observed source privately captures exact converter context from compact and packed actual sheets without authoring hypotheses',async()=>{
  for(const packed of [false,true]){
    const input=currentFixture(),board=input.observed.boards[0],request={kind:'observed',sessionId:input.observed.sessionId,...input.expected};
    if(packed)for(const set of input.opposingSheet)set.level=50;
    const state=structuredClone(input.observed);state.teamSha256=request.teamId;
    if(!packed)state.boards[0].opponentSheets={p2:structuredClone(input.opposingSheet)};
    const full={sessionId:request.sessionId,teamSha256:request.teamId,rooms:[{id:request.room,sheets:{p2:Teams.pack(input.opposingSheet)}}]},calls=[];
    const result=await resolvePlanningSource(request,{workspace:process.cwd(),loadTeam:async()=>({teamId:request.teamId,team:Teams.import(input.teamText)}),
      call:async(_path,{op})=>{calls.push(op);return {ok:true,result:structuredClone(op==='status'?full:state)};}});
    assert.equal(result.observedPositionInput.hypotheses,undefined);
    assert.equal(result.observedPositionInput.observed.sessionId,request.sessionId);assert.equal(result.observedPositionInput.observed.teamSha256,request.teamId);
    assert.deepEqual(result.observedPositionInput.observed.actions,[state.actions[0]]);assert.deepEqual(result.observedPositionInput.observed.boards,[state.boards[0]]);
    assert.deepEqual(result.observedPositionInput.expected,{...input.expected,opposingSheetSha256:publishedSheetDigest(result.opponentSheet)});
    assert.equal(result.source.publishedOpposingSheetSha256,publishedSheetDigest(result.opponentSheet));
    assert.equal(result.observedPositionSheetBinding.status,'bound');
    assert(buildObservedPosition({...result.observedPositionInput,hypotheses:input.hypotheses}).position);
    assert.deepEqual(calls,['turn-status','status'],'Capture adds no source RPC');
    state.actions[0].token='c'.repeat(64);assert.equal(result.observedPositionInput.observed.actions[0].token,request.token,'Captured input cannot follow later mutable observations');
  }
});

test('unknown published nature stays unknown and cannot fabricate a native sheet digest or break ordinary planning',async()=>{
  for(const key of ['nature','level']){
    const {data,request,state}=fixture();data.opponentSheet[0][key]=null;
    const result=await resolvePlanningSource(request,{workspace:process.cwd(),loadTeam:async()=>({teamId,team:data.ownTeam}),
      call:async(_path,{op})=>({ok:true,result:op==='status'?{sessionId:request.sessionId,teamSha256:teamId,rooms:[]}:structuredClone(state)})});
    assert.equal(result.observedPositionSheetBinding.status,'unavailable');assert.equal(result.source.publishedOpposingSheetSha256,undefined);
    assert.equal(result.observedPositionInput.expected.opposingSheetSha256,undefined);assert.equal(result.observedPositionInput.opposingSheet[0][key],null);
    assert.equal(await result.revalidate(),true);assert.equal(result.source.kind,'bound-observed-turn');
  }
});
