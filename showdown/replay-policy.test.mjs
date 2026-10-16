import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ShowdownClient} from './client.mjs';
import {AgentSession} from './agent-session.mjs';
import {registerBattleTools} from './mcp-tools.mjs';
import {parseSessionArgs} from './session.mjs';
import {verifySetReplayPreservation} from './replay-preservation.mjs';
import {saveBattle,listBattles} from '../metrics/store.mjs';
import {saveGameEvidence} from '../metrics/retention.mjs';
import {attachVerifiedReplay} from '../metrics/replay-evidence.mjs';
const {Teams}=createRequire(import.meta.url)('pokemon-showdown');

const parent='game-bestof3-gen9championsvgc2026regmcbo3-1000',room='battle-gen9championsvgc2026regmcbo3-1001',teamId='a'.repeat(64);
const log='|player|p1|Fixture\n|player|p2|Opponent\n|gametype|doubles\n|tier|[Gen 9] Champions VGC 2026 Reg M-C (Bo3)\n|start\n|turn|1\n|win|Fixture';
const pause=()=>new Promise(resolve=>setImmediate(resolve));
async function settle(session){for(let attempt=0;attempt<1000;attempt++){const states=session.replayPolicySnapshot().sets;if(states.length&&states.every(state=>['complete','attention-required'].includes(state.status))&&!session.replayTasks.size)return;await new Promise(resolve=>setTimeout(resolve,1));}throw new Error('Fixture replay preservation did not settle');}
function fixture({budget=500,proof=true}={}){
  const packed='Species|item|ability|move',sent=[],client=new ShowdownClient({expectedTeamHash:createHash('sha256').update(packed).digest('hex')});client.connected=true;client.authenticated=true;client.epoch=1;client.formats='[Gen 9] Champions VGC 2026 Reg M-C (Bo3),e';
  client.ws={send:line=>sent.push(line),close:()=>{client.connected=false;client.authenticated=false;client.emit('disconnected');}};
  let verified=false,flushes=0,allowProof=proof,flushGate=null;
  const session=new AgentSession(client,{username:'Fixture',packed,authorizedSets:2,replayBudgetMs:budget,replayFetchImpl:async url=>new Response(JSON.stringify({id:new URL(url).pathname.slice(1).replace(/(?:-privateaccesspw)?\.json$/u,''),formatid:'gen9championsvgc2026regmcbo3',log})),replayPreservationVerifier:async({teamId,parentId,roomIds})=>({teamId,parentId,complete:verified&&allowProof,preserved:verified&&allowProof?roomIds:[],missing:verified&&allowProof?[]:roomIds,failures:verified&&allowProof?[]:[{roomId:room,reason:'Synthetic report preservation not confirmed.'}]})});
  client.on('replay-verified',()=>{verified=true;});
  const initialTeamId=client.expectedTeamHash;
  session.attachMetricsRecorder({status:()=>({enabled:true,teamId:initialTeamId,state:'ready',pending:0,features:{previewDecisionEvidence:true},recordingSchemaVersion:2}),flush:async()=>{flushes++;if(flushGate)await flushGate;return {enabled:true,teamId:initialTeamId,state:'ready'};},close:async()=>{}});
  client.receive('|updatesearch|{"searching":[],"games":null}');
  const policy=enabled=>session.execute({id:'policy-'+String(enabled),op:'set-replay-policy',confirmed:true,enabled});
  const start=async()=>{const reply=await session.execute({id:'start-'+session.searchesSent,op:'start',confirmed:true});if(reply.ok){client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'Fixture vs Opponent'}})}`);client.receive(`>${parent}\n|uhtml|game|<a href="/${room}">Game 1</a>`);}return reply;};
  const finish=({idle=true}={})=>{client.receive(`>${room}\n${log}\n>${parent}\n|win|Fixture`);if(idle)client.receive('|updatesearch|{"searching":[],"games":null}');};
  const autoReply=()=>{const send=client.ws.send;client.ws.send=line=>{send(line);if(line.endsWith('|/savereplay'))queueMicrotask(()=>client.receive(`|popup|https://replay.pokemonshowdown.com/${line.split('|')[0].slice(7)}-privateaccesspw`));};};
  return {client,session,sent,policy,start,finish,autoReply,get flushes(){return flushes;},setProof:value=>{allowProof=value;},setFlushGate:value=>{flushGate=value;}};
}
test('policy defaults off and enabling is explicit, idle-only, future-scoped and never uploads historical sets',async t=>{
  const f=fixture();t.after(()=>f.session.dispose());assert.equal(f.session.snapshot().replayPolicy.enabled,false);await f.start();f.finish();await pause();assert.equal(f.sent.filter(line=>line.endsWith('|/savereplay')).length,0);
  const before=f.sent.length,enabled=await f.policy(true);assert.equal(enabled.ok,true);assert.equal(enabled.result.fromSearch,2);assert.equal(enabled.result.sets.length,0);assert.equal(f.sent.length,before);assert.equal(f.session.authorizedSets,2);assert.equal(f.client.authenticated,true);
  assert.equal((await f.session.execute({id:'unconfirmed-policy',op:'set-replay-policy',enabled:false})).ok,false);assert.equal(f.session.snapshot().replayPolicy.enabled,true);
});
test('authorized policy waits for official parent and idle, then preserves report before another search',async t=>{
  const f=fixture();t.after(()=>f.session.dispose());f.autoReply();assert.equal((await f.policy(true)).ok,true);assert.equal((await f.start()).ok,true);assert.equal((await f.session.execute({id:'active-policy',op:'set-replay-policy',confirmed:true,enabled:false})).ok,false);
  f.client.receive(`>${room}\n${log}`);await pause();assert.equal(f.sent.filter(line=>line.endsWith('|/savereplay')).length,0);
  let release;f.setFlushGate(new Promise(resolve=>{release=resolve;}));f.client.receive(`>${parent}\n|win|Fixture`);await pause();assert.equal(f.session.replayPolicySnapshot().sets[0].status,'awaiting-idle');assert.equal(f.sent.filter(line=>line.endsWith('|/savereplay')).length,0);
  f.client.receive('|updatesearch|{"searching":[],"games":null}');for(let attempt=0;attempt<30&&f.flushes===0;attempt++)await pause();assert.equal(f.session.replayPolicySnapshot().sets[0].status,'preserving');assert.equal((await f.session.execute({id:'early-next',op:'start',confirmed:true})).ok,false);
  release();await settle(f.session);const state=f.session.replayPolicySnapshot();assert.equal(state.sets[0].status,'complete');assert.deepEqual(state.sets[0].preservedChildIds,[room]);assert.equal(JSON.stringify(state).includes('privateaccesspw'),false);assert.equal(f.sent.filter(line=>line.endsWith('|/savereplay')).length,1);assert.equal(f.sent.filter(line=>line.includes('/search ')).length,1);
  assert.equal((await f.session.execute({id:'more',op:'authorize-sets',confirmed:true,additionalSets:1})).ok,true);assert.equal(f.session.replayPolicySnapshot().enabled,true);assert.equal(f.session.authorizedSets,3);assert.equal((await f.session.execute({id:'next-after-proof',op:'start',confirmed:true})).ok,true);
});
test('failed report preservation blocks search and a manual retry never repeats the upload',async t=>{
  const f=fixture({proof:false});t.after(()=>f.session.dispose());f.autoReply();await f.policy(true);await f.start();f.finish();await settle(f.session);assert.equal(f.session.replayPolicySnapshot().sets[0].status,'attention-required');assert.equal((await f.session.execute({id:'blocked-start',op:'start',confirmed:true})).ok,false);assert.equal((await f.session.execute({id:'disabled-cannot-bypass',op:'set-replay-policy',confirmed:true,enabled:false})).ok,false);
  assert.equal(f.sent.filter(line=>line.endsWith('|/savereplay')).length,1);f.setProof(true);const retried=await f.session.execute({id:'preserve-existing-replay',op:'save-replays',room:parent,confirmed:true});assert.equal(retried.ok,true);assert.equal(retried.result.complete,true);assert.equal(retried.result.preservation.complete,true);assert.equal(f.sent.filter(line=>line.endsWith('|/savereplay')).length,1);assert.equal(f.session.snapshot().replayPolicy.pendingParents.length,0);
});
test('an uncertain upload is not repeated automatically; late server URL can be preserved by explicit retry',async t=>{
  const f=fixture({budget:35});t.after(()=>f.session.dispose());await f.policy(true);await f.start();f.finish();await settle(f.session);assert.equal(f.sent.filter(line=>line.endsWith('|/savereplay')).length,1);assert.equal(f.session.snapshot().replayPolicy.sets[0].status,'attention-required');await pause();assert.equal(f.sent.filter(line=>line.endsWith('|/savereplay')).length,1);
  f.client.receive(`|popup|https://replay.pokemonshowdown.com/${room.slice(7)}-privateaccesspw`);const replay=await f.session.execute({id:'verify-late-url',op:'save-replays',confirmed:true,room:parent});assert.equal(replay.ok,true);assert.equal(replay.result.complete,true);assert.equal(f.sent.filter(line=>line.endsWith('|/savereplay')).length,1);
});
test('invalid replay commands cannot create a policy obligation and MCP/startup policy schemas are explicit',async t=>{
  const f=fixture();t.after(()=>f.session.dispose());const wrong=await f.session.execute({id:'wrong-parent',op:'save-replays',confirmed:true,room:parent});assert.equal(wrong.ok,false);assert.equal(f.session.replayPolicySnapshot().sets.length,0);
  const registry=new Map();registerBattleTools({registerTool(name,settings,handler){registry.set(name,{settings,handler});}},{workspace:process.cwd()});const schema=registry.get('battle_set_replay_policy').settings.inputSchema;assert.equal(schema.safeParse({confirmed:true,commandId:'policy',enabled:true}).success,true);for(const args of [{enabled:true},{enabled:true,confirmed:true},{enabled:true,confirmed:true,commandId:'policy',visibility:'public'}])assert.equal(schema.safeParse(args).success,false);
  assert.equal(parseSessionArgs(['Fixture','--team','fixture.txt']).saveReplays,false);assert.equal(parseSessionArgs(['Fixture','--team','fixture.txt','--save-replays']).saveReplays,true);assert.equal(f.session.capabilities().features.previewDecisionEvidence,true);
});
test('automatic policy waits for late official child results before its first upload attempt',async t=>{
  const f=fixture();t.after(()=>f.session.dispose());f.autoReply();await f.policy(true);await f.start();f.client.receive(`>${parent}\n|win|Fixture`);f.client.receive('|updatesearch|{"searching":[],"games":null}');await pause();assert.equal(f.session.replayPolicySnapshot().sets[0].status,'awaiting-child-results');assert.equal(f.session.replayPolicySnapshot().sets[0].attempted,false);assert.equal(f.sent.filter(line=>line.endsWith('|/savereplay')).length,0);
  f.client.receive(`>${room}\n${log}`);await settle(f.session);assert.equal(f.session.replayPolicySnapshot().sets[0].status,'complete');assert.equal(f.sent.filter(line=>line.endsWith('|/savereplay')).length,1);
});
test('manual historical replay after a real fixture team switch returns URLs and can verify old-team import without the current recorder',async t=>{
  const f=fixture({proof:false});t.after(()=>f.session.dispose());f.autoReply();await f.start();f.finish();const previousTeamId=f.client.expectedTeamHash;
  const teamText=[['Golisopod','Emergency Exit'],['Kommo-o','Soundproof'],['Rillaboom','Grassy Surge'],['Politoed','Drizzle'],['Farigiraf','Armor Tail'],['Sylveon','Pixilate']].map(([species,ability])=>`${species}\nAbility: ${ability}\nLevel: 50\nEVs: 32 HP / 32 SpA / 2 SpD\nModest Nature\n- Protect`).join('\n\n'),nextId=createHash('sha256').update(Teams.pack(Teams.import(teamText))).digest('hex');
  let nextFlushes=0;f.session.recorderFactory=async()=>({status:()=>({enabled:true,teamId:nextId,state:'ready'}),flush:async()=>{nextFlushes++;return {enabled:true,teamId:nextId,state:'ready'};},close:async()=>{}});
  const switched=await f.session.execute({id:'switch-fixture',op:'switch-team',confirmed:true,teamText,teamId:nextId});assert.equal(switched.ok,true);assert.equal(nextFlushes,1);
  const first=await f.session.execute({id:'save-old-team',op:'save-replays',confirmed:true,room:parent});assert.equal(first.ok,true);assert.equal(first.result.teamId,previousTeamId);assert.equal(first.result.transportComplete,true);assert.equal(first.result.complete,false);assert.equal(first.result.requiresReplayImport,true);assert.equal(first.result.replays.length,1);assert.equal(nextFlushes,1);assert.equal(f.session.replayPolicySnapshot().sets[0].required,false);assert.deepEqual(f.session.replayPolicySnapshot().pendingParents,[]);
  f.setProof(true);const imported=await f.session.execute({id:'verify-old-team-import',op:'save-replays',confirmed:true,room:parent});assert.equal(imported.ok,true);assert.equal(imported.result.teamId,previousTeamId);assert.equal(imported.result.complete,true);assert.equal(imported.result.requiresReplayImport,false);assert.equal(nextFlushes,1);assert.equal(f.sent.filter(line=>line.endsWith('|/savereplay')).length,1);
});
test('local preservation proof requires exact parent manifest, report link and both retained evidence hashes',async t=>{
  const workspace=await mkdtemp(join(tmpdir(),'replay-policy-proof-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  const record={schemaVersion:1,roomId:room,parentId:parent,teamId,username:'Fixture',ownSide:'p1',players:{p1:'Fixture',p2:'Opponent'},outcome:'win',completed:true,turns:1,opponentRoster:[],selected:[],selectionKnown:false,leads:[],pokemon:[],quality:{complete:true,operational:false,warnings:[]},team:{name:'Fixture',roster:[]},metadata:{setResult:{outcome:'win',completed:true,expectedChildIds:[room]}}};await saveBattle({workspace,record});
  const args={workspace,teamId,parentId:parent,roomIds:[room]};assert.equal((await verifySetReplayPreservation(args)).complete,false);
  const events=log.split('\n').map(line=>{const [,type,...data]=line.split('|');return {room,type,data};});await saveGameEvidence({workspace,teamId,roomId:room,events});await attachVerifiedReplay({workspace,teamId,roomId:room,url:'https://replay.pokemonshowdown.com/'+room.slice(7)+'-privateaccesspw',fetchImpl:async()=>new Response(JSON.stringify({id:room.slice(7),formatid:'gen9championsvgc2026regmcbo3',log}))});
  const proof=await verifySetReplayPreservation(args);assert.equal(proof.complete,true);assert.deepEqual(proof.preserved,[room]);assert.equal(JSON.stringify(proof).includes('privateaccesspw'),false);assert.equal((await verifySetReplayPreservation({...args,roomIds:[room+'9']})).complete,false);assert.equal((await verifySetReplayPreservation({...args,officialOutcome:'loss'})).complete,false);
  const row=(await listBattles({workspace}))[0],replayPath=join(workspace,row.metadata.replay.evidencePath),bytes=await readFile(replayPath);await writeFile(replayPath,Buffer.from('corrupt'));assert.equal((await verifySetReplayPreservation(args)).complete,false);await writeFile(replayPath,bytes);assert.equal((await verifySetReplayPreservation(args)).complete,true);
});
